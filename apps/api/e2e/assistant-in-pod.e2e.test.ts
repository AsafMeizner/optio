/**
 * Ask Optio in the API pod (OPTIO_ASSISTANT_PLACEMENT=api-pod): a turn runs
 * as a child process of the API through the process runtime, with a fake
 * `claude` on PATH (test-utils/e2e/fake-harness) that plays the fake
 * runtime's tape, and never touches an agent pod.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const shimDir = fileURLToPath(new URL("../src/test-utils/e2e/fake-harness", import.meta.url));
const agentHome = mkdtempSync(join(tmpdir(), "optio-agent-home-"));
let server: ApiServerHandle;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  server = await startApiServer({
    env: {
      OPTIO_ASSISTANT_PLACEMENT: "api-pod",
      OPTIO_AGENT_HOME_DIR: agentHome,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    },
  });
  const res = await fetch(`${server.baseUrl}/api/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ANTHROPIC_API_KEY", value: "dummy-test-key" }),
  });
  expect([200, 201]).toContain(res.status);
}, 150_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.stop();
  rmSync(agentHome, { recursive: true, force: true });
});

async function peer(path = "/ws/optio/chat") {
  const frames: any[] = [];
  const ws = new WebSocket(server.baseUrl.replace("http", "ws") + path);
  sockets.push(ws);
  ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  await waitFor(async () => frames.find((f) => f.type === "status"), { label: "chat ready" });
  return { ws, frames };
}

it("runs an assistant turn as a child process of the API, in the agent home, with no agent pod", async () => {
  const chat = await peer();
  const { sessionId } = chat.frames.find((f) => f.type === "history");
  chat.ws.send(
    JSON.stringify({ type: "message", content: "List my machines", requestId: randomUUID() }),
  );
  await waitFor(
    async () =>
      chat.frames.find((f) => f.type === "text" && f.content.includes("Mock agent handled:")),
    { label: "the fake claude's reply", timeoutMs: 60_000 },
  );
  await waitFor(
    async () => chat.frames.filter((f) => f.type === "status" && f.status === "ready").length === 2,
  );
  expect(
    chat.frames.filter((f) => f.type === "error"),
    server.logs(),
  ).toEqual([]);
  // The setup's own lines ("wrote …/.mcp.json") are not part of the conversation.
  expect(chat.frames.filter((f) => f.type === "text" && /^wrote /.test(f.content))).toEqual([]);

  // The turn ran in this process: its run home is under the agent home, with
  // the protocol's files, and the server said so.
  const runs = join(agentHome, "optio", "runs");
  const turnDirs = existsSync(runs) ? readdirSync(runs) : [];
  expect(turnDirs.length).toBeGreaterThanOrEqual(1);
  const output = readFileSync(join(runs, turnDirs[0]!, "output.ndjson"), "utf8");
  expect(output).toContain("Mock agent handled:");
  expect(readFileSync(join(runs, turnDirs[0]!, "exit"), "utf8").trim()).toBe("0");
  expect(existsSync(join(agentHome, "optio", "sessions", sessionId))).toBe(true);
  const session = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`).then((r) => r.json());
  expect(session.session.podId ?? null).toBeNull();
}, 120_000);
