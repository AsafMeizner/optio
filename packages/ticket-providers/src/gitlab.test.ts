import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabTicketProvider } from "./gitlab.js";
import type { GitLabProviderConfig } from "./gitlab.js";

vi.mock("@optio/shared/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@optio/shared/ssrf")>();
  return {
    ...actual,
    assertSsrfSafe: vi.fn(),
  };
});

import { assertSsrfSafe, SsrfError } from "@optio/shared/ssrf";

const mockAssertSsrfSafe = assertSsrfSafe as ReturnType<typeof vi.fn>;

function baseConfig(): GitLabProviderConfig {
  return {
    token: "glpat-test-token",
    projectPath: "group/project",
    host: "gitlab.com",
  };
}

beforeEach(() => {
  mockAssertSsrfSafe.mockReset();
  mockAssertSsrfSafe.mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

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
  it("calls assertSsrfSafe before fetching issues", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    const provider = new GitLabTicketProvider();
    await provider.fetchActionableTickets(baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
    const calledUrl = mockAssertSsrfSafe.mock.calls[0][0] as string;
    expect(calledUrl).toContain("https://gitlab.com/api/v4");
    fetchSpy.mockRestore();
  });

  it("throws SsrfError when host resolves to private address", async () => {
    mockAssertSsrfSafe.mockRejectedValueOnce(
      new SsrfError("DNS resolved evil.example.com to private address 169.254.169.254"),
    );

    const provider = new GitLabTicketProvider();
    const config: GitLabProviderConfig = {
      ...baseConfig(),
      host: "evil.example.com",
    };

    await expect(provider.fetchActionableTickets(config)).rejects.toThrow(SsrfError);
  });

  it("calls assertSsrfSafe before adding a comment", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }));

    const provider = new GitLabTicketProvider();
    await provider.addComment("1", "test comment", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("calls assertSsrfSafe before fetching comments", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const provider = new GitLabTicketProvider();
    await provider.fetchTicketComments("1", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("calls assertSsrfSafe before updating state", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const provider = new GitLabTicketProvider();
    await provider.updateState("1", "closed", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
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
