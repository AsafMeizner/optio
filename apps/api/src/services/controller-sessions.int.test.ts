import { ALL_CONTROLLER_TOOL_NAMES } from "@optio/shared";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db } from "../db/client.js";
import {
  users,
  interactiveSessions,
  localHosts,
  localTerminals,
  localTerminalTranscripts,
  sessionToolApprovals,
  agentPods,
  sessionChatTurns,
} from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { createSession, appendSessionChatEvent } from "./interactive-session-service.js";
import {
  claimSessionTurn,
  finishSessionTurn,
  queuedSessionMessages,
} from "./session-turn-service.js";
import {
  controlControllerSession,
  controllerSessionHistory,
  sendControllerSessionMessage,
} from "./controller-sessions.js";
import { listControllerSessions } from "./controller-service.js";
import { createControllerMcp } from "./controller-mcp.js";
import type { ControllerPrincipal } from "./controller-auth.js";
import { decideSessionApproval } from "./session-tool-approval.js";
import { sendToHost } from "./local-relay.js";

vi.hoisted(() => {
  process.env.OPTIO_RUNTIME = "fake";
  process.env.OPTIO_ALLOW_FAKE_RUNTIME = "1";
});
vi.mock("./local-relay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-relay.js")>()),
  sendToHost: vi.fn().mockResolvedValue(true),
}));
afterEach(() => vi.mocked(sendToHost).mockReset().mockResolvedValue(true));

async function setup() {
  const workspaceId = (await insertWorkspace()).id;
  const [user, other] = await db
    .insert(users)
    .values(
      ["owner", "other"].map((name) => ({
        provider: "github",
        externalId: randomUUID(),
        email: `${randomUUID()}@test.invalid`,
        displayName: name,
      })),
    )
    .returning();
  const caller = await createSession({
    title: "Optio",
    agentRuntime: "codex",
    workspaceId,
    userId: user.id,
  });
  const claim = await claimSessionTurn(caller.id, randomUUID(), "Continue existing work");
  if (!claim.accepted) throw new Error(claim.reason);
  const p: ControllerPrincipal = {
    actor: { userId: user.id, workspaceId, isAdmin: false },
    access: "manage",
    name: "Optio",
    run: { kind: "session-turn", sessionId: caller.id, id: claim.turn.id },
  };
  const target = await createSession({
    title: "Existing work",
    agentRuntime: "codex",
    workspaceId,
    userId: user.id,
  });
  return {
    p,
    target,
    other,
    caller,
    async close() {
      await finishSessionTurn(claim.turn.id, true);
    },
  };
}

async function local(p: ControllerPrincipal, kind = "agent") {
  const [host] = await db
    .insert(localHosts)
    .values({
      userId: p.actor.userId,
      workspaceId: p.actor.workspaceId,
      name: "Laptop",
      hostname: randomUUID(),
      platform: "darwin",
    })
    .returning();
  const [row] = await db
    .insert(localTerminals)
    .values({
      hostId: host.id,
      userId: p.actor.userId,
      workspaceId: p.actor.workspaceId,
      title: "Local conversation",
      dir: "/tmp",
      spec: { kind, agent: "codex" },
      state: "running",
    })
    .returning();
  return row;
}

