import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { persistentAgentInternalRoutes } from "./persistent-agent-internal.js";

const mockSelect = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock("../services/persistent-agent-service.js", () => ({
  getPersistentAgentBySlug: vi.fn(),
  getPersistentAgentUnscoped: vi.fn(),
  wakeAgent: vi.fn(),
  listRecentMessages: vi.fn(),
}));

vi.mock("../services/controller-auth.js", () => ({
  validateControllerToken: vi.fn(),
}));
import { validateControllerToken } from "../services/controller-auth.js";
import { getPersistentAgentUnscoped } from "../services/persistent-agent-service.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function selectResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(persistentAgentInternalRoutes);
  await app.ready();
  return app;
}

describe("persistentAgentInternalRoutes auth", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects missing agent tokens", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/internal/persistent-agents",
    });

    expect(res.statusCode).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects malformed agent tokens before querying", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/internal/persistent-agents",
      headers: { "x-optio-agent-token": "not-a-uuid" },
    });

    expect(res.statusCode).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a valid agent token and scopes peer listing to its workspace", async () => {
    vi.mocked(validateControllerToken).mockResolvedValue({
      actor: { userId: null, workspaceId: "ws-1", isAdmin: false },
      access: "manage",
      name: "Forge",
      run: { kind: "turn", id: "turn-1", agentId: AGENT_ID },
    });
    vi.mocked(getPersistentAgentUnscoped).mockResolvedValue({
      id: AGENT_ID,
      slug: "forge",
      name: "Forge",
      workspaceId: "ws-1",
    } as Awaited<ReturnType<typeof getPersistentAgentUnscoped>>);
    mockSelect.mockReturnValueOnce(
      selectResult([
        {
          slug: "scribe",
          name: "Scribe",
          description: "Writes notes",
          state: "running",
          enabled: true,
        },
      ]),
    );
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/internal/persistent-agents",
      headers: { "x-optio-agent-token": "signed-turn-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      agents: [
        {
          slug: "scribe",
          name: "Scribe",
          description: "Writes notes",
          state: "running",
          enabled: true,
        },
      ],
      me: { slug: "forge" },
    });
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(validateControllerToken).toHaveBeenCalledWith("signed-turn-token", "messages");
    await app.close();
  });
});
