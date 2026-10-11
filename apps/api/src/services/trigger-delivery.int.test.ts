import { users, workDefinitions, localHosts, localTerminals } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { triggerEvents, triggerOccurrences, workflowRuns, workflowTriggers } from "../db/schema.js";
import {
  insertWorkspace,
  insertWorkflow,
  insertWorkflowTrigger,
} from "../test-utils/integration/fixtures.js";
import {
  acceptTriggerEvent,
  enqueueOccurrence,
  deliverOccurrence,
  drainTriggerDeliveries,
  DeliveryPendingError,
  fireTriggerDurably,
} from "./trigger-delivery.js";
import { advanceScheduleCas } from "./trigger-service.js";
import * as workflows from "./workflow-service.js";
import { triggerDeliveryRoutes } from "../routes/trigger-deliveries.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

async function fixture() {
  const ws = await insertWorkspace();
  const wf = await insertWorkflow({ workspaceId: ws.id });
  const trigger = await insertWorkflowTrigger(wf.id, {
    targetType: "job",
    type: "webhook",
    config: { webhookPath: randomUUID() },
  });
  return { ws, wf, trigger };
}
describe("durable trigger deliveries", () => {
  it("deduplicates concurrent receipts in Postgres and keeps unmatched events durable until processed", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        acceptTriggerEvent("slack", key, {
          eventId: key,
          channelId: "none",
          text: "unmatched",
          kind: "message",
        }),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    await drainTriggerDeliveries();
    const [row] = await db.select().from(triggerEvents).where(eq(triggerEvents.deliveryKey, key));
    expect(row.state).toBe("dispatched");
  });
  it("reuses a run after crashing between target creation and recording dispatch success", async () => {
    const { trigger, wf } = await fixture();
    const delivery = await enqueueOccurrence(trigger, { source: "webhook" }, randomUUID());
    const original = workflows.createWorkflowRun;
    const failure = vi
      .spyOn(workflows, "createWorkflowRun")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw Error("process lost after insert");
      });
    await expect(deliverOccurrence(delivery.id)).rejects.toThrow("process lost");
    failure.mockRestore();
    const [pending] = await db
      .select()
      .from(triggerOccurrences)
      .where(eq(triggerOccurrences.id, delivery.id));
    expect(pending.state).toBe("pending");
    expect(pending.attempts).toBe(1);
    await db
      .update(triggerOccurrences)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(triggerOccurrences.id, delivery.id));
    await Promise.all([deliverOccurrence(delivery.id), deliverOccurrence(delivery.id)]);
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(delivery.id);
    const [done] = await db
      .select()
      .from(triggerOccurrences)
      .where(eq(triggerOccurrences.id, delivery.id));
    expect(done).toMatchObject({
      state: "started",
      attempts: 2,
      result: { kind: "workflow_run", id: delivery.id },
    });
  });
  it("advances the schedule and saves its occurrence in the same transaction", async () => {
    const { trigger } = await fixture();
    const seen = new Date(Date.now() - 60000);
    await db
      .update(workflowTriggers)
      .set({ nextFireAt: seen })
      .where(eq(workflowTriggers.id, trigger.id));
    await expect(
      db.transaction(async (tx) => {
        expect(await advanceScheduleCas(trigger.id, "0 0 * * *", seen, tx)).toBe(true);
        await enqueueOccurrence(trigger, { source: "schedule" }, "rollback", tx);
        throw Error("crash");
      }),
    ).rejects.toThrow("crash");
    const [after] = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.id, trigger.id));
    expect(after.nextFireAt?.getTime()).toBe(seen.getTime());
    expect(
      await db
        .select()
        .from(triggerOccurrences)
        .where(eq(triggerOccurrences.occurrenceKey, "rollback")),
    ).toHaveLength(0);
  });
  it("skips disabled triggers and accepts a transient dispatch failure for retry", async () => {
    const { trigger } = await fixture();
    const row = await enqueueOccurrence(trigger, { source: "webhook" });
    await db
      .update(workflowTriggers)
      .set({ enabled: false })
      .where(eq(workflowTriggers.id, trigger.id));
    expect(await deliverOccurrence(row.id)).toBeNull();
    const [skipped] = await db
      .select()
      .from(triggerOccurrences)
      .where(eq(triggerOccurrences.id, row.id));
    expect(skipped.state).toBe("skipped");
    await db
      .update(workflowTriggers)
      .set({ enabled: true })
      .where(eq(workflowTriggers.id, trigger.id));
    const failure = vi
      .spyOn(workflows, "createWorkflowRun")
      .mockRejectedValueOnce(Error("temporary outage"));
    await expect(fireTriggerDurably(trigger, { source: "webhook" })).rejects.toBeInstanceOf(
      DeliveryPendingError,
    );
    failure.mockRestore();
  });
  it("preserves historical names and cannot replay work that changed ownership", async () => {
    const { trigger, wf, ws } = await fixture();
    const occurrence = await enqueueOccurrence(trigger, { source: "webhook" });
    const [owner] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: randomUUID(),
        email: "owner@test.invalid",
        displayName: "Owner",
      })
      .returning();
    await db
      .update(workDefinitions)
      .set({ ownerUserId: owner.id, name: "Private new name" })
      .where(eq(workDefinitions.id, wf.id));
    expect(await deliverOccurrence(occurrence.id)).toBeNull();
    await db
      .update(triggerOccurrences)
      .set({ state: "failed" })
      .where(eq(triggerOccurrences.id, occurrence.id));
    const app = await buildRouteTestApp(triggerDeliveryRoutes, {
      user: { id: randomUUID(), workspaceId: ws.id, workspaceRole: "member" },
    });
    const history = await app.inject({ url: "/api/trigger-deliveries" });
    expect(history.statusCode).toBe(200);
    expect(history.json().rows[0].name).toBe(wf.name);
    expect(history.body).not.toContain("Private new name");
    expect(
      (await app.inject({ method: "POST", url: `/api/trigger-deliveries/${occurrence.id}/retry` }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });
  it("recovers an existing Local terminal without resetting or spawning it again", async () => {
    const ws = await insertWorkspace();
    const [host] = await db
      .insert(localHosts)
      .values({ workspaceId: ws.id, name: "Offline", hostname: "test", platform: "darwin" })
      .returning();
    const [terminal] = await db
      .insert(localTerminals)
      .values({
        workspaceId: ws.id,
        hostId: host.id,
        dir: "/tmp",
        title: "Already running",
        spec: { kind: "shell" },
        state: "running",
      })
      .returning();
    const { createTerminal } = await import("./local-terminal-service.js");
    const recovered = await createTerminal({
      id: terminal.id,
      host,
      userId: null,
      workspaceId: ws.id,
      dir: "/tmp",
      spec: { kind: "shell" },
    });
    expect(recovered.state).toBe("running");
    expect(recovered.id).toBe(terminal.id);
    const [stored] = await db
      .select()
      .from(localTerminals)
      .where(eq(localTerminals.id, terminal.id));
    expect(stored.state).toBe("running");
  });
  it("scopes history and retry to the workspace, and paginates equal receipt timestamps", async () => {
    const { trigger, ws } = await fixture();
    const other = await fixture();
    await enqueueOccurrence(other.trigger, { source: "webhook" });
    for (let i = 0; i < 51; i++) await enqueueOccurrence(trigger, { source: "webhook" });
    await db.execute(
      sql`UPDATE trigger_occurrences SET received_at='2026-10-01T00:00:00Z',state='failed' WHERE workspace_id=${ws.id}::uuid`,
    );
    const app = await buildRouteTestApp(triggerDeliveryRoutes, {
      user: { id: randomUUID(), workspaceId: ws.id, workspaceRole: "admin" },
    });
    const first = await app.inject({ url: "/api/trigger-deliveries" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().rows).toHaveLength(50);
    const second = await app.inject({
      url: `/api/trigger-deliveries?before=${encodeURIComponent(first.json().next)}`,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().rows).toHaveLength(1);
    expect(first.json().rows.map((r: { id: string }) => r.id)).not.toContain(
      second.json().rows[0].id,
    );
    expect(JSON.stringify(first.json())).not.toContain("firing");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/trigger-deliveries/${second.json().rows[0].id}/retry`,
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });
});
