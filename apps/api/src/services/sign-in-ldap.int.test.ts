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
  listSignInProviders,
} from "./sign-in-config-service.js";
const ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "LDAP_URL",
  "LDAP_BIND_PASSWORD",
  "LDAP_USER_BASE_DN",
];
async function insertUser(
  name: string,
  email = `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@acme.com`,
) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomBytes(6).toString("hex"),
      email,
      displayName: name,
    })
    .returning();
  return row;
}

describe("LDAP configuration", () => {
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
  it("stores an LDAP directory with its bind password as the secret (none needed for an anonymous bind)", async () => {
    const ldap = { url: "ldaps://ad.example.com:636", userBaseDn: "DC=corp,DC=example" };
    await expect(
      saveSignInConfig(
        "ldap",
        { settings: { ...ldap, bindDn: "CN=optio,DC=corp,DC=example" } },
        null,
      ),
    ).rejects.toThrow(/bind password is required/);
    const view = await saveSignInConfig("ldap", { settings: ldap }, null);
    expect(view).toMatchObject({
      provider: "ldap",
      enabled: true,
      clientId: null,
      hasClientSecret: false,
      callbackUrl: null,
      settings: ldap,
    });
    await saveSignInConfig(
      "ldap",
      { clientSecret: "bind-pw", settings: { ...ldap, bindDn: "CN=optio,DC=corp,DC=example" } },
      null,
    );
    expect(await resolveProviderConfig("ldap")).toMatchObject({
      clientSecret: "bind-pw",
      settings: { bindDn: "CN=optio,DC=corp,DC=example" },
    });
    expect((await listSignInProviders()).find((p) => p.provider === "ldap")?.hasClientSecret).toBe(
      true,
    );
  });
});
