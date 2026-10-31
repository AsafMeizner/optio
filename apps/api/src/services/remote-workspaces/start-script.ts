/**
 * The start script (docs/remote-workspaces.md, "The start script"): what
 * pairs a workspace with Optio when the workspace doesn't do it itself. It
 * checks out the repository, installs the Optio
 * CLI from the server and starts `optio local up` in the checkout, detached,
 * logging to /tmp/optio-local.log. Everything it needs comes from OPTIO_*
 * variables (`startScriptEnv`), so the same script serves:
 *
 * - Daytona and E2B: Optio runs it in the sandbox (`runStartScript`), with
 *   the variables in the command's environment;
 * - GitHub Codespaces: the devcontainer's postStartCommand fetches it from
 *   `GET /api/cli/workspace-start.sh` (routes/cli-downloads.ts) after reading
 *   the variables from the codespace's pairing secret
 *   (examples/remote-workspaces/codespaces).
 *
 * A Coder template starts the daemon in its own startup script
 * (examples/coder/optio-workspace).
 */
import { REMOTE_WORKSPACE_REPO_PARAMETER } from "@optio/shared";
import type { PairingBundle } from "./types.js";

/** The start script's environment for one start. */
export function startScriptEnv(input: {
  bundle: PairingBundle;
  checkoutDir: string;
  /** The machine's name in Optio (the workspace's). */
  hostname: string;
  /** The start's parameters: the repository is read from them. */
  parameters: Record<string, string>;
}): Record<string, string> {
  const p = input.parameters;
  return {
    OPTIO_SERVER: input.bundle.OPTIO_SERVER,
    OPTIO_TOKEN: input.bundle.OPTIO_TOKEN,
    OPTIO_LOCAL_HOST_ID: input.bundle.OPTIO_LOCAL_HOST_ID,
    OPTIO_LOCAL_HOSTNAME: input.hostname,
    OPTIO_CHECKOUT_DIR: input.checkoutDir,
    OPTIO_REPO_URL: p[REMOTE_WORKSPACE_REPO_PARAMETER] ?? "",
  };
}

/** The script itself (POSIX sh). */
export const START_SCRIPT = `#!/bin/sh
# Pairs this workspace with Optio as a machine (docs/remote-workspaces.md).
# Reads OPTIO_SERVER, OPTIO_TOKEN, OPTIO_LOCAL_HOST_ID, OPTIO_LOCAL_HOSTNAME,
# OPTIO_CHECKOUT_DIR and OPTIO_REPO_URL from the
# environment; needs Node.js 20+, git, curl (or wget) and tar.
set -u
if [ -z "\${OPTIO_SERVER:-}" ] || [ -z "\${OPTIO_TOKEN:-}" ] || [ -z "\${OPTIO_LOCAL_HOST_ID:-}" ]; then
  echo "optio: no pairing bundle here; nothing to start"
  exit 0
fi
dir="\${OPTIO_CHECKOUT_DIR:-$HOME/repo}"
name="\${OPTIO_LOCAL_HOSTNAME:-$(hostname)}"

# An earlier start's daemon pairs with a token that is revoked by now. (The
# brackets keep the pattern from matching this script's own command line.)
pkill -f 'optio[.]js local up' 2>/dev/null || true

mkdir -p "$dir"
if [ -n "\${OPTIO_REPO_URL:-}" ] && [ ! -e "$dir/.git" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
  git clone -- "$OPTIO_REPO_URL" "$dir" || echo "optio: couldn't clone $OPTIO_REPO_URL into $dir"
fi

if command -v curl >/dev/null 2>&1; then curl -fsSL "$OPTIO_SERVER/api/cli/install.sh" | sh
else wget -qO- "$OPTIO_SERVER/api/cli/install.sh" | sh; fi || {
  echo "optio: couldn't install the Optio CLI from $OPTIO_SERVER"; exit 1; }

export OPTIO_SERVER OPTIO_TOKEN OPTIO_LOCAL_HOST_ID
export OPTIO_LOCAL_HOSTNAME="$name"
nohup "$HOME/.optio/bin/optio" local up --no-remote-dirs --dir "$dir" --name "$name" \\
  >>/tmp/optio-local.log 2>&1 &
echo "optio: started the daemon for $dir (log: /tmp/optio-local.log)"
`;

/**
 * The command a provider runs to start it detached: the script travels in
 * OPTIO_START_SCRIPT next to the other variables, so nothing in the command
 * line needs quoting and no secret is in it.
 */
export const START_COMMAND = `nohup sh -c "$OPTIO_START_SCRIPT" >>/tmp/optio-local.log 2>&1 &`;

/** `env` and the script, as one environment for START_COMMAND. */
export function startCommandEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, OPTIO_START_SCRIPT: START_SCRIPT };
}

/**
 * `env` as a shell file of `export NAME='value'` lines (for a provider that
 * hands the variables over as one value, Codespaces' secret).
 */
export function shellExports(env: Record<string, string>): string {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${quote(v)}`)
    .join("\n");
}
