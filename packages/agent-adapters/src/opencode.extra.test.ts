import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeAdapter } from "./opencode.js";

const adapter = new OpenCodeAdapter();

describe("OpenCodeAdapter", () => {
  describe("buildContainerConfig", () => {
    const baseInput = {
      taskId: "test-123",
      prompt: "Fix the bug",
      repoUrl: "https://github.com/org/repo",
      repoBranch: "main",
    };

    // With the headless rules on (OPTIO_OPENCODE_HEADLESS); opencode.test.ts
    // covers the adapter with them off.
    describe("with the headless rules on", () => {
      beforeEach(() => {
        vi.stubEnv("OPTIO_OPENCODE_HEADLESS", "true");
      });
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it("includes opencode config as setup file", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const configFile = config.setupFiles?.find((f) =>
          f.path.includes(".config/opencode/opencode.json"),
        );
        expect(configFile).toBeDefined();
        // Plus the headless permissions (opencode-headless.test.ts).
        expect(JSON.parse(configFile!.content)).toMatchObject({
          $schema: "https://opencode.ai/config.json",
          permission: expect.objectContaining({ question: "deny" }),
        });
      });

      it("returns only opencode config in setupFiles when no task file", () => {
        const config = adapter.buildContainerConfig(baseInput);
        // The config and the global headless rules (opencode-headless.ts).
        expect(config.setupFiles).toHaveLength(2);
        expect(config.setupFiles![0].path).toContain("opencode.json");
        expect(config.setupFiles![1].path).toContain("opencode/AGENTS.md");
      });
    });
  });
});
