import { z } from "zod";
import { OIDC_PRESETS } from "@optio/shared";

export const OidcSettingsSchema = z
  .object({
    preset: z.enum(OIDC_PRESETS).optional(),
    issuerUrl: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//.test(value), "Use an HTTP(S) issuer URL"),
    scopes: z.string().max(1000).optional(),
    groupsClaim: z.string().max(200).optional(),
    emailClaim: z.string().max(200).optional(),
    nameClaim: z.string().max(200).optional(),
    usernameClaim: z.string().max(200).optional(),
    trustEmail: z.boolean().optional(),
    usePkce: z.boolean().optional(),
    tokenAuthMethod: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
    caPem: z.string().max(100000).nullable().optional(),
    insecureSkipVerify: z.boolean().optional(),
    linkByEmail: z.boolean().optional(),
  })
  .strict();
