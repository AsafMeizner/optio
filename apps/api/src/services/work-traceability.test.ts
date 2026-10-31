import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));

import { requesterEmailEnabled, workTraceabilityEnabled } from "./work-traceability.js";

describe("which repos get traceability", () => {
  const env = (repos: string) => ({ OPTIO_WORK_TRACEABILITY_REPOS: repos });

  it("none by default", () => {
    expect(workTraceabilityEnabled("https://github.com/acme/app", {})).toBe(false);
    expect(workTraceabilityEnabled("https://github.com/acme/app", env(""))).toBe(false);
    expect(workTraceabilityEnabled(null, env("https://github.com/acme/app"))).toBe(false);
  });

  it("a listed repo, however its URL is spelled", () => {
    const listed = env(" https://github.com/acme/app.git , https://gitlab.example.com/g/other");
    expect(workTraceabilityEnabled("https://github.com/acme/app", listed)).toBe(true);
    expect(workTraceabilityEnabled("git@github.com:acme/app.git", listed)).toBe(true);
    expect(workTraceabilityEnabled("https://GitHub.com/Acme/App/", listed)).toBe(true);
    expect(workTraceabilityEnabled("https://github.com/acme/app-public", listed)).toBe(false);
    expect(workTraceabilityEnabled("https://github.com/acme/other", listed)).toBe(false);
  });

  it("every repo under a listed group, and nothing beside it", () => {
    const group = env("https://gitlab.example.com/platform/*");
    expect(workTraceabilityEnabled("https://gitlab.example.com/platform/api", group)).toBe(true);
    expect(workTraceabilityEnabled("https://gitlab.example.com/platform/sub/api", group)).toBe(
      true,
    );
    expect(workTraceabilityEnabled("https://gitlab.example.com/platform-public/api", group)).toBe(
      false,
    );
    expect(workTraceabilityEnabled("https://gitlab.example.com/platform", group)).toBe(false);
  });
});

describe("the requester's email", () => {
  it("only with an explicit opt-in", () => {
    expect(requesterEmailEnabled({})).toBe(false);
    expect(requesterEmailEnabled({ OPTIO_WORK_TRACEABILITY_EMAIL: "1" })).toBe(false);
    expect(requesterEmailEnabled({ OPTIO_WORK_TRACEABILITY_EMAIL: "true" })).toBe(true);
  });
});
