# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Optio, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email your report to **security@optio.dev** with:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
3. You will receive an acknowledgment within 48 hours.
4. We will work with you to understand the issue and coordinate a fix before any public disclosure.

We ask that you give us reasonable time to address the issue before disclosing it publicly.

## Current Security Posture

### Authentication and authorization

The web UI and API require sign-in (GitHub, Google, GitLab or generic OIDC; see
`docs/sign-in.md`) unless `OPTIO_AUTH_DISABLED=true`, which is for local
development only. Sessions and personal access tokens are random 256-bit values
stored as SHA-256 hashes. Workspaces enforce admin / member / viewer roles, and
work, secrets and connections are either the organization's or one person's
(`docs/scope.md`). Actions on the whole deployment (global secrets, the Claude
token, ticket providers, cluster pods and upgrades) need a deployment admin:
anyone who can sign in can create a workspace and be its admin.

With GitHub or OIDC sign-in and no allowed domains, anyone with an account at
that provider can sign in. Restrict sign-in (allowed domains, your IdP) or keep
Optio on a private network.

### Encryption at Rest

Secrets stored in the database (e.g., API keys, tokens) are encrypted using **AES-256-GCM** with a configurable encryption key. Each secret has its own initialization vector (IV) and authentication tag. The encryption key is provided at deployment time via the `encryption.key` Helm value or the `ENCRYPTION_KEY` environment variable.

### Agent Execution

Agents (Claude Code, OpenAI Codex) run inside isolated Kubernetes pods with git worktrees. Each task gets its own worktree within a shared repo pod. The pods run with a dedicated ServiceAccount that has RBAC-scoped permissions limited to pod and exec operations within the Optio namespace.

Claude Code runs with `--dangerously-skip-permissions`, which means the agent has full access to the filesystem and can execute arbitrary commands within the pod. This is necessary for the agent to function but means you should treat the pod environment as untrusted after agent execution.

Agents read untrusted text (issues, PR diffs, web pages) and must be assumed prompt-injectable. Agent pods get no Kubernetes token, a separate service account, and GitHub App tokens limited to their repo. Enable `networkPolicy.enabled` in production so agent pods reach only the API and the internet (cloud metadata is denied by default). Keep Ask Optio on its default `agent-pod` placement: `api-pod` runs the assistant with the API's own credentials.

Past reviews and their open items: `docs/security-review-2026-10.md`, `docs/audits/security-audit-2026-10-26.md`.

## Production Deployment Recommendations

If you plan to deploy Optio beyond a local development environment, consider the following hardening measures:

### Authentication and Authorization

- Add **JWT or OAuth 2.0** authentication to the API server (e.g., via a Fastify plugin or reverse proxy)
- Use an identity provider (Auth0, Okta, Keycloak) for user management
- Implement role-based access control to restrict who can create tasks, manage repos, and view secrets

### Network Security

- Deploy behind a **reverse proxy** (nginx, Traefik, Caddy) that handles TLS termination
- Use **Kubernetes NetworkPolicies** to restrict pod-to-pod traffic within the cluster
- Restrict API and WebSocket access to known IP ranges or VPN connections
- Enable TLS for PostgreSQL and Redis connections

### Secrets Management

- Use a dedicated secrets manager (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) instead of the built-in encrypted-at-rest storage for high-sensitivity credentials
- Rotate the encryption key periodically
- Never log or expose secret values — Optio already enforces this in code, but verify in your deployment

### Kubernetes Hardening

- Run agent pods with a **read-only root filesystem** where possible
- Set resource limits (CPU, memory) on agent pods to prevent resource exhaustion
- Use **Pod Security Standards** (restricted or baseline) for the Optio namespace
- Limit the ServiceAccount permissions to the minimum required
- Consider using a container runtime sandbox (gVisor, Kata Containers) for agent pods

### Monitoring and Auditing

- Enable audit logging for the Kubernetes API server
- Monitor the `task_events` and `pod_health_events` tables for anomalous activity
- Set up alerts for failed tasks, crashed pods, and unusual agent behavior
- Review agent-generated PRs before merging — do not blindly auto-merge in production

### Supply Chain

- Pin container image versions in the Helm chart rather than using `latest`
- Scan agent images for vulnerabilities before deployment
- Use a private container registry with image signing

## Supported Versions

Optio is pre-1.0 software. Security fixes will be applied to the latest release only. There is no long-term support for older versions at this time.
