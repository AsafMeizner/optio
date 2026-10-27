# Sign-in

How people sign in to an Optio deployment, and how an organization sets up
its Google sign-in from the app. Code: `apps/api/src/services/sign-in-config-service.ts`,
`routes/sign-in.ts`, `services/oauth/google.ts`; web
`components/settings/sign-in-settings.tsx` (Settings → Access → Sign-in, and
the setup wizard's Sign-in step).

## Providers

OAuth providers: **Google**, **GitHub**, **GitLab**, generic **OIDC**. Each
can be configured by environment variables (`<PROVIDER>_OAUTH_CLIENT_ID` /
`_SECRET`, `OIDC_ISSUER_URL` …, Helm `auth.*`). **Google** can also be
configured **in the app**: Settings → Sign-in stores the OAuth client in
`auth_provider_configs` (the secret AES-256-GCM encrypted on the row, AAD
`auth_provider|google`, never returned) together with the **allowed
domains**. A stored, enabled row takes precedence over the environment.
`GET /api/auth/providers` (public) lists what people can sign in with and
says `setupRequired: true` while nothing is configured anywhere.

## Allowed domains

With domains set, a sign-in is refused (`/login?error=domain_not_allowed`)
unless the account's Google Workspace domain (`hd`) is listed **and** its
verified email's domain is listed (`domainDecision`). Public mail domains are
refused when saving (`normalizeAutoJoinDomains`). The CLI's PKCE login shares
the callback, so it is covered too. The `hd=` authorize parameter is sent as a
hint when exactly one domain is allowed.

## Deployment admins

The people who may change how everyone signs in. Instance-wide: a workspace
admin isn't enough, since every signer-in becomes admin of a workspace of
their own. Granted by `users.deployment_admin` (Settings → Sign-in →
Deployment admins, by email, for people who have signed in once) or by
`OPTIO_DEPLOYMENT_ADMINS` (comma-separated emails; Helm
`auth.deploymentAdmins`). `GET /api/auth/me` reports `deploymentAdmin`.

Email-based grants require a verified email assertion from the sign-in
provider, persisted in `users.email_verified`. Existing users populate it at
their next sign-in; an existing explicit `deployment_admin` grant remains in
place. The first bootstrap login must also use the configured provider and
an allowed, verified domain, and only one concurrent login can claim it.

Deployment admins also control deployment-wide secrets: rotating the shared
GitHub token, reading the Claude token proxy, refreshing shared Claude
credentials from a machine, and adding shared agent credentials. The legacy
agent-credential owner value `workspace` stores a global secret, so it needs
this role too. Members can still store personal credentials. Automatic shared-token refresh
checks the machine owner's permission again before using it. For upgrades with
no deployment admin yet, the founding workspace's admin retains shared-credential
administration until a deployment admin is appointed.

## Browser authentication

Browser login starts through the web application's `/api/auth/:provider/login`
proxy. It creates a private verifier cookie and sends its SHA-256 challenge to
the API. The OAuth state and final exchange code retain that challenge, and
the callback exchanges the code only with the originating browser's verifier.
State and exchange codes are consumed atomically in Redis. Native CLI login
continues to use its own PKCE verifier.

With an HTTPS `PUBLIC_URL`, browser session and verifier cookies use the
`__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, without a
Domain attribute. Upgrading from the old cookie name requires one browser
sign-in; existing PATs are unaffected. HTTP development keeps the original
cookie names. Set the same `PUBLIC_URL` on the web and API containers.

Cookie-authenticated mutations and browser WebSocket upgrades require a
trusted Origin (`PUBLIC_URL`, `PUBLIC_API_URL`, or `OPTIO_ALLOWED_ORIGINS` at
the API; the web proxy accepts its own origin). Native clients without an
Origin header keep explicit credential authentication. WebSocket upgrades
also recheck workspace membership and resolve the current role.

## First install: bootstrap

Install the chart with `publicUrl` and **no provider** (allowed now). Nobody
can sign in, so Optio is in **bootstrap mode**: `/login` sends people to
`/setup`, whose first step is **Sign-in**. The step is reachable without a
session but needs the one-time **setup token**: `OPTIO_SETUP_TOKEN` (Helm
`auth.setupToken`) or, when unset, one the API generates, shares through Redis
(every replica agrees) and prints in its log:

```
kubectl logs -n optio deploy/optio-api | grep "setup token"
```

The step shows the redirect URI to register in Google Cloud Console
(`<origin>/api/auth/google/callback`, the origin being `PUBLIC_API_URL` when
the browser reaches the API at an origin of its own, else `PUBLIC_URL`), takes
the client ID and secret, the allowed domains, and the organization's name,
then **saves and signs in with Google**. The first person through
`completeSignIn`: they become the **deployment admin**, their workspace is
renamed to the organization and gets the allowed domains as auto-join (role
member), and the pending claim is spent. Everyone else from those domains
then lands in that workspace as a member.

The token also lets a signed-in person **claim** the role on a deployment
that has none yet (`POST /api/auth/deployment-admins/claim`, an upgrade from
before the role existed). Once a deployment admin exists the token opens
nothing.

## Endpoints

| Method | Path                                | Who                                               |
| ------ | ----------------------------------- | ------------------------------------------------- |
| GET    | `/api/auth/sign-in`                 | anyone signed in; public in bootstrap mode        |
| PUT    | `/api/auth/sign-in/:provider`       | deployment admin, or the setup token while usable |
| DELETE | `/api/auth/sign-in/:provider`       | same                                              |
| GET    | `/api/auth/deployment-admins`       | same                                              |
| POST   | `/api/auth/deployment-admins`       | same (`{ email }`, an existing user)              |
| DELETE | `/api/auth/deployment-admins/:id`   | same (never the last one)                         |
| POST   | `/api/auth/deployment-admins/claim` | signed in + setup token, only while none exists   |

The setup token travels in `X-Optio-Setup-Token`. The auth plugin lets
`/api/auth/sign-in*` through without a session only while in bootstrap mode.
Only `/api/setup/status` is public among the agent setup endpoints. Credential
probes and repository listing require a signed-in workspace admin, even before
any agent credentials have been stored. Complete the Sign-in step first.

## Testing

`services/sign-in-config-service.test.ts` (the domain decision, the env
list), `services/sign-in-config.int.test.ts` (stored config over env, secret
sealed, bootstrap mode, the shared token, the first sign-in's bootstrap, the
deployment-admin rules).
