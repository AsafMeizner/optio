# OpenCode: headless run rules

Optio runs OpenCode with `opencode run`, non-interactively, inside a pod. Nobody can
answer a permission ask. OpenCode 1.14 defaults `external_directory` (a tool touching a
path outside the working directory, such as a virtualenv under `/tmp`) and `doom_loop`
to "ask"; a headless ask is rejected and the run aborts with exit 1.

`OPTIO_OPENCODE_HEADLESS` turns on a set of rules that keeps such a run going. It is
**off by default**: off, an OpenCode run is exactly what it was before this option
existed — no permission block, no global rules file, no extra flag.

## What it does when on

- Every `opencode.json` Optio writes (the adapter's pre-seeded global file in Repo Task
  and review pods, and the run's own `OPENCODE_CONFIG`, now written for every OpenCode
  run rather than only runs with MCP servers) carries a `permission` block: built-in
  agent restrictions preserved, `question` denied, paths outside the working directory denied except
  OpenCode's own tool-output directory, and `sudo` / `apt` / `apt-get` / `dpkg` denied.
  A denied call comes back to the agent as a tool error, so it works around it instead
  of aborting.
- `opencode run` gets `--dangerously-skip-permissions` (OpenCode's "auto" mode: approve
  what no rule explicitly denies), so an ask that slips through any rule is approved
  rather than aborting the run.
- A global `AGENTS.md` under the agent's home tells the agent the same rules, so a
  smaller model doesn't spend turns on paths it can't use. Job runs, persistent agents
  and interactive sessions get it too.

## Turning it on

Set the environment variable on the API deployment:

```yaml
env:
  - name: OPTIO_OPENCODE_HEADLESS
    value: "true"
```

`1`, `yes` and `on` are accepted as well. Restart the API; new OpenCode runs pick it up.

## Checking

With the option on, a Job run's `opencode.json` (`/opt/optio/runs/<run>/opencode/opencode.json`
in the pod) contains `"question": "deny"`, and the run's command line includes
`--dangerously-skip-permissions`. With it off, neither is present.
