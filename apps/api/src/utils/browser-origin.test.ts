import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOriginAllowed } from "./browser-origin.js";

afterEach(() => vi.unstubAllEnvs());

describe("browser origin boundary", () => {
  it("allows native callers without an Origin header", () => {
    expect(browserOriginAllowed(undefined)).toBe(true);
  });

  it("checks exact configured origins, including scheme and port", () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example");
    vi.stubEnv("PUBLIC_API_URL", "https://api.example/api/");
    vi.stubEnv("OPTIO_ALLOWED_ORIGINS", "https://trusted.example:8443");
    for (const origin of [
      "https://optio.example",
      "https://api.example",
      "https://trusted.example:8443",
    ])
      expect(browserOriginAllowed(origin)).toBe(true);
    for (const origin of [
      "https://evil.example",
      "https://optio.example.evil.test",
      "http://optio.example",
      "https://trusted.example",
      "null",
      "https://optio.example/path",
    ])
      expect(browserOriginAllowed(origin)).toBe(false);
  });

  it("does not implicitly trust localhost in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_URL", "");
    vi.stubEnv("PUBLIC_API_URL", "");
    vi.stubEnv("OPTIO_ALLOWED_ORIGINS", "");
    expect(browserOriginAllowed("http://localhost:3000")).toBe(false);
  });
});
