import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubOAuthProvider } from "./github.js";
import { GitLabOAuthProvider } from "./gitlab.js";
import { GoogleOAuthProvider } from "./google.js";

const resolveConfig = vi.hoisted(() => vi.fn());
vi.mock("../sign-in-config-service.js", () => ({ resolveProviderConfig: resolveConfig }));
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
  });

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfig.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
  for (const key of [
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "GITLAB_OAUTH_CLIENT_ID",
    "GITLAB_OAUTH_CLIENT_SECRET",
    "GITLAB_OAUTH_BASE_URL",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv("PUBLIC_API_URL", "https://api.optio.example");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OAuth provider exchange boundaries", () => {
  for (const Provider of [GitHubOAuthProvider, GitLabOAuthProvider, GoogleOAuthProvider]) {
    describe(Provider.name, () => {
      it("preserves state and uses the public API callback without exposing a client secret", () => {
        const provider = new Provider();
        const url = new URL(provider.authorizeUrl("state&other=value"));
        expect(url.protocol).toBe("https:");
        expect(url.searchParams.get("state")).toBe("state&other=value");
        expect(url.searchParams.get("redirect_uri")).toBe(
          `https://api.optio.example/api/auth/${provider.name}/callback`,
        );
        expect(url.searchParams.has("client_secret")).toBe(false);
      });
      it("exchanges a code by POST and retains refresh credentials", async () => {
        fetchMock.mockResolvedValueOnce(
          json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
        );
        const provider = new Provider();
        expect(await provider.exchangeCode("code")).toMatchObject({
          accessToken: "access",
          refreshToken: "refresh",
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(new URL(url).protocol).toBe("https:");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toMatchObject({
          code: "code",
          client_id: "",
          client_secret: "",
        });
      });
      it("rejects a failed token HTTP response", async () => {
        fetchMock.mockResolvedValueOnce(json({}, 401));
        await expect(new Provider().exchangeCode("code")).rejects.toThrow(
          /token exchange failed: 401/,
        );
      });
      it.each([
        [{ error: "invalid_grant", error_description: "Code was spent" }, "Code was spent"],
        [{ error: "invalid_grant" }, "invalid_grant"],
      ])("rejects provider-declared token errors", async (body, message) => {
        fetchMock.mockResolvedValueOnce(json(body));
        await expect(new Provider().exchangeCode("code")).rejects.toThrow(String(message));
      });
      it("rejects a failed identity lookup", async () => {
        fetchMock.mockResolvedValueOnce(json({}, 401));
        await expect(new Provider().fetchUser("access")).rejects.toThrow(/user fetch failed: 401/);
      });
    });
  }
});

describe("GitHub verified identity", () => {
  it("requests email permissions for OAuth apps, while GitHub Apps use their installation permissions", () => {
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "oauth-client");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "oauth-secret");
    const provider = new GitHubOAuthProvider();
    expect(new URL(provider.authorizeUrl("state")).searchParams.get("scope")).toBe(
      "read:user user:email",
    );
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "app-client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "app-secret");
    const params = new URL(provider.authorizeUrl("state")).searchParams;
    expect(params.get("client_id")).toBe("app-client");
    expect(params.has("scope")).toBe(false);
  });
  it("uses the configured app credentials for exchange", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "app-id");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "app-secret");
    fetchMock.mockResolvedValueOnce(json({ access_token: "a" }));
    expect(await new GitHubOAuthProvider().exchangeCode("c")).toEqual({
      accessToken: "a",
      refreshToken: undefined,
      expiresIn: undefined,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      client_id: "app-id",
      client_secret: "app-secret",
    });
  });
  it.each([
    [403, [], "public@acme.test", false],
    [200, [], "public@acme.test", false],
    [200, [{ email: "first@acme.test", primary: true, verified: false }], "first@acme.test", false],
    [200, [{ email: "other@acme.test", primary: false, verified: true }], "other@acme.test", false],
    [
      200,
      [
        { email: "unverified@acme.test", primary: true, verified: false },
        { email: "verified@acme.test", primary: true, verified: true },
      ],
      "verified@acme.test",
      true,
    ],
  ])(
    "only trusts a verified primary email (status %s)",
    async (status, emails, email, emailVerified) => {
      fetchMock.mockResolvedValueOnce(
        json({
          id: 12,
          login: "octo",
          name: "Octo",
          email: "public@acme.test",
          avatar_url: "avatar",
        }),
      );
      fetchMock.mockResolvedValueOnce(json(emails, status));
      expect(await new GitHubOAuthProvider().fetchUser("access")).toEqual({
        externalId: "12",
        email,
        emailVerified,
        displayName: "Octo",
        username: "octo",
        avatarUrl: "avatar",
      });
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer access");
    },
  );
  it.each([
    [{ id: 12, login: "octo" }, "octo"],
    [{ id: 12 }, ""],
  ])(
    "handles absent public identity fields without fabricating verification",
    async (user, displayName) => {
      fetchMock.mockResolvedValueOnce(json(user)).mockResolvedValueOnce(json([]));
      expect(await new GitHubOAuthProvider().fetchUser("a")).toMatchObject({
        email: "",
        emailVerified: false,
        displayName,
      });
    },
  );
});

