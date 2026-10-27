import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockTransitionTask = vi.fn();

vi.mock("../services/task-service.js", () => ({
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: { id: "id", state: "state", workspaceId: "workspaceId" },
}));

import { bulkRoutes } from "./bulk.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(bulkRoutes);
}

describe("POST /api/tasks/bulk/retry-failed", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("retries all failed tasks", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "task-1" }, { id: "task-2" }]),
    };
    mockDbSelect.mockReturnValue(chainable);
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/retry-failed" });

    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(2);
    expect(res.json().total).toBe(2);
    expect(mockTransitionTask).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("skips tasks that fail to transition", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "task-1" }, { id: "task-2" }]),
    };
    mockDbSelect.mockReturnValue(chainable);
    mockTransitionTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Invalid transition"));

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/retry-failed" });

    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(1);
    expect(res.json().total).toBe(2);
  });

  it("returns zero when no failed tasks exist", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValue(chainable);

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/retry-failed" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ retried: 0, total: 0 });
  });
});

describe("POST /api/tasks/bulk/cancel-active", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("cancels all running and queued tasks", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn(),
    };
    chainable.where
      .mockResolvedValueOnce([{ id: "task-1", state: "running" }]) // running
      .mockResolvedValueOnce([{ id: "task-2", state: "queued" }]); // queued

    mockDbSelect.mockReturnValue(chainable);
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/cancel-active" });

    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toBe(2);
    expect(res.json().total).toBe(2);
  });
});

describe("bulk task ownership", () => {
  it.each(["member", "admin"] as const)(
    "never retries someone else's personal work for a %s",
    async (workspaceRole) => {
      vi.clearAllMocks();
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([
          { id: "org", ownerUserId: null },
          { id: "mine", ownerUserId: "user-1" },
          { id: "theirs", ownerUserId: "user-2" },
        ]),
      });
      mockTransitionTask.mockResolvedValue(undefined);
      const app = await buildRouteTestApp(bulkRoutes, {
        user: { id: "user-1", workspaceId: "ws-1", workspaceRole },
      });
      try {
        const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/retry-failed" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ retried: 2, total: 2 });
        expect(mockTransitionTask.mock.calls.map(([id]) => id)).toEqual(["org", "mine"]);
      } finally {
        await app.close();
      }
    },
  );

  it("never cancels someone else's personal work", async () => {
    vi.clearAllMocks();
    const where = vi
      .fn()
      .mockResolvedValueOnce([{ id: "theirs", ownerUserId: "user-2" }])
      .mockResolvedValueOnce([{ id: "mine", ownerUserId: "user-1" }]);
    mockDbSelect.mockReturnValue({ from: vi.fn().mockReturnThis(), where });
    mockTransitionTask.mockResolvedValue(undefined);
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/tasks/bulk/cancel-active" });
      expect(res.json()).toEqual({ cancelled: 1, total: 1 });
      expect(mockTransitionTask.mock.calls.map(([id]) => id)).toEqual(["mine"]);
    } finally {
      await app.close();
    }
  });
});
