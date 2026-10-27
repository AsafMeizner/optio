import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedFetch, setOutboundDefaults, SsrfError } from "./outbound-http.js";
import type { HostResolver, OutboundPolicy } from "./ssrf.js";

const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 as const }];
const DEFAULT_POLICY: OutboundPolicy = { allowPrivate: false, allowedHosts: [], allowAll: false };
const resolvePublic: HostResolver = async () => PUBLIC_ADDRESS;
const loopbackPolicy = { ...DEFAULT_POLICY, allowedHosts: ["127.0.0.1"] };
const resolveLoopback: HostResolver = async () => [{ address: "127.0.0.1", family: 4 }];

// The synthetic names do not resolve in DNS. A response proves undici used the
// address vetted by our resolver rather than performing an independent lookup.
let server: http.Server;
let port: number;
const seen: { method: string; url: string; host?: string; authorization?: string; body: string }[] =
  [];
const url = (path: string, host = "source.test") => new URL(`http://${host}:${port}${path}`);

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method!,
      url: req.url!,
      host: req.headers.host,
      authorization: req.headers.authorization,
      body,
    });
    const path = req.url!;
    if (path === "/slow") return;
    if (path === "/cross") res.writeHead(302, { location: url("/ok", "other.test").toString() });
    else if (path === "/private")
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    else if (path === "/same" || path === "/loop")
      res.writeHead(302, { location: path === "/loop" ? "/loop" : "/ok" });
    else if (/^\/30[12378]$/.test(path)) res.writeHead(Number(path.slice(1)), { location: "/ok" });
    else if (path === "/no-location") res.writeHead(302);
    else res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
});

