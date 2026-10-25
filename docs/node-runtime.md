# Node.js runtime

Optio development, CI, and release images use Node.js **26.12.1**. The developer
version is in `.node-version`; CI reads that file. Install the matching pnpm with
`npm install -g pnpm@10.34.8` (also pinned in `package.json`). Node 26 no longer
ships Corepack.

The API, web, MCP build stages, and agent runtime use the same digest-pinned
`node:26.12.1-bookworm-slim` multi-platform image. Ubuntu-based agent images copy
Node and npm from that image and install their shared-library dependencies.
This avoids a floating NodeSource package supplying a different patch version.
The base agent explicitly installs Corepack 0.36.0 to preserve project-aware
pnpm and Yarn selection for repository tooling.

Node 26.12.1 includes the October 2026 security fixes, including the Brotli
decoder fix for CVE-2026-111497. See the
[official release notes](https://nodejs.org/en/blog/release/v26.12.1).
Upgrading requires rebuilding the service and agent images and replacing running
pods; changing source configuration alone does not patch existing containers.

This release updates compatible dependency patch/minor versions. Next.js stays
on the latest 15.x patch, TypeScript on 5.x, and Vitest on 3.x. OpenTelemetry stays on its existing major family, with its API held at 1.9.1
to satisfy the SDK peer constraint. The documented Claude Code/OpenCode
workaround pins remain unchanged. Major framework, schema, queue, and SDK migrations need
separate review.

When updating Node again, refresh `.node-version`, the root engine requirement,
all five Dockerfiles that name the Node image, Node type definitions, this
document, and the contributor prerequisites. Resolve the multi-platform digest
from the official Docker registry and run the release checks on the new runtime.

The dependency refresh reduces the workspace audit from 100 findings to 15
(11 moderate, 2 high, 2 critical), as checked on October 25, 2026. Remaining
findings are in Vitest/mocker/Tinypool tooling, Zod 3, and older OpenTelemetry
propagator/instrumentation packages. Resolving them requires separately reviewed
version-family migrations; this is not a clean dependency audit. These counts
are registry findings, not a determination that each path is exploitable in
Optio.

Node 26 also exposes host Web Storage globals. Vitest 3's jsdom environment
otherwise preserves Node's storage instead of using browser storage. The web
test setup explicitly selects the current jsdom window's local/session storage;
the existing persistence and blocked-storage tests exercise this behavior.
