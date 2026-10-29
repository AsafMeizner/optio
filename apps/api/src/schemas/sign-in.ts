import { secureIdentityProviderUrl, insecureIdentityProviderTlsAllowed } from "../utils/idp-url.js";
import { z } from "zod";
import { OIDC_PRESETS } from "@optio/shared";

const pem = z
  .string()
  .max(50_000)
  .refine((v) => !v.trim() || /-----BEGIN CERTIFICATE-----/.test(v), {
    message: "Paste the CA as PEM (-----BEGIN CERTIFICATE-----)",
  })
  .nullable()
  .optional();

export const OidcSettingsSchema = z.object({
  preset: z.enum(OIDC_PRESETS).optional(),
  issuerUrl: z
    .string()
    .trim()
    .url()
    .refine(secureIdentityProviderUrl, { message: "The issuer URL must start with https://" }),
  scopes: z.string().trim().max(500).optional(),
  groupsClaim: z.string().trim().max(200).optional(),
  emailClaim: z.string().trim().max(100).optional(),
  nameClaim: z.string().trim().max(100).optional(),
  usernameClaim: z.string().trim().max(100).optional(),
  trustEmail: z.boolean().optional(),
  usePkce: z.boolean().optional(),
  tokenAuthMethod: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
  caPem: pem,
  insecureSkipVerify: z
    .boolean()
    .optional()
    .refine((value) => !value || insecureIdentityProviderTlsAllowed(), {
      message:
        "Insecure identity-provider TLS requires OPTIO_IDP_ALLOW_INSECURE_TLS=true on the deployment",
    }),
  linkByEmail: z.boolean().optional(),
});

export const ldapSettingsSchema = z.object({
  url: z
    .string()
    .trim()
    .regex(/^ldaps?:\/\/[^\s/]+$/i, "An ldap:// or ldaps:// URL, e.g. ldaps://ad.example.com:636"),
  startTls: z.boolean().optional(),
  caPem: pem,
  insecureSkipVerify: z.boolean().optional(),
  bindDn: z.string().trim().max(1000).nullable().optional(),
  userBaseDn: z.string().trim().min(1).max(1000),
  userFilter: z.string().trim().max(2000).nullable().optional(),
  usernameAttribute: z.string().trim().max(100).nullable().optional(),
  emailAttribute: z.string().trim().max(100).nullable().optional(),
  displayNameAttribute: z.string().trim().max(100).nullable().optional(),
  groupMode: z.enum(["memberOf", "search"]).optional(),
  groupBaseDn: z.string().trim().max(1000).nullable().optional(),
  groupFilter: z.string().trim().max(2000).nullable().optional(),
  usernameLabel: z.string().trim().max(60).nullable().optional(),
  linkByEmail: z.boolean().optional(),
});

export const ldapLoginSchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(1000),
  /** The CLI: answer with a personal access token instead of a browser code. */
  cli: z.boolean().optional(),
});