describe("guardedFetch pinned transport", () => {
  it("resolves only once before connecting, even if a second DNS answer would rebind", async () => {
    const resolver = vi
      .fn<HostResolver>()
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const response = await guardedFetch(url("/ok"), {
      resolveHost: resolver,
      policy: loopbackPolicy,
    });
    expect(await response.text()).toBe("ok");
    expect(resolver).toHaveBeenCalledExactlyOnceWith("source.test");
    expect(seen).toEqual([
      {
        method: "GET",
        url: "/ok",
        host: `source.test:${port}`,
        authorization: undefined,
        body: "",
      },
    ]);
  });

  it("blocks a DNS answer containing a private address before connecting", async () => {
    await expect(
      guardedFetch(url("/ok"), {
        resolveHost: async () => [...PUBLIC_ADDRESS, { address: "127.0.0.1", family: 4 }],
        policy: DEFAULT_POLICY,
      }),
    ).rejects.toThrow(SsrfError);
    expect(seen).toEqual([]);
  });

  it("vets redirects and never sends a request to metadata", async () => {
    await expect(
      guardedFetch(url("/private"), { resolveHost: resolveLoopback, policy: loopbackPolicy }),
    ).rejects.toThrow("cloud metadata address");
    expect(seen.map((request) => request.url)).toEqual(["/private"]);
  });

  it("rechecks DNS on a same-origin redirect instead of reusing the prior authorization", async () => {
    const resolver = vi
      .fn<HostResolver>()
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      guardedFetch(url("/same"), { resolveHost: resolver, policy: loopbackPolicy }),
    ).rejects.toThrow("cloud metadata address");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(seen.map((request) => request.url)).toEqual(["/same"]);
  });

  it.each(["/same", "/cross"])(
    "sends credentials only on the original origin (%s)",
    async (path) => {
      const response = await guardedFetch(url(path), {
        resolveHost: resolveLoopback,
        policy: loopbackPolicy,
        headers: { Authorization: "Bearer secret" },
      });
      await response.text();
      expect(seen.map((request) => request.authorization)).toEqual([
        "Bearer secret",
        path === "/same" ? "Bearer secret" : undefined,
      ]);
    },
  );

  it.each([
    [301, "POST", "GET"],
    [302, "POST", "GET"],
    [303, "PUT", "GET"],
    [301, "PUT", "PUT"],
    [302, "PATCH", "PATCH"],
    [307, "POST", "POST"],
    [308, "POST", "POST"],
  ])(
    "honors HTTP %s redirect method/body semantics for %s",
    async (status, method, redirectedMethod) => {
      const response = await guardedFetch(url(`/${status}`), {
        resolveHost: resolveLoopback,
        policy: loopbackPolicy,
        method,
        body: "payload",
      });
      await response.text();
      expect(seen.map((request) => [request.method, request.body])).toEqual([
        [method, "payload"],
        [redirectedMethod, redirectedMethod === "GET" ? "" : "payload"],
      ]);
    },
  );

  it("returns a redirect with no location without following it", async () => {
    const response = await guardedFetch(url("/no-location"), {
      resolveHost: resolveLoopback,
      policy: loopbackPolicy,
    });
    expect(response.status).toBe(302);
    await response.text();
    expect(seen).toHaveLength(1);
  });

  it("returns manual redirects and rejects redirects in error mode", async () => {
    const response = await guardedFetch(url("/same"), {
      resolveHost: resolveLoopback,
      policy: loopbackPolicy,
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/ok");
    await response.text();
    await expect(
      guardedFetch(url("/same"), {
        resolveHost: resolveLoopback,
        policy: loopbackPolicy,
        redirect: "error",
      }),
    ).rejects.toThrow();
    expect(seen.map((request) => request.url)).toEqual(["/same", "/same"]);
  });

  it("bounds redirect loops", async () => {
    await expect(
      guardedFetch(url("/loop"), {
        resolveHost: resolveLoopback,
        policy: loopbackPolicy,
        maxRedirects: 2,
      }),
    ).rejects.toThrow("redirected more than 2 times");
    expect(seen).toHaveLength(3);
  });

  it("times out a request that never responds", async () => {
    await expect(
      guardedFetch(url("/slow"), {
        resolveHost: resolveLoopback,
        policy: loopbackPolicy,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
  });
});

describe("guardedFetch request policy", () => {
  it.each(["object", "tuples", "Headers"])(
    "drops every custom credential across origins, retaining safe headers (%s)",
    async (shape) => {
      const entries: [string, string][] = [
        ["PRIVATE-TOKEN", "gitlab-secret"],
        ["X-Api-Key", "key-secret"],
        ["X-Custom-Credential", "custom-secret"],
        ["Cookie", "session=secret"],
        ["Authorization", "Bearer secret"],
        ["Accept", "application/json"],
        ["Accept-Language", "en"],
        ["Content-Type", "application/json"],
        ["User-Agent", "optio"],
      ];
      const headers =
        shape === "Headers"
          ? new Headers(entries)
          : shape === "tuples"
            ? entries
            : Object.fromEntries(entries);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
        )
        .mockResolvedValue(new Response("ok"));
      await guardedFetch("https://source.example/", {
        resolveHost: resolvePublic,
        policy: DEFAULT_POLICY,
        fetchImpl,
        headers,
      });
      expect(Object.fromEntries(new Headers(fetchImpl.mock.calls[1]![1].headers))).toEqual({
        accept: "application/json",
        "accept-language": "en",
        "content-type": "application/json",
        "user-agent": "optio",
      });
      expect(new Headers(headers).get("private-token")).toBe("gitlab-secret");
    },
  );

  it("allows an unauthenticated cross-origin redirect without adding headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
      )
      .mockResolvedValue(new Response("ok"));
    await guardedFetch("https://source.example/", {
      resolveHost: resolvePublic,
      policy: DEFAULT_POLICY,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[1]![1].headers).toBeUndefined();
  });

  it.each(["http://169.254.169.254/", "ftp://source.example/", "not a URL"])(
    "blocks %s before invoking even an injected client",
    async (input) => {
      const fetchImpl = vi.fn();
      await expect(guardedFetch(input, { fetchImpl, policy: DEFAULT_POLICY })).rejects.toThrow(
        SsrfError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("reports an invalid redirect without leaking URL credentials", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "http://[invalid" } }),
      );
    await expect(
      guardedFetch("https://secret:password@source.example/", {
        resolveHost: resolvePublic,
        policy: DEFAULT_POLICY,
        fetchImpl,
      }),
    ).rejects.toThrow("blocked: source.example redirected to an invalid URL");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit abort signal unchanged", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
    await guardedFetch("https://source.example/", {
      resolveHost: resolvePublic,
      policy: DEFAULT_POLICY,
      fetchImpl,
      signal: controller.signal,
      redirect: "error",
    });
    expect(fetchImpl.mock.calls[0]![1].signal).toBe(controller.signal);
    expect(fetchImpl.mock.calls[0]![1].redirect).toBe("error");
  });

  it("merges and restores process defaults without dropping the outer policy", async () => {
    const outerFetch = vi.fn().mockResolvedValue(new Response("outer"));
    const innerFetch = vi.fn().mockResolvedValue(new Response("inner"));
    const restoreOuter = setOutboundDefaults({
      resolveHost: resolveLoopback,
      policy: loopbackPolicy,
      fetchImpl: outerFetch,
    });
    try {
      const restoreInner = setOutboundDefaults({ fetchImpl: innerFetch });
      try {
        expect(await (await guardedFetch(url("/ok"))).text()).toBe("inner");
      } finally {
        restoreInner();
      }
      expect(await (await guardedFetch(url("/ok"))).text()).toBe("outer");
    } finally {
      restoreOuter();
    }
    await expect(
      guardedFetch(url("/ok"), { resolveHost: resolveLoopback, policy: DEFAULT_POLICY }),
    ).rejects.toThrow(SsrfError);
    expect(innerFetch).toHaveBeenCalledTimes(1);
    expect(outerFetch).toHaveBeenCalledTimes(1);
  });
});
