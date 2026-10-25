import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { opencodeConfigJson } from "./harness-config.js";

const servers = {
  docs: { command: "docs-mcp", args: [] },
  "Support Pylon": {
    command: "node",
    args: ["/opt/optio/mcp-bridge.js"],
    env: { OPTIO_HTTP_AUTH_VALUE: "Bearer pyl_t", OPTIO_HTTP_NAME: "Support Pylon" },
  },
};

describe("renderers", () => {
  // With the headless rules on (OPTIO_OPENCODE_HEADLESS); off, the run is as before
  // (harness-config.test.ts).
  beforeEach(() => {
    vi.stubEnv("OPTIO_OPENCODE_HEADLESS", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("OpenCode: the run's config carries the headless permissions", () => {
    // Merged over the global file, so a run with MCP servers keeps them (#585).
    const json = JSON.parse(opencodeConfigJson(servers));
    expect(json.permission).toEqual({
      question: "deny",
      bash: { "sudo *": "deny", "apt *": "deny", "apt-get *": "deny", "dpkg *": "deny" },
      external_directory: {
        "*": "deny",
        "/home/agent/.local/share/opencode/tool-output/**": "allow",
      },
    });
    expect(Object.keys(json.mcp)).toEqual(["docs", "Support Pylon"]);
  });

  it("OpenCode: a run with no servers gets the permissions and no `mcp` key", () => {
    // Written for every OpenCode run (services/opencode-run-setup.ts).
    const json = JSON.parse(opencodeConfigJson({}));
    expect(json.permission.question).toBe("deny");
    expect(json).not.toHaveProperty("mcp");
  });
});
