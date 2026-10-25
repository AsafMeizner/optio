# Pi agent

Optio runs [Pi](https://github.com/earendil-works/pi) in pods for Repo Tasks,
Jobs, persistent agents, interactive agent sessions, and PR reviews. The base
agent image installs `@earendil-works/pi-coding-agent@1.4.0`; custom images must
include the same version. Pi requires Node.js 22.19 or newer.

Choose **Pi** in the Work form's Who section. Add or select an Anthropic,
OpenAI, or Gemini API key there (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`GEMINI_API_KEY`). A selected credential takes precedence over deployment
credentials. Without a selection, pod runs resolve supported keys from the
work owner's, repo's, workspace's, and deployment's secrets. Claude subscription
and Codex app-server credentials are not Pi credentials.

The optional model is a Pi `provider/model` identifier, as listed by
`pi --list-models`. The thinking level follows Pi's supported levels. These
settings are stored on each work item as `agentOptions.piModel` and
`agentOptions.piThinking`. A repository can select Pi as its default runtime;
per-repo model and thinking defaults are not stored. Review models use the
normal review-model setting. Pi on Optio Local machines is not supported yet;
the form disables that choice.

Pi runs in JSON print mode. Optio records completed assistant messages and tool
calls, reported token usage and cost, the opened PR URL, and the exact session
ID. It waits for `agent_settled` rather than the earlier `agent_end`, which can
precede an automatic retry. Empty/truncated output, aborted or exhausted
responses, and nonzero process exits fail the run.

Optio writes native Pi MCP configuration and connection/custom skill files into
the run's private `PI_CODING_AGENT_DIR`. Even a run with no MCP servers gets a
private directory. Connection names containing spaces or punctuation are
converted to valid, distinct Pi server names. Repository settings, MCP overrides,
and discovered extensions are not trusted; the built-in MCP extension is loaded
explicitly. Repository `AGENTS.md` and `CLAUDE.md` context still applies. Pi has no
built-in permission sandbox: the pod and Optio's normal execution boundaries
provide isolation.

Repo Task conversation sessions live in Git's per-worktree administrative
directory, separate from temporary config. Resume opens the exact prior session
while the worktree is retained; deleting the worktree deletes those sessions.
Pooled turns keep their existing Optio history behavior and do not use a shared
Pi session. Marketplace-installed skills remain Claude Code only.

Upstream protocol references:
[CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md),
[JSON events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md),
[MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).
