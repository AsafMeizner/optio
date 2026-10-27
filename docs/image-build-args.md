# Image build arguments

Builds install the complete upstream toolchain by default. To select runtimes:

```bash
docker build -f images/base.Dockerfile --build-arg AGENT_CLIS=claude-code,opencode -t optio-agent:custom .
```

`AGENT_CLIS=all` includes every runtime. A comma list can select `claude-code`,
`codex`, `pi`, `copilot`, `cursor`, `gemini`, `openclaw`, and `opencode` on the
base image. The compatibility image supports Claude Code and Codex. The API image contains
no agent harnesses; agent-selection arguments cannot restore execution in the API pod.
GitHub, GitLab, AWS and other system utilities are unchanged.

`CLAUDE_CODE_VERSION` overrides the Claude package version. The base, compatibility and dedicated assistant images default to the security-tested
`2.1.310` release. Run `scripts/smoke-claude-exec.mjs` on the target CPU architecture
and kernel before changing it.

On the base image, `OPENCODE_INSTALL_METHOD=npm` selects the pinned npm package
instead of the default installer script. `PREINSTALL_MCP_SERVERS=1` installs
pinned Filesystem MCP (`@modelcontextprotocol/server-filesystem@2.0.1`) for explicitly configured server
commands and sets `OPTIO_MCP_PREINSTALLED=1` in the image. This option defaults
to `0`; automatic connection command selection is outside this change.

The deprecated PostgreSQL MCP server is excluded from preinstallation. Configure
a maintained PostgreSQL server separately, using a database role with only the
permissions it needs.