describe("Google verified identity and stored client", () => {
  it.each([
    [true, "acme.test", true, "acme.test"],
    [false, "", false, null],
    ["true", 123, false, null],
    [undefined, undefined, false, null],
  ])(
    "requires literal verification and a string hosted domain",
    async (verified, hd, emailVerified, hostedDomain) => {
      fetchMock.mockResolvedValueOnce(json({ id: "google-id", verified_email: verified, hd }));
      expect(await new GoogleOAuthProvider().fetchUser("access")).toMatchObject({
        externalId: "google-id",
        email: "",
        displayName: "",
        emailVerified,
        hostedDomain,
      });
    },
  );
  it("retains the provider identity fields", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        id: 1,
        email: "person@acme.test",
        name: "Person",
        picture: "avatar",
        verified_email: true,
        hd: "acme.test",
      }),
    );
    expect(await new GoogleOAuthProvider().fetchUser("a")).toMatchObject({
      email: "person@acme.test",
      displayName: "Person",
      avatarUrl: "avatar",
      emailVerified: true,
    });
  });
  it("reloads the stored client at exchange and only hints one allowed domain", async () => {
    resolveConfig.mockResolvedValueOnce({
      clientId: "first",
      clientSecret: "first-secret",
      allowedDomains: ["acme.test"],
    });
    const provider = new GoogleOAuthProvider();
    await provider.prepare();
    const params = new URL(provider.authorizeUrl("state")).searchParams;
    expect(params.get("client_id")).toBe("first");
    expect(params.get("hd")).toBe("acme.test");
    resolveConfig.mockResolvedValueOnce({
      clientId: "second",
      clientSecret: "rotated",
      allowedDomains: ["a.test", "b.test"],
    });
    fetchMock.mockResolvedValueOnce(json({ access_token: "a" }));
    await provider.exchangeCode("c");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      client_id: "second",
      client_secret: "rotated",
    });
    expect(new URL(provider.authorizeUrl("s")).searchParams.has("hd")).toBe(false);
  });
  it("falls back to environment credentials when no client is stored", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "env-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "env-secret");
    const provider = new GoogleOAuthProvider();
    expect(new URL(provider.authorizeUrl("s")).searchParams.get("client_id")).toBe("env-id");
    await provider.prepare();
    fetchMock.mockResolvedValueOnce(json({ access_token: "a" }));
    await provider.exchangeCode("c");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      client_id: "env-id",
      client_secret: "env-secret",
    });
  });
});

describe("GitLab verified identity", () => {
  it("uses the configured self-hosted GitLab and client credentials", async () => {
    vi.stubEnv("GITLAB_OAUTH_BASE_URL", "https://git.acme.test");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-id");
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-secret");
    const provider = new GitLabOAuthProvider();
    expect(new URL(provider.authorizeUrl("s")).host).toBe("git.acme.test");
    fetchMock.mockResolvedValueOnce(json({ access_token: "a" }));
    await provider.exchangeCode("c");
    expect(fetchMock.mock.calls[0][0]).toBe("https://git.acme.test/oauth/token");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      client_id: "gitlab-id",
      client_secret: "gitlab-secret",
    });
  });
  it.each([
    [
      { email: "person@acme.test", confirmed_at: "2026-01-01", name: "Person", username: "person" },
      true,
      "Person",
    ],
    [{ email: "person@acme.test", username: "person" }, false, "person"],
    [{ confirmed_at: "2026-01-01" }, false, ""],
  ])(
    "requires a confirmed email and preserves username fallback",
    async (identity, emailVerified, displayName) => {
      fetchMock.mockResolvedValueOnce(json({ id: 1, ...identity }));
      expect(await new GitLabOAuthProvider().fetchUser("a")).toMatchObject({
        externalId: "1",
        emailVerified,
        displayName,
      });
    },
  );
});
