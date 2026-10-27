import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  taskComments: {
    id: "id",
    taskId: "task_id",
    userId: "user_id",
    content: "content",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  users: {
    id: "id",
    displayName: "display_name",
    avatarUrl: "avatar_url",
  },
}));

vi.mock("./event-bus.js", () => ({ publishEvent: vi.fn() }));

import { db } from "../db/client.js";
import { publishEvent } from "./event-bus.js";
import { addComment, listComments, updateComment, deleteComment } from "./comment-service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addComment", () => {
  it("inserts a comment and publishes event", async () => {
    const mockComment = {
      id: "comment-1",
      taskId: "task-1",
      userId: "user-1",
      content: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockComment]),
      }),
    });

    const result = await addComment("task-1", "hello", "user-1");

    expect(result).toEqual(mockComment);
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task:comment",
        taskId: "task-1",
        commentId: "comment-1",
      }),
    );
  });
});

describe("listComments", () => {
  it("returns comments with user info", async () => {
    const rows = [
      {
        id: "c1",
        taskId: "t1",
        userId: "u1",
        content: "test",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        userName: "Alice",
        userAvatar: "https://example.com/avatar.png",
      },
    ];
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    });

    const result = await listComments("t1");

    expect(result).toHaveLength(1);
    expect(result[0].user).toEqual({
      id: "u1",
      displayName: "Alice",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("returns undefined user when userId is null", async () => {
    const rows = [
      {
        id: "c1",
        taskId: "t1",
        userId: null,
        content: "system comment",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        userName: null,
        userAvatar: null,
      },
    ];
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    });

    const result = await listComments("t1");

    expect(result[0].user).toBeUndefined();
  });
});

describe("updateComment", () => {
  it("throws when comment not found", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(updateComment("task-1", "nonexistent", "new content")).rejects.toThrow(
      "Comment not found",
    );
  });

  it("throws when user is not the author", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "c1", userId: "user-a", content: "old" }]),
      }),
    });

    await expect(updateComment("task-1", "c1", "new content", "user-b")).rejects.toThrow(
      "Not authorized",
    );
  });
});

describe("deleteComment", () => {
  it("throws when comment not found", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(deleteComment("task-1", "nonexistent")).rejects.toThrow("Comment not found");
  });

  it("throws when user is not the author", async () => {
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "c1", userId: "user-a", content: "test" }]),
      }),
    });

    await expect(deleteComment("task-1", "c1", "user-b")).rejects.toThrow("Not authorized");
  });
});

it("does not let a signed-in user rewrite or delete an authorless system comment", async () => {
  (db.select as any).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ id: "system", taskId: "task-1", userId: null }]),
    }),
  });
  await expect(updateComment("task-1", "system", "replacement", "user-1")).rejects.toThrow(
    "Not authorized",
  );
  await expect(deleteComment("task-1", "system", "user-1")).rejects.toThrow("Not authorized");
});
