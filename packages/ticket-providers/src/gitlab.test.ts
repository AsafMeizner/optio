import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitLabTicketProvider } from "./gitlab.js";
import type { GitLabProviderConfig } from "./gitlab.js";

import { setOutboundDefaults } from "@optio/shared/outbound-http";
import { SsrfError } from "@optio/shared/ssrf";
const mockResolveHost = vi.fn();
let restoreOutbound: () => void;

function baseConfig(): GitLabProviderConfig {
  return {
    token: "glpat-test-token",
    projectPath: "group/project",
    host: "gitlab.com",
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockResolveHost.mockReset();
  mockResolveHost.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  restoreOutbound = setOutboundDefaults({
    resolveHost: mockResolveHost,
    fetchImpl: (url, init) => fetch(url, init),
    policy: { allowPrivate: false, allowAll: false, allowedHosts: [] },
  });
});
afterEach(() => restoreOutbound());

describe("GitLabTicketProvider sign-in", () => {
  it("sends the token as Authorization: Bearer, which takes every GitLab token kind", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    await new GitLabTicketProvider().fetchActionableTickets(baseConfig());

    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer glpat-test-token");
    expect(headers.get("private-token")).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe("GitLabTicketProvider SSRF protection", () => {
  it("vets and pins DNS before fetching issues", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    const provider = new GitLabTicketProvider();
    await provider.fetchActionableTickets(baseConfig());

    expect(mockResolveHost).toHaveBeenCalled();
    const calledUrl = mockResolveHost.mock.calls[0][0] as string;
    expect(calledUrl).toBe("gitlab.com");
    fetchSpy.mockRestore();
  });

  it("throws SsrfError when host resolves to private address", async () => {
    mockResolveHost.mockRejectedValueOnce(
      new SsrfError("DNS resolved evil.example.com to private address 169.254.169.254"),
    );

    const provider = new GitLabTicketProvider();
    const config: GitLabProviderConfig = {
      ...baseConfig(),
      host: "evil.example.com",
    };

    await expect(provider.fetchActionableTickets(config)).rejects.toThrow(SsrfError);
  });

  it("vets and pins DNS before adding a comment", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }));

    const provider = new GitLabTicketProvider();
    await provider.addComment("1", "test comment", baseConfig());

    expect(mockResolveHost).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("vets and pins DNS before fetching comments", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const provider = new GitLabTicketProvider();
    await provider.fetchTicketComments("1", baseConfig());

    expect(mockResolveHost).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("vets and pins DNS before updating state", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const provider = new GitLabTicketProvider();
    await provider.updateState("1", "closed", baseConfig());

    expect(mockResolveHost).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses redirect: 'error' on all fetch calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    const provider = new GitLabTicketProvider();
    await provider.fetchActionableTickets(baseConfig());

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error" }),
    );
    fetchSpy.mockRestore();
  });
});

describe("GitLabTicketProvider basic functionality", () => {
  it("fetches and transforms GitLab issues", async () => {
    const mockIssue = {
      iid: 42,
      title: "Test Issue",
      description: "Test description",
      web_url: "https://gitlab.com/group/project/-/issues/42",
      labels: ["optio"],
      assignee: { username: "testuser" },
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([mockIssue]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    const provider = new GitLabTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(1);
    expect(tickets[0].externalId).toBe("42");
    expect(tickets[0].title).toBe("Test Issue");
    expect(tickets[0].source).toBe("gitlab");
  });
});

it("blocks a private DNS answer before sending the GitLab token", async () => {
  mockResolveHost.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await expect(new GitLabTicketProvider().fetchActionableTickets(baseConfig())).rejects.toThrow(
    SsrfError,
  );
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("rechecks each page and rejects DNS rebinding before the next authenticated request", async () => {
  mockResolveHost
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify([{ iid: 1 }]), {
      headers: { "x-total-pages": "2" },
    }),
  );
  await expect(new GitLabTicketProvider().fetchActionableTickets(baseConfig())).rejects.toThrow(
    SsrfError,
  );
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
