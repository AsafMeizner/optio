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

const httpUrl = (what: string) =>
  z
    .string()
    .trim()
    .url()
    .refine(secureIdentityProviderUrl, { message: `${what} must start with https://` });

const attributeName = z.string().trim().max(300).nullable().optional();

export const samlSettingsSchema = z
  .object({
    metadataUrl: httpUrl("The metadata URL").nullable().optional(),
    metadataXml: z.string().max(500_000).nullable().optional(),
    entryPoint: httpUrl("The single sign-on URL").nullable().optional(),
    idpEntityId: z.string().trim().max(1000).nullable().optional(),
    idpCert: z
      .string()
      .max(50_000)
      .refine((v) => !v.trim() || /-----BEGIN CERTIFICATE-----|^[A-Za-z0-9+/=\s]+$/.test(v), {
        message: "Paste the certificate as PEM (-----BEGIN CERTIFICATE-----)",
      })
      .nullable()
      .optional(),
    spEntityId: z.string().trim().max(1000).nullable().optional(),
    nameIdFormat: z.string().trim().max(200).nullable().optional(),
    idAttribute: attributeName,
    emailAttribute: attributeName,
    nameAttribute: attributeName,
    usernameAttribute: attributeName,
    groupsAttribute: attributeName,
    wantAuthnResponseSigned: z.boolean().optional(),
    wantAssertionsSigned: z.literal(true).optional(),
    caPem: pem,
    insecureSkipVerify: OidcSettingsSchema.shape.insecureSkipVerify,
    linkByEmail: z.boolean().optional(),
  })
  .refine(
    (s) =>
      !!(s.metadataUrl?.trim() || s.metadataXml?.trim() || (s.entryPoint && s.idpCert?.trim())),
    {
      message:
        "Give the identity provider's metadata (a URL or the XML), or its single sign-on URL and signing certificate",
      path: ["metadataUrl"],
    },
  );

export const giteaSettingsSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine(secureIdentityProviderUrl, { message: "The server URL must start with https://" }),
  scopes: z.string().trim().max(500).optional(),
  caPem: pem,
  insecureSkipVerify: z.literal(false).optional(),
  linkByEmail: z.boolean().optional(),
});

export const bitbucketSettingsSchema = z.object({ linkByEmail: z.boolean().optional() });

export function settingsSchemaFor(provider: "oidc" | "saml" | "gitea" | "bitbucket") {
  switch (provider) {
    case "oidc":
      return OidcSettingsSchema;
    case "saml":
      return samlSettingsSchema;
    case "gitea":
      return giteaSettingsSchema;
    case "bitbucket":
      return bitbucketSettingsSchema;
  }
}
