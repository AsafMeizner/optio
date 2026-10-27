// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { GET, POST } from "./[...path]/route.js";
import { GET as callback } from "../auth/callback/route.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("browser authentication boundaries", () => {
  it("preserves the explicit bootstrap setup token through the proxy", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ bootstrap: true }));
    vi.stubGlobal("fetch", fetch);
    await GET(
      new NextRequest("https://optio.example/api/auth/sign-in", {
        headers: { "x-optio-setup-token": "explicit-bootstrap-token" },
      }),
    );
    expect(fetch.mock.calls[0][1].headers.get("x-optio-setup-token")).toBe(
      "explicit-bootstrap-token",
    );
  });
  it("rejects a same-site hostile Origin before forwarding the session", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.com");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await POST(
      new NextRequest("https://optio.example.com/api/tasks", {
        method: "POST",
        headers: { origin: "https://evil.example.com", cookie: "optio_session=secret" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates a private browser verifier and forwards only its hash on login", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example");
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://provider.example/authorize" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await GET(
      new NextRequest("https://optio.example/api/auth/google/login?browserChallenge=attacker"),
    );
    const verifier = response.cookies.get("__Host-optio_oauth_verifier")!;
    expect(verifier.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    const target = new URL(fetch.mock.calls[0][0]);
    expect(target.searchParams.get("browserChallenge")).toBe(
      createHash("sha256").update(verifier.value).digest("base64url"),
    );
  });

  it("never accepts a sibling-domain cookie in place of the HTTPS session cookie", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example");
    const fetch = vi.fn().mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await GET(
      new NextRequest("https://optio.example/api/auth/me", {
        headers: { cookie: "optio_session=planted" },
      }),
    );
    expect(fetch.mock.calls[0][1].headers.get("authorization")).toBeNull();
    await GET(
      new NextRequest("https://optio.example/api/auth/me", {
        headers: { cookie: "__Host-optio_session=real; optio_session=planted" },
      }),
    );
    expect(fetch.mock.calls[1][1].headers.get("authorization")).toBe("Bearer real");
  });

  it("refuses a callback supplied to a browser that did not initiate login", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await callback(
      new NextRequest("https://optio.example/auth/callback?code=attacker-code"),
    );
    expect(response.headers.get("location")).toContain("invalid_state");
    expect(response.cookies.get("optio_session")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exchanges the callback with its cookie verifier and removes the verifier", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ token: "session" }));
    vi.stubGlobal("fetch", fetch);
    const response = await callback(
      new NextRequest("https://optio.example/auth/callback?code=code", {
        headers: { cookie: `optio_oauth_verifier=${"v".repeat(43)}` },
      }),
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      code: "code",
      browserVerifier: "v".repeat(43),
    });
    expect(response.cookies.get("optio_session")?.value).toBe("session");
    expect(response.cookies.get("optio_oauth_verifier")?.value).toBe("");
  });
});
