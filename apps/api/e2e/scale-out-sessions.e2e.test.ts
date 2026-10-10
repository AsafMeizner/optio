/**
 * E2E: two real API servers on one database and one Redis (phase C2 of
 * docs/plans/scale-out.md). A pod session's chat turn runs on the server
 * that received the prompt; a viewer connected to the other server sees its
 * frames live; an interrupt sent to the other server stops it; a share
 * revoked and a session ended through the other server close the sockets
 * here; and a marketplace skill synced by whichever server took the job is
 * injected into a run started through the other.
 *
 * Auth is on (PATs), as collaboration needs real users. The fake runtime
 * plays the chat turns (`claude -p '<prompt>'`) and the Job run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import { waitFor } from "../src/test-utils/e2e/api-server.js";

const run = promisify(execFile);
let cluster: ApiCluster;
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const workspace = randomUUID();
const tokens: string[] = [];
const sockets: WebSocket[] = [];
let skillSource: string;

beforeAll(async () => {
  await sql`INSERT INTO workspaces (id, name, slug) VALUES (${workspace}, 'Scale-out', ${workspace})`;
  for (let i = 0; i < 2; i++) {
    const user = randomUUID(),
      token = `optio_pat_${randomBytes(32).toString("hex")}`;
    tokens.push(token);
    await sql`INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
      VALUES (${user}, 'github', ${user}, ${`${user}@example.com`}, 'Person', ${workspace})`;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspace}, ${user}, 'member')`;
    await sql`INSERT INTO api_keys (user_id, name, prefix, hashed_key) VALUES (${user}, 'test', ${token.slice(0, 12)}, ${createHash("sha256").update(token).digest("hex")})`;
  }
  skillSource = await fs.mkdtemp(path.join(tmpdir(), "optio-e2e-skill-"));
  await fs.mkdir(path.join(skillSource, "skills", "greet"), { recursive: true });
  await fs.writeFile(
    path.join(skillSource, "skills", "greet", "SKILL.md"),
    "---\nname: greet\n---\n\nSay hi to everyone.\n",
  );
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  await run("git", ["init", "-q", "-b", "main"], { cwd: skillSource, env });
  await run("git", ["add", "."], { cwd: skillSource, env });
  await run("git", ["commit", "-q", "-m", "greet"], { cwd: skillSource, env });
  cluster = await startApiCluster({ size: 2, env: { OPTIO_AUTH_DISABLED: "false" } });
}, 240_000);

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await cluster?.stop();
  await sql.end();
  await fs.rm(skillSource, { recursive: true, force: true });
});

async function call(server: number, who: number, p: string, method = "GET", body?: unknown) {
  return cluster.client(server)<any>(p, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function peer(server: number, who: number, id: string) {
  const frames: Record<string, any>[] = [];
  const base = cluster.servers[server].handle.baseUrl.replace(/^http/, "ws");
  const ws = new WebSocket(`${base}/ws/sessions/${id}/chat`, [
    "optio-ws-v1",
    `optio-auth-${tokens[who]}`,
  ]);
  sockets.push(ws);
  ws.onmessage = (event) => {
    if (typeof event.data === "string") frames.push(JSON.parse(event.data));
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });
  return {
    ws,
    frames,
    closed,
    ready: () =>
      waitFor(async () => frames.find((f) => f.type === "history_done"), { timeoutMs: 15_000 }),
    /** Frames after the replay boundary (live ones). */
    live: () => {
      const i = frames.findIndex((f) => f.type === "history_done");
      return i < 0 ? [] : frames.slice(i + 1);
    },
  };
}

async function turnState(sessionId: string, requestId: string) {
  const [turn] =
    await sql`SELECT state, finished_at FROM session_chat_turns WHERE session_id = ${sessionId} AND request_id = ${requestId}`;
  return turn as { state: string; finished_at: Date | null } | undefined;
}

