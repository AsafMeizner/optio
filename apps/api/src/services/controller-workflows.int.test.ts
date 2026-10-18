import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db } from "../db/client.js";
import {
  users,
  workDefinitions,
  persistentAgents,
  prReviews,
  localHosts,
  mcpServers,
  sessionToolApprovals,
} from "../db/schema.js";
import {
  insertWorkspace,
  insertWorkflow,
  insertWorkflowRun,
  insertTask,
  insertRepo,
} from "../test-utils/integration/fixtures.js";
import type { ControllerPrincipal } from "./controller-auth.js";
import * as library from "./controller-library.js";
import * as triggers from "./controller-triggers.js";
import * as controls from "./controller-controls.js";
import * as reviews from "./controller-reviews.js";
import * as work from "./controller-service.js";
import { createControllerMcp } from "./controller-mcp.js";
import { createTrigger, getTrigger } from "./trigger-service.js";
import { createSession } from "./interactive-session-service.js";
import { claimSessionTurn, finishSessionTurn } from "./session-turn-service.js";
import { decideSessionApproval } from "./session-tool-approval.js";

vi.mock("./reconcile-queue.js", () => ({ enqueueReconcile: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: vi.fn(), getJobs: vi.fn().mockResolvedValue([]) },
}));
async function setup() {
  const workspaceId = (await insertWorkspace()).id;
  const [owner, other] = await db
    .insert(users)
    .values(
      ["Owner", "Other"].map((displayName) => ({
        provider: "github",
        externalId: randomUUID(),
        email: `${randomUUID()}@test.invalid`,
        displayName,
      })),
    )
    .returning();
  const p: ControllerPrincipal = {
    actor: { workspaceId, userId: owner.id, isAdmin: false },
    access: "manage",
    name: "Operator",
  };
  return { p, other };
}
async function clientFor(p: ControllerPrincipal, authorize?: () => Promise<boolean>) {
  const server = createControllerMcp(p, authorize);
  const client = new Client({ name: "workflow-tests", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
const page = { limit: 10, offset: 0 };

describe("Controller workflow and library parity", () => {
  it("creates, renders and edits prompts with exact tenant and private-owner boundaries", async () => {
    const { p, other } = await setup();
    const { template } = await library.createControllerPrompt(p, {
      name: "Daily summary",
      template: "Hello {{name}}{{#if urgent}}!{{/if}}",
    });
    expect(template.ownerUserId).toBe(p.actor.userId);
    expect((await library.listControllerPrompts(p, page)).prompts.map((t) => t.id)).toContain(
      template.id,
    );
    expect(
      await library.previewControllerPrompt(p, template.id, { name: "Optio", urgent: true }),
    ).toEqual({ rendered: "Hello Optio!" });
    await library.updateControllerPrompt(p, template.id, { description: "Daily", kind: "job" });
    expect(await library.getControllerPrompt(p, template.id)).toMatchObject({
      description: "Daily",
      kind: "job",
    });
    for (const actor of [
      { ...p.actor, workspaceId: null },
      { ...p.actor, userId: other.id },
    ]) {
      await expect(library.getControllerPrompt({ ...p, actor }, template.id)).rejects.toMatchObject(
        { status: 404 },
      );
    }
    await expect(
      library.updateControllerPrompt(
        { ...p, actor: { ...p.actor, userId: other.id, isAdmin: true } },
        template.id,
        { name: "Stolen" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      library.deleteControllerPrompt({ ...p, access: "read" }, template.id),
    ).rejects.toMatchObject({ status: 403 });
    expect(await library.deleteControllerPrompt(p, template.id)).toMatchObject({ deleted: true });
  });

  it("uses the MCP schemas for prompt CRUD and omits writes for read-only callers", async () => {
    const { p } = await setup();
    const { client, close } = await clientFor(p);
    try {
      const created = await client.callTool({
        name: "optio_create_prompt",
        arguments: { name: "Reusable", template: "Review {{repo}}" },
      });
      expect(created.isError).not.toBe(true);
      const data = JSON.parse((created.content as { text: string }[])[0].text);
      expect(data.template.ownerUserId).toBe(p.actor.userId);
      const preview = await client.callTool({
        name: "optio_preview_prompt",
        arguments: { id: data.template.id, params: { repo: "optio" } },
      });
      expect(JSON.parse((preview.content as { text: string }[])[0].text)).toEqual({
        rendered: "Review optio",
      });
    } finally {
      await close();
    }
    const read = await clientFor({ ...p, access: "read" });
    try {
      const names = (await read.client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("optio_preview_prompt");
      for (const name of [
        "control_run",
        "create_trigger",
        "delete_work",
        "create_prompt",
        "control_review",
        "control_agent",
      ])
        expect(names).not.toContain(`optio_${name}`);
    } finally {
      await read.close();
    }
  });

  it("edits event triggers through the shared validation, preserves secrets, and binds trigger IDs to work", async () => {
    const { p } = await setup();
    const job = await insertWorkflow({
      workspaceId: p.actor.workspaceId,
      ownerUserId: p.actor.userId,
    });
    const other = await insertWorkflow({ workspaceId: p.actor.workspaceId });
    const { trigger } = await triggers.createControllerTrigger(p, job.id, {
      type: "github",
      config: { events: ["push"], repos: ["acme/app"], branches: ["main"] },
    });
    await triggers.updateControllerTrigger(p, job.id, trigger.id, {
      enabled: false,
      paramMapping: { title: "$.head_commit.message" },
    });
    expect(await getTrigger(trigger.id)).toMatchObject({
      enabled: false,
      paramMapping: { title: "$.head_commit.message" },
    });
    await expect(triggers.deleteControllerTrigger(p, other.id, trigger.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      triggers.createControllerTrigger(p, job.id, {
        type: "github",
        config: { events: ["invalid"] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const webhook = await createTrigger({
      targetType: "job",
      targetId: job.id,
      type: "webhook",
      config: { path: randomUUID(), secret: "must-not-leak" },
    });
    const updated = await triggers.updateControllerTrigger(p, job.id, webhook.id, {
      config: { path: randomUUID() },
    });
    expect(JSON.stringify(updated)).not.toContain("must-not-leak");
    expect(updated.trigger?.config).toMatchObject({ hasSecret: true });
    expect((await getTrigger(webhook.id))?.config).toMatchObject({ secret: "must-not-leak" });
    await expect(
      triggers.updateControllerTrigger(p, job.id, webhook.id, {
        config: { path: "x", secret: "new" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      triggers.createControllerTrigger(p, job.id, { type: "pylon", config: {} }),
    ).rejects.toMatchObject({ status: 400 });
    await triggers.deleteControllerTrigger(p, job.id, trigger.id);
    expect(await getTrigger(trigger.id)).toBeNull();
  });

  it("supports Local definitions for their interactive owner without granting machines to background agents", async () => {
    const { p, other } = await setup();
    const interactive = {
      ...p,
      run: { kind: "session-turn" as const, id: randomUUID(), sessionId: randomUUID() },
    };
    const [host] = await db
      .insert(localHosts)
      .values({
        workspaceId: p.actor.workspaceId,
        userId: p.actor.userId,
        name: "Laptop",
        hostname: randomUUID(),
        platform: "darwin",
        dirs: [{ path: "/tmp" }],
      })
      .returning();
    const spec = {
      name: "Local scheduled",
      when: { type: "schedule" as const, config: { cronExpression: "0 9 * * *", timezone: "UTC" } },
      where: { runTarget: "local" as const, localHostId: host.id, localDir: "/tmp" },
      who: { runtime: "codex" },
      what: { prompt: "Read logs" },
      then: "waits-for-me" as const,
    };
    const created = await work.createControllerWork(interactive, spec);
    expect(
      (await work.listControllerWork(interactive, { ...page, kind: "definition" })).rows.map(
        (r) => r.id,
      ),
    ).toContain(created.id);
    await expect(work.getControllerWork(p, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      work.getControllerWork(
        { ...interactive, actor: { ...p.actor, userId: other.id, isAdmin: true } },
        created.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await work.updateControllerWork(interactive, created.id, { ...spec, name: "Updated Local" });
    await work.setControllerWorkEnabled(interactive, created.id, false);
    await expect(work.runControllerWork(interactive, created.id)).rejects.toMatchObject({
      status: 409,
    });
    const detail = work.describeWork(await work.getControllerWork(interactive, created.id));
    expect(detail).toMatchObject({
      name: "Updated Local",
      enabled: false,
      hostId: host.id,
      dir: "/tmp",
    });
    await controls.deleteControllerWork(interactive, created.id);
    expect(
      await db.select().from(workDefinitions).where(eq(workDefinitions.id, created.id)),
    ).toHaveLength(0);
  });

  it("cancels and retries Job runs using the same state transitions and cancellation budget as the UI", async () => {
    const { p, other } = await setup();
    const job = await insertWorkflow({
      workspaceId: p.actor.workspaceId,
      ownerUserId: p.actor.userId,
      maxRetries: 3,
    });
    const run = await insertWorkflowRun(job.id, { state: "running" });
    await expect(
      controls.controlControllerRun(
        { ...p, actor: { ...p.actor, userId: other.id, isAdmin: true } },
        run.id,
        "cancel",
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await controls.controlControllerRun(p, run.id, "cancel")).toMatchObject({
      state: "failed",
    });
    const { getWorkflowRun } = await import("./workflow-service.js");
    expect(await getWorkflowRun(run.id)).toMatchObject({
      retryCount: 3,
      errorMessage: "Cancelled by user",
    });
    expect(await controls.controlControllerRun(p, run.id, "retry")).toMatchObject({
      state: "queued",
    });
    await expect(controls.controlControllerRun(p, run.id, "resume")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("resumes tasks on the existing agent session and refuses unrelated tenants and self-control", async () => {
    const { p } = await setup();
    const task = await insertTask({
      workspaceId: p.actor.workspaceId,
      ownerUserId: p.actor.userId,
      state: "failed",
      sessionId: "session-to-resume",
    });
    const { taskQueue } = await import("../workers/task-worker.js");
    await expect(
      controls.controlControllerRun(
        { ...p, actor: { ...p.actor, workspaceId: null } },
        task.id,
        "resume",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await controls.controlControllerRun(p, task.id, "resume", "Fix the tests"),
    ).toMatchObject({ state: "queued" });
    expect(taskQueue.add).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: task.id,
        resumeSessionId: "session-to-resume",
        resumePrompt: "Fix the tests",
      }),
      expect.any(Object),
    );
    await expect(
      controls.controlControllerRun(
        { ...p, run: { kind: "work-run", id: task.id } },
        task.id,
        "cancel",
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("sets agent controls and edits review drafts without reaching outside the workspace", async () => {
    const { p } = await setup();
    const [agent] = await db
      .insert(persistentAgents)
      .values({
        workspaceId: p.actor.workspaceId,
        ownerUserId: p.actor.userId,
        slug: randomUUID(),
        name: "Helper",
        initialPrompt: "Ready",
        agentRuntime: "codex",
      })
      .returning();
    await controls.controlControllerAgent(p, agent.id, "pause");
    expect(
      (await db.select().from(persistentAgents).where(eq(persistentAgents.id, agent.id)))[0]
        .controlIntent,
    ).toBe("pause");
    const [review] = await db
      .insert(prReviews)
      .values({
        workspaceId: p.actor.workspaceId,
        prUrl: `https://github.com/acme/app/pull/${Date.now()}`,
        repoUrl: "https://github.com/acme/app",
        repoOwner: "acme",
        repoName: "app",
        prNumber: 1,
        headSha: "abc",
        state: "ready",
      })
      .returning();
    await reviews.updateControllerReview(p, review.id, {
      verdict: "comment",
      summary: "Looks good",
    });
    expect((await db.select().from(prReviews).where(eq(prReviews.id, review.id)))[0]).toMatchObject(
      { summary: "Looks good", userEngaged: true },
    );
    await expect(
      reviews.controlControllerReview(
        { ...p, actor: { ...p.actor, workspaceId: null } },
        review.id,
        "submit",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await reviews.controlControllerReview(p, review.id, "cancel");
    expect(
      (await db.select().from(prReviews).where(eq(prReviews.id, review.id)))[0].controlIntent,
    ).toBe("cancel");
    await expect(
      reviews.createControllerReview(p, "https://github.com/not-configured/repo/pull/1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns selectable environment references without raw MCP command arguments", async () => {
    const { p } = await setup();
    await db.insert(mcpServers).values({
      workspaceId: p.actor.workspaceId,
      name: "Private args",
      scope: "global",
      command: "node",
      args: ["--token=never-serialize-this"],
      enabled: true,
    });
    const result = await library.controllerEnvironment(p, undefined, "codex");
    expect(result.mcpServers.map((s) => s.name)).toContain("Private args");
    expect(JSON.stringify(result)).not.toContain("never-serialize-this");
    await expect(library.controllerEnvironment(p, randomUUID(), "codex")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("uses exactly one approval card and rechecks authorization before a library write", async () => {
    const { p } = await setup();
    const session = await createSession({
      agentRuntime: "codex",
      workspaceId: p.actor.workspaceId,
      userId: p.actor.userId!,
    });
    const claim = await claimSessionTurn(session.id, randomUUID(), "Save a prompt");
    if (!claim.accepted) throw new Error("claim failed");
    const operator: ControllerPrincipal = {
      ...p,
      run: { kind: "session-turn", id: claim.turn.id, sessionId: session.id },
      sessionPolicy: { confirmWrites: true, enabledTools: [] },
    };
    const { client, close } = await clientFor(operator, async () => false);
    try {
      const pending = client.callTool({
        name: "optio_create_prompt",
        arguments: { name: "Must not be created", template: "No" },
      });
      await vi.waitFor(async () =>
        expect(
          await db
            .select()
            .from(sessionToolApprovals)
            .where(eq(sessionToolApprovals.sessionId, session.id)),
        ).toHaveLength(1),
      );
      const [approval] = await db
        .select()
        .from(sessionToolApprovals)
        .where(eq(sessionToolApprovals.sessionId, session.id));
      await decideSessionApproval(session.id, approval.id, true);
      expect((await pending).isError).toBe(true);
      expect((await library.listControllerPrompts(p, page)).prompts).toHaveLength(0);
    } finally {
      await close();
      await finishSessionTurn(claim.turn.id, true);
    }
  });
});

describe("Controller collaboration and review boundaries", () => {
  it("binds comment edits to their task and author", async () => {
    const { p, other } = await setup();
    const task = await insertTask({ workspaceId: p.actor.workspaceId });
    const second = await insertTask({ workspaceId: p.actor.workspaceId });
    const { writeControllerComment, controllerActivity } = await import("./controller-comments.js");
    const created = await writeControllerComment(p, task.id, "add", "Investigated the failure");
    const commentId = "comment" in created ? created.comment!.id : "";
    expect((await controllerActivity(p, task.id, "comments", 10, 0)).entries).toHaveLength(1);
    await expect(
      writeControllerComment(p, second.id, "edit", "Wrong task", commentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      writeControllerComment(
        { ...p, actor: { ...p.actor, userId: other.id, isAdmin: true } },
        task.id,
        "delete",
        undefined,
        commentId,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await writeControllerComment(p, task.id, "edit", "Updated findings", commentId);
    expect((await controllerActivity(p, task.id, "comments", 10, 0)).entries[0]).toMatchObject({
      content: "Updated findings",
    });
    await writeControllerComment(p, task.id, "delete", undefined, commentId);
    expect((await controllerActivity(p, task.id, "comments", 10, 0)).entries).toHaveLength(0);
  });
  it("pins review launches to the expected tenant before calling the git provider", async () => {
    const { p } = await setup();
    const repo = await insertRepo({
      workspaceId: p.actor.workspaceId,
      repoUrl: "https://github.com/acme/scope-test",
    });
    const { launchPrReview, ReviewScopeError } = await import("./pr-review-service.js");
    await expect(
      launchPrReview({
        prUrl: `${repo.repoUrl}/pull/1`,
        workspaceId: p.actor.workspaceId!,
        expectedWorkspaceId: null,
      }),
    ).rejects.toBeInstanceOf(ReviewScopeError);
    const foreign = await insertTask({ workspaceId: null, prUrl: `${repo.repoUrl}/pull/2` });
    await expect(reviews.mergeControllerPr(p, foreign.id, "squash")).rejects.toMatchObject({
      status: 404,
    });
  });
  it("exposes the runtime option catalog without permitting refresh or Settings mutations", async () => {
    const { p } = await setup();
    const result = await library.controllerModels(p, "opencode");
    expect(result.provider).toBe("opencode");
    expect(result.catalog).toBeDefined();
    const { client, close } = await clientFor(p);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("optio_get_models");
      expect(names.some((n) => /credential|member|cluster|sign_in/.test(n))).toBe(false);
    } finally {
      await close();
    }
  });
});
