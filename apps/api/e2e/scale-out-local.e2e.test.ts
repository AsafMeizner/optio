/**
 * E2E: Optio Local across three real API servers on one database and one
 * Redis (phase D of docs/plans/scale-out.md). A test daemon connects to one
 * server (the host's owner); viewers, REST calls and workers on the others
 * reach it through the Local bus:
 *
 * (a) a viewer on B gets the snapshot and the output of a daemon on A, and
 *     its input and resize reach the daemon;
 * (b) spawn, kill, dirs and limits through B's REST reach the daemon on A
 *     and get their answers;
 * (c) the daemon reconnects to B (newest wins): A closes its socket and a
 *     viewer on A gets the output from the daemon's new connection;
 * (d) A is SIGKILLed while it owns the host: the daemon reconnects to B, the
 *     terminal stays alive and viewable, nothing is marked exited;
 * (e) a local Job run started through B with the daemon on A runs to
 *     completion, whichever server's worker dispatches it;
 * (f) every server agrees on whether the host is online.
 *
 * The daemon and viewers are test clients (local-fakes.ts), never a real
 * daemon or terminal. Auth is disabled (one implicit user).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import { waitFor } from "../src/test-utils/e2e/api-server.js";
import { FakeDaemon, FakeViewer, type Json } from "../src/test-utils/e2e/local-fakes.js";

let cluster: ApiCluster;

beforeAll(async () => {
  cluster = await startApiCluster({
    size: 3,
    // A viewer attached through a server that went away reconnects within a second.
    env: { OPTIO_LOCAL_VIEWER_HEARTBEAT_MS: "1000" },
  });
}, 240_000);

afterAll(async () => {
  await cluster?.stop();
});

const wsBase = (i: number) => cluster.servers[i].handle.baseUrl.replace(/^http/, "ws");
const api = (i: number) => cluster.client(i);

const DIRS = [{ path: "/tmp/e2e-repo", repoUrl: "https://github.com/acme/e2e" }];
const CAPS = {
  manageDirs: true,
  refreshLimits: true,
  transcriptBackfill: true,
  answersQueries: true,
};

interface HostRow {
  id: string;
  state: string;
  manageDirs?: boolean;
  dirs: Array<{ path: string }>;
}
interface TerminalRow {
  id: string;
  hostId: string;
  state: string;
  exitCode: number | null;
}

async function registerHost(i: number, hostname: string): Promise<string> {
  const { status, body } = await api(i)<{ host: HostRow }>("/api/local/hosts/register", {
    method: "POST",
    body: JSON.stringify({ hostname, platform: "darwin", arch: "arm64", dirs: DIRS }),
  });
  expect(status).toBe(200);
  return body.host.id;
}

/** What server `i` says about the host: online (its daemon's capabilities show) or not. */
async function onlineOn(i: number, hostId: string): Promise<boolean> {
  const { body } = await api(i)<{ hosts: HostRow[] }>("/api/local/hosts");
  return body.hosts.find((h) => h.id === hostId)?.manageDirs === true;
}

/** What server `i`'s session recovery says about a live terminal: `live` iff its host is online. */
async function recoveryOn(i: number, terminalId: string): Promise<string> {
  const { body } = await api(i)<{ state: string }>(`/api/session-recovery/local/${terminalId}`);
  return body.state;
}

async function everyLive<T>(fn: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(
    cluster.servers
      .map((s, i) => [s, i] as const)
      .filter(([s]) => s.alive)
      .map(([, i]) => fn(i)),
  );
}

const getTerminal = async (i: number, id: string) =>
  (await api(i)<{ terminal: TerminalRow }>(`/api/local/terminals/${id}`)).body.terminal;

/** A daemon connected to server `i`, seen online by every live server. */
async function connectDaemon(
  i: number,
  hostId: string,
  cleanups: Array<() => void>,
  terminals: Json[] = [],
): Promise<FakeDaemon> {
  const daemon = new FakeDaemon(wsBase(i));
  cleanups.push(() => daemon.close());
  await daemon.connect(hostId, DIRS, terminals, CAPS);
  await waitFor(async () =>
    (await everyLive((j) => onlineOn(j, hostId))).every(Boolean) ? true : null,
  );
  return daemon;
}

