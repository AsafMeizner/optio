import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { secretRoutes } from "../routes/secrets.js";
import { retrieveSecret } from "./secret-service.js";

vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => false }));
vi.mock("./optio-action-service.js", () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

const apps: Array<Awaited<ReturnType<typeof buildRouteTestApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function actor(deploymentAdmin = false) {
  const workspace = await insertWorkspace();
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@example.com`,
      displayName: "Admin",
      deploymentAdmin,
    })
    .returning();
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace.id, userId: user.id, role: "admin" });
  const app = await buildRouteTestApp(secretRoutes, {
    user: { id: user.id, workspaceId: workspace.id, workspaceRole: "admin" },
  });
  apps.push(app);
  return { app, user, workspace };
}

describe("deployment and workspace secret boundaries", () => {
  it("prevents another workspace admin from replacing or deleting deployment secrets, including alternate-scope bypasses", async () => {
    const owner = await actor(true);
    const attacker = await actor();
    const name = `GLOBAL_${randomUUID()}`;
    expect(
      (
        await owner.app.inject({
          method: "POST",
          url: "/api/secrets",
          payload: { name, value: "original" },
        })
      ).statusCode,
    ).toBe(201);
    for (const scope of [undefined, "global"]) {
      const res = await attacker.app.inject({
        method: "POST",
        url: "/api/secrets?scope=user",
        payload: { name, value: "attacker", ...(scope ? { scope } : {}) },
      });
      expect(res.statusCode).toBe(403);
    }
    for (const suffix of ["", "?scope=global"]) {
      const res = await attacker.app.inject({
        method: "DELETE",
        url: `/api/secrets/${name}${suffix}`,
        payload: { scope: "user" },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(await retrieveSecret(name)).toBe("original");
    expect(
      (await owner.app.inject({ method: "DELETE", url: `/api/secrets/${name}` })).statusCode,
    ).toBe(204);
    await expect(retrieveSecret(name)).rejects.toThrow();
  });

  it("preserves workspace and private writes without deployment permission", async () => {
    const first = await actor();
    const second = await actor();
    const name = `SCOPED_${randomUUID()}`;
    for (const caller of [first, second]) {
      expect(
        (
          await caller.app.inject({
            method: "POST",
            url: "/api/secrets",
            payload: { name, value: caller.user.id, scope: "repo:shared" },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await caller.app.inject({
            method: "POST",
            url: "/api/secrets",
            payload: { name, value: "private", scope: "user" },
          })
        ).statusCode,
      ).toBe(201);
    }
    expect(await retrieveSecret(name, "repo:shared", first.workspace.id)).toBe(first.user.id);
    expect(await retrieveSecret(name, "repo:shared", second.workspace.id)).toBe(second.user.id);
    const foreign = await first.app.inject({
      method: "DELETE",
      url: `/api/secrets/${name}?scope=user&userId=${second.user.id}`,
    });
    expect(foreign.statusCode).toBe(404);
    expect(await retrieveSecret(name, "user", null, second.user.id)).toBe("private");
    expect(
      (await first.app.inject({ method: "DELETE", url: `/api/secrets/${name}?scope=user` }))
        .statusCode,
    ).toBe(204);
    await expect(retrieveSecret(name, "user", null, first.user.id)).rejects.toThrow();
  });
});
