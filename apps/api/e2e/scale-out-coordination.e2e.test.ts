/**
 * E2E: phase C1 of docs/plans/scale-out.md through two REAL API servers on
 * one database (the api-cluster harness), with auth ENABLED so the
 * WebSocket upgrade path is the real one:
 *
 *   6. a WebSocket upgrade token minted on A is accepted by B, once;
 *   7. the same signed webhook delivery posted to A and to B fires once;
 *   8. a schedule trigger due now, with both servers sweeping, fires once;
 *   +  two servers booting leave exactly one scheduler per repeat job.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import { waitFor } from "../src/test-utils/e2e/api-server.js";
import { REPEAT_SCHEDULERS } from "../src/services/repeat-jobs.js";

const GITLAB_WEBHOOK_SECRET = "e2e-scale-out-gitlab-token";

let cluster: ApiCluster;
let adminToken = "";

/** An admin with a session, seeded straight into the DB (like webhook-ingress-auth.e2e). */
async function seedAdmin(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const wsId = randomUUID();
    const userId = randomUUID();
    adminToken = `e2e-admin-${randomBytes(16).toString("hex")}`;
    const tokenHash = createHash("sha256").update(adminToken).digest("hex");
    await sql`INSERT INTO workspaces (id, name, slug) VALUES (${wsId}, 'Scale-out e2e', ${`scale-out-e2e-${wsId.slice(0, 8)}`})`;
    await sql`
      INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
      VALUES (${userId}, 'github', 'scale-out-e2e-admin', 'admin@scale-out.e2e', 'Scale-out admin', ${wsId})`;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, 'admin')`;
    await sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}, ${tokenHash}, NOW() + INTERVAL '1 day')`;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await seedAdmin();
  cluster = await startApiCluster({
    size: 2,
    env: {
      OPTIO_AUTH_DISABLED: "false",
      GITLAB_WEBHOOK_SECRET,
      OPTIO_WORKFLOW_TRIGGER_INTERVAL: "1000",
    },
  });
}, 240_000);

afterAll(async () => {
  await cluster?.stop();
});

function server(i: number): string {
  return cluster.servers[i].handle.baseUrl;
}

