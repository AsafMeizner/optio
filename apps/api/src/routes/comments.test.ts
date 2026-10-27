import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { mockTaskComment, mockTaskEvent } from "../test-utils/fixtures.js";

// ─── Mocks ───

const mockListComments = vi.fn();
const mockAddComment = vi.fn();
const mockUpdateComment = vi.fn();
const mockDeleteComment = vi.fn();

vi.mock("../services/comment-service.js", () => ({
  listComments: (...args: unknown[]) => mockListComments(...args),
  addComment: (...args: unknown[]) => mockAddComment(...args),
  updateComment: (...args: unknown[]) => mockUpdateComment(...args),
  deleteComment: (...args: unknown[]) => mockDeleteComment(...args),
}));

const mockGetTask = vi.fn();
const mockGetTaskEvents = vi.fn();

vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTaskEvents: (...args: unknown[]) => mockGetTaskEvents(...args),
}));

const mockListMessages = vi.fn().mockResolvedValue([]);

vi.mock("../services/task-message-service.js", () => ({
  listMessages: (...args: unknown[]) => mockListMessages(...args),
}));

import { commentRoutes } from "./comments.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(commentRoutes);
}

describe("GET /api/tasks/:id/comments", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists comments for a task", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockListComments.mockResolvedValue([{ ...mockTaskComment, content: "Hello" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/comments" });

    expect(res.statusCode).toBe(200);
    expect(res.json().comments).toHaveLength(1);
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent/comments" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/comments", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("adds a comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockAddComment.mockResolvedValue({ ...mockTaskComment, content: "New comment" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/comments",
      payload: { content: "New comment" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddComment).toHaveBeenCalledWith("task-1", "New comment", "user-1");
  });

  it("rejects empty content (400 from Zod body schema)", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/comments",
      payload: { content: "" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/tasks/:taskId/comments/:commentId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockUpdateComment.mockResolvedValue({ ...mockTaskComment, content: "Updated" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/c-1",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateComment).toHaveBeenCalledWith("task-1", "c-1", "Updated", "user-1");
  });

  it("returns 404 for nonexistent comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockUpdateComment.mockRejectedValue(new Error("Comment not found"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/nonexistent",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for unauthorized edit", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockUpdateComment.mockRejectedValue(new Error("Not authorized to edit"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/c-1",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/tasks/:taskId/comments/:commentId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockDeleteComment.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/tasks/task-1/comments/c-1" });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteComment).toHaveBeenCalledWith("task-1", "c-1", "user-1");
  });

  it("returns 404 for nonexistent comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockDeleteComment.mockRejectedValue(new Error("Comment not found"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/comments/nonexistent",
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/tasks/:id/activity", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns interleaved activity feed", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockListComments.mockResolvedValue([
      {
        ...mockTaskComment,
        content: "Comment",
        createdAt: new Date("2026-03-27T10:00:00Z"),
      },
    ]);
    mockGetTaskEvents.mockResolvedValue([
      {
        ...mockTaskEvent,
        fromState: "pending",
        toState: "queued",
        trigger: "submit",
        createdAt: new Date("2026-03-27T09:00:00Z"),
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/activity" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activity).toHaveLength(2);
    // Sorted by createdAt: event first (09:00), then comment (10:00)
    expect(body.activity[0].type).toBe("event");
    expect(body.activity[1].type).toBe("comment");
  });
});

describe("workspace scoping", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 404 for PATCH comment on task in different workspace", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/c-1",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(404);
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });

  it("returns 404 for DELETE comment on task in different workspace", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/comments/c-1",
    });

    expect(res.statusCode).toBe(404);
    expect(mockDeleteComment).not.toHaveBeenCalled();
  });
});

describe("private task resource visibility", () => {
  it.each(["comments", "activity"])("hides %s from a different member", async (resource) => {
    vi.clearAllMocks();
    mockGetTask.mockResolvedValue({
      id: "task-private",
      workspaceId: "ws-1",
      ownerUserId: "someone-else",
    });
    const app = await buildRouteTestApp(commentRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "member" },
    });
    try {
      const res = await app.inject({ method: "GET", url: `/api/tasks/task-private/${resource}` });
      expect(res.statusCode).toBe(404);
      expect(mockListComments).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
