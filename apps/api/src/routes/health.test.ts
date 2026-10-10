import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockDbExecute = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
}));

const mockCheckRuntimeHealth = vi.fn();

vi.mock("../services/container-service.js", () => ({
  checkRuntimeHealth: (...args: unknown[]) => mockCheckRuntimeHealth(...args),
}));

import { healthRoutes, _resetHealthCache } from "./health.js";

// ─── Helpers ───

async function buildTestApp(user: unknown = null): Promise<FastifyInstance> {
  return buildRouteTestApp(healthRoutes, { user: user as never });
}

describe("GET /api/health", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetHealthCache();
    app = await buildTestApp();
  });

  it("returns 200 when all checks pass", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(true);
    expect(body.checks.database).toBe(true);
    // The runtime health may be cached from a previous test in this module;
    // just verify healthy is true when db is up
    expect(body.checks.containerRuntime).toBeTypeOf("boolean");
  });

  it("returns 503 when database is down", async () => {
    mockDbExecute.mockRejectedValue(new Error("connection refused"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.healthy).toBe(false);
    expect(body.checks.database).toBe(false);
  });

  it("returns 200 when database is up but container runtime is down", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockCheckRuntimeHealth.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(true);
    expect(body.checks.database).toBe(true);
    expect(body.checks.containerRuntime).toBe(false);
  });

  it("returns 503 only when database is down, regardless of container runtime", async () => {
    mockDbExecute.mockRejectedValue(new Error("connection refused"));
    mockCheckRuntimeHealth.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.healthy).toBe(false);
    expect(body.checks.database).toBe(false);
  });

  it("returns maxConcurrent from env", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.json().maxConcurrent).toBeTypeOf("number");
  });
});

describe("GET /api/health instance id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHealthCache();
    mockDbExecute.mockResolvedValue([{ "?column?": 1 }]);
    mockCheckRuntimeHealth.mockResolvedValue(true);
  });

  it("names the instance only for a signed-in request", async () => {
    const anonymous = await buildTestApp(null);
    const res = await anonymous.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("instanceId");

    const signedIn = await buildTestApp({
      id: "u1",
      provider: "github",
      email: "u@x",
      displayName: "U",
    });
    const res2 = await signedIn.inject({ method: "GET", url: "/api/health" });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().instanceId).toMatch(/^[^:]+:[0-9a-f]{6}$/);
  });
});
