/**
 * E2E: the API servers the test tiers start (this tier and the web e2e stack,
 * both via startApiServer) are hermetic. They run next to the developer's
 * real Optio, so they must never reach its cluster or its Claude login:
 * cluster routes are served by a fake read-only Kubernetes API, the host's
 * Keychain / ~/.claude credentials are invisible, and a request to a git
 * platform (the dummy GITHUB_TOKEN the tiers seed) is answered in-process
 * (src/test-utils/e2e/hermetic-env.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function get(path: string) {
  const res = await fetch(`${server.baseUrl}${path}`);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // text/plain
  }
  return { status: res.status, body };
}

describe("test API servers are isolated from this machine", () => {
  it("serve the cluster pages from the fake read-only Kubernetes API", async () => {
    const { status, body } = await get("/api/cluster/overview");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.nodes.map((n: { name: string }) => n.name)).toEqual(["test-node"]);
    expect(body.pods.map((p: { name: string }) => p.name)).toContain("optio-api-0");
  });

  it("cannot see this machine's Claude login", async () => {
    const token = await get("/api/auth/claude-token");
    expect(token.status).toBe(503);

    const status = await get("/api/auth/status");
    expect(status.status).toBe(200);
    expect(status.body.subscription.available).toBe(false);
  });

  it("answers its GitHub calls itself: a dummy token never reaches api.github.com", async () => {
    const secret = await fetch(`${server.baseUrl}/api/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GITHUB_TOKEN", value: "e2e-dummy-token", scope: "global" }),
    });
    expect(secret.status).toBe(201);
    const { status, body } = await get("/api/repos/github/accessible");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.error).toBe("GitHub returned 401");
    expect(server.logs()).toContain("[hermetic] answered GET https://api.github.com locally");
  });
});
