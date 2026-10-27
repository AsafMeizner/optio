# Security audit — 26 October 2026

This review covered the current working tree, including changes that were already
in progress. It combined manual source review, dependency and container scanning,
secret scanning, and executable regression tests. It is not a penetration-test
certification or a claim that the system has no remaining vulnerabilities.

## Integration with the merged audit

The follow-up is integrated over PR #690 (`8c58f679`) and retains its Git token
scoping, skill import restrictions, webhook body bounds, usage checks, Pi runtime,
image-build arguments and Node 26.12.1 baseline. The implementation below makes
agent-container placement mandatory and adds the browser, verified-email,
private-work, transport and dependency hardening missing from that merge.
The integration review additionally found a credential-exfiltration regression
in registration-based Git host trust: a workspace admin could register an
attacker's host and cause repository autodetection to send deployment credentials
there. Trust now comes from built-in provider hosts and deployment-configured
allowlists; registering a repo cannot grant access to shared credentials. The
same rule applies to automatic pod Git credential injection.

The new Pi image dependency tree also contained vulnerable Undici 8.10.2. Its
existing Pi 1.4.0 default now uses an audited lockfile with Undici 8.12.3; optional
runtime selection and the explicit Pi version override remain available.

The verification pass also exposed a run-handoff clock mismatch: releasing a
lease used the API clock while claiming it used Postgres time. A fast API clock
could leave a released lease temporarily unclaimable. Release now uses database
time; a deterministic clock-skew regression verifies immediate handoff and that
an old holder cannot release the newer holder's lease. Browser test cleanup also
drains in-flight mock requests before disposing their response context.

Post-merge artifact verification found that the preset-image workflow's two
`include` entries overwrote the platform on each preset, producing only ARM64
images. Platform is now an explicit matrix axis, so each of the five presets
builds on both architectures before their manifests are published.

Unrelated unfinished Codex-login and session-UI edits were kept out of this PR.
Their security guards remain in the original working tree and must accompany
those features when they are submitted.

A review of the combined code confirmed these remaining security boundaries:

1. **Provider events are not bound to an owning workspace.** A member can create
   a Slack/Linear/Jira/PagerDuty/Sentry trigger in their own workspace matching
   another tenant's legitimate signed events. Signature verification authenticates
   the provider, but dispatch still searches triggers across workspaces. The fix
   needs an authoritative provider-account-to-workspace mapping, not merely more
   event filters (`event-trigger-service.ts`, `listEventTriggers`/matching).
2. **Ad-hoc repo tasks can request any URL reachable by deployment Git credentials.**
   App tokens are now scoped to the requested repo, but the task pipeline does not
   require that repo to be registered to the caller's workspace. A signed-in member
   with runnable agent work can reach a known repo accessible to the deployment's
   App/PAT. Workspace repo entitlement must be checked before credentials or pods
   are issued (`routes/tasks.ts`, `work-write-service.ts`, `task-worker.ts`).
3. **Generic webhook authentication remains optional.** An enabled secretless
   trigger with a known/guessable global path can be invoked anonymously. Signed
   variants hash re-serialized JSON and accept caller-chosen idempotency keys;
   signatures need raw-body verification and a defined replay policy. A required
   secret or explicit unauthenticated mode is needed (`routes/hooks.ts`,
   `trigger-service.ts`).

These were already open policy/design items in the merged audit; this integration
preserves existing behavior rather than silently changing tenant enrollment or
legacy trigger/repo semantics. They remain actionable security work. Additional
hardening includes expiring/revocable Git-helper credentials, encrypted trigger
secrets, workspace-scoped credential UI, and supply-chain pinning.

The unit/scanner/image totals below describe the first audit validation pass.
The combined branch is additionally checked with the repository's full push gate
and CI; see the integration PR for those exact results.

Vitest 4's more accurate coverage mapping exposed gaps hidden by the old mapper.
The follow-up adds shared transport and web-state tests and measures API coverage
across its unit and real-database integration suites together. All numeric
coverage thresholds and runtime-source inclusions are retained. The push gate
now uses CI settings and runs this aggregate API coverage check before allowing
a push. The standalone Zod patch regression runs without application coverage;
the complete suites enforce that coverage separately.

## Confirmed findings and remediation

