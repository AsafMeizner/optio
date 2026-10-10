import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockSyncEnvSource = vi.fn();

vi.mock("../services/config/source.js", () => {
  class ConfigApplyBusyError extends Error {}
  return {
    ConfigApplyBusyError,
    configStatus: vi.fn(),
    syncEnvSource: (...args: unknown[]) => mockSyncEnvSource(...args),
  };
});
vi.mock("../services/config/apply.js", () => ({ applyManifests: vi.fn(), detachObject: vi.fn() }));
vi.mock("../services/config/export.js", () => ({
  exportManifests: vi.fn(),
  manifestsToYaml: vi.fn(),
}));
vi.mock("../services/optio-action-service.js", () => ({ logAction: vi.fn() }));

import { configRoutes } from "./config.js";
import { ConfigApplyBusyError } from "../services/config/source.js";

describe("POST /api/config/source/sync", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(configRoutes);
  });

  it("answers 409 with a readable message while another instance is applying", async () => {
    mockSyncEnvSource.mockRejectedValue(new ConfigApplyBusyError());
    const res = await app.inject({ method: "POST", url: "/api/config/source/sync" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/still running; try again/);
  });

  it("answers 404 when config as code is off", async () => {
    mockSyncEnvSource.mockResolvedValue(null);
    const res = await app.inject({ method: "POST", url: "/api/config/source/sync" });
    expect(res.statusCode).toBe(404);
  });
});
