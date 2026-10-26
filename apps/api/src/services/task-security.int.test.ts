import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskComments, taskDependencies, tasks, users } from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { dependencyRoutes } from "../routes/dependencies.js";
import { commentRoutes } from "../routes/comments.js";
import { addDependencies, getDependencies, getDependents } from "./dependency-service.js";
import { createSubtask } from "./subtask-service.js";

vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => false }));
vi.mock("../workers/task-worker.js", () => ({ taskQueue: { add: vi.fn() } }));

const apps: Array<Awaited<ReturnType<typeof buildRouteTestApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function user() {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@example.com`,
      displayName: "Owner",
    })
    .returning();
  return row;
}

describe("task execution and resource authorization", () => {
  it("rejects foreign-workspace dependencies through HTTP and the submission service", async () => {
    const workspace = await insertWorkspace();
    const otherWorkspace = await insertWorkspace();
    const owner = await user();
    const source = await insertTask({ workspaceId: workspace.id });
    const foreign = await insertTask({
      workspaceId: otherWorkspace.id,
      title: "Private foreign title",
    });
    const app = await buildRouteTestApp(dependencyRoutes, {
      user: { id: owner.id, workspaceId: workspace.id, workspaceRole: "member" },
    });
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${source.id}/dependencies`,
      payload: { dependsOnIds: [foreign.id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(foreign.title);
    await expect(addDependencies(source.id, [foreign.id])).rejects.toThrow("not found");
    expect(
      await db.select().from(taskDependencies).where(eq(taskDependencies.taskId, source.id)),
    ).toEqual([]);
  });

  it("does not let organization work disclose private dependencies, even for its creator", async () => {
    const workspace = await insertWorkspace();
    const owner = await user();
    const organization = await insertTask({ workspaceId: workspace.id, createdBy: owner.id });
    const personal = await insertTask({ workspaceId: workspace.id, ownerUserId: owner.id });
    await expect(addDependencies(organization.id, [personal.id])).rejects.toThrow("not found");
    await addDependencies(personal.id, [organization.id]);
    expect(await getDependencies(personal.id)).toMatchObject([{ id: organization.id }]);
  });

  it("ignores unsafe historical edges for reads and automatic dependency advancement", async () => {
    const first = await insertWorkspace();
    const second = await insertWorkspace();
    const owner = await user();
    const source = await insertTask({ workspaceId: first.id });
    const foreign = await insertTask({ workspaceId: second.id });
    const privateTask = await insertTask({ workspaceId: first.id, ownerUserId: owner.id });
    await db.insert(taskDependencies).values([
      { taskId: source.id, dependsOnTaskId: foreign.id },
      { taskId: source.id, dependsOnTaskId: privateTask.id },
    ]);
    expect(await getDependencies(source.id)).toEqual([]);
    expect(await getDependents(foreign.id)).toEqual([]);
    expect(await getDependents(privateTask.id)).toEqual([]);
  });

  it("does not expose a private dependent through an organization's reverse dependency list", async () => {
    const workspace = await insertWorkspace();
    const owner = await user();
    const reader = await user();
    const source = await insertTask({ workspaceId: workspace.id, ownerUserId: owner.id });
    const target = await insertTask({ workspaceId: workspace.id });
    await addDependencies(source.id, [target.id]);
    const app = await buildRouteTestApp(dependencyRoutes, {
      user: { id: reader.id, workspaceId: workspace.id, workspaceRole: "member" },
    });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: `/api/tasks/${target.id}/dependents` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dependents: [] });
  });

  it("preserves a parent's owner and restricted environment in automatically created subtasks", async () => {
    const workspace = await insertWorkspace();
    const owner = await user();
    const parent = await insertTask({
      workspaceId: workspace.id,
      ownerUserId: owner.id,
      podSecrets: [],
      settings: { controllerAccess: "off", connections: { remove: [randomUUID()] } },
      repoBranch: "release",
      autoMerge: false,
      autoResume: false,
    });
    const child = await createSubtask({
      parentTaskId: parent.id,
      title: "Review",
      prompt: "Review the changes",
      taskType: "review",
    });
    const [stored] = await db.select().from(tasks).where(eq(tasks.id, child.id));
    expect(stored).toMatchObject({
      workspaceId: workspace.id,
      ownerUserId: owner.id,
      podSecrets: [],
      settings: parent.settings,
      repoBranch: "release",
      autoMerge: false,
      autoResume: false,
    });
  });

  it.each(["PATCH", "DELETE"] as const)(
    "binds %s comment IDs to the authorized task",
    async (method) => {
      const workspace = await insertWorkspace();
      const foreignWorkspace = await insertWorkspace();
      const owner = await user();
      const ownTask = await insertTask({ workspaceId: workspace.id });
      const foreignTask = await insertTask({ workspaceId: foreignWorkspace.id });
      const [comment] = await db
        .insert(taskComments)
        .values({ taskId: foreignTask.id, content: "Foreign system comment", userId: null })
        .returning();
      const app = await buildRouteTestApp(commentRoutes, {
        user: { id: owner.id, workspaceId: workspace.id, workspaceRole: "member" },
      });
      apps.push(app);
      const res = await app.inject({
        method,
        url: `/api/tasks/${ownTask.id}/comments/${comment.id}`,
        ...(method === "PATCH" ? { payload: { content: "attacker edit" } } : {}),
      });
      expect(res.statusCode).toBe(404);
      expect(
        await db.select().from(taskComments).where(eq(taskComments.id, comment.id)),
      ).toMatchObject([{ content: "Foreign system comment" }]);
    },
  );
});