| Severity | Finding and exploit conditions                                                                                                                                                                                                                | Remediation                                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Ask Optio could run a user-controlled harness in the API container with native shell/file tools. Its MCP restrictions did not prevent reading API credentials, the Kubernetes identity, or other users' files.                                | All interactive harness turns now require agent containers. The obsolete `api-pod` setting cannot restore process execution. Removed the harness binaries and agent home from the API image/chart.                                                                        |
| Critical | A workspace admin could replace deployment-wide credentials, read the shared Claude token, or roll out an arbitrary API image. Machine refresh and shared agent credentials offered alternate write paths.                                    | Require deployment-admin authority for global secrets, credential/token proxies, cluster administration and automatic credential import. Preserve personal credentials and workspace-scoped operations. Validate private-secret offboarding against workspace membership. |
| High     | The global WebSocket bus forwarded resource events across workspaces, including private messages/logs; reconnect history was unscoped. Task/Job/agent log sockets also lacked owner checks.                                                   | Resolve event audiences from current database rows, enforce workspace and owner visibility, omit log bodies from the global stream, and scope catch-up queries. Unknown/deleted resources fail closed.                                                                    |
| High     | Legacy task log/export/event/message/comment/subtask/dependency routes bypassed private-work visibility. Bulk retry/cancel and child creation bypassed owner-only execution.                                                                  | Apply the existing `canSee`/`canChange` policy consistently before reads or mutations. Workspace admins retain the documented read-only visibility into private work.                                                                                                     |
| High     | Dependency edges could cross tenants or expose private tasks. Review/subtask creation dropped parent ownership and environment restrictions; review lookups could use another workspace's repo settings or the creator's Git credentials.     | Enforce dependency workspace/owner compatibility, filter historical unsafe edges, inherit the parent's owner/access settings, and scope review/merge settings and Git access to the work's owner and workspace.                                                           |
| High     | Unverified OAuth email claims could satisfy deployment-admin grants. Bootstrap completion was not sufficiently bound to the configured provider/domain and could race.                                                                        | Persist provider-verified email status, require verified email for email-based grants, enforce bootstrap provider/domain rules, and consume the bootstrap claim atomically.                                                                                               |
| High     | Cookie-authenticated mutations and WebSockets did not adequately reject hostile browser origins. OAuth exchange codes were not bound to the initiating browser; read-then-delete exchanges could race.                                        | Validate browser origins, bind web OAuth exchanges to an HttpOnly verifier, consume one-use codes with Redis `GETDEL`, and use HTTPS `__Host-` cookies to prevent sibling-domain cookie planting. Native PAT and CLI PKCE flows remain supported.                         |
| High     | Missing agent credentials made setup operations anonymous, including probes/repository listing. Secret lookup failures could also activate that bypass.                                                                                       | Only setup status remains public; configuration/probes require authenticated authorization. First-install sign-in configuration keeps its setup-token bootstrap path.                                                                                                     |
| High     | Jira/GitLab ticket integrations checked DNS separately from connection establishment. Jira followed redirects; GitLab could forward `PRIVATE-TOKEN` to a redirected host. Generic outbound redirects also retained custom credential headers. | Share a DNS-pinned HTTP transport across the API and ticket providers. Route actual Jira SDK requests through it, reject ticket/GitLab redirects, and retain only an explicit safe header list on generic cross-origin redirects.                                         |
| High     | Network policies omitted non-repo agent pods. Additive policies permitted internal/metadata destinations and arbitrary ports throughout the Optio namespace. Requested restrictions could fail to install while provisioning continued.       | Cover every managed agent pod, restrict DNS and internal API access, exclude nonpublic address ranges from internet egress, provide explicit narrow exceptions, and fail provisioning when requested restrictions cannot be installed.                                    |
| High     | The optional secret proxy did not implement TLS interception or exclude credentials from per-run exec environments; generated Envoy configuration also failed real binary validation.                                                         | Disable enabling or reusing the unsupported proxy, including existing repo configurations and interactive sessions. Return a clear error instead of claiming credential isolation. Re-enabling needs a working implementation and end-to-end isolation tests.             |
| Medium   | Comment mutation checked a supplied task ID independently of the comment ID.                                                                                                                                                                  | Bind both IDs in the mutation query and prevent authenticated users from editing authorless comments.                                                                                                                                                                     |
| Medium   | Caller-supplied `X-Forwarded-For` values bypassed the WebSocket connection cap. Application size checks ran after the transport buffered a message.                                                                                           | Use Fastify's resolved client address and enforce the existing 1 MiB limit in the WebSocket transport itself.                                                                                                                                                             |
| Medium   | Assistant Markdown could load external images from untrusted agent output, enabling passive tracking or data-bearing requests.                                                                                                                | Disable embedded media while preserving explicit links, matching the existing log-rendering policy.                                                                                                                                                                       |

Primary implementation areas are `apps/api/src/plugins/auth.ts`,
`services/{sign-in-config-service,session-harness-service,event-visibility,task-service,dependency-service,subtask-service,review-service}.ts`,
the task routes and WebSocket handlers, `packages/shared/src/utils/outbound-http.ts`,
`packages/ticket-providers`, and `helm/optio/templates/network-policy.yaml`.

