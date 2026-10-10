/**
 * Run attachment against a real Postgres (docs/plans/scale-out.md §2): two
 * API instances — two module graphs of run-attachment.ts, each with its own
 * INSTANCE_ID and connection pool — race for the same runs. Exactly one
 * claims an expired attachment, a live one is nobody else's, a log batch
 * from an instance that lost the run rolls back whole, and a run's exit and
 * spend are recorded once.
 */
import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import { taskLogs, tasks, workRuns } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";

type AttachmentModule = typeof import("./run-attachment.js");
type LogModule = typeof import("./run-log-service.js");

interface Instance {
  id: string;
  att: AttachmentModule;
  logs: LogModule;
}

/** A fresh module graph: what a second API process would be. */
async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const { INSTANCE_ID } = await import("./instance.js");
  return {
    id: INSTANCE_ID,
    att: await import("./run-attachment.js"),
    logs: await import("./run-log-service.js"),
  };
}

const ref = (id: string) => ({ kind: "work-run" as const, id });
const expired = () => new Date(Date.now() - 5_000);

async function startedRun(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  return insertTask({
    state: TaskState.RUNNING,
    execState: "started",
    execPid: 4242,
    attachedBy: "gone-instance:000000",
    attachLeaseUntil: expired(),
    ...overrides,
  });
}

async function row(id: string) {
  const [r] = await db.select().from(workRuns).where(eq(workRuns.id, id));
  return r;
}

describe("run attachment, two instances on one database", () => {
  it("racing the claim on an expired attachment, exactly one instance wins — every time", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    expect(a.id).not.toBe(b.id);

    for (let i = 0; i < 25; i++) {
      const run = await startedRun({ consumedBytes: 123 });
      const [ca, cb] = await Promise.all([
        a.att.claimAttachment(ref(run.id)),
        b.att.claimAttachment(ref(run.id)),
      ]);
      const winners = [ca, cb].filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual({ consumedBytes: 123, execState: "started" });
      const after = await row(run.id);
      expect(after.attachedBy).toBe(ca ? a.id : b.id);
      expect(after.attachLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("a live attachment is nobody else's: the other's claim and renew fail, the holder's renew holds", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const run = await startedRun();

    expect(await a.att.claimAttachment(ref(run.id))).not.toBeNull();
    expect(await b.att.claimAttachment(ref(run.id))).toBeNull();
    expect(await b.att.renewAttachment(ref(run.id))).toBe(false);
    expect(await a.att.renewAttachment(ref(run.id))).toBe(true);
    expect((await row(run.id)).attachedBy).toBe(a.id);

    // Given up at shutdown, it is claimable at once.
    await a.att.releaseAttachment(ref(run.id));
    expect(await b.att.claimAttachment(ref(run.id))).not.toBeNull();
    expect(await a.att.renewAttachment(ref(run.id))).toBe(false);
  });

  it("a run never started is not claimable; one with its exit recorded is (to finish settling)", async () => {
    const a = await bootInstance();
    const never = await startedRun({ execState: null });
    expect(await a.att.claimAttachment(ref(never.id))).toBeNull();

    const settling = await startedRun({ execState: "exited", consumedBytes: 77 });
    expect(await a.att.claimAttachment(ref(settling.id))).toEqual({
      consumedBytes: 77,
      execState: "exited",
    });
  });

  it("log rows and the offset commit together: the loser's batch rolls back whole", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const run = await startedRun();
    await a.att.claimAttachment(ref(run.id));

    const line = { content: "hello", logType: "text" };
    await expect(
      b.logs.appendRunLogsBatch(ref(run.id), [line, line], { from: 0, to: 12 }),
    ).rejects.toBeInstanceOf(b.logs.AttachmentLostError);
    const count = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(taskLogs)
          .where(eq(taskLogs.taskId, run.id))
      )[0].n;
    expect(await count()).toBe(0);
    expect((await row(run.id)).consumedBytes).toBe(0);

    const stored = await a.logs.appendRunLogsBatch(ref(run.id), [line, line], { from: 0, to: 12 });
    expect(stored).toHaveLength(2);
    expect(await count()).toBe(2);
    expect((await row(run.id)).consumedBytes).toBe(12);

    // A batch from a stale offset (a duplicate) is refused the same way.
    await expect(
      a.logs.appendRunLogsBatch(ref(run.id), [line], { from: 0, to: 6 }),
    ).rejects.toBeInstanceOf(a.logs.AttachmentLostError);
    expect(await count()).toBe(2);
  });

  it("a run's exit and its spend are recorded once, whichever instance finishes it", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const { addUsage } = await import("./run-usage.js");
    const run = await startedRun({ costUsd: "0.25" });
    await a.att.claimAttachment(ref(run.id));

    const spend = () => addUsage(workRuns, { costUsd: 0.5, inputTokens: 10 });
    expect(await b.att.settleRun(ref(run.id), spend())).toBe("taken");
    expect(await a.att.settleRun(ref(run.id), spend())).toBe("settled");
    expect(await a.att.settleRun(ref(run.id), spend())).toBe("already");
    const after = await row(run.id);
    expect(after.execState).toBe("exited");
    expect(after.costUsd).toBe("0.75");
    expect(after.inputTokens).toBe(10);

    // Its holder went away before settling the rest: the next one finishes
    // the run without adding the spend again.
    await db.update(workRuns).set({ attachLeaseUntil: expired() }).where(eq(workRuns.id, run.id));
    expect(await b.att.claimAttachment(ref(run.id))).toMatchObject({ execState: "exited" });
    expect(await b.att.settleRun(ref(run.id), spend())).toBe("already");
    expect((await row(run.id)).costUsd).toBe("0.75");

    await b.att.closeAttachment(ref(run.id));
    const closed = await row(run.id);
    expect(closed.attachedBy).toBeNull();
    expect(closed.attachLeaseUntil).toBeNull();
  });

  it("a new attempt starts with no execution: queuing a task again clears the last one's", async () => {
    const { transitionTask } = await import("./task-service.js");
    const run = await startedRun({
      state: TaskState.FAILED,
      execState: "exited",
      consumedBytes: 900,
      attachLeaseUntil: new Date(Date.now() + 30_000),
    });
    await transitionTask(run.id, TaskState.QUEUED, "user_retry");
    const [after] = await db
      .select()
      .from(workRuns)
      .where(and(eq(workRuns.id, run.id), eq(workRuns.state, TaskState.QUEUED)));
    expect(after).toMatchObject({
      execState: null,
      execPid: null,
      consumedBytes: 0,
      attachedBy: null,
      attachLeaseUntil: null,
    });
  });
});
