/**
 * /ws/events is one Redis channel fanned out to every signed-in user of the
 * deployment. It must not carry run output or message bodies, nor frames
 * about another workspace's runs, and its catch-up must stay in the caller's
 * workspace.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { taskEvents, users, workspaceMembers } from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { listenWsApp, WsTestClient } from "../test-utils/integration/ws-client.js";
import { eventsWs } from "./events.js";

const savedAuthDisabled = process.env.OPTIO_AUTH_DISABLED;
let app: FastifyInstance;
let wsBase: string;
let redis: Redis;
let token: string;
let mineTaskId: string;
let otherTaskId: string;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  const mine = await insertWorkspace();
  const other = await insertWorkspace();
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `events-it-${randomBytes(4).toString("hex")}`,
      email: "events@it",
      displayName: "Events IT",
      defaultWorkspaceId: mine.id,
    })
    .returning();
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: mine.id, userId: user.id, role: "member" });
  token = (await createApiKey(user.id, "events it")).token;

  mineTaskId = (await insertTask({ workspaceId: mine.id, title: "mine" })).id;
  otherTaskId = (await insertTask({ workspaceId: other.id, title: "other tenant secret" })).id;
  for (const taskId of [mineTaskId, otherTaskId]) {
    await db
      .insert(taskEvents)
      .values({ taskId, fromState: "queued", toState: "running", trigger: "it" });
  }

  ({ app, wsBase } = await listenWsApp([eventsWs]));
  redis = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  if (savedAuthDisabled === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuthDisabled;
});

describe("/ws/events", () => {
  it("catches up on the caller's workspace only", async () => {
    const client = new WsTestClient(`${wsBase}/ws/events`, { token });
    await client.opened;
    await client.next((f) => f.catchUp && f.taskId === mineTaskId);
    expect(client.frames.some((f) => f.taskId === otherTaskId)).toBe(false);
    await client.close();
  });

  it("forwards the workspace's state changes, never content frames or another workspace's", async () => {
    const client = new WsTestClient(`${wsBase}/ws/events`, { token });
    await client.opened;
    const publish = (event: Record<string, unknown>) =>
      redis.publish("optio:events", JSON.stringify(event));
    // Publish until the (asynchronous) subscription is live, then the rest in
    // order: the marker frame that follows them proves they were dropped.
    const ready = client.next((f) => f.type === "task:state_changed" && f.marker === "ready");
    const timer = setInterval(
      () => void publish({ type: "task:state_changed", taskId: mineTaskId, marker: "ready" }),
      50,
    );
    try {
      await ready;
    } finally {
      clearInterval(timer);
    }
    await publish({ type: "task:log", taskId: mineTaskId, content: "LOG-LINE" });
    await publish({ type: "task:message", taskId: mineTaskId, content: "MESSAGE-BODY" });
    await publish({ type: "workflow_run:log", workflowRunId: mineTaskId, content: "LOG-LINE" });
    await publish({ type: "task:created", taskId: otherTaskId, title: "other tenant secret" });
    await publish({ type: "task:state_changed", taskId: otherTaskId });
    await publish({ type: "task:created", taskId: mineTaskId, title: "mine" });
    await publish({ type: "auth:status_changed", timestamp: "now" });

    await client.next((f) => f.type === "auth:status_changed");
    const live = client.frames.filter((f) => !f.catchUp && f.marker !== "ready");
    expect(live.map((f) => f.type)).toEqual(["task:created", "auth:status_changed"]);
    expect(live[0]).toMatchObject({ taskId: mineTaskId });
    expect(JSON.stringify(client.frames)).not.toMatch(/LOG-LINE|MESSAGE-BODY|other tenant/);
    await client.close();
  });
});