## Dependencies and images

The initial `pnpm audit --json` reported **159 findings**: 8 critical, 63 high,
77 moderate, and 11 low. Those are scanner findings across production and developer
dependencies, not 159 demonstrated remotely exploitable application bugs.

Patched direct/transitive dependencies include Next.js 15.5.28, Fastify 5.12.7,
Undici 8.12.3, Vitest 4.1.12, Vite 7.3.7, Sharp 0.35.5, OpenTelemetry, Axios,
DOMPurify, multipart/form parsers, and the affected utility dependencies. Vitest
constructor mocks and generated-output exclusions were updated without removing
source assertions. The API image now installs only its production dependency graph.

The final registry audit reports **one high advisory**, Zod
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), for the
retained 3.25.76 compatibility dependency. Upstream fixed collection bounds in
[Zod 4.6.6](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd).
The checked-in `patches/zod@3.25.76.patch` backports early collection rejection to
the v3 and bundled v4 implementations, for ESM and CommonJS. Forty regression
cases verify size limits, async validation, min/max combinations, transforms and
conditional checks. Raw set/map limits are enforced before deduplication; custom
conditional/refinement callbacks retain their parsed-value semantics. No blanket
advisory ignore is configured.

`pnpm security:audit` checks the live registry, accepts only that exact advisory
and version with the reviewed patch's SHA-256, and executes the regression suite.
Every other advisory fails the gate. CI now runs this command.

