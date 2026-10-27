import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAgentCommand } from "./task-worker.js";

describe("buildAgentCommand — opencode", () => {
  // With the headless rules on (OPTIO_OPENCODE_HEADLESS); off, the run is as before
  // (task-worker.test.ts).
  beforeEach(() => {
    vi.stubEnv("OPTIO_OPENCODE_HEADLESS", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("approves what no rule denies, and still closes stdin", () => {
    const cmds = buildAgentCommand("opencode", { OPTIO_OPENCODE_MODEL: "openai/gpt-4.1" });
    const run = cmds.find((l) => l.includes("opencode run"));
    expect(run).toBe(
      "opencode run --format json --dangerously-skip-permissions --model 'openai/gpt-4.1' \"$OPTIO_PROMPT\" </dev/null",
    );
  });
});
