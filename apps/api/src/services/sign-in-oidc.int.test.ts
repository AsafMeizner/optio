import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, userIdentities, users } from "../db/schema.js";
import {
  SignInConfigError,
  saveSignInConfig,
  resolveProviderConfig,
  deleteSignInConfig,
  testSignInProvider,
} from "./sign-in-config-service.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";
const ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OPTIO_DEPLOYMENT_ADMINS",
];
async function insertUser(
  name: string,
  email = `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@acme.com`,
  emailVerified = true,
) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomBytes(6).toString("hex"),
      email,
      emailVerified,
      displayName: name,
    })
    .returning();
  return row;
}

describe("OIDC configuration and account links", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    await db.delete(authProviderConfigs);
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const oidc = { issuerUrl: "https://sso.example.com/realms/optio" };
  it("does not return a discovery response's internal details from the admin test", async () => {
    const restore = setOutboundDefaults({
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("internal-peer:127.0.0.1 client-secret=hidden"),
    });
    try {
      expect(await testSignInProvider("oidc", { settings: oidc })).toEqual({
        ok: false,
        error: "Could not connect to the identity provider",
      });
    } finally {
      restore();
    }
  });
  it("stores an OIDC client encrypted, resolves it over the environment, and never returns the secret", async () => {
    process.env.OIDC_ISSUER_URL = "https://env.example";
    process.env.OIDC_CLIENT_ID = "env-id";
    process.env.OIDC_CLIENT_SECRET = "env-secret";
    expect(await resolveProviderConfig("oidc")).toMatchObject({
      clientId: "env-id",
      source: "environment",
      settings: { issuerUrl: "https://env.example" },
    });

    await expect(
      saveSignInConfig("oidc", { clientId: "db-id", settings: oidc }, null),
    ).rejects.toThrow(/client secret is required/);
    await expect(
      saveSignInConfig("oidc", { clientId: "db-id", clientSecret: "x" }, null),
    ).rejects.toThrow(/Settings are required/);
    await expect(
      saveSignInConfig(
        "oidc",
        { clientId: "db-id", clientSecret: "x", settings: { issuerUrl: "not a url" } },
        null,
      ),
    ).rejects.toThrow(/issuerUrl/);
    const view = await saveSignInConfig(
      "oidc",
      {
        clientId: "db-id",
        clientSecret: "db-secret",
        allowedDomains: ["Acme.com"],
        settings: { ...oidc, preset: "keycloak" },
      },
      null,
    );
    expect(view).toMatchObject({
      provider: "oidc",
      source: "database",
      enabled: true,
      clientId: "db-id",
      hasClientSecret: true,
      allowedDomains: ["acme.com"],
      settings: { issuerUrl: oidc.issuerUrl, preset: "keycloak" },
    });
    expect(JSON.stringify(view)).not.toContain("db-secret");
    expect(view.callbackUrl).toMatch(/\/api\/auth\/oidc\/callback$/);

    const [row] = await db.select().from(authProviderConfigs);
    expect(row.encryptedClientSecret?.toString("utf8")).not.toContain("db-secret");
    expect(await resolveProviderConfig("oidc")).toMatchObject({
      clientId: "db-id",
      clientSecret: "db-secret",
      allowedDomains: ["acme.com"],
      source: "database",
    });

    // A later save without a secret or settings keeps the stored ones; disabling falls back to the environment.
    await saveSignInConfig("oidc", { clientId: "db-id-2" }, null);
    expect((await resolveProviderConfig("oidc"))?.clientSecret).toBe("db-secret");
    expect((await resolveProviderConfig("oidc"))?.settings).toMatchObject({ preset: "keycloak" });
    await saveSignInConfig("oidc", { clientId: "db-id-2", enabled: false }, null);
    expect((await resolveProviderConfig("oidc"))?.source).toBe("environment");
    await deleteSignInConfig("oidc");
    expect((await resolveProviderConfig("oidc"))?.clientId).toBe("env-id");

    await expect(
      saveSignInConfig("github", { clientId: "x", clientSecret: "y" }, null),
    ).rejects.toThrow(SignInConfigError);
    await expect(
      saveSignInConfig(
        "oidc",
        { clientId: "x", clientSecret: "y", settings: oidc, allowedDomains: ["gmail.com"] },
        null,
      ),
    ).rejects.toThrow(/Anyone can get a gmail.com address/);
  });

  it("never links a verified identity into an unverified target, including an environment-admin email", async () => {
    const { createSession } = await import("./session-service.js");
    const { isDeploymentAdmin } = await import("./sign-in-config-service.js");
    const email = `victim-${randomBytes(6).toString("hex")}@acme.com`;
    const attacker = await insertUser("Unverified attacker", email, false);
    process.env.OPTIO_DEPLOYMENT_ADMINS = email;
    const victim = await createSession(
      "google",
      { externalId: "verified-victim", email, emailVerified: true, displayName: "Victim" },
      { linkByEmail: true },
    );
    expect(victim.user.id).not.toBe(attacker.id);
    expect(await isDeploymentAdmin(victim.user)).toBe(true);
    expect(await isDeploymentAdmin(attacker)).toBe(false);
    const [unchanged] = await db.select().from(users).where(eq(users.id, attacker.id));
    expect(unchanged.emailVerified).toBe(false);
    expect(unchanged.externalId).toBe(attacker.externalId);
    expect(
      await db.select().from(userIdentities).where(eq(userIdentities.userId, attacker.id)),
    ).toHaveLength(0);
  });

  it("links a sign-in to an existing account by email only when switched on, never re-keying it", async () => {
    const { createSession } = await import("./session-service.js");
    const email = `link-${randomBytes(3).toString("hex")}@acme.com`;
    const original = await insertUser("Linda", email);
    const profile = (externalId: string, asserted = true) => ({
      externalId,
      email,
      displayName: "Linda",
      emailVerified: true,
      emailVerifiedByProvider: asserted,
    });

    // By default (as upstream) a new identity is a new account, whatever the provider.
    for (const provider of ["google", "github", "gitlab", "oidc", "ldap", "saml"]) {
      const s = await createSession(provider, profile(`${provider}-id`));
      expect(s.user.id).not.toBe(original.id);
    }

    // Switched on: the provider must have asserted the email itself — an
    // administrator's trustEmail alone never links.
    const lena = await insertUser("Lena", `lena-${randomBytes(3).toString("hex")}@acme.com`);
    const asLena = (externalId: string, asserted = true) => ({
      ...profile(externalId, asserted),
      email: lena.email,
    });
    const tess = await insertUser("Tess", `tess-${randomBytes(3).toString("hex")}@acme.com`);
    const trusted = await createSession(
      "oidc",
      { ...profile("trusted-only", false), email: tess.email },
      { linkByEmail: true },
    );
    expect(trusted.user.id).not.toBe(tess.id);
    const [unasserted] = await db.select().from(users).where(eq(users.id, trusted.user.id));
    expect(unasserted.emailVerified).toBe(false);
    const viaLdap = await createSession("ldap", asLena("ldap-entry"), { linkByEmail: true });
    expect(viaLdap.user.id).toBe(lena.id);
    // The account keeps the identity it was made with; the new one is linked beside it.
    const [kept] = await db.select().from(users).where(eq(users.id, lena.id));
    expect(kept).toMatchObject({ provider: "oidc", externalId: lena.externalId });
    const links = await db.select().from(userIdentities).where(eq(userIdentities.userId, lena.id));
    expect(links.map((l) => [l.provider, l.externalId])).toEqual([["ldap", "ldap-entry"]]);

    // Google then GitHub, alternating: one account, still the provider it was made with.
    const g = await createSession("google", asLena("g-1"), { linkByEmail: true });
    const gh = await createSession("github", asLena("gh-1"), { linkByEmail: true });
    const g2 = await createSession("google", asLena("g-1"));
    const ldapAgain = await createSession("ldap", asLena("ldap-entry"));
    expect(new Set([g.user.id, gh.user.id, g2.user.id, ldapAgain.user.id])).toEqual(
      new Set([lena.id]),
    );
    const [after] = await db.select().from(users).where(eq(users.id, lena.id));
    expect(after.provider).toBe("oidc");
  });

  it("links nobody by email when two accounts share it", async () => {
    const { createSession } = await import("./session-service.js");
    const email = `twin-${randomBytes(3).toString("hex")}@acme.com`;
    const a = await insertUser("Twin A", email);
    const b = await insertUser("Twin B", email.toUpperCase());
    const s = await createSession(
      "ldap",
      { externalId: "twin", email, displayName: "Twin", emailVerified: true },
      { linkByEmail: true },
    );
    expect([a.id, b.id]).not.toContain(s.user.id);
  });
});