Node and Ubuntu image digests were refreshed and available distribution updates
are applied during image builds. Claude Code's old 2.1.112 pin was replaced with
2.1.310 after a disposable Linux ARM64 `docker exec` smoke test exercised an actual
Bash tool call against a fake local provider. This resolves the affected versions
in the upstream [worktree advisory](https://github.com/anthropics/claude-code/security/advisories/GHSA-7835-87q9-rgvv)
and [plugin SHA advisory](https://github.com/anthropics/claude-code/security/advisories/GHSA-pq7j-f95f-qfcv).
The former describes a macOS sandbox escape; it is not evidence of a Linux
container escape in Optio. Agent execution on Linux AMD64 still needs independent
validation for the previously documented Bun issue.

## Verification and scope

- Full workspace unit suite plus final API rerun: **5,645 passed**, with 10 existing Linux-only runtime
  tests skipped on macOS.
- Workspace typechecking passed. Focused API authorization, controller, OAuth,
  WebSocket, assistant-isolation and DNS-pinning tests exercised real
  Postgres/Redis, real HTTP sockets, and deterministic API pipelines.
- Chromium checks passed for chat display, assistant navigation and a real
  assistant flow against the isolated test stack. Trusted origins are now
  explicitly configured in that stack. OpenAPI generation, lint and types passed
  with 184 existing schema warnings. Scoped ESLint and `git diff --check` passed.
  The original checkout had formatting differences in the unrelated
  `codex-event-parser.ts` work. Those files are excluded from this integration;
  the integrated branch passes the formatting check.
- Gitleaks reported 19 history matches and 9 current-source matches. Manual
  inspection classified them as test credentials, test TLS keys, documentation
  examples or false positives; no production secret was confirmed. This is not
  proof that credentials were never exposed.
- OSV queries for 46 explicitly versioned Android Maven artifacts returned no
  advisories. This does not cover all BOM-selected or resolved transitive native
  dependencies. Native storage/TLS code received static review; native dynamic
  penetration testing was not performed.
- Trivy reviewed the API image and rendered deployment configuration. Required
  control-plane permissions (`pods/exec`, NetworkPolicy management) and writable
  database storage are expected scanner findings, not permissions granted to
  agent service accounts.

Container scans of the rebuilt images found:

| Image            | OS high/critical findings | Application/tool findings                                     | Assessment                                                                                                                                                                                                                               |
| ---------------- | ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API              | 65 high, 1 critical       | One high Zod advisory, locally patched                        | No distribution-fixed high/critical OS finding remains. Removed npm and its vulnerable dependency tree from the runtime.                                                                                                                 |
| Web              | 56 high, 1 critical       | None                                                          | No distribution-fixed high/critical OS finding remains; npm removed.                                                                                                                                                                     |
| PostgreSQL 16.15 | 61 high, 1 critical       | 26 Go-standard-library findings in the bundled `gosu` utility | Distribution packages are current. The utility drops privileges; the deployment starts PostgreSQL directly as UID 999, without invoking its root-only `gosu` branch. These scanner matches do not establish reachable TLS/HTTP exploits. |
| Redis 7.4.12     | None                      | None                                                          | Refreshed within the existing major version.                                                                                                                                                                                             |

The API/web critical zlib entry is
[CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853):
Debian identifies the affected MiniZip code as not built into these zlib binaries.
The PostgreSQL libxml2 entry,
[CVE-2026-6653](https://security-tracker.debian.org/tracker/CVE-2026-6653),
remains without a stable-distribution fix. Debian classifies it as a minor XML
parser issue; Trivy labels it critical. It is retained, not suppressed. Image counts include duplicated
findings across packages and do not equal distinct application vulnerabilities.

PostgreSQL and Redis image digests are pinned. Both deployments now use Recreate
updates: two PostgreSQL processes must not write the same data directory, and two
independent Redis instances must not receive traffic as though they were replicas.
The disabled Envoy implementation's old 1.31 default is also replaced with
[1.39.5](https://github.com/envoyproxy/envoy/releases/tag/v1.39.5).

The rebuilt base agent image has **zero high/critical OS findings and no
Node/Python dependency findings**. It retains 37 medium and 4 low Ubuntu entries
without available packaged fixes, plus an UNKNOWN-severity `gh`/`x/crypto`
module advisory whose [OpenPGP reachability is unverified](https://pkg.go.dev/vuln/GO-2026-5932).
Copilot is pinned to 1.0.103, beyond the fix for its
[nested-repository execution vulnerability](https://github.com/github/copilot-cli/security/advisories/GHSA-9ccr-r5hg-74gf). OpenClaw's Node 22 compatible release has a separate audited lockfile
and fixed MCP/Undici/Zod overrides, checked in CI. Agent npm 12 includes patched
bundled dependencies and requires explicit approval for package install hooks.
The node-agent scan also includes compiler headers: its raw 14 critical and
372 high entries all match `linux-libc-dev` kernel headers, not an installed or
running kernel. The container uses the Docker Desktop host kernel
`7.0.14-linuxkit`; that host kernel was not audited. After separating those
header-only matches, the node image retains 98 medium, 25 low and one UNKNOWN
finding, with no Node/Python dependency findings. Headers remain available for
native-module builds; the raw results are not described as clean.

The Go/full presets replace unsupported Go 1.23.4 with
[Go 1.27.3](https://go.dev/dl/), with architecture-specific SHA-256 checks.

The local Docker Desktop deployment was upgraded successfully: both API replicas,
web, PostgreSQL 16.15 and Redis 7.4.12 are healthy. The verified-email migration is
present. A real Claude Job completed through Kubernetes using the rebuilt agent
image, and its temporary Job was deleted afterward. PostgreSQL was backed up
before rollout; the existing encryption key was preserved. Existing agent pods
and their work were not destroyed.

Validated image IDs:

- API: `079038c0e4903e9813a69e15534efe9e31d5f7b134eca0440e6e0c798bc7f56a`
- Web: `21c17830b7c3587a90eacb4a2e44044e668099ba1f32c80a9cc2dc90a9a939fa`
- Base/agent: `c12cf78f17da5ad137d8827ef87ca449440a7b030e0a30fe2ad43ddf57983eab`
- Node agent: `f9a49ca82775afa71d0f78d556b58ecdd1f8c81207a180a37c6291ce284fdf30`

The base and node variants received native Claude Bash/stream tests. Other
language presets were not built in full; the updated Go installer was checked
separately. This rollout is local only; production hosting was not changed.

## Remaining operational boundaries

- Shared deployment credentials and global cluster controls now require a
  deployment admin, not merely an admin in any workspace. The legacy API
  `owner: workspace` credential option stores deployment-global credentials and
  follows the stronger gate.
- HTTPS browser sessions must sign in again because session cookies now use the
  host-only prefix. Existing explicit deployment-admin grants remain; new grants
  by email require a provider-verified sign-in. The database migration records
  that verified status without trusting historical email strings.
- The review does not revoke credentials already copied into old pods or exposed
  before these fixes. Historical child rows are not relabeled underneath active
  workers. Unsafe historical dependency edges are ignored, not deleted.
- NetworkPolicy enforcement requires a supporting CNI and the policy to be
  enabled. Docker Desktop cannot establish that enforcement works. Extra egress
  should be narrow and explicit for trusted internal connections. Kubernetes
  [combines permissions from applicable policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/),
  so another broad policy can undo a restriction.
- The optional secret proxy is disabled. Standard agent work intentionally gets
  its configured credentials; it must not be treated as credential-free execution.
- Worktrees in the same execution pool remain mutually trusted. Linux pods share
  the host kernel; these changes do not establish isolation for hostile tenants.
- Registry scans cannot detect unpublished vulnerabilities, and some OS/vendor
  advisories have no available fix. Container results must be evaluated against
  vendor status and reachable functionality rather than equating a scanner count
  with exploitability.
