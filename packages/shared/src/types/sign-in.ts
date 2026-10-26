export const OIDC_PRESETS = [
  "adfs",
  "auth0",
  "authelia",
  "authentik",
  "generic",
  "keycloak",
  "entra",
  "okta",
  "zitadel",
] as const;
export type OidcPreset = (typeof OIDC_PRESETS)[number];

export const OIDC_PRESET_LABEL: Record<OidcPreset, string> = {
  generic: "Generic OpenID Connect",
  keycloak: "Keycloak",
  authentik: "Authentik",
  adfs: "ADFS (Windows Server)",
  entra: "Microsoft Entra ID",
  okta: "Okta",
  zitadel: "Zitadel",
  authelia: "Authelia",
  auth0: "Auth0",
};

/**
 * The issuer URL each preset expects, with the parts to fill in braced
 * (`{tenant-id}`): what the settings form offers as the issuer's placeholder.
 */
export const OIDC_PRESET_ISSUER_TEMPLATE: Record<OidcPreset, string> = {
  generic: "https://sso.example.com",
  keycloak: "https://keycloak.example.com/realms/{realm}",
  authentik: "https://authentik.example.com/application/o/{application-slug}/",
  adfs: "https://adfs.example.com/adfs",
  entra: "https://login.microsoftonline.com/{tenant-id}/v2.0",
  okta: "https://{your-org}.okta.com/oauth2/default",
  zitadel: "https://{instance}.zitadel.cloud",
  authelia: "https://auth.example.com",
  auth0: "https://{tenant}.{region}.auth0.com/",
};

export interface OidcSettings {
  /** Link only a unique, provider-verified email; disabled by default. */
  linkByEmail?: boolean;
  preset?: OidcPreset;
  /** The issuer: `<issuerUrl>/.well-known/openid-configuration` must exist. */
  issuerUrl: string;
  /** Space-separated; default "openid profile email" plus the preset's groups scope. */
  scopes?: string;
  /** The claim that carries the person's groups (default "groups"). */
  groupsClaim?: string;
  /** Claims used for the account (defaults: email, name, preferred_username). */
  emailClaim?: string;
  nameClaim?: string;
  usernameClaim?: string;
  /**
   * Treat the email as verified when the provider sends no `email_verified`
   * claim (default false). An explicit
   * `email_verified: false` is never overridden, and it never links an
   * account to another by email.
   */
  trustEmail?: boolean;
  /**
   * PKCE (S256) on the authorization request (default true when set up in
   * the app; the environment's OIDC uses it with `OIDC_USE_PKCE=true`).
   */
  usePkce?: boolean;
  /** How the client secret is sent to the token endpoint (default post). */
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic";
  /** PEM bundle of the CA that signed the provider's certificate, when it's a private one. */
  caPem?: string | null;
  /** Skip certificate verification (test labs only). */
  insecureSkipVerify?: boolean;
}

export interface SignInProviderTestResult {
  ok: boolean;
  error?: string;
  /** OIDC: what discovery found. */
  oidc?: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string | null;
    jwksUri: string;
    scopesSupported: string[];
    claimsSupported: string[];
    /** Whether the configured groups claim is advertised (null when the server lists no claims). */
    groupsClaimAdvertised: boolean | null;
    pkceSupported: boolean | null;
  };
  /** LDAP: what a bind and a sample search found. */
  ldap?: {
    boundAs?: string;
    serverInfo?: { vendor?: string; namingContexts?: string[] };
    sample?: {
      dn: string;
      username: string;
      email: string;
      displayName: string;
      groups: string[];
    } | null;
  };
}

export interface SignInAccessSettings {
  /** A provider-verified unique email may link to an existing account; disabled by default. */
  linkByEmail?: boolean;
}

export interface LdapSignInSettings extends SignInAccessSettings {
  /** ldap:// or ldaps:// URL, e.g. ldaps://ad.example.com:636 */
  url: string;
  /** Upgrade a plain ldap:// connection with STARTTLS before binding. */
  startTls?: boolean;
  caPem?: string | null;
  insecureSkipVerify?: boolean;
  /** Service account for the search bind; empty = anonymous bind. Its password is stored sealed. */
  bindDn?: string | null;
  /** Where users live, e.g. OU=People,DC=example,DC=com */
  userBaseDn: string;
  /** Filter with a {{username}} placeholder. Default matches sAMAccountName, uid or mail. */
  userFilter?: string | null;
  usernameAttribute?: string | null;
  emailAttribute?: string | null;
  displayNameAttribute?: string | null;
  /** "memberOf" (the attribute on the user, default) or "search" (a group search). */
  groupMode?: "memberOf" | "search";
  groupBaseDn?: string | null;
  /** For groupMode "search": filter with {{dn}} / {{username}} placeholders. */
  groupFilter?: string | null;
  /** Shown above the username field ("Corporate account"). */
  usernameLabel?: string | null;
}

export type AnySignInSettings = OidcSettings | LdapSignInSettings;

export interface PublicSignInProvider {
  name: "google" | "github" | "gitlab" | "oidc" | "ldap";
  displayName: string;
  /** "redirect": a button that sends the browser to the provider; "password": a form on the login page. */
  method: "redirect" | "password";
  /** LDAP: the label above the username field. */
  usernameLabel?: string | null;
}
