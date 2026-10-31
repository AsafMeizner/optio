import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// Starter prompts have no workspace: every workspace lists them, so the
// restore (which rewrites edited ones) is gated on a deployment admin.

vi.mock("../services/prompt-template-service.js", () => ({}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({ promptTemplates: {} }));

const mockIsDeploymentAdmin = vi.fn();
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: (...args: unknown[]) => mockIsDeploymentAdmin(...args),
  hasDeploymentAdmin: vi.fn().mockResolvedValue(true),
  isFoundingWorkspaceAdmin: vi.fn().mockResolvedValue(false),
}));

const mockSeedStarterPrompts = vi.fn();
vi.mock("../services/starter-prompts.js", () => ({
  seedStarterPrompts: (...args: unknown[]) => mockSeedStarterPrompts(...args),
}));

import { promptTemplateRoutes } from "./prompt-templates.js";

const seed = async (workspaceRole: "admin" | "member" | "viewer") => {
  const app = await buildRouteTestApp(promptTemplateRoutes, {
    user: { id: "user-1", workspaceId: "ws-a", workspaceRole },
  });
  try {
    return await app.inject({ method: "POST", url: "/api/prompt-templates/seed" });
  } finally {
    await app.close();
  }
};

describe("POST /api/prompt-templates/seed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a deployment admin restores the starter prompts and sees what changed", async () => {
    mockIsDeploymentAdmin.mockResolvedValue(true);
    mockSeedStarterPrompts.mockResolvedValueOnce({ created: 2, restored: 1, unchanged: 10 });
    const res = await seed("admin");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 2, restored: 1, unchanged: 10 });
    expect(mockSeedStarterPrompts).toHaveBeenCalledWith({ restore: true });
  });

  it("a workspace admin who is not a deployment admin can't rewrite the shared starter rows", async () => {
    mockIsDeploymentAdmin.mockResolvedValue(false);
    const res = await seed("admin");
    expect(res.statusCode).toBe(403);
    expect(mockSeedStarterPrompts).not.toHaveBeenCalled();
  });

  it.each(["member", "viewer"] as const)("refuses a %s", async (role) => {
    mockIsDeploymentAdmin.mockResolvedValue(true);
    const res = await seed(role);
    expect(res.statusCode).toBe(403);
    expect(mockSeedStarterPrompts).not.toHaveBeenCalled();
  });
});
