import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { OidcSettingsSchema } from "../../schemas/sign-in.js";
import { discoverOidc, oidcFetch } from "./oidc.js";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.unstubAllEnvs();
});

describe("identity-provider transport boundaries", () => {
  it("requires HTTPS for non-loopback issuers and every issuer in production", async () => {
    expect(OidcSettingsSchema.safeParse({ issuerUrl: "http://idp.example.test" }).success).toBe(
      false,
    );
    await expect(discoverOidc({ issuerUrl: "http://idp.example.test" })).rejects.toThrow(
      "https://",
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(OidcSettingsSchema.safeParse({ issuerUrl: "http://127.0.0.1:8080" }).success).toBe(
      false,
    );
    expect(
      OidcSettingsSchema.safeParse({ issuerUrl: "https://user:secret@idp.example.test" }).success,
    ).toBe(false);
  });

  it("requires the discovery issuer and rejects plaintext endpoints", async () => {
    const issuer = "https://idp.example.test";
    const doc = {
      authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token",
      jwks_uri: issuer + "/keys",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(doc)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...doc, issuer, token_endpoint: "http://tokens.example.test" }),
        ),
      );
    restore = setOutboundDefaults({
      fetchImpl,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    await expect(discoverOidc({ issuerUrl: issuer })).rejects.toThrow("required issuer");
    await expect(discoverOidc({ issuerUrl: issuer })).rejects.toThrow("https://");
  });

  it("refuses private targets before opening a connection", async () => {
    restore = setOutboundDefaults({
      policy: { allowPrivate: false, allowedHosts: [], allowAll: false },
    });
    await expect(
      oidcFetch({})!("https://127.0.0.1:1/token", {
        method: "POST",
        body: "client_secret=protected",
      }),
    ).rejects.toThrow();
  });

  it("does not follow a real307 with the authorization code and client secret", async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      received.push(req.url!);
      if (req.url === "/token") {
        res.writeHead(307, { location: "/capture" });
        res.end();
      } else {
        res.end("captured");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      vi.stubEnv("NODE_ENV", "test");
      restore = setOutboundDefaults({
        policy: { allowPrivate: false, allowedHosts: ["127.0.0.1"], allowAll: false },
      });
      const address = server.address() as { port: number };
      await expect(
        oidcFetch({})!(`http://127.0.0.1:${address.port}/token`, {
          method: "POST",
          body: "code=private-code&client_secret=private-secret",
        }),
      ).rejects.toThrow();
      expect(received).toEqual(["/token"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("cannot disable TLS verification through stored settings alone", () => {
    vi.stubEnv("OPTIO_IDP_ALLOW_INSECURE_TLS", "false");
    const settings = { issuerUrl: "https://idp.example.test", insecureSkipVerify: true };
    expect(OidcSettingsSchema.safeParse(settings).success).toBe(false);
    expect(() => oidcFetch(settings)).toThrow("deployment policy");
    vi.stubEnv("OPTIO_IDP_ALLOW_INSECURE_TLS", "true");
    expect(OidcSettingsSchema.safeParse(settings).success).toBe(true);
    expect(oidcFetch(settings)).toBeTypeOf("function");
  });
});
