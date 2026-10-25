# Image build arguments

Builds install the complete upstream toolchain by default. To select runtimes:

```bash
docker build -f images/base.Dockerfile --build-arg AGENT_CLIS=claude-code,opencode -t optio-agent:custom .
```

`AGENT_CLIS=all` includes every runtime. A comma list can select `claude-code`,
`codex`, `pi`, `copilot`, `cursor`, `gemini`, `openclaw`, and `opencode` on the
base image. The API and compatibility images support Claude Code and Codex.
GitHub, GitLab, AWS and other system utilities are unchanged.

`CLAUDE_CODE_VERSION` overrides the Claude package version. The base and API
images default to upstream's `2.1.112` compatibility pin; `Dockerfile.agent`
defaults to an empty value, preserving its unpinned install.

On the base image, `OPENCODE_INSTALL_METHOD=npm` selects the pinned npm package
instead of the default installer script. `PREINSTALL_MCP_SERVERS=1` installs
pinned Filesystem and PostgreSQL MCP binaries for explicitly configured server
commands and sets `OPTIO_MCP_PREINSTALLED=1` in the image. This option defaults
to `0`; automatic connection command selection is outside this change.
