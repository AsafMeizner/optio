import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantPlacement,
  harnessInstalled,
  inPodTurnLimit,
  placeAssistantTurn,
  resetHarnessLookup,
} from "./assistant-placement.js";

const dirs: string[] = [];
afterEach(() => {
  resetHarnessLookup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A PATH holding only the named binaries. */
function pathWith(...bins: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "optio-harness-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const bin of bins) {
    writeFileSync(join(dir, bin), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, bin), 0o755);
  }
  return dir;
}

describe("assistant placement", () => {
  it("defaults to the API pod, except under the fake runtime", () => {
    expect(assistantPlacement({})).toBe("api-pod");
    expect(assistantPlacement({ OPTIO_RUNTIME: "fake" })).toBe("agent-pod");
    expect(
      assistantPlacement({ OPTIO_RUNTIME: "fake", OPTIO_ASSISTANT_PLACEMENT: "api-pod" }),
    ).toBe("api-pod");
    expect(assistantPlacement({ OPTIO_ASSISTANT_PLACEMENT: "agent-pod" })).toBe("agent-pod");
    expect(assistantPlacement({ OPTIO_ASSISTANT_PLACEMENT: "garbage" })).toBe("api-pod");
  });

  it("reads the in-pod turn limit with a sane default", () => {
    expect(inPodTurnLimit({})).toBe(3);
    expect(inPodTurnLimit({ OPTIO_ASSISTANT_IN_POD_MAX: "5" })).toBe(5);
    expect(inPodTurnLimit({ OPTIO_ASSISTANT_IN_POD_MAX: "0" })).toBe(3);
    expect(inPodTurnLimit({ OPTIO_ASSISTANT_IN_POD_MAX: "lots" })).toBe(3);
  });

  it("finds a harness's binary on PATH", () => {
    const env = { PATH: pathWith("claude") };
    expect(harnessInstalled("claude-code", env)).toBe(true);
    expect(harnessInstalled("codex", env)).toBe(false);
    expect(harnessInstalled("not-a-harness", env)).toBe(false);
  });

  it("places a turn: API pod when it can, an agent pod and why when it can't", () => {
    const env = { PATH: pathWith("claude") };
    const base = { runtime: "claude-code", assistant: true, repoUrl: null, liveInPod: 0 };
    expect(placeAssistantTurn(base, env)).toEqual({ where: "api-pod" });
    expect(placeAssistantTurn({ ...base, assistant: false }, env)).toEqual({
      where: "agent-pod",
      reason: "configured",
    });
    expect(placeAssistantTurn(base, { ...env, OPTIO_ASSISTANT_PLACEMENT: "agent-pod" })).toEqual({
      where: "agent-pod",
      reason: "configured",
    });
    expect(placeAssistantTurn({ ...base, repoUrl: "https://github.com/a/b" }, env)).toEqual({
      where: "agent-pod",
      reason: "repo",
    });
    expect(placeAssistantTurn({ ...base, runtime: "gemini" }, env)).toEqual({
      where: "agent-pod",
      reason: "harness-missing",
    });
    expect(placeAssistantTurn({ ...base, liveInPod: 3 }, env)).toEqual({
      where: "agent-pod",
      reason: "pod-full",
    });
    expect(
      placeAssistantTurn({ ...base, liveInPod: 3 }, { ...env, OPTIO_ASSISTANT_IN_POD_MAX: "4" }),
    ).toEqual({
      where: "api-pod",
    });
  });
});
