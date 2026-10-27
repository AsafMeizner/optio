/** Regression: legacy placement settings cannot run a user-controlled harness in the API. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

it("isolates assistant turns in agent pods even with legacy api-pod placement configured", async () => {
  const chat = await peer();
  const { sessionId } = chat.frames.find((f) => f.type === "history");
  chat.ws.send(
    JSON.stringify({ type: "message", content: "List my machines", requestId: randomUUID() }),
  );
  await waitFor(
    async () => chat.frames.find((f) => f.type === "text" && f.content.includes("Mock agent")),
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

  // Neither the harness nor setup files ran in the API filesystem, despite
  // an installed harness and an explicit legacy api-pod environment setting.
  expect(readdirSync(agentHome)).toEqual([]);
  expect(existsSync(join(agentHome, "optio", "sessions", sessionId))).toBe(false);
  const session = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`).then((r) => r.json());
  expect(session.session.podId).toEqual(expect.any(String));
}, 120_000);
