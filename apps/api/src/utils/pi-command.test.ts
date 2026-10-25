import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { piCommand } from "./pi-command.js";
import { buildPooledAgentCommand } from "../services/pooled-agent-command.js";

it("quotes model/thinking/session options and closes non-TTY stdin", () => {
  const command = piCommand(
    { OPTIO_PI_MODEL: "model'; touch /tmp/nope; '", OPTIO_PI_THINKING: "high" },
    "session; echo wrong",
  ).join("\n");
  execFileSync("bash", ["-n"], { input: command });
  expect(command).toContain("--session-id 'session; echo wrong'");
  expect(command).toContain('-- "$OPTIO_PROMPT" </dev/null');
  expect(command).toContain("--no-approve --no-extensions --extension builtin:mcp");
});
it("uses the same command for pooled runs", () => {
  expect(buildPooledAgentCommand("pi", {}, { maxTurns: 5, label: "test" })).toEqual(piCommand({}));
});
