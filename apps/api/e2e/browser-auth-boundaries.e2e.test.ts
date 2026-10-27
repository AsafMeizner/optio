/** Real HTTP + WebSocket authentication with production-style HTTPS cookies. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const token = randomBytes(32).toString("hex");
const userId = randomUUID();
const workspaceId = randomUUID();
const email = "admin@browser-auth.e2e";
let server: ApiServerHandle;

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`INSERT INTO workspaces (id, name, slug) VALUES (${workspaceId}, 'Auth boundaries', ${workspaceId})`;
    await sql`INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
      VALUES (${userId}, 'oidc', ${userId}, ${email}, 'Unverified identity', ${workspaceId})`;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'member')`;
    await sql`INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}, ${createHash("sha256").update(token).digest("hex")}, now() + interval '1 day')`;
  } finally {
    await sql.end();
  }
  server = await startApiServer({
    env: {
      OPTIO_AUTH_DISABLED: "false",
      PUBLIC_URL: "https://optio.example",
      OPTIO_DEPLOYMENT_ADMINS: email,
    },
  });
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

it("keeps setup repository access private before any agent credentials exist", async () => {
  const response = await fetch(`${server.baseUrl}/api/setup/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(401);
});

it("requires host-bound cookies on HTTPS deployments and preserves Bearer clients", async () => {
  const planted = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: { cookie: `optio_session=${token}` },
  });
  expect(planted.status).toBe(401);
  const real = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: { cookie: `__Host-optio_session=${token}` },
  });
  expect(real.status).toBe(200);
  const native = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(native.status).toBe(200);
  expect((await native.json()).user.deploymentAdmin).toBe(false);
});

it("blocks a forged browser mutation while allowing the configured origin", async () => {
  const headers = { cookie: `__Host-optio_session=${token}`, "content-type": "application/json" };
  const forged = await fetch(`${server.baseUrl}/api/auth/api-keys`, {
    method: "POST",
    headers: { ...headers, origin: "https://hostile.example" },
    body: JSON.stringify({ name: "forged" }),
  });
  expect(forged.status).toBe(403);
  const real = await fetch(`${server.baseUrl}/api/auth/api-keys`, {
    method: "POST",
    headers: { ...headers, origin: "https://optio.example" },
    body: JSON.stringify({ name: "legitimate" }),
  });
  expect(real.status).toBe(201);
});

it("rechecks workspace membership when a single-use WebSocket token is redeemed", async () => {
  const response = await fetch(`${server.baseUrl}/api/auth/ws-token`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const upgrade = (await response.json()).token;
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`DELETE FROM workspace_members WHERE user_id = ${userId}`;
  } finally {
    await sql.end();
  }
  const socket = new WebSocket(`${server.baseUrl.replace("http:", "ws:")}/ws/events`, [
    "optio-ws-v1",
    `optio-auth-${upgrade}`,
  ]);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket did not reject revoked membership"));
    }, 5_000);
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket upgrade failed"));
    };
  });
  expect(code).toBe(4403);
});
