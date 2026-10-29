import type { OidcSettings } from "@optio/shared";
import type { SignInProviderName } from "./sign-in-config-service.js";
function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

export function envConfig(
  provider: SignInProviderName,
): { clientId: string; clientSecret: string; settings?: OidcSettings } | null {
  const env = process.env;
  switch (provider) {
    case "google":
      return env.GOOGLE_OAUTH_CLIENT_ID
        ? {
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
          }
        : null;
    case "github":
      return env.GITHUB_OAUTH_CLIENT_ID || env.GITHUB_APP_CLIENT_ID
        ? {
            clientId: (env.GITHUB_OAUTH_CLIENT_ID ?? env.GITHUB_APP_CLIENT_ID)!,
            clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? env.GITHUB_APP_CLIENT_SECRET ?? "",
          }
        : null;
    case "gitlab":
      return env.GITLAB_OAUTH_CLIENT_ID
        ? {
            clientId: env.GITLAB_OAUTH_CLIENT_ID,
            clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
          }
        : null;
    case "oidc":
      if (!env.OIDC_ISSUER_URL) return null;
      return {
        clientId: env.OIDC_CLIENT_ID ?? "",
        clientSecret: env.OIDC_CLIENT_SECRET ?? "",
        settings: {
          issuerUrl: env.OIDC_ISSUER_URL,
          scopes: env.OIDC_SCOPES || "openid email profile",
          groupsClaim: env.OIDC_GROUPS_CLAIM || undefined,
          emailClaim: env.OIDC_EMAIL_CLAIM || undefined,
          nameClaim: env.OIDC_NAME_CLAIM || undefined,
          usernameClaim: env.OIDC_USERNAME_CLAIM || undefined,
          trustEmail: envBool("OIDC_TRUST_EMAIL") ?? false,
          usePkce: envBool("OIDC_USE_PKCE") ?? false,
          caPem: env.OIDC_CA_PEM || undefined,
          linkByEmail: envBool("OIDC_LINK_BY_EMAIL") ?? false,
        },
      };
  }
}
