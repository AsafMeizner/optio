/**
 * E2E: agent runs outlive the API process that started them
 * (docs/plans/scale-out.md §1–2, Testing). Real API servers on one database,
 * one Redis and one fake-runtime directory (src/test-utils/e2e/api-cluster.ts):
 * fake agents are detached processes writing their run directory, so a run
 * goes on when its server is killed, and another server attaches to it.
 *
 * Every case checks the run's final state, that its log rows are exactly
 * the agent's lines — `tick 1`…`tick N` from `[[mock:ticks:N:MS]]`, each
 * once, no gap — and that its cost was added once.
 *
 *   1  one server, a Repo Task running, SIGKILL, a new server → completes
 *   2  the attached server killed → another attaches within 10 s
 *   3  three servers, ten runs across kinds, one killed → all complete, the
 *      global and per-repo limits never exceeded (the DB polled every 250 ms)
 *   4  cancel through a server that is not attached stops the agent
 *   5  a mid-run message through a server that is not attached reaches it
 *   9  SIGTERM to the attached server → another has the run in under 5 s
 *  10  the pod goes away mid-run → the run fails with the pod's reason
 *  11  a Job run and a persistent-agent turn through 1, 4 and 5
 *  12  a boot with runs in flight fails nothing
 *  13  a force-redo of a running task stops the old agent; only the new
 *      attempt's logs are kept, and it finishes once
 *  14  a review cancelled while its run is being set up: the run is
 *      cancelled, the agent stopped, nothing written to the review
 *  15  a Job edited mid-run (agent → command): the re-attach still reads
 *      the run as the agent it started
 *  16  SIGTERM while a run settles: it finishes there, once (one draft,
 *      one completion), never handed to another server half-settled
 *  17  a failed run's message carries the tail of the agent's stderr
 *  18  the log write fails once mid-stream: the run is re-attached (its
 *      agent left running) and completes, logs contiguous, cost once
 *  19  the log write fails every time: after 3 failed attaches the run
 *      fails and its agent is stopped
 *
 * The lease is shortened (6 s, renewed every 2 s) and the attach sweep runs
 * every second, so a SIGKILLed server's runs move on in seconds.
 *
 * Every cluster in this file works on one database, so all of them share one
 * fake-runtime directory too: a pod row an earlier cluster left `ready`
 * still has its container, as a deployment's pods outlive its API servers
 * (with a directory per cluster, the next cluster's health check finds those
 * pods gone, cleans them up as crashed and marks the repo's running tasks
 * with the pod's error). The servers are hermetic (startApiServer): `kubectl`
 * is a failing stub, the Kubernetes API a read-only fake, and git platform
 * hosts are answered in-process, so nothing reaches a real cluster or
 * GitHub with the dummy credentials seeded here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { Queue } from "bullmq";
import { FakeContainerRuntime } from "@optio/container-runtime";
import { getBullMQOptions } from "../src/services/redis-config.js";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import { waitFor } from "../src/test-utils/e2e/api-server.js";

const LEASE_MS = 6_000;
const MAX_CONCURRENT = 4;
const CLUSTER_ENV: Record<string, string> = {
  OPTIO_ATTACH_LEASE_MS: String(LEASE_MS),
  OPTIO_ATTACH_RENEW_MS: "2000",
  OPTIO_ATTACH_SWEEP_INTERVAL_MS: "1000",
  OPTIO_MAX_CONCURRENT: String(MAX_CONCURRENT),
  // Slow PR polling: the dummy GITHUB_TOKEN would hammer the real API.
  OPTIO_PR_WATCH_INTERVAL: "600000",
  // An agent whose result nobody streamed yet waits this long for its EOF.
  OPTIO_FAKE_EOF_TIMEOUT_MS: "120000",
};

const REPO_A = "https://github.com/e2e-org/scale-a";
const REPO_B = "https://github.com/e2e-org/scale-b";
const REPO_DOOMED = "https://github.com/e2e-org/scale-doomed";

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

/** The fake runtime's pods and runs, for every cluster in this file (see above). */
const FAKE_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "optio-e2e-scale-out-"));

afterAll(async () => {
  await sql.end({ timeout: 5 });
  rmSync(FAKE_RUNTIME_DIR, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type Client = ReturnType<ApiCluster["any"]>;

let seeded = false;
async function seed(api: Client) {
  if (seeded) return;
  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
    const { status, body } = await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name, value: `e2e-dummy-${name}`, scope: "global" }),
    });
    expect(status, JSON.stringify(body)).toBe(201);
  }
  for (const repoUrl of [REPO_A, REPO_B, REPO_DOOMED]) {
    const { status, body } = await api("/api/repos", {
      method: "POST",
      body: JSON.stringify({
        repoUrl,
        fullName: repoUrl.replace("https://github.com/", ""),
        defaultBranch: "main",
      }),
    });
    expect(status, JSON.stringify(body)).toBe(201);
  }
  seeded = true;
}

const ticks = (n: number, everyMs = 100) => `[[mock:ticks:${n}:${everyMs}]]`;

async function createTask(api: Client, repoUrl: string, directives: string): Promise<string> {
  // Directives go in the title: it is rendered into the agent's prompt.
  const { status, body } = await api<{ task: { id: string } }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: `scale-out ${directives}`,
      prompt: "E2E scale-out scenario",
      repoUrl,
      agentType: "claude-code",
    }),
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body.task.id;
}

