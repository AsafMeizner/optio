import { shellQuote } from "@optio/shared";

/** Pi 1.4: native MCP + skills come from the run's private agent directory. */
export function piCommand(
  env: Record<string, string>,
  resumeSessionId?: string | null,
  repoTask = false,
): string[] {
  const flags: string[] = [];
  if (env.OPTIO_PI_MODEL) flags.push(`--model ${shellQuote(env.OPTIO_PI_MODEL)}`);
  if (env.OPTIO_PI_THINKING) flags.push(`--thinking ${shellQuote(env.OPTIO_PI_THINKING)}`);
  if (resumeSessionId) flags.push(`--session-id ${shellQuote(resumeSessionId)}`);
  return [
    `export PI_CODING_AGENT_DIR="\${OPTIO_PI_HOME:?Pi run home is required}"`,
    ...(repoTask
      ? [
          // Git's per-worktree administrative directory survives run-home cleanup
          // and resets, but is removed with the worktree. It never dirties the repo.
          `PI_SESSION_DIR="$(git rev-parse --git-path optio-pi-sessions)"`,
          `mkdir -p "$PI_SESSION_DIR"`,
          `chmod 700 "$PI_SESSION_DIR"`,
        ]
      : []),
    // Disallow repository extensions/config from replacing the injected MCP
    // servers. AGENTS.md/CLAUDE.md context still loads. Explicit MCP loads
    // even with discovery disabled. No non-TTY stdin read can hang the run.
    `pi --print --mode json --no-approve --no-extensions --extension builtin:mcp ${repoTask ? '--session-dir "$PI_SESSION_DIR" ' : ""}${flags.join(" ")} -- "$OPTIO_PROMPT" </dev/null`,
  ];
}