/** A running shell spawned through server `via` on `daemon`. */
async function runningShell(via: number, hostId: string, daemon: FakeDaemon): Promise<string> {
  const { status, body } = await api(via)<{ terminal: TerminalRow }>("/api/local/terminals", {
    method: "POST",
    body: JSON.stringify({ hostId, dir: "/tmp/e2e-repo", spec: { kind: "shell" } }),
  });
  expect(status).toBe(201);
  expect(body.terminal.state).toBe("launching");
  const terminalId = body.terminal.id;
  const spawn = await daemon.next((m) => m.type === "spawn" && m.terminalId === terminalId);
  expect(spawn.dir).toBe("/tmp/e2e-repo");
  daemon.send({ type: "started", terminalId });
  await waitFor(async () =>
    (await getTerminal(via, terminalId)).state === "running" ? true : null,
  );
  return terminalId;
}

/** A viewer on server `i` attached to the terminal: the daemon answers its attach with `snapshot`. */
async function attachViewer(
  i: number,
  terminalId: string,
  daemon: FakeDaemon,
  snapshot: string,
  cleanups: Array<() => void>,
): Promise<FakeViewer> {
  const viewer = new FakeViewer(wsBase(i));
  cleanups.push(() => viewer.close());
  await viewer.connect(terminalId);
  const attach = await daemon.next((m) => m.type === "attach" && m.terminalId === terminalId);
  daemon.send({
    type: "scrollback",
    terminalId,
    attachId: attach.attachId,
    dataB64: Buffer.from(snapshot).toString("base64"),
    cols: 100,
    rows: 30,
  });
  daemon.send({ type: "size", terminalId, cols: 100, rows: 30 });
  await waitFor(async () => (viewer.text().includes(snapshot) ? true : null));
  return viewer;
}

const output = (daemon: FakeDaemon, terminalId: string, text: string) =>
  daemon.send({ type: "output", terminalId, dataB64: Buffer.from(text).toString("base64") });