async function createJobRun(api: Client, name: string, directives: string): Promise<string> {
  const job = await api<{ workflow: { id: string } }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      name,
      promptTemplate: `Scale-out Job ${directives}`,
      agentRuntime: "claude-code",
    }),
  });
  expect(job.status, JSON.stringify(job.body)).toBe(201);
  const run = await api<{ run: { id: string } }>(`/api/jobs/${job.body.workflow.id}/runs`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body.run.id;
}

async function createAgent(api: Client, slug: string, directives: string): Promise<string> {
  const { status, body } = await api<{ agent: { id: string } }>("/api/persistent-agents", {
    method: "POST",
    body: JSON.stringify({
      slug,
      name: slug,
      agentRuntime: "claude-code",
      initialPrompt: `Scale-out agent ${directives}`,
    }),
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body.agent.id;
}

interface ExecRow {
  id: string;
  state: string | null;
  exec_state: string | null;
  attached_by: string | null;
  attach_lease_until: Date | null;
  consumed_bytes: string | number;
  cost_usd: string | null;
  error_message: string | null;
}

async function workRun(id: string): Promise<ExecRow> {
  const [row] = await sql<ExecRow[]>`
    SELECT id, state::text AS state, exec_state, attached_by, attach_lease_until,
           consumed_bytes, cost_usd, error_message
    FROM tasks WHERE id = ${id}`;
  return row;
}

async function openTurn(agentId: string): Promise<ExecRow | undefined> {
  const [row] = await sql<ExecRow[]>`
    SELECT id, NULL AS state, exec_state, attached_by, attach_lease_until,
           consumed_bytes, cost_usd, error_message
    FROM persistent_agent_turns
    WHERE agent_id = ${agentId} AND finished_at IS NULL
    ORDER BY turn_number DESC LIMIT 1`;
  return row;
}

async function turns(agentId: string) {
  return sql<
    Array<{
      id: string;
      turn_number: number;
      halt_reason: string | null;
      cost_usd: string | null;
      error_message: string | null;
      finished_at: Date | null;
    }>
  >`SELECT id, turn_number, halt_reason, cost_usd, error_message, finished_at
    FROM persistent_agent_turns WHERE agent_id = ${agentId} ORDER BY turn_number`;
}

async function agentRow(agentId: string) {
  const [row] = await sql<Array<{ state: string; total_cost_usd: string }>>`
    SELECT state::text AS state, total_cost_usd FROM persistent_agents WHERE id = ${agentId}`;
  return row;
}

/** The server (by boot index) whose live lease holds the row, or -1. */
function holder(cluster: ApiCluster, row: ExecRow | undefined): number {
  if (!row?.attached_by || !row.attach_lease_until) return -1;
  if (new Date(row.attach_lease_until).getTime() <= Date.now()) return -1;
  const base = row.attached_by.split(":")[0];
  return cluster.servers.findIndex((s) => s.name === base);
}

/** A live server other than `not`. */
function otherLive(cluster: ApiCluster, not: number): number {
  const i = cluster.servers.findIndex((s, idx) => s.alive && idx !== not);
  if (i < 0) throw new Error("no other live server");
  return i;
}

async function logRows(owner: { taskId?: string; turnId?: string }) {
  return owner.taskId
    ? sql<Array<{ content: string; log_type: string | null }>>`
        SELECT content, log_type FROM task_logs WHERE task_id = ${owner.taskId}`
    : sql<Array<{ content: string; log_type: string | null }>>`
        SELECT content, log_type FROM task_logs WHERE persistent_agent_turn_id = ${owner.turnId!}`;
}

/** The tick numbers stored for a run. */
async function tickNumbers(owner: { taskId?: string; turnId?: string }): Promise<number[]> {
  return (await logRows(owner))
    .map((r) => /^tick (\d+)$/.exec(r.content)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
}

/**
 * The run's log rows are the agent's lines, each exactly once: ticks
 * 1…n (or a contiguous prefix of them, for a run stopped mid-way), one
 * session line, one result line when it got that far.
 */
async function expectContiguousLogs(
  owner: { taskId?: string; turnId?: string },
  n: number,
  opts: { complete?: boolean } = { complete: true },
) {
  const rows = await logRows(owner);
  const nums = await tickNumbers(owner);
  const sorted = [...nums].sort((a, b) => a - b);
  expect(new Set(nums).size, "no duplicate tick rows").toBe(nums.length);
  expect(sorted, "ticks contiguous from 1").toEqual(sorted.map((_, i) => i + 1));
  expect(rows.filter((r) => r.content.startsWith("Session started")).length).toBe(1);
  if (opts.complete !== false) {
    expect(sorted.length).toBe(n);
    expect(rows.filter((r) => r.log_type === "info" && r.content.includes("$")).length).toBe(1);
  }
}

/** Waits until the row's agent started and some of its output is stored. */
async function waitStreaming(read: () => Promise<ExecRow | undefined>, label: string) {
  return waitFor(
    async () => {
      const row = await read();
      return row && row.exec_state === "started" && Number(row.consumed_bytes) > 0 ? row : null;
    },
    { timeoutMs: 60_000, intervalMs: 100, label: `${label} streaming` },
  );
}

/** Waits until a live server other than `not` holds the row; returns it and the time it took. */
async function waitTakenOver(
  cluster: ApiCluster,
  read: () => Promise<ExecRow | undefined>,
  not: number,
  timeoutMs: number,
  label: string,
): Promise<{ by: number; ms: number }> {
  const t0 = Date.now();
  const by = await waitFor(
    async () => {
      const i = holder(cluster, await read());
      return i >= 0 && i !== not && cluster.servers[i].alive ? i + 1 : null;
    },
    { timeoutMs, intervalMs: 100, label: `${label} re-attached` },
  );
  return { by: by - 1, ms: Date.now() - t0 };
}

async function waitWorkRunState(id: string, states: string[], label: string, timeoutMs = 120_000) {
  return waitFor(
    async () => {
      const row = await workRun(id);
      return row && states.includes(row.state ?? "") ? row : null;
    },
    { timeoutMs, intervalMs: 250, label: `${label} → ${states.join("|")}` },
  );
}

async function waitAgentIdleAfter(agentId: string, finishedTurns: number, label: string) {
  return waitFor(
    async () => {
      const [agent, ts] = await Promise.all([agentRow(agentId), turns(agentId)]);
      const done = ts.filter((t) => t.finished_at).length;
      return agent.state === "idle" && done >= finishedTurns ? { agent, turns: ts } : null;
    },
    { timeoutMs: 120_000, intervalMs: 250, label: `${label} idle after ${finishedTurns} turn(s)` },
  );
}

/**
 * Waits until the agent is idle after a turn that ran to its end, and
 * returns it. Before it, the only turns allowed are ones whose starting
 * server died before their agent started: the reconciler halts such a turn
 * (it never ran: no cost, no logs) and the agent's next turn does the work —
 * recovery, as a task set up by a dead server is queued again.
 */
async function waitAgentTurnDone(agentId: string, label: string) {
  const { agent, turns: ts } = await waitFor(
    async () => {
      const [a, t] = await Promise.all([agentRow(agentId), turns(agentId)]);
      return a.state === "idle" && t.some((x) => x.halt_reason === "natural")
        ? { agent: a, turns: t }
        : null;
    },
    { timeoutMs: 120_000, intervalMs: 250, label: `${label} idle after a natural turn` },
  ).catch(async (err) => {
    // Say where the agent is stuck.
    const [a] = await sql`
      SELECT state::text AS state, consecutive_failures, last_failure_reason, updated_at
      FROM persistent_agents WHERE id = ${agentId}`;
    const t = await sql`
      SELECT turn_number, halt_reason, error_message, exec_state, attached_by,
             attach_lease_until, pod_id, created_at, finished_at
      FROM persistent_agent_turns WHERE agent_id = ${agentId} ORDER BY turn_number`;
    const pods = await sql`
      SELECT id, state, pod_id, pod_name, created_at, updated_at, error_message
      FROM agent_pods WHERE pool = 'persistent-agent' AND pool_key = ${agentId}`;
    const msgs = await sql`
      SELECT id, turn_id, received_at FROM persistent_agent_messages WHERE agent_id = ${agentId}`;
    throw new Error(
      `${String(err)}\nagent: ${JSON.stringify(a)}\nturns: ${JSON.stringify(t)}\npods: ${JSON.stringify(pods)}\nmessages: ${JSON.stringify(msgs)}`,
    );
  });
  const natural = ts.filter((t) => t.halt_reason === "natural");
  expect(natural, JSON.stringify(ts)).toHaveLength(1);
  for (const t of ts.filter((x) => x.halt_reason !== "natural")) {
    expect(t.halt_reason, JSON.stringify(ts)).toBe("error");
    expect(t.error_message, JSON.stringify(ts)).toMatch(/went away before its agent started/);
    expect(t.cost_usd).toBeNull();
    expect(await logRows({ turnId: t.id })).toHaveLength(0);
  }
  return { agent, turn: natural[0] };
}

/** The fake agent's exit file for a run (its exit code), or null while it runs. */
function exitCodeOf(cluster: ApiCluster, runId: string): number | null {
  const path = join(cluster.fakeRuntimeDir, "runs", runId, "exit");
  return existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : null;
}

/** Fails the test with the servers' log tails when `fn` throws. */
async function withLogs<T>(cluster: ApiCluster, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const tails = cluster.servers
      .map((s) => `--- ${s.name} ---\n${s.handle.logs().split("\n").slice(-80).join("\n")}`)
      .join("\n");
    throw new Error(`${String(err)}\n${tails}`);
  }
}

/**
 * No run was failed or flagged by a recovery path. (A task whose server
 * died while it was being set up is queued again — `provisioning_interrupted`
 * — and runs to its end: that is recovery working, not a failure.)
 */
async function noRecoveryFailures(ids: string[]) {
  const rows = await sql<Array<{ trigger: string }>>`
    SELECT trigger FROM task_events
    WHERE task_id = ANY(${ids}::uuid[])
      AND trigger IN ('execution_interrupted', 'startup_recovery_required', 'run_lost',
                      'stall_detected', 'running_pod_died', 'provisioning_pod_died')`;
  expect(rows.map((r) => r.trigger)).toEqual([]);
}

// ── One server: kill it, boot another ────────────────────────────────────────

describe("one server", () => {
  let cluster: ApiCluster;

  beforeAll(async () => {
    cluster = await startApiCluster({
      size: 1,
      env: CLUSTER_ENV,
      fakeRuntimeDir: FAKE_RUNTIME_DIR,
    });
    await seed(cluster.any());
  }, 240_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  it("(1, 11) a Repo Task, a Job run and an agent turn survive SIGKILL of their only server", async () => {
    await withLogs(cluster, async () => {
      const api = cluster.client(0);
      const N = 60;
      const taskId = await createTask(api, REPO_A, `[[mock:pr]] ${ticks(N)}`);
      const runId = await createJobRun(api, "kill-1 job", ticks(N));
      const agentId = await createAgent(api, "kill-1-agent", ticks(N));

      await waitStreaming(() => workRun(taskId), "task");
      await waitStreaming(() => workRun(runId), "job run");
      const turn = await waitStreaming(() => openTurn(agentId), "turn");

      await cluster.kill(0, "SIGKILL");
      // The agents go on in their pods with nobody streaming them.
      expect(exitCodeOf(cluster, taskId)).toBeNull();
      await cluster.add();

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      expect(task.exec_state).toBe("exited");
      await expectContiguousLogs({ taskId }, N);

      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run");
      expect(run.state).toBe("completed");
      expect(run.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId: runId }, N);

      const { agent, turns: ts } = await waitAgentIdleAfter(agentId, 1, "agent");
      expect(ts[0].halt_reason, JSON.stringify(ts)).toBe("natural");
      expect(ts[0].cost_usd).toBe("0.0123");
      expect(agent.total_cost_usd).toBe("0.0123");
      await expectContiguousLogs({ turnId: turn.id }, N);

      await noRecoveryFailures([taskId, runId]);
    });
  }, 180_000);

  it("(12) booting a server while runs are in flight fails nothing and takes nothing", async () => {
    await withLogs(cluster, async () => {
      const live = cluster.live()[0];
      const i = cluster.servers.indexOf(live);
      const api = cluster.client(i);
      const N = 50;
      const taskId = await createTask(api, REPO_B, `[[mock:pr]] ${ticks(N)}`);
      const runId = await createJobRun(api, "boot-12 job", ticks(N));
      await waitStreaming(() => workRun(taskId), "task");
      await waitStreaming(() => workRun(runId), "job run");

      const booted = await cluster.add();
      const bootedIndex = cluster.servers.indexOf(booted);
      // The new server's boot left the runs where they were.
      for (const id of [taskId, runId]) {
        const row = await workRun(id);
        expect(["running", "provisioning"]).toContain(row.state);
        expect(holder(cluster, row)).toBe(i);
      }

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run");
      expect(run.state).toBe("completed");
      await expectContiguousLogs({ taskId: runId }, N);
      await noRecoveryFailures([taskId, runId]);
      expect(bootedIndex).toBeGreaterThan(i);
    });
  }, 180_000);
});

// ── Three servers ────────────────────────────────────────────────────────────

describe("three servers", () => {
  let cluster: ApiCluster;

  /** Keeps three servers up between cases that kill one. */
  async function replenish() {
    while (cluster.live().length < 3) await cluster.add();
  }

  beforeAll(async () => {
    cluster = await startApiCluster({
      size: 3,
      env: CLUSTER_ENV,
      fakeRuntimeDir: FAKE_RUNTIME_DIR,
    });
    await seed(cluster.any());
  }, 300_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  it("(2) when the attached server is killed, another attaches within 10 s and the run completes", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 80;
      const taskId = await createTask(cluster.client(0), REPO_A, `[[mock:pr]] ${ticks(N)}`);
      const row = await waitStreaming(() => workRun(taskId), "task");
      const attached = holder(cluster, row);
      expect(attached).toBeGreaterThanOrEqual(0);

      const before = (await tickNumbers({ taskId })).length;
      await cluster.kill(attached, "SIGKILL");
      const { ms } = await waitTakenOver(cluster, () => workRun(taskId), attached, 10_000, "task");
      expect(ms).toBeLessThan(10_000);

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      // Changed hands mid-run: some ticks were stored before, the rest after.
      expect(before).toBeLessThan(N);
      await expectContiguousLogs({ taskId }, N);
    });
  }, 180_000);

  it("(3) ten runs across kinds, one server killed: all complete, limits never exceeded", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const api = cluster.any();
      const N = 30;
      const taskIds = [
        ...(await Promise.all(
          [0, 1, 2, 3].map(() => createTask(api, REPO_A, `[[mock:pr]] ${ticks(N)}`)),
        )),
        ...(await Promise.all(
          [0, 1].map(() => createTask(api, REPO_B, `[[mock:pr]] ${ticks(N)}`)),
        )),
      ];
      const runIds = await Promise.all([0, 1].map((k) => createJobRun(api, `ten-${k}`, ticks(N))));
      const agentIds = await Promise.all(
        [0, 1].map((k) => createAgent(api, `ten-agent-${k}`, ticks(N))),
      );

      // The limits, polled from the database the whole time.
      let maxGlobal = 0;
      const maxPerRepo: Record<string, number> = {};
      let polling = true;
      const poller = (async () => {
        while (polling) {
          const rows = await sql<Array<{ repo_url: string; n: number }>>`
            SELECT repo_url, count(*)::int AS n FROM repo_tasks
            WHERE state IN ('provisioning', 'running') GROUP BY repo_url`;
          maxGlobal = Math.max(
            maxGlobal,
            rows.reduce((a, r) => a + r.n, 0),
          );
          for (const r of rows) maxPerRepo[r.repo_url] = Math.max(maxPerRepo[r.repo_url] ?? 0, r.n);
          await new Promise((r) => setTimeout(r, 250));
        }
      })();

      try {
        // Kill the server streaming the most runs once the first wave streams.
        await waitFor(
          async () => {
            const rows = await Promise.all(taskIds.map(workRun));
            return rows.filter((r) => r.exec_state === "started" && Number(r.consumed_bytes) > 0)
              .length >= 2
              ? true
              : null;
          },
          { timeoutMs: 60_000, intervalMs: 100, label: "first wave streaming" },
        );
        const counts = new Map<number, number>();
        for (const id of [...taskIds, ...runIds]) {
          const h = holder(cluster, await workRun(id));
          if (h >= 0) counts.set(h, (counts.get(h) ?? 0) + 1);
        }
        const victim = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
        await cluster.kill(victim, "SIGKILL");

        for (const id of taskIds) {
          const task = await waitWorkRunState(
            id,
            ["pr_opened", "failed", "needs_attention"],
            "task",
            240_000,
          );
          expect(task.state).toBe("pr_opened");
          expect(task.cost_usd).toBe("0.0123");
          await expectContiguousLogs({ taskId: id }, N);
        }
        for (const id of runIds) {
          const run = await waitWorkRunState(id, ["completed", "failed"], "job run", 240_000);
          expect(run.state).toBe("completed");
          expect(run.cost_usd).toBe("0.0123");
          await expectContiguousLogs({ taskId: id }, N);
        }
        for (const id of agentIds) {
          const { agent, turn } = await waitAgentTurnDone(id, "agent");
          expect(agent.total_cost_usd).toBe("0.0123");
          await expectContiguousLogs({ turnId: turn.id }, N);
        }
      } finally {
        polling = false;
        await poller;
      }

      expect(maxGlobal).toBeLessThanOrEqual(MAX_CONCURRENT);
      for (const repo of [REPO_A, REPO_B]) expect(maxPerRepo[repo] ?? 0).toBeLessThanOrEqual(2);
      await noRecoveryFailures(taskIds);
    });
  }, 420_000);

  it("(4, 11) a cancel through a server not attached to the run stops its agent — task, Job run, agent turn", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 300;
      const taskId = await createTask(cluster.any(), REPO_A, ticks(N));
      const runId = await createJobRun(cluster.any(), "cancel-4 job", ticks(N));
      const agentId = await createAgent(cluster.any(), "cancel-4-agent", ticks(N));
      const taskRow = await waitStreaming(() => workRun(taskId), "task");
      const runRow = await waitStreaming(() => workRun(runId), "job run");
      const turn = await waitStreaming(() => openTurn(agentId), "turn");

      const cancelTask = await cluster.client(otherLive(cluster, holder(cluster, taskRow)))(
        `/api/tasks/${taskId}/cancel`,
        { method: "POST", body: "{}" },
      );
      expect(cancelTask.status).toBe(200);
      const cancelRun = await cluster.client(otherLive(cluster, holder(cluster, runRow)))(
        `/api/workflow-runs/${runId}/cancel`,
        { method: "POST", body: "{}" },
      );
      expect(cancelRun.status).toBe(200);
      // A persistent agent's cancel is its archive.
      const archive = await cluster.client(otherLive(cluster, holder(cluster, turn)))(
        `/api/persistent-agents/${agentId}/control`,
        { method: "POST", body: JSON.stringify({ intent: "archive" }) },
      );
      expect(archive.status).toBe(200);

      // Each agent got the signal (exit 143) long before its N ticks.
      for (const [kind, id] of [
        ["task", taskId],
        ["job run", runId],
        ["agent turn", turn.id],
      ] as const) {
        await waitFor(async () => (exitCodeOf(cluster, id) === 143 ? true : null), {
          timeoutMs: 30_000,
          label: `the ${kind}'s agent stopped (${id})`,
        });
      }

      const task = await waitWorkRunState(taskId, ["cancelled"], "task");
      expect(task.state).toBe("cancelled");
      const run = await waitWorkRunState(runId, ["failed"], "job run");
      expect(run.error_message).toBe("Cancelled by user");
      await waitFor(async () => ((await agentRow(agentId)).state === "archived" ? true : null), {
        label: "agent archived",
      });
      await waitFor(async () => ((await turns(agentId))[0]?.finished_at ? true : null), {
        label: "turn halted",
      });

      // The runs settled where they stopped: every stored tick once, far short of N.
      for (const owner of [{ taskId }, { taskId: runId }, { turnId: turn.id }]) {
        await waitFor(
          async () => {
            const row = owner.turnId
              ? await sql`SELECT exec_state FROM persistent_agent_turns WHERE id = ${owner.turnId}`
              : await sql`SELECT exec_state FROM tasks WHERE id = ${owner.taskId!}`;
            return row[0]?.exec_state === "exited" ? true : null;
          },
          { label: "settled" },
        );
        await expectContiguousLogs(owner, N, { complete: false });
        expect((await tickNumbers(owner)).length).toBeLessThan(N);
      }
    });
  }, 180_000);

  it("(5, 11) a message through a server not attached to the run reaches its agent", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 40;
      const taskId = await createTask(
        cluster.any(),
        REPO_B,
        `[[mock:pr]] [[mock:echo-stdin]] ${ticks(N)}`,
      );
      const row = await waitStreaming(() => workRun(taskId), "task");
      const via = otherLive(cluster, holder(cluster, row));
      const sent = await cluster.client(via)(`/api/tasks/${taskId}/message`, {
        method: "POST",
        body: JSON.stringify({ content: "hello from elsewhere", mode: "soft" }),
      });
      expect(sent.status).toBe(202);

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      const contents = (await logRows({ taskId })).map((r) => r.content);
      expect(contents).toContain("stdin: hello from elsewhere");
      expect(contents.filter((c) => c === "stdin: hello from elsewhere")).toHaveLength(1);
      const [msg] = await sql<Array<{ delivered_at: Date | null; delivery_error: string | null }>>`
        SELECT delivered_at, delivery_error FROM task_messages WHERE task_id = ${taskId}`;
      expect(msg.delivery_error).toBeNull();
      expect(msg.delivered_at).not.toBeNull();
      await expectContiguousLogs({ taskId }, N);

      // A persistent agent takes messages through its inbox: one posted to a
      // server not attached to the running turn wakes the agent's next turn.
      const agentId = await createAgent(cluster.any(), "message-5-agent", ticks(N));
      const turn = await waitStreaming(() => openTurn(agentId), "turn");
      const agentVia = otherLive(cluster, holder(cluster, turn));
      const posted = await cluster.client(agentVia)(`/api/persistent-agents/${agentId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: "second thought" }),
      });
      expect(posted.status).toBe(202);
      const { turns: ts } = await waitAgentIdleAfter(agentId, 2, "agent");
      const [second] = await sql<Array<{ prompt_used: string }>>`
        SELECT prompt_used FROM persistent_agent_turns WHERE id = ${ts[1].id}`;
      expect(second.prompt_used).toContain("second thought");
      await expectContiguousLogs({ turnId: turn.id }, N);
    });
  }, 180_000);

  it("(9) SIGTERM to the attached server hands the run to another in under 5 s", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 80;
      const taskId = await createTask(cluster.any(), REPO_A, `[[mock:pr]] ${ticks(N)}`);
      const row = await waitStreaming(() => workRun(taskId), "task");
      const attached = holder(cluster, row);
      expect(attached).toBeGreaterThanOrEqual(0);

      const stopping = cluster.kill(attached, "SIGTERM");
      const { ms } = await waitTakenOver(cluster, () => workRun(taskId), attached, 5_000, "task");
      expect(ms).toBeLessThan(5_000);
      await stopping;

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
    });
  }, 180_000);

  it("(10) the pod going away mid-run fails the run with the pod's reason", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const taskId = await createTask(cluster.any(), REPO_DOOMED, ticks(300));
      await waitStreaming(() => workRun(taskId), "task");
      const [pod] = await sql<Array<{ pod_id: string | null; pod_name: string }>>`
        SELECT p.pod_id, p.pod_name FROM agent_pods p
        JOIN tasks t ON t.last_pod_id = p.id WHERE t.id = ${taskId}`;
      const fake = new FakeContainerRuntime({ dir: cluster.fakeRuntimeDir });
      await fake.destroy({ id: pod.pod_id ?? pod.pod_name, name: pod.pod_name });

      const task = await waitWorkRunState(
        taskId,
        ["failed", "cancelled", "completed", "pr_opened", "needs_attention"],
        "task",
        60_000,
      );
      expect(task.state).toBe("failed");
      expect(task.error_message).toMatch(/pod/i);
      await expectContiguousLogs({ taskId }, 300, { complete: false });
    });
  }, 120_000);
});

// ── Resets, review runs, edits and settling ──────────────────────────────────

describe("resets, review runs, edits and settling", () => {
  let cluster: ApiCluster;
  let reviewQueue: Queue;
  /** A pause right after a run's exit is recorded: a window to SIGTERM a server in. */
  const SETTLE_PAUSE_MS = 3_000;

  async function replenish() {
    while (cluster.live().length < 2) await cluster.add();
  }

  beforeAll(async () => {
    cluster = await startApiCluster({
      size: 2,
      fakeRuntimeDir: FAKE_RUNTIME_DIR,
      env: {
        ...CLUSTER_ENV,
        OPTIO_SETTLE_PAUSE_MS: String(SETTLE_PAUSE_MS),
        // A run's output line FAULT-ONCE fails the log write of the job that
        // started it; FAULT-ALWAYS fails every job's (cases 18, 19).
        OPTIO_TEST_STREAM_FAULT_FIRST: "FAULT-ONCE",
        OPTIO_TEST_STREAM_FAULT: "FAULT-ALWAYS",
      },
    });
    await seed(cluster.any());
    reviewQueue = new Queue("pr-review-runs", getBullMQOptions());
  }, 300_000);

  afterAll(async () => {
    await reviewQueue?.close();
    await cluster?.stop();
  });

  let prNumber = 100;
  /** A review of a PR on REPO_A with one run queued for the review worker. */
  async function createReviewRun(directives: string) {
    const [repo] = await sql<Array<{ workspace_id: string | null }>>`
      SELECT workspace_id FROM repos WHERE repo_url = ${REPO_A}`;
    const n = prNumber++;
    const [review] = await sql<Array<{ id: string }>>`
      INSERT INTO pr_reviews (pr_url, pr_number, repo_owner, repo_name, repo_url, head_sha, state, workspace_id)
      VALUES (${`${REPO_A}/pull/${n}`}, ${n}, 'e2e-org', 'scale-a', ${REPO_A}, 'deadbeef', 'reviewing', ${repo.workspace_id})
      RETURNING id`;
    const [run] = await sql<Array<{ id: string }>>`
      INSERT INTO pr_review_runs (pr_review_id, kind, state, prompt, metadata)
      VALUES (${review.id}, 'initial', 'queued', ${`Review the PR ${directives}`}, '{}'::jsonb)
      RETURNING id`;
    await reviewQueue.add("process-pr-review-run", { runId: run.id }, { jobId: run.id });
    return { reviewId: review.id, runId: run.id };
  }

  async function reviewRun(runId: string): Promise<ExecRow> {
    const [row] = await sql<ExecRow[]>`
      SELECT id, state::text AS state, exec_state, attached_by, attach_lease_until,
             consumed_bytes, cost_usd, error_message
      FROM pr_review_runs WHERE id = ${runId}`;
    return row;
  }

  async function review(reviewId: string) {
    const [row] = await sql<
      Array<{ state: string; summary: string | null; verdict: string | null }>
    >`
      SELECT state::text AS state, summary, verdict FROM pr_reviews WHERE id = ${reviewId}`;
    return row;
  }

  async function reviewEvents(reviewId: string, trigger: string) {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pr_review_events
      WHERE pr_review_id = ${reviewId} AND trigger = ${trigger}`;
    return rows[0].n;
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("(13) a force-redo of a running task stops its agent; only the new attempt's logs remain", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 40;
      const taskId = await createTask(cluster.any(), REPO_B, `[[mock:pr]] ${ticks(N)}`);
      await waitStreaming(() => workRun(taskId), "task");
      const [{ exec_pid: oldPid }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;
      expect(alive(oldPid)).toBe(true);

      const redo = await cluster.any()(`/api/tasks/${taskId}/force-redo`, {
        method: "POST",
        body: "{}",
      });
      expect(redo.status).toBe(200);
      // The old attempt's agent is stopped (its TERM: the redo's, or its job's).
      await waitFor(async () => (alive(oldPid) ? null : true), {
        timeoutMs: 10_000,
        label: "the old attempt's agent stopped",
      });

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      // One attempt's spend (the redo cleared the old one's), one attempt's lines.
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
      const [{ exec_pid: newPid }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;
      expect(newPid).not.toBe(oldPid);
      const events = await sql<Array<{ trigger: string }>>`
        SELECT trigger FROM task_events WHERE task_id = ${taskId} AND to_state = 'pr_opened'`;
      expect(events).toHaveLength(1);
    });
  }, 180_000);

  it("(14) a review cancelled while its run is being set up: run cancelled, agent stopped, nothing written", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const { reviewId, runId } = await createReviewRun(`[[mock:slow-start:4000]] ${ticks(20)}`);
      // The start exec is under way (the fake's run directory exists): cancel.
      await waitFor(
        async () => (existsSync(join(cluster.fakeRuntimeDir, "runs", runId)) ? true : null),
        { timeoutMs: 60_000, intervalMs: 100, label: "the review run's start under way" },
      );
      expect((await reviewRun(runId)).state).toBe("provisioning");
      const cancel = await cluster.any()(`/api/pr-reviews/${reviewId}/cancel`, {
        method: "POST",
        body: "{}",
      });
      expect(cancel.status).toBeLessThan(300);
      await waitFor(async () => ((await review(reviewId)).state === "cancelled" ? true : null), {
        timeoutMs: 30_000,
        label: "review cancelled",
      });

      // The agent the start launched is stopped (TERM: 143), not left running.
      await waitFor(async () => (exitCodeOf(cluster, runId) === 143 ? true : null), {
        timeoutMs: 30_000,
        label: "the review run's agent stopped",
      });
      const run = await reviewRun(runId);
      expect(run.state).toBe("cancelled");
      // Give a stray finish its chance to write anything: nothing comes.
      await new Promise((r) => setTimeout(r, 2_000));
      const after = await review(reviewId);
      expect(after.state).toBe("cancelled");
      expect(after.summary).toBeNull();
      expect(after.verdict).toBeNull();
      expect(await reviewEvents(reviewId, "agent_drafted")).toBe(0);
      expect((await reviewRun(runId)).state).toBe("cancelled");
      const logs = await sql`SELECT 1 FROM task_logs WHERE pr_review_run_id = ${runId}`;
      expect(logs).toHaveLength(0);
    });
  }, 180_000);

  it("(15) a Job edited from an agent to a command mid-run: the re-attach still reads it as the agent", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 60;
      const job = await cluster.any()<{ workflow: { id: string } }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          name: "edit-15 job",
          promptTemplate: `Scale-out Job ${ticks(N)}`,
          agentRuntime: "claude-code",
        }),
      });
      expect(job.status, JSON.stringify(job.body)).toBe(201);
      const jobId = job.body.workflow.id;
      const started = await cluster.any()<{ run: { id: string } }>(`/api/jobs/${jobId}/runs`, {
        method: "POST",
        body: "{}",
      });
      expect(started.status).toBe(201);
      const runId = started.body.run.id;
      const row = await waitStreaming(() => workRun(runId), "job run");

      const edit = await cluster.any()(`/api/jobs/${jobId}`, {
        method: "PATCH",
        body: JSON.stringify({ agentRuntime: "shell", promptTemplate: "echo edited" }),
      });
      expect(edit.status).toBe(200);

      const attached = holder(cluster, row);
      expect(attached).toBeGreaterThanOrEqual(0);
      await cluster.kill(attached, "SIGKILL");
      await waitTakenOver(cluster, () => workRun(runId), attached, 15_000, "job run");

      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run");
      expect(run.error_message).toBeNull();
      expect(run.state).toBe("completed");
      expect(run.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId: runId }, N);
    });
  }, 180_000);

  it("(17) a failed run's message carries the tail of its agent's stderr", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const taskId = await createTask(
        cluster.any(),
        REPO_B,
        "[[mock:fail]] [[mock:stderr:claude: the model refused the key]]",
      );
      const task = await waitWorkRunState(
        taskId,
        ["failed", "pr_opened", "needs_attention", "completed"],
        "task",
      );
      expect(task.state).toBe("failed");
      expect(task.error_message).toContain("Mock agent failure");
      expect(task.error_message).toContain("Agent stderr (last 8 KB):");
      expect(task.error_message).toContain("claude: the model refused the key");
    });
  }, 120_000);

  it("(18) a log write that fails once mid-stream: the run is re-attached and completes, its agent untouched", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 40;
      const taskId = await createTask(
        cluster.any(),
        REPO_A,
        `[[mock:pr]] ${ticks(N)} [[mock:mark:10:FAULT-ONCE]]`,
      );
      await waitStreaming(() => workRun(taskId), "task");
      const [{ exec_pid: pid }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
      // The job that started the run always fails on this line, so another
      // job — an attach — stored it, once.
      const marks = (await logRows({ taskId })).filter((r) => r.content === "FAULT-ONCE");
      expect(marks).toHaveLength(1);
      // The same agent ran to its end (exit 0): the failure only moved the
      // run to another job, it never stopped or restarted the agent.
      const [{ exec_pid: after }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;
      expect(after).toBe(pid);
      expect(exitCodeOf(cluster, taskId)).toBe(0);
      await noRecoveryFailures([taskId]);
    });
  }, 180_000);

  it("(19) a log write that fails every time: after 3 failed attaches the run fails and its agent is stopped", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const job = await cluster.any()<{ workflow: { id: string } }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          name: "fault-19 job",
          promptTemplate: `Scale-out Job ${ticks(600)} [[mock:mark:5:FAULT-ALWAYS]]`,
          agentRuntime: "claude-code",
          maxRetries: 0,
        }),
      });
      expect(job.status, JSON.stringify(job.body)).toBe(201);
      const started = await cluster.any()<{ run: { id: string } }>(
        `/api/jobs/${job.body.workflow.id}/runs`,
        { method: "POST", body: "{}" },
      );
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run", 120_000);
      expect(run.state).toBe("failed");
      expect(run.error_message).toContain("Attaching to the run failed 3 times in a row");
      expect(run.error_message).toContain("FAULT-ALWAYS");
      const [meta] = await sql<Array<{ failures: number }>>`
        SELECT (metadata->>'attachFailures')::int AS failures FROM tasks WHERE id = ${runId}`;
      expect(meta.failures).toBe(3);
      // The agent, still ticking (600 of them), was stopped.
      await waitFor(async () => (exitCodeOf(cluster, runId) === 143 ? true : null), {
        timeoutMs: 30_000,
        label: "the run's agent stopped",
      });
      // Nothing past the failing line was ever stored (its batch — tick 5
      // too, when they came in one chunk — rolled back each time): a
      // contiguous prefix of the ticks, each once.
      await expectContiguousLogs({ taskId: runId }, 600, { complete: false });
      expect((await tickNumbers({ taskId: runId })).length).toBeLessThanOrEqual(5);
    });
  }, 180_000);

  it("(16) SIGTERM while a review run settles: it finishes on that server, once", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const { reviewId, runId } = await createReviewRun(ticks(10));
      // Its exit is recorded and the run is still settling (the pause).
      const row = await waitFor(
        async () => {
          const r = await reviewRun(runId);
          return r && r.state === "running" && r.exec_state === "exited" ? r : null;
        },
        { timeoutMs: 60_000, intervalMs: 100, label: "review run settling" },
      );
      const settling = holder(cluster, row);
      expect(settling).toBeGreaterThanOrEqual(0);
      // Who holds the run while that server shuts down: only it, until the
      // run is closed — never another server finishing it a second time.
      const holders = new Set<string>();
      let watching = true;
      const watcher = (async () => {
        while (watching) {
          const r = await reviewRun(runId);
          if (r.attached_by) holders.add(r.attached_by.split(":")[0]);
          await new Promise((res) => setTimeout(res, 50));
        }
      })();
      try {
        await cluster.kill(settling, "SIGTERM");
      } finally {
        watching = false;
        await watcher;
      }
      expect([...holders]).toEqual([cluster.servers[settling].name]);

      // The SIGTERMed server finished it before going: done when it was gone.
      const done = await reviewRun(runId);
      expect(done.state).toBe("completed");
      expect(done.cost_usd).toBe("0.0123");
      expect(done.attached_by).toBeNull();
      await waitFor(async () => ((await review(reviewId)).state === "ready" ? true : null), {
        timeoutMs: 30_000,
        label: "review drafted",
      });
      // No other server finished it again.
      await new Promise((r) => setTimeout(r, 3 * 1_000));
      expect(await reviewEvents(reviewId, "agent_drafted")).toBe(1);
      expect((await reviewRun(runId)).cost_usd).toBe("0.0123");
      const tickRows = await sql<Array<{ content: string }>>`
        SELECT content FROM task_logs WHERE pr_review_run_id = ${runId} AND content LIKE 'tick %'`;
      expect(tickRows).toHaveLength(10);
    });
  }, 180_000);
});