async function api<T = any>(
  i: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server(i)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

/**
 * Opens a WebSocket with the upgrade token in the subprotocol. The upgrade
 * itself always completes; the server authenticates after it and closes
 * with 4401 when the token is no good. So: accepted when the socket is
 * still open a moment later (then we close it), else the server's code.
 */
function upgrade(i: number, token: string): Promise<{ accepted: boolean; closeCode?: number }> {
  return new Promise((resolve) => {
    const url = `${server(i).replace(/^http/, "ws")}/ws/events`;
    const ws = new WebSocket(url, ["optio-ws-v1", `optio-auth-${token}`]);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    ws.addEventListener("open", () => {
      timer = setTimeout(() => {
        settled = true;
        ws.close(1000);
        resolve({ accepted: true });
      }, 1500);
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      if (!settled) resolve({ accepted: false, closeCode: ev.code });
    });
    ws.addEventListener("error", () => {
      /* close follows */
    });
  });
}

describe("scale-out coordination across two API servers", () => {
  it("a WebSocket upgrade token minted on A is accepted by B, and only once", async () => {
    const minted = await api<{ token: string }>(0, "GET", "/api/auth/ws-token");
    expect(minted.status).toBe(200);
    expect(minted.body.token).not.toBe("auth-disabled");

    const onB = await upgrade(1, minted.body.token);
    expect(onB).toEqual({ accepted: true });

    // Consumed on B: A rejects the same token.
    const again = await upgrade(0, minted.body.token);
    expect(again).toEqual({ accepted: false, closeCode: 4401 });
  }, 30_000);

  it("the same signed webhook delivery posted to A and to B fires once", async () => {
    const project = `acme/scale-out-${Date.now()}`;
    const created = await api<{ workflow: { id: string } }>(0, "POST", "/api/jobs", {
      name: `push summary ${Date.now()}`,
      promptTemplate: "Summarize {{commits}} on {{sourceBranch}}",
      agentRuntime: "claude-code",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const jobId = created.body.workflow.id;
    const trigger = await api(0, "POST", `/api/jobs/${jobId}/triggers`, {
      type: "gitlab",
      config: { events: ["push"], projects: [project], branches: ["main"] },
    });
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);

    const raw = JSON.stringify({
      object_kind: "push",
      ref: "refs/heads/main",
      before: "aaaa1111",
      after: "bbbb2222",
      user_username: "alice",
      project: { path_with_namespace: project, web_url: `https://gitlab.com/${project}` },
      commits: [{ id: "bbbb2222", title: "fix: thing", message: "fix: thing" }],
    });
    const deliveryId = randomUUID();
    const deliver = async (i: number) => {
      const res = await fetch(`${server(i)}/api/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-event": "Push Hook",
          "x-gitlab-event-uuid": deliveryId,
          "x-gitlab-token": GITLAB_WEBHOOK_SECRET,
        },
        body: raw,
      });
      return { status: res.status, body: await res.json() };
    };

    // The provider's retry lands on the other instance.
    const [onA, onB] = await Promise.all([deliver(0), deliver(1)]);
    expect(onA.status).toBe(200);
    expect(onB.status).toBe(200);
    expect([onA.body, onB.body]).toEqual(
      expect.arrayContaining([{ ok: true }, { ok: true, duplicate: true }]),
    );
    const runs = async () =>
      (await api<{ runs: unknown[] }>(1, "GET", `/api/jobs/${jobId}/runs`)).body.runs;
    await waitFor(async () => ((await runs()).length >= 1 ? true : null), {
      timeoutMs: 30_000,
      label: "a run of the GitLab-triggered Job",
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await runs()).toHaveLength(1);
  }, 60_000);

  it("a schedule trigger due now fires once with both servers sweeping", async () => {
    const created = await api<{ workflow: { id: string } }>(1, "POST", "/api/jobs", {
      name: `nightly ${Date.now()}`,
      promptTemplate: "Nightly sweep",
      agentRuntime: "claude-code",
    });
    expect(created.status).toBe(201);
    const jobId = created.body.workflow.id;
    // A yearly cron: once nextFireAt is pulled into the past it is due
    // exactly once, and the advance puts it a year away.
    const trigger = await api<{ trigger: { id: string } }>(
      1,
      "POST",
      `/api/jobs/${jobId}/triggers`,
      {
        type: "schedule",
        config: { cronExpression: "0 0 1 1 *" },
      },
    );
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`UPDATE workflow_triggers SET next_fire_at = NOW() - INTERVAL '1 minute' WHERE id = ${trigger.body.trigger.id}`;
    } finally {
      await sql.end();
    }

    const runs = async () =>
      (await api<{ runs: unknown[] }>(0, "GET", `/api/jobs/${jobId}/runs`)).body.runs;
    await waitFor(async () => ((await runs()).length >= 1 ? true : null), {
      timeoutMs: 30_000,
      label: "the schedule to fire",
    });
    // Both servers sweep every second; give them several more ticks.
    await new Promise((r) => setTimeout(r, 4000));
    expect(await runs()).toHaveLength(1);
    const listed = await api<{ triggers: Array<{ id: string; nextFireAt: string | null }> }>(
      0,
      "GET",
      `/api/jobs/${jobId}/triggers`,
    );
    const after = listed.body.triggers.find((t) => t.id === trigger.body.trigger.id);
    expect(new Date(after!.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it("two servers booting leave exactly one scheduler per repeat job", async () => {
    const { getBullMQOptions } = await import("../src/services/redis-config.js");
    const opts = getBullMQOptions();
    const expectations: Array<[string, number]> = [
      ["pr-watcher", 1],
      ["external-pr-review", 1],
      ["repo-cleanup", 2],
      ["ticket-sync", 1],
      ["workflow-trigger-checker", 1],
      ["token-validation", 1],
      ["reconcile-resync", 1],
      ["skill-sync", 1],
      ["housekeeping", 1],
    ];
    for (const [name, expected] of expectations) {
      const queue = new Queue(name, { ...opts });
      try {
        const schedulers = await queue.getJobSchedulers();
        expect(schedulers.map((s) => s.key).sort(), `${name} schedulers`).toEqual(
          [...REPEAT_SCHEDULERS[name as keyof typeof REPEAT_SCHEDULERS]].sort(),
        );
        expect(schedulers).toHaveLength(expected);
        // And nothing hash-keyed beside them.
        expect(await queue.getRepeatableJobs()).toHaveLength(expected);
      } finally {
        await queue.close();
      }
    }
  }, 30_000);
});
