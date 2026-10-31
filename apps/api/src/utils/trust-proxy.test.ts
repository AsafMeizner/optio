import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ignoredTrustProxyReason, trustProxyFromEnv } from "./trust-proxy.js";

describe("trustProxyFromEnv", () => {
  it("reads hops, true, addresses, or nothing", () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv("")).toBe(false);
    expect(trustProxyFromEnv("0")).toBe(false);
    expect(trustProxyFromEnv("1")).toBe(false);
    expect(trustProxyFromEnv("true")).toBe(false);
    expect(trustProxyFromEnv("10.0.0.0/8, 127.0.0.1")).toEqual(["10.0.0.0/8", "127.0.0.1"]);
  });

  it("refuses unrestricted proxy trust so agent pods cannot spoof a loopback client", async () => {
    const app = Fastify({ trustProxy: trustProxyFromEnv("true") });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.42.0.7",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.json().ip).toBe("10.42.0.7");
    await app.close();
  });

  it("with an explicit ingress CIDR, req.ip is the address it saw, not one the client wrote", async () => {
    const app = Fastify({ trustProxy: trustProxyFromEnv("10.42.0.0/16") });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    // The controller appends the peer it saw; anything before it is the client's own claim.
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.42.0.7",
      headers: { "x-forwarded-for": "6.6.6.6, 192.168.1.20" },
    });
    expect(res.json().ip).toBe("192.168.1.20");
    const direct = Fastify({ trustProxy: trustProxyFromEnv("") });
    direct.get("/ip", async (req) => ({ ip: req.ip }));
    const plain = await direct.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.42.0.7",
      headers: { "x-forwarded-for": "6.6.6.6" },
    });
    expect(plain.json().ip).toBe("10.42.0.7");
  });
});

describe("ignoredTrustProxyReason", () => {
  it("names the values that are read as trusting nobody", () => {
    expect(ignoredTrustProxyReason("true")).toMatch(/"true" is ignored/);
    expect(ignoredTrustProxyReason(" 2 ")).toMatch(/"2" is ignored/);
  });

  it("stays quiet for unset, off and explicit addresses", () => {
    for (const v of [undefined, "", "false", "0", "10.42.0.0/16", "127.0.0.1, 10.0.0.1"]) {
      expect(ignoredTrustProxyReason(v)).toBeNull();
    }
  });
});
