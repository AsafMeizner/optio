import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { giteaSettingsSchema } from "../../schemas/sign-in.js";
import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { createGiteaProvider, giteaOidcSettings } from "./gitea.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("Gitea sign-in boundaries", () => {
  it.each(["http://git.example.test", "not a URL"])(
    "refuses insecure or malformed base URL %s",
    (baseUrl) => {
      expect(giteaSettingsSchema.safeParse({ baseUrl }).success).toBe(false);
    },
  );
  it("refuses a stored certificate bypass and supports private CAs", () => {
    expect(
      giteaSettingsSchema.safeParse({
        baseUrl: "https://git.example.test",
        insecureSkipVerify: true,
      }).success,
    ).toBe(false);
    expect(
      giteaSettingsSchema.safeParse({
        baseUrl: "https://git.example.test",
        caPem: "-----BEGIN CERTIFICATE-----\nfixture",
      }).success,
    ).toBe(true);
  });
  it.each([false, undefined])(
    "does not verify Gitea email from an ID token whose assertion is %s",
    async (email_verified) => {
      const issuer = "https://git.example.test";
      const token = await new SignJWT({
        sub: "gitea-user",
        email: "unverified@example.test",
        ...(email_verified === undefined ? {} : { email_verified }),
      })
        .setProtectedHeader({ alg: "HS256" })
        .sign(new Uint8Array(32));
      const restore = setOutboundDefaults({
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              issuer,
              authorization_endpoint: issuer + "/auth",
              token_endpoint: issuer + "/token",
              jwks_uri: issuer + "/jwks",
            }),
          ),
      });
      try {
        const provider = createGiteaProvider(async () => ({
          clientId: "client",
          clientSecret: "dummy",
          settings: giteaOidcSettings({ baseUrl: issuer }),
          source: "database",
          sendNonce: true,
        }));
        // exchangeCode's signature checks are covered by the real signed OIDC
        // tests; exercise Gitea's subsequent claim projection with an ID token.
        const profile = await provider.fetchUser("dummy-access", {
          accessToken: "dummy-access",
          idToken: token,
        });
        expect(profile.email).toBe("unverified@example.test");
        expect(profile.emailVerified).toBe(false);
        expect(profile.emailVerifiedByProvider).toBe(false);
      } finally {
        restore();
      }
    },
  );
});
