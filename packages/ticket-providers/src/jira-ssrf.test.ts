import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setOutboundDefaults } from "@optio/shared/outbound-http";
import { JiraTicketProvider, type JiraProviderConfig } from "./jira.js";

let server: http.Server;
let port: number;
let mode: "ok" | "redirect" = "ok";
let restoreOutbound: (() => void) | undefined;
const seen: Array<{ path: string; method: string; auth?: string; body: string }> = [];
const resolveHost = vi.fn();
const provider = new JiraTicketProvider();
const config = (): JiraProviderConfig => ({
  baseUrl: `http://jira.test:${port}/jira`,
  email: "owner@example.com",
  apiToken: "secret-token",
});
const operations = [
  ["issues", () => provider.fetchActionableTickets(config())],
  ["comments", () => provider.fetchTicketComments("TEST-1", config())],
  ["add comment", () => provider.addComment("TEST-1", "A comment", config())],
  ["transition", () => provider.updateState("TEST-1", "closed", config())],
] as const;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url!, method: req.method!, auth: req.headers.authorization, body });
    if (mode === "redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/stolen` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url!.includes("transitions")
          ? { transitions: [{ id: "done", to: { name: "Done" } }] }
          : { issues: [], comments: [] },
      ),
    );
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
  mode = "ok";
  resolveHost.mockReset().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  // The fake host has no system DNS record: successful traffic proves that
  // Axios used the guard's pinned address rather than resolving it again.
  restoreOutbound = setOutboundDefaults({
    resolveHost,
    policy: { allowPrivate: false, allowAll: false, allowedHosts: ["127.0.0.1"] },
  });
});
afterEach(() => {
  restoreOutbound?.();
});

describe("Jira SDK guarded transport", () => {
  it.each(operations)(
    "pins vetted DNS for %s and preserves authentication",
    async (_name, operation) => {
      await operation();
      expect(seen.length).toBeGreaterThan(0);
      expect(resolveHost).toHaveBeenCalledTimes(seen.length);
      for (const request of seen) {
        expect(request.path).toMatch(/^\/jira\/rest\/api\/3\//);
        expect(request.auth).toBe(
          `Basic ${Buffer.from("owner@example.com:secret-token").toString("base64")}`,
        );
      }
    },
  );

  it.each(operations)(
    "blocks redirects from %s before reaching their target",
    async (_name, operation) => {
      mode = "redirect";
      await expect(operation()).rejects.toThrow();
      expect(seen).toHaveLength(1);
      expect(seen[0].path).not.toBe("/stolen");
    },
  );

  it.each(operations)(
    "rejects a DNS answer resolving to an unapproved private address for %s",
    async (_name, operation) => {
      resolveHost.mockResolvedValue([{ address: "127.0.0.2", family: 4 }]);
      await expect(operation()).rejects.toThrow(/blocked/);
      expect(seen).toEqual([]);
    },
  );

  it("re-vets DNS before a second SDK request so rebinding cannot redirect a state change", async () => {
    resolveHost
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.2", family: 4 }]);
    await expect(provider.updateState("TEST-1", "closed", config())).rejects.toThrow(/blocked/);
    expect(resolveHost).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
  });

  it("preserves Jira query and JSON body serialization through the guarded adapter", async () => {
    await provider.fetchActionableTickets({ ...config(), projectKey: "TEST" });
    const url = new URL(seen[0].path, "http://placeholder");
    expect(url.searchParams.get("jql")).toContain('project = "TEST"');
    expect(url.searchParams.get("fields")).toContain("summary,description");
    await provider.addComment("TEST-1", 'Quoted "comment"', config());
    expect(JSON.parse(seen[1].body).body.content[0].content[0].text).toBe('Quoted "comment"');
  });
});