describe("sessions across two API servers", () => {
  let sessionId: string;

  it("a viewer on server B sees, live, the frames of a turn running on server A", async () => {
    const created = await call(0, 0, "/api/sessions", "POST", {
      repoUrl: "https://github.com/test/scale-out-session",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    sessionId = created.body.session.id;
    expect((await call(1, 0, `/api/sessions/${sessionId}`)).status).toBe(200);

    const onA = peer(0, 0, sessionId);
    const onB = peer(1, 0, sessionId);
    await Promise.all([onA.ready(), onB.ready()]);

    const requestId = randomUUID();
    onA.ws.send(JSON.stringify({ type: "message", content: "Describe this workspace", requestId }));
    await waitFor(
      async () => onB.live().find((f) => f.type === "user_message" && f.requestId === requestId),
      { label: "B sees the prompt A received" },
    );
    await waitFor(async () => (await turnState(sessionId, requestId))?.state === "completed", {
      label: "the turn completes on A",
    });
    await waitFor(async () => onB.live().find((f) => f.type === "status" && f.status === "idle"), {
      label: "B sees the turn end",
    });
    const typesOnB = onB.live().map((f) => f.type);
    expect(typesOnB).toContain("chat_event");
    expect(onB.live().every((f) => f.catchUp === undefined)).toBe(true);
    expect(typesOnB.indexOf("user_message")).toBeLessThan(typesOnB.lastIndexOf("status"));
    // The same frames reached the socket on A, in the same order.
    expect(onA.live().map((f) => f.type)).toEqual(typesOnB);
    onA.ws.close();
    onB.ws.close();
  }, 90_000);

  it("an interrupt sent to server B stops the turn running on server A", async () => {
    const onA = peer(0, 0, sessionId);
    const onB = peer(1, 0, sessionId);
    await Promise.all([onA.ready(), onB.ready()]);
    const requestId = randomUUID();
    onA.ws.send(
      JSON.stringify({ type: "message", content: "Keep going [[mock:hang]]", requestId }),
    );
    await waitFor(
      async () => onB.live().find((f) => f.type === "status" && f.status === "thinking"),
      { label: "B sees the turn start" },
    );
    expect((await turnState(sessionId, requestId))?.state).toBe("running");

    onB.ws.send(JSON.stringify({ type: "interrupt" }));
    await waitFor(async () => (await turnState(sessionId, requestId))?.state === "interrupted", {
      timeoutMs: 15_000,
      label: "the turn on A is interrupted",
    });
    await waitFor(
      async () =>
        onA
          .live()
          .find((f) => f.type === "status" && f.status === "idle" && f.recovery === "resumable"),
      { label: "A reports the interrupted turn" },
    );
    await waitFor(
      async () =>
        onB
          .live()
          .find((f) => f.type === "status" && f.status === "idle" && f.recovery === "resumable"),
      { label: "B reports the interrupted turn" },
    );
    onA.ws.close();
    onB.ws.close();
  }, 90_000);

  it("a share revoked through server B closes the collaborator connected to server A", async () => {
    const share = await call(0, 0, `/api/session-shares/pod/${sessionId}`, "POST", {});
    expect(share.status, JSON.stringify(share.body)).toBe(201);
    const token = share.body.path.split("#")[1];
    expect((await call(1, 1, "/api/session-shares/redeem", "POST", { token })).status).toBe(200);

    const colleagueOnA = peer(0, 1, sessionId);
    await colleagueOnA.ready();
    const revoked = await call(
      1,
      0,
      `/api/session-shares/pod/${sessionId}/${share.body.id}`,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    const started = Date.now();
    const close = await colleagueOnA.closed;
    expect(close.code).toBe(4403);
    expect(close.reason).toMatch(/revoked/);
    // Through the bus, not the 10 s access recheck.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 60_000);

  it("a session ended through server B closes the owner's socket on server A and stops its turn", async () => {
    const onA = peer(0, 0, sessionId);
    await onA.ready();
    const requestId = randomUUID();
    onA.ws.send(JSON.stringify({ type: "message", content: "Wait [[mock:hang]]", requestId }));
    await waitFor(async () => (await turnState(sessionId, requestId))?.state === "running", {
      label: "a turn is running on A",
    });

    const started = Date.now();
    expect((await call(1, 0, `/api/sessions/${sessionId}/end`, "POST")).status).toBe(200);
    const close = await onA.closed;
    expect(close.code).toBe(4403);
    expect(close.reason).toMatch(/ended/);
    expect(Date.now() - started).toBeLessThan(5_000);
    await waitFor(async () => (await turnState(sessionId, requestId))?.state === "interrupted", {
      timeoutMs: 15_000,
      label: "the running turn on A is interrupted by the end",
    });
  }, 60_000);
});

describe("marketplace skills across two API servers", () => {
  it("a skill synced by whichever server took the job is injected into a run started through the other", async () => {
    const created = await call(0, 0, "/api/installed-skills", "POST", {
      name: "greet",
      sourceUrl: `file://${skillSource}`,
      ref: "main",
      subpath: "skills/greet",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const skillId = created.body.skill.id;
    await waitFor(
      async () => {
        const { body } = await call(1, 0, `/api/installed-skills/${skillId}`);
        return body.skill?.resolvedSha ? body.skill : null;
      },
      { timeoutMs: 60_000, label: "the skill syncs" },
    );
    const [{ n }] =
      await sql`SELECT count(*)::int AS n FROM installed_skill_files WHERE skill_id = ${skillId}`;
    expect(n).toBe(1);

    const job = await call(1, 0, "/api/jobs", "POST", {
      name: "e2e skill job",
      promptTemplate: "Greet [[mock:file:.claude/skills/greet/SKILL.md]]",
      agentRuntime: "claude-code",
    });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const started = await call(1, 0, `/api/jobs/${job.body.workflow.id}/runs`, "POST", {});
    expect(started.status).toBe(201);
    const runId = started.body.run.id;
    const settled = await waitFor(
      async () => {
        const { body } = await call(0, 0, `/api/workflow-runs/${runId}`);
        return ["completed", "failed"].includes(body.run.state) ? body.run : null;
      },
      { timeoutMs: 90_000, label: "the skill run settles" },
    );
    expect(settled.state).toBe("completed");
    const { body: logs } = await call(0, 0, `/api/workflow-runs/${runId}/logs`);
    const line = (logs.logs as Array<{ content: string }>)
      .map((l) => l.content)
      .find((l) => l.startsWith("file .claude/skills/greet/SKILL.md="));
    expect(line, "the skill file reached the run").toBeDefined();
    expect(JSON.parse(line!.slice("file .claude/skills/greet/SKILL.md=".length))).toContain(
      "Say hi to everyone.",
    );
  }, 180_000);
});
