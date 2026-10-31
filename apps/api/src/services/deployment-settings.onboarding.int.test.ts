import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { deploymentSettingsRoutes } from "../routes/deployment-settings.js";
import { ONBOARDING, getDeploymentSetting, setDeploymentSetting } from "./deployment-settings.js";

// The getting-started guide's switch (docs/using-optio.md): off by default,
// read by anyone signed in, changed by deployment admins only.

beforeEach(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("OPTIO_ONBOARDING", "");
  await setDeploymentSetting(ONBOARDING.key, null, null);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await setDeploymentSetting(ONBOARDING.key, null, null);
});

async function appAs(opts: { deploymentAdmin?: boolean; role?: "admin" | "member" | "viewer" }) {
  const role = opts.role ?? "admin";
  const ws = await insertWorkspace();
  const [user] = await db
    .insert(users)
    .values({
      email: randomUUID() + "@onboarding.example.test",
      provider: "github",
      externalId: randomUUID(),
      displayName: "Onboarding test",
      deploymentAdmin: opts.deploymentAdmin ?? false,
    })
    .returning();
  await db.insert(workspaceMembers).values({ userId: user.id, workspaceId: ws.id, role });
  return buildRouteTestApp(async (app) => deploymentSettingsRoutes(app), {
    user: { id: user.id, workspaceId: ws.id, workspaceRole: role },
  });
}

const put = (app: Awaited<ReturnType<typeof appAs>>, onboarding: boolean | null) =>
  app.inject({ method: "PUT", url: "/api/deployment-settings", payload: { onboarding } });

describe("onboarding switch", () => {
  it("is off by default and follows OPTIO_ONBOARDING when nothing is saved", async () => {
    const member = await appAs({ role: "member" });
    try {
      const off = await member.inject({ method: "GET", url: "/api/deployment-settings" });
      expect(off.json().onboarding).toEqual({
        value: false,
        environment: false,
        source: "environment",
      });
      vi.stubEnv("OPTIO_ONBOARDING", "true");
      const on = await member.inject({ method: "GET", url: "/api/deployment-settings" });
      expect(on.json().onboarding).toEqual({
        value: true,
        environment: true,
        source: "environment",
      });
    } finally {
      await member.close();
    }
  });

  it.each(["admin", "member", "viewer"] as const)(
    "refuses a workspace %s who isn't a deployment admin, and writes nothing",
    async (role) => {
      const app = await appAs({ role });
      try {
        const res = await put(app, true);
        expect(res.statusCode).toBe(403);
        expect(await getDeploymentSetting(ONBOARDING.key)).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );

  it("a deployment admin turns it on for everyone, and back to the deployment's default", async () => {
    const admin = await appAs({ deploymentAdmin: true });
    const member = await appAs({ role: "member" });
    try {
      const on = await put(admin, true);
      expect(on.statusCode).toBe(200);
      expect(on.json().onboarding).toEqual({ value: true, environment: false, source: "app" });
      expect(await getDeploymentSetting(ONBOARDING.key)).toBe(true);
      expect(
        (await member.inject({ method: "GET", url: "/api/deployment-settings" })).json().onboarding,
      ).toMatchObject({ value: true, source: "app" });

      const back = await put(admin, null);
      expect(back.statusCode).toBe(200);
      expect(back.json().onboarding).toEqual({
        value: false,
        environment: false,
        source: "environment",
      });
      expect(await getDeploymentSetting(ONBOARDING.key)).toBeUndefined();
    } finally {
      await admin.close();
      await member.close();
    }
  });

  it("a saved off wins over the environment's on", async () => {
    vi.stubEnv("OPTIO_ONBOARDING", "true");
    const admin = await appAs({ deploymentAdmin: true });
    try {
      const res = await put(admin, false);
      expect(res.json().onboarding).toEqual({ value: false, environment: true, source: "app" });
    } finally {
      await admin.close();
    }
  });

  it("rejects a value that isn't a boolean or null", async () => {
    const admin = await appAs({ deploymentAdmin: true });
    try {
      const res = await admin.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { onboarding: "yes" },
      });
      expect(res.statusCode).toBe(400);
      expect(await getDeploymentSetting(ONBOARDING.key)).toBeUndefined();
    } finally {
      await admin.close();
    }
  });
});
