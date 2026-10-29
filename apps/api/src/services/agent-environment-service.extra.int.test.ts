/**
 * OpenCode's headless rules in the agent environment, against real Postgres:
 * with `OPTIO_OPENCODE_HEADLESS` on, every OpenCode run gets its own
 * `opencode.json` with the permission block and the global `AGENTS.md`,
 * MCP servers or not; other runtimes get none of it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildAgentEnvironment } from "./agent-environment-service.js";
import { logger } from "../logger.js";

type Env = Record<string, string>;
type File = { path: string; content: string; sensitive?: boolean };
/** The setup files a pod would write, decoded from `OPTIO_SETUP_FILES`. */
const filesOf = (env: Env): File[] =>
  env.OPTIO_SETUP_FILES
    ? JSON.parse(Buffer.from(env.OPTIO_SETUP_FILES, "base64").toString("utf8"))
    : [];
const build = (input: Parameters<typeof buildAgentEnvironment>[0]) =>
  buildAgentEnvironment(input, logger);

describe("buildAgentEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives every OpenCode run its headless permissions and rules, MCP servers or not", async () => {
    // With the headless rules on (OPTIO_OPENCODE_HEADLESS; off, the run is as before).
    vi.stubEnv("OPTIO_OPENCODE_HEADLESS", "true");
    // A Job run with nothing assigned: no .mcp.json, and no adapter pre-seeding
    // (pooled pods never call buildContainerConfig). Its OPENCODE_CONFIG still
    // denies questions, and the rules land under the agent's home.
    const ws = await insertWorkspace();
    const runId = "5c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
    const job = await build({
      repoUrl: null,
      agentType: "opencode",
      workspaceId: ws.id,
      ownerUserId: null,
      runId,
    });
    const files = filesOf(job);
    expect(files.find((f) => f.path === ".mcp.json")).toBeUndefined();
    const own = files.find((f) => f.path === `/opt/optio/runs/${runId}/opencode/opencode.json`)!;
    expect(own).toBeDefined();
    expect(own.sensitive).toBeUndefined();
    const config = JSON.parse(own.content);
    expect(config.permission.question).toBe("deny");
    expect(config.permission.external_directory["*"]).toBe("deny");
    expect(config.permission.bash["sudo *"]).toBe("deny");
    expect(config).not.toHaveProperty("mcp");
    expect(job.OPTIO_OPENCODE_CONFIG).toBe(
      `/home/agent/optio/runs/${runId}/opencode/opencode.json`,
    );
    expect(job.OPTIO_RUN_HOME).toBe(`/home/agent/optio/runs/${runId}`);
    const rules = files.filter((f) => f.path === "/home/agent/.config/opencode/AGENTS.md");
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toMatch(/Never ask one/);

    // A Repo Task: the adapter's own copy of the rules is not written twice.
    const task = await buildAgentEnvironment(
      { repoUrl: null, agentType: "opencode", workspaceId: ws.id, ownerUserId: null, runId },
      logger,
      [{ path: "/home/agent/.config/opencode/AGENTS.md", content: "the adapter's" }],
    );
    const taskRules = filesOf(task).filter(
      (f) => f.path === "/home/agent/.config/opencode/AGENTS.md",
    );
    expect(taskRules).toEqual([
      { path: "/home/agent/.config/opencode/AGENTS.md", content: "the adapter's" },
    ]);
    expect(task.OPTIO_OPENCODE_CONFIG).toBeDefined();

    // Other runtimes and commands get none of it.
    for (const agentType of ["claude-code", null]) {
      const other = await build({
        repoUrl: null,
        agentType,
        workspaceId: ws.id,
        ownerUserId: null,
        runId,
      });
      expect(other.OPTIO_OPENCODE_CONFIG).toBeUndefined();
      expect(filesOf(other).some((f) => f.path.includes("opencode"))).toBe(false);
    }
  });

  it("leaves an OpenCode run without MCP servers alone while the rules are off", async () => {
    const ws = await insertWorkspace();
    const job = await build({
      repoUrl: null,
      agentType: "opencode",
      workspaceId: ws.id,
      ownerUserId: null,
      runId: "0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    });
    expect(job.OPTIO_OPENCODE_CONFIG).toBeUndefined();
    expect(filesOf(job).some((f) => f.path.includes("opencode"))).toBe(false);
  });
});