describe("Controller interactive session tools", () => {
  it("queues into a busy harness conversation exactly once and discovers its input capability", async () => {
    const s = await setup();
    const active = await claimSessionTurn(s.target.id, randomUUID(), "Busy");
    if (!active.accepted) throw new Error(active.reason);
    try {
      const requestId = randomUUID();
      expect(
        await sendControllerSessionMessage(s.p, s.target.id, "Continue here", requestId),
      ).toMatchObject({ delivery: "queued", requestId });
      await sendControllerSessionMessage(s.p, s.target.id, "Continue here", requestId);
      expect(await queuedSessionMessages(s.target.id)).toEqual([
        { requestId, content: "Continue here" },
      ]);
      await expect(
        sendControllerSessionMessage(s.p, s.target.id, "Different", requestId),
      ).rejects.toMatchObject({ status: 409 });
      expect((await listControllerSessions(s.p, { id: s.target.id }))[0]).toMatchObject({
        canMessage: true,
        runTarget: "cluster",
        href: `/work/${s.target.id}`,
      });
    } finally {
      await finishSessionTurn(active.turn.id, true);
      await s.close();
    }
  });

  it("does not grant headless runs, read-only callers, other owners, other workspaces or self-input access", async () => {
    const s = await setup();
    try {
      const foreign = await createSession({
        agentRuntime: "codex",
        userId: s.other.id,
        workspaceId: s.p.actor.workspaceId,
      });
      const foreignLocal = await local({ ...s.p, actor: { ...s.p.actor, userId: s.other.id } });
      for (const id of [foreign.id, foreignLocal.id]) {
        await expect(
          controllerSessionHistory({ ...s.p, actor: { ...s.p.actor, isAdmin: true } }, id, 20),
        ).rejects.toMatchObject({ status: 404 });
        await expect(sendControllerSessionMessage(s.p, id, "hello")).rejects.toMatchObject({
          status: 404,
        });
      }
      await expect(
        controllerSessionHistory(
          { ...s.p, actor: { ...s.p.actor, workspaceId: null } },
          s.target.id,
          20,
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        controllerSessionHistory({ ...s.p, run: undefined }, s.target.id, 20),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        sendControllerSessionMessage({ ...s.p, access: "read" }, s.target.id, "hi"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(sendControllerSessionMessage(s.p, s.caller.id, "hi")).rejects.toMatchObject({
        status: 409,
      });
      expect(sendToHost).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it("reads bounded recent history from ended pod and Local conversations but does not restart them", async () => {
    const s = await setup();
    try {
      for (const content of ["old", "new", "x".repeat(3000)])
        await appendSessionChatEvent({ sessionId: s.target.id, content, logType: "text" });
      await db
        .update(interactiveSessions)
        .set({ state: "ended" })
        .where(eq(interactiveSessions.id, s.target.id));
      const page = await controllerSessionHistory(s.p, s.target.id, 2);
      expect(page.hasEarlier).toBe(true);
      expect(page.entries.map((e) => e.text.length)).toEqual([3, 2000]);
      await expect(sendControllerSessionMessage(s.p, s.target.id, "hi")).rejects.toMatchObject({
        status: 409,
      });
      const terminal = await local(s.p);
      await db.insert(localTerminalTranscripts).values(
        [1, 2, 3].map((seq) => ({
          terminalId: terminal.id,
          seq,
          role: "assistant",
          kind: "text",
          text: `reply ${seq}`,
        })),
      );
      expect(await controllerSessionHistory(s.p, terminal.id, 2)).toMatchObject({
        hasEarlier: true,
        entries: [{ text: "reply 2" }, { text: "reply 3" }],
      });
      await db
        .update(localTerminals)
        .set({ state: "exited" })
        .where(eq(localTerminals.id, terminal.id));
      await expect(sendControllerSessionMessage(s.p, terminal.id, "hi")).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      await s.close();
    }
  });

  it("uses the Local chat transport with separate text and Enter writes, rejecting offline and shell input", async () => {
    const s = await setup();
    try {
      const terminal = await local(s.p);
      expect(
        await sendControllerSessionMessage(s.p, terminal.id, "Continue the plan"),
      ).toMatchObject({ delivery: "sent" });
      expect(
        vi
          .mocked(sendToHost)
          .mock.calls.map(([, frame]) =>
            Buffer.from((frame as { dataB64: string }).dataB64, "base64").toString(),
          ),
      ).toEqual(["Continue the plan", "\r"]);
      vi.mocked(sendToHost).mockClear().mockResolvedValue(false);
      await expect(sendControllerSessionMessage(s.p, terminal.id, "next")).rejects.toMatchObject({
        status: 409,
        message: "Host is offline",
      });
      expect(sendToHost).toHaveBeenCalledTimes(1);
      const shell = await local(s.p, "shell");
      await expect(sendControllerSessionMessage(s.p, shell.id, "rm -rf .")).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        sendControllerSessionMessage(s.p, terminal.id, "\u001b[A"),
      ).rejects.toMatchObject({ status: 400 });
      expect(sendToHost).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it("runs legacy pod chat through its existing runner, preserving persisted conversation and receipts", async () => {
    const s = await setup();
    try {
      const [pod] = await db
        .insert(agentPods)
        .values({
          pool: "repo",
          poolKey: randomUUID(),
          podName: "chat-pod",
          podId: "chat-pod",
          state: "ready",
        })
        .returning();
      await db
        .update(interactiveSessions)
        .set({ agentRuntime: null, podId: pod.id })
        .where(eq(interactiveSessions.id, s.target.id));
      const requestId = randomUUID();
      expect(
        await sendControllerSessionMessage(
          s.p,
          s.target.id,
          "Reply briefly [[mock:cost:0.01]]",
          requestId,
        ),
      ).toMatchObject({ delivery: "started", requestId });
      await expect
        .poll(
          async () =>
            (
              await db
                .select()
                .from(sessionChatTurns)
                .where(eq(sessionChatTurns.sessionId, s.target.id))
            )[0]?.state,
        )
        .toBe("completed");
      const history = await controllerSessionHistory(s.p, s.target.id, 30);
      expect(history.entries.some((e) => e.text.includes("Reply briefly"))).toBe(true);
      expect(history.entries.some((e) => e.type === "text")).toBe(true);
      await expect(
        sendControllerSessionMessage(
          s.p,
          s.target.id,
          "Reply briefly [[mock:cost:0.01]]",
          requestId,
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await s.close();
    }
  });

  it("offers one approval card and sends nothing before it is approved", async () => {
    const s = await setup();
    const server = createControllerMcp({
      ...s.p,
      sessionPolicy: { confirmWrites: true, enabledTools: [] },
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
        ALL_CONTROLLER_TOOL_NAMES.map((n) => `optio_${n}`).sort(),
      );
      const result = client.callTool({
        name: "optio_send_session_message",
        arguments: { id: s.target.id, body: "Proceed with the fix" },
      });
      let approvalId = "";
      await expect
        .poll(async () => {
          const rows = await db
            .select()
            .from(sessionToolApprovals)
            .where(eq(sessionToolApprovals.turnId, s.p.run!.id));
          approvalId = rows[0]?.id;
          return rows.length;
        })
        .toBe(1);
      expect(await queuedSessionMessages(s.target.id)).toHaveLength(0);
      await decideSessionApproval(s.caller.id, approvalId, true);
      expect((await result).isError).not.toBe(true);
      expect(await queuedSessionMessages(s.target.id)).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      await s.close();
    }
  });
  it("exposes session reads but no writes to a read-only session, and no session tools to a headless caller", async () => {
    const s = await setup();
    try {
      for (const [p, expected] of [
        [{ ...s.p, access: "read" as const }, ["optio_get_session_history"]],
        [{ ...s.p, run: undefined }, []],
      ] as const) {
        const server = createControllerMcp(p);
        const client = new Client({ name: "test", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(a);
        await client.connect(b);
        try {
          const names = (await client.listTools()).tools.map((t) => t.name);
          expect(
            names.filter(
              (n) => n === "optio_get_session_history" || n === "optio_send_session_message",
            ),
          ).toEqual(expected);
        } finally {
          await client.close();
          await server.close();
        }
      }
    } finally {
      await s.close();
    }
  });
});

describe("Controller session pagination and controls", () => {
  it("pages older pod and Local history without repeating entries", async () => {
    const s = await setup();
    try {
      for (let i = 0; i < 5; i++)
        await appendSessionChatEvent({
          sessionId: s.target.id,
          stream: "stdout",
          logType: "text",
          content: `Message ${i}`,
        });
      const recent = await controllerSessionHistory(s.p, s.target.id, 2);
      expect(recent.entries.map((e) => e.text)).toEqual(["Message 3", "Message 4"]);
      const older = await controllerSessionHistory(s.p, s.target.id, 2, recent.nextBeforeSeq!);
      expect(older.entries.map((e) => e.text)).toEqual(["Message 1", "Message 2"]);
      const oldest = await controllerSessionHistory(s.p, s.target.id, 2, older.nextBeforeSeq!);
      expect(oldest.entries.map((e) => e.text)).toEqual(["Message 0"]);
      expect(oldest.nextBeforeSeq).toBeNull();
      const terminal = await local(s.p);
      await db.insert(localTerminalTranscripts).values(
        [1, 2, 3].map((seq) => ({
          terminalId: terminal.id,
          seq,
          role: "assistant",
          kind: "text",
          text: `Local ${seq}`,
        })),
      );
      const first = await controllerSessionHistory(s.p, terminal.id, 2);
      const last = await controllerSessionHistory(s.p, terminal.id, 2, first.nextBeforeSeq!);
      expect(last.entries.map((e) => e.text)).toEqual(["Local 1"]);
    } finally {
      await s.close();
    }
  });
  it("cancels queued pod input, interrupts active turns and ends only owned sessions", async () => {
    const s = await setup();
    try {
      const requestId = randomUUID();
      await sendControllerSessionMessage(s.p, s.target.id, "Queued", requestId);
      await controlControllerSession(s.p, s.target.id, "cancel_queued", requestId);
      expect(await queuedSessionMessages(s.target.id)).toEqual([]);
      await expect(
        controlControllerSession(s.p, s.target.id, "cancel_queued", requestId),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        controlControllerSession({ ...s.p, access: "read" }, s.target.id, "end"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(controlControllerSession(s.p, s.caller.id, "end")).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        controlControllerSession(
          { ...s.p, actor: { ...s.p.actor, userId: s.other.id, isAdmin: true } },
          s.target.id,
          "end",
        ),
      ).rejects.toMatchObject({ status: 404 });
      const turn = await claimSessionTurn(s.target.id, randomUUID(), "Working");
      if (!turn.accepted) throw new Error("claim failed");
      await controlControllerSession(s.p, s.target.id, "interrupt");
      expect(
        (await db.select().from(sessionChatTurns).where(eq(sessionChatTurns.id, turn.turn.id)))[0]
          .finishedAt,
      ).not.toBeNull();
      await controlControllerSession(s.p, s.target.id, "end");
      expect(
        (
          await db.select().from(interactiveSessions).where(eq(interactiveSessions.id, s.target.id))
        )[0].state,
      ).toBe("ended");
      await finishSessionTurn(turn.turn.id, false);
    } finally {
      await s.close();
    }
  });
});
