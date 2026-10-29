import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { mockTask } from "../test-utils/fixtures.js";

// ─── Mocks ───

const mockGetSubtasks = vi.fn();
const mockCreateSubtask = vi.fn();
const mockQueueSubtask = vi.fn();
const mockCheckBlockingSubtasks = vi.fn();

vi.mock("../services/subtask-service.js", () => ({
  getSubtasks: (...args: unknown[]) => mockGetSubtasks(...args),
  createSubtask: (...args: unknown[]) => mockCreateSubtask(...args),
  queueSubtask: (...args: unknown[]) => mockQueueSubtask(...args),
  checkBlockingSubtasks: (...args: unknown[]) => mockCheckBlockingSubtasks(...args),
}));

const mockGetTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
}));

// Ownership as work-ownership.ts states it, without its display-name lookup.
vi.mock("../services/work-ownership.js", () => ({
  workActor: (req: { user?: { id: string } }) => ({ userId: req.user?.id ?? null }),
  workChangeError: async (owner: string | null, actor: { userId: string | null }) =>
    owner && owner !== actor.userId ? "Only its owner can run this" : null,
}));

import { subtaskRoutes } from "./subtasks.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(subtaskRoutes);
}

const mockTaskData = { ...mockTask };
const mockSubtaskData = { ...mockTask, id: "sub-1", parentTaskId: "task-1" };

describe("GET /api/tasks/:id/subtasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists subtasks for a task", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetSubtasks.mockResolvedValue([{ ...mockSubtaskData, title: "Step 1" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks" });

    expect(res.statusCode).toBe(200);
    expect(res.json().subtasks).toHaveLength(1);
  });

  it("returns 404 if parent task not found", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent/subtasks" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 if task is in a different workspace", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/subtasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates and auto-queues a child subtask", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      ...mockSubtaskData,
      title: "Child task",
      subtaskOrder: 0,
    });
    mockQueueSubtask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Child task", prompt: "Do the thing", taskType: "child" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().subtask.id).toBe("sub-1");
    expect(mockQueueSubtask).toHaveBeenCalledWith("sub-1");
  });

  it("auto-queues first step but not subsequent steps", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      ...mockSubtaskData,
      id: "sub-2",
      title: "Step 2",
      subtaskOrder: 1,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Step 2", prompt: "Do step 2", taskType: "step" },
    });

    expect(res.statusCode).toBe(201);
    // subtaskOrder 1 means not the first step, so should NOT auto-queue
    expect(mockQueueSubtask).not.toHaveBeenCalled();
  });

  it("respects autoQueue=false", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      ...mockSubtaskData,
      title: "Manual task",
      subtaskOrder: 0,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Manual task", prompt: "Wait for me", autoQueue: false },
    });

    expect(res.statusCode).toBe(201);
    expect(mockQueueSubtask).not.toHaveBeenCalled();
  });

  it("refuses a subtask under someone else's private task", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, ownerUserId: "someone-else" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Block it", prompt: "x", blocksParent: true },
    });

    expect(res.statusCode).toBe(403);
    expect(mockCreateSubtask).not.toHaveBeenCalled();
    expect(mockQueueSubtask).not.toHaveBeenCalled();
  });

  it("rejects missing title (400 from Zod body schema)", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { prompt: "Do something" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/tasks/:id/subtasks/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns blocking subtask status", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCheckBlockingSubtasks.mockResolvedValue({
      allComplete: false,
      total: 3,
      pending: 0,
      running: 2,
      completed: 1,
      failed: 0,
    });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().allComplete).toBe(false);
    expect(res.json().total).toBe(3);
  });
});

describe("private task resource visibility", () => {
  it.each(["subtasks", "subtasks/status"])("hides %s from a different member", async (resource) => {
    vi.clearAllMocks();
    mockGetTask.mockResolvedValue({
      id: "task-private",
      workspaceId: "ws-1",
      ownerUserId: "someone-else",
    });
    const app = await buildRouteTestApp(subtaskRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "member" },
    });
    try {
      const res = await app.inject({ method: "GET", url: `/api/tasks/task-private/${resource}` });
      expect(res.statusCode).toBe(404);
      expect(mockGetSubtasks).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