describe("Optio Local across API instances", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("(a) a viewer on B streams a daemon on A: snapshot, output, input, resize", async () => {
    const hostId = await registerHost(0, "scale-a");
    const daemon = await connectDaemon(0, hostId, cleanups);
    const terminalId = await runningShell(0, hostId, daemon);

    const viewer = await attachViewer(1, terminalId, daemon, "$ snapshot\r\n", cleanups);
    // The snapshot names its grid (replay), then the size, which is the viewer's to take.
    expect(viewer.control.find((m) => m.type === "replay")).toMatchObject({ cols: 100, rows: 30 });
    await waitFor(async () => (viewer.control.some((m) => m.type === "size") ? true : null));

    output(daemon, terminalId, "live 1\r\n");
    output(daemon, terminalId, "live 2\r\n");
    await waitFor(async () => (viewer.text().includes("live 2") ? true : null));
    expect(viewer.text()).toBe("$ snapshot\r\nlive 1\r\nlive 2\r\n");

    viewer.send({ type: "input", data: "ls -la\r" });
    const input = await daemon.next((m) => m.type === "input" && m.terminalId === terminalId);
    expect(Buffer.from(String(input.dataB64), "base64").toString()).toBe("ls -la\r");

    viewer.send({ type: "resize", cols: 140, rows: 45 });
    const resize = await daemon.next((m) => m.type === "resize" && m.terminalId === terminalId);
    expect(resize).toMatchObject({ cols: 140, rows: 45 });
    // The daemon's echo tells the viewer the grid is now its own.
    daemon.send({ type: "size", terminalId, cols: 140, rows: 45 });
    await waitFor(async () =>
      viewer.control.some((m) => m.type === "size" && m.cols === 140 && m.yours === true)
        ? true
        : null,
    );

    // A status change made through a third server reaches the viewer on B.
    const { status } = await api(2)(`/api/local/terminals/${terminalId}/kill`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(200);
    const kill = await daemon.next((m) => m.type === "kill" && m.terminalId === terminalId);
    expect(kill.terminalId).toBe(terminalId);
    daemon.send({ type: "exit", terminalId, exitCode: 0 });
    await waitFor(async () => (viewer.control.some((m) => m.type === "exit") ? true : null));

    // The viewer leaving tells the daemon there is nobody left to stream to.
    viewer.close();
  });

  it("(b) spawn, kill, dirs and limits through B reach the daemon on A and get their answers", async () => {
    const hostId = await registerHost(0, "scale-b");
    const daemon = await connectDaemon(0, hostId, cleanups);

    // Spawn through B.
    const terminalId = await runningShell(1, hostId, daemon);

    // Dirs through B: the daemon's answer comes back to B's request.
    const addDir = api(1)<{ host: HostRow; path: string }>(`/api/local/hosts/${hostId}/dirs`, {
      method: "POST",
      body: JSON.stringify({ path: "~/work/app" }),
    });
    const dirs = await daemon.next((m) => m.type === "dirs");
    expect(dirs).toMatchObject({ op: "add", path: "~/work/app" });
    daemon.send({
      type: "dirs-result",
      requestId: dirs.requestId,
      path: "/Users/e2e/work/app",
      dirs: [...DIRS, { path: "/Users/e2e/work/app" }],
    });
    const added = await addDir;
    expect(added.status).toBe(200);
    expect(added.body.path).toBe("/Users/e2e/work/app");
    expect(added.body.host.dirs.map((d) => d.path)).toContain("/Users/e2e/work/app");

    // Limits through C.
    const refresh = api(2)<{ limits: Json }>(`/api/local/hosts/${hostId}/limits/refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const ask = await daemon.next((m) => m.type === "limits-refresh");
    const codex = {
      primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null },
      secondary: null,
      planType: "pro",
      observedAt: new Date().toISOString(),
    };
    daemon.send({ type: "limits-refresh-result", requestId: ask.requestId, limits: { codex } });
    const refreshed = await refresh;
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.limits).toMatchObject({ codex: { primary: { usedPercent: 42 } } });

    // Input through B's REST.
    const typed = await api(1)(`/api/local/terminals/${terminalId}/input`, {
      method: "POST",
      body: JSON.stringify({ data: "echo hi" }),
    });
    expect(typed.status).toBe(200);
    const input = await daemon.next((m) => m.type === "input" && m.terminalId === terminalId);
    expect(Buffer.from(String(input.dataB64), "base64").toString()).toBe("echo hi");

    // Kill through B: the PTY is asked to die; the row isn't faked to exited.
    const killed = await api(1)(`/api/local/terminals/${terminalId}/kill`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(killed.status).toBe(200);
    await daemon.next((m) => m.type === "kill" && m.terminalId === terminalId);
    expect((await getTerminal(1, terminalId)).state).toBe("running");
    daemon.send({ type: "exit", terminalId, exitCode: 137 });
    await waitFor(async () =>
      (await getTerminal(2, terminalId)).state === "exited" ? true : null,
    );
  });

  it("(c) the daemon reconnects to B: A closes its socket, a viewer on A streams the new connection", async () => {
    const hostId = await registerHost(0, "scale-c");
    const first = await connectDaemon(0, hostId, cleanups);
    const terminalId = await runningShell(0, hostId, first);
    const viewer = await attachViewer(0, terminalId, first, "before\r\n", cleanups);

    // The same machine's daemon comes back on B (a laptop resume: the old
    // TCP connection may still look open). Newest wins.
    const second = new FakeDaemon(wsBase(1));
    cleanups.push(() => second.close());
    await second.connect(hostId, DIRS, [{ terminalId, running: true }], CAPS);
    const closed = await first.closed;
    expect(closed.code).toBe(4000);

    // The viewer on A was streaming the old connection: it is told to
    // reconnect (4503), as the clients do, and attaches to the new one.
    expect((await viewer.closed).code).toBe(4503);
    const again = await attachViewer(0, terminalId, second, "after\r\n", cleanups);
    output(second, terminalId, "from B\r\n");
    await waitFor(async () => (again.text().includes("from B") ? true : null));
    expect(again.text()).toBe("after\r\nfrom B\r\n");

    // Still online everywhere, and the terminal was never marked exited.
    expect((await everyLive((j) => onlineOn(j, hostId))).every(Boolean)).toBe(true);
    expect((await getTerminal(2, terminalId)).state).toBe("running");

    // Input from the viewer on A reaches the daemon on B.
    again.send({ type: "input", data: "q" });
    const input = await second.next((m) => m.type === "input" && m.terminalId === terminalId);
    expect(Buffer.from(String(input.dataB64), "base64").toString()).toBe("q");
  });

  it("(e) a local Job run started through B, with the daemon on A, runs to completion", async () => {
    const hostId = await registerHost(0, "scale-e");
    const daemon = await connectDaemon(0, hostId, cleanups);
    const { status, body } = await api(1)<{ task: { id: string } }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "standalone",
        name: `scale-out local job ${Math.random().toString(36).slice(2, 8)}`,
        prompt: "Say hello to {{name}}",
        agentType: "claude-code",
        runTarget: "local",
        localHostId: hostId,
        localDir: "/tmp/e2e-repo",
        localSessionMode: "headless",
        maxRetries: 0,
      }),
    });
    expect(status).toBe(201);
    const jobId = body.task.id;

    // Three runs, so the cross-server dispatch path is taken whichever
    // server's worker picks each one up.
    for (const name of ["Ada", "Grace", "Linus"]) {
      const started = await api(1)<{ runId: string }>(`/api/tasks/${jobId}/runs`, {
        method: "POST",
        body: JSON.stringify({ params: { name } }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId;
      const spawn = await daemon.next(
        (m) => m.type === "spawn" && (m.spec as Json).prompt === `Say hello to ${name}`,
        30_000,
      );
      const terminalId = String(spawn.terminalId);
      daemon.send({ type: "started", terminalId });
      daemon.send({
        type: "usage",
        terminalId,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          turns: 1,
          model: "claude-sonnet-4-5",
          costUsd: 0.001,
          updatedAt: new Date().toISOString(),
        },
      });
      daemon.send({ type: "exit", terminalId, exitCode: 0 });
      const run = await waitFor(
        async () => {
          const r = (
            await api(2)<{ run: { state: string; costUsd: string | null } }>(
              `/api/workflow-runs/${runId}`,
            )
          ).body.run;
          return r.state === "completed" || r.state === "failed" ? r : null;
        },
        { timeoutMs: 30_000 },
      );
      expect(run.state).toBe("completed");
      expect(run.costUsd).toBe("0.001");
    }
  });

  it("(f) every server agrees on whether the host is online", async () => {
    const hostId = await registerHost(2, "scale-f");
    expect(await everyLive((j) => onlineOn(j, hostId))).toEqual([false, false, false]);
    const daemon = await connectDaemon(1, hostId, cleanups);
    const terminalId = await runningShell(2, hostId, daemon);
    expect(await everyLive((j) => onlineOn(j, hostId))).toEqual([true, true, true]);
    expect(await everyLive((j) => recoveryOn(j, terminalId))).toEqual(["live", "live", "live"]);

    daemon.close();
    await waitFor(async () =>
      (await everyLive((j) => onlineOn(j, hostId))).every((up) => !up) ? true : null,
    );
    expect(await everyLive((j) => recoveryOn(j, terminalId))).toEqual([
      "reconnecting",
      "reconnecting",
      "reconnecting",
    ]);
    const hosts = (await api(0)<{ hosts: HostRow[] }>("/api/local/hosts")).body.hosts;
    expect(hosts.find((h) => h.id === hostId)?.state).toBe("offline");
    // Nothing exited: the PTY lives on the machine; the next hello reconciles it.
    expect((await getTerminal(0, terminalId)).state).toBe("running");
  });

  // Last: it kills server 0.
  it("(d) A is killed while it owns the host: the daemon moves to B, the terminal lives on", async () => {
    const hostId = await registerHost(0, "scale-d");
    const daemon = await connectDaemon(0, hostId, cleanups);
    const terminalId = await runningShell(0, hostId, daemon);
    // A viewer on C, streaming through A.
    const onC = await attachViewer(2, terminalId, daemon, "on C\r\n", cleanups);

    await cluster.kill(0);
    expect((await daemon.closed).code).not.toBe(4000);

    // The daemon reconnects to B and reports its terminal still running.
    const moved = new FakeDaemon(wsBase(1));
    cleanups.push(() => moved.close());
    await moved.connect(hostId, DIRS, [{ terminalId, running: true }], CAPS);
    await waitFor(async () =>
      (await everyLive((j) => onlineOn(j, hostId))).every(Boolean) ? true : null,
    );
    expect((await getTerminal(1, terminalId)).state).toBe("running");

    // C's viewer was streaming through A: it is told to reconnect, and does.
    expect((await onC.closed).code).toBe(4503);
    const again = await attachViewer(2, terminalId, moved, "after the move\r\n", cleanups);
    output(moved, terminalId, "still alive\r\n");
    await waitFor(async () => (again.text().includes("still alive") ? true : null));

    // A viewer on B (the new owner) streams it directly.
    const onB = await attachViewer(1, terminalId, moved, "on B\r\n", cleanups);
    output(moved, terminalId, "both\r\n");
    await waitFor(async () =>
      onB.text().includes("both") && again.text().includes("both") ? true : null,
    );

    // Nothing was marked exited, and the survivors agree it is online.
    expect((await getTerminal(2, terminalId)).state).toBe("running");
    expect(await everyLive((j) => recoveryOn(j, terminalId))).toEqual(["live", "live"]);
  });
});
