import { describe, it, expect, vi } from "vitest";
import { NotionTicketProvider, asNotionConfig } from "./notion.js";
import type { NotionProviderConfig } from "./notion.js";

vi.mock("@notionhq/client", () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return {
        databases: {
          query: vi.fn(),
        },
        blocks: {
          children: {
            list: vi.fn(),
          },
        },
        comments: {
          list: vi.fn(),
          create: vi.fn(),
        },
        pages: {
          update: vi.fn(),
        },
      };
    }),
  };
});

import { Client } from "@notionhq/client";

function makeNotionPage(id: string, num: number, labels: string[] = ["optio"]) {
  return {
    id,
    url: `https://notion.so/${id.replace(/-/g, "")}`,
    created_time: "2025-01-01T00:00:00Z",
    last_edited_time: "2025-01-01T00:00:00Z",
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: `Task ${num}` }],
      },
      Status: {
        type: "status",
        status: { name: "In Progress" },
      },
      Tags: {
        type: "multi_select",
        multi_select: labels.map((l) => ({ name: l })),
      },
      Assignee: {
        type: "people",
        people: [{ name: "Test User", id: "user-1" }],
      },
    },
  };
}

function baseConfig(): NotionProviderConfig {
  return { apiKey: "ntn_test-token", databaseId: "db-123" };
}

describe("NotionTicketProvider config validation", () => {
  it("throws when apiKey is missing", () => {
    expect(() => asNotionConfig({ databaseId: "db-123" })).toThrow(
      "Notion provider requires apiKey and databaseId in config",
    );
  });

  it("throws when databaseId is missing", () => {
    expect(() => asNotionConfig({ apiKey: "ntn_test" })).toThrow(
      "Notion provider requires apiKey and databaseId in config",
    );
  });

  it("returns config when valid", () => {
    const config = asNotionConfig({ apiKey: "ntn_test", databaseId: "db-123" });
    expect(config.apiKey).toBe("ntn_test");
    expect(config.databaseId).toBe("db-123");
  });
});

describe("NotionTicketProvider fetchActionableTickets", () => {
  it("fetches a single page of results", async () => {
    const pages = Array.from({ length: 3 }, (_, i) => makeNotionPage(`page-${i + 1}`, i + 1));

    const query = vi.fn().mockResolvedValueOnce({
      results: pages,
      has_more: false,
      next_cursor: null,
    });
    const blocksList = vi.fn().mockResolvedValue({
      results: [
        {
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "Page content" }] },
        },
      ],
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        databases: { query },
        blocks: { children: { list: blocksList } },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(3);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        database_id: "db-123",
        page_size: 100,
      }),
    );
  });

  it("paginates using cursor-based pagination", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => makeNotionPage(`page-${i + 1}`, i + 1));
    const page2 = [makeNotionPage("page-3", 3)];

    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: page1,
        has_more: true,
        next_cursor: "cursor-abc",
      })
      .mockResolvedValueOnce({
        results: page2,
        has_more: false,
        next_cursor: null,
      });
    const blocksList = vi.fn().mockResolvedValue({
      results: [],
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        databases: { query },
        blocks: { children: { list: blocksList } },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(3);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ start_cursor: "cursor-abc" }),
    );
  });

  it("respects maxPages limit", async () => {
    const pages = Array.from({ length: 2 }, (_, i) => makeNotionPage(`page-${i + 1}`, i + 1));

    const query = vi.fn().mockResolvedValue({
      results: pages,
      has_more: true,
      next_cursor: "cursor-next",
    });
    const blocksList = vi.fn().mockResolvedValue({
      results: [],
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        databases: { query },
        blocks: { children: { list: blocksList } },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const config: NotionProviderConfig = { ...baseConfig(), maxPages: 1 };
    const tickets = await provider.fetchActionableTickets(config);

    // Only one page fetched, so only 2 tickets
    expect(query).toHaveBeenCalledTimes(1);
    expect(tickets).toHaveLength(2);
  });

  it("returns empty array when no results", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        databases: { query },
        blocks: { children: { list: vi.fn() } },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("filters pages by label", async () => {
    const pages = [
      makeNotionPage("page-1", 1, ["optio"]),
      makeNotionPage("page-2", 2, ["other-label"]),
      makeNotionPage("page-3", 3, ["optio", "bug"]),
    ];

    const query = vi.fn().mockResolvedValueOnce({
      results: pages,
      has_more: false,
      next_cursor: null,
    });
    const blocksList = vi.fn().mockResolvedValue({
      results: [],
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        databases: { query },
        blocks: { children: { list: blocksList } },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.externalId)).toEqual(["page-1", "page-3"]);
  });

  it("transforms Notion page to Ticket format correctly", async () => {
    const page = makeNotionPage("page-abc-123", 1, ["optio"]);
    const query = vi.fn().mockResolvedValueOnce({
      results: [page],
      has_more: false,
      next_cursor: null,
    });
    const blocksList = vi.fn().mockResolvedValue({
      results: [
        {
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "Task description here" }] },
        },
      ],
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        databases: { query },
        blocks: { children: { list: blocksList } },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    expect(ticket.externalId).toBe("page-abc-123");
    expect(ticket.source).toBe("notion");
    expect(ticket.title).toBe("Task 1");
    expect(ticket.body).toBe("Task description here");
    expect(ticket.labels).toEqual(["optio"]);
    expect(ticket.assignee).toBe("Test User");
    expect(ticket.repo).toBeUndefined();
    expect(ticket.metadata).toMatchObject({
      pageId: "page-abc-123",
      status: "In Progress",
    });
  });

  it("uses custom statusProperty and doneValue", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        databases: { query },
        blocks: { children: { list: vi.fn() } },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const config: NotionProviderConfig = {
      ...baseConfig(),
      statusProperty: "Phase",
      doneValue: "Completed",
    };
    await provider.fetchActionableTickets(config);

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          and: [
            {
              property: "Phase",
              status: { does_not_equal: "Completed" },
            },
          ],
        },
      }),
    );
  });
});

describe("NotionTicketProvider fetchTicketComments", () => {
  it("fetches comments for a page", async () => {
    const commentsList = vi.fn().mockResolvedValueOnce({
      results: [
        {
          created_by: { name: "Alice" },
          rich_text: [{ plain_text: "Looks good!" }],
          created_time: "2025-01-15T10:00:00Z",
        },
        {
          created_by: { id: "user-2" },
          rich_text: [{ plain_text: "Needs changes" }],
          created_time: "2025-01-16T10:00:00Z",
        },
      ],
    });

    vi.mocked(Client).mockImplementation(function () {
      return {
        comments: { list: commentsList },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const comments = await provider.fetchTicketComments("page-123", baseConfig());

    expect(comments).toHaveLength(2);
    expect(comments[0]).toEqual({
      author: "Alice",
      body: "Looks good!",
      createdAt: "2025-01-15T10:00:00Z",
    });
    expect(comments[1]).toEqual({
      author: "user-2",
      body: "Needs changes",
      createdAt: "2025-01-16T10:00:00Z",
    });
    expect(commentsList).toHaveBeenCalledWith({
      block_id: "page-123",
      page_size: 100,
    });
  });
});

describe("NotionTicketProvider addComment", () => {
  it("creates a comment on a page", async () => {
    const create = vi.fn().mockResolvedValueOnce({});

    vi.mocked(Client).mockImplementation(function () {
      return {
        comments: { create },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    await provider.addComment("page-123", "Agent completed the task", baseConfig());

    expect(create).toHaveBeenCalledWith({
      parent: { page_id: "page-123" },
      rich_text: [
        {
          type: "text",
          text: { content: "Agent completed the task" },
        },
      ],
    });
  });
});

describe("NotionTicketProvider updateState", () => {
  it("updates page status to done value when closing", async () => {
    const update = vi.fn().mockResolvedValueOnce({});

    vi.mocked(Client).mockImplementation(function () {
      return {
        pages: { update },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    await provider.updateState("page-123", "closed", baseConfig());

    expect(update).toHaveBeenCalledWith({
      page_id: "page-123",
      properties: {
        Status: {
          status: { name: "Done" },
        },
      },
    });
  });

  it("updates page status to open value when reopening", async () => {
    const update = vi.fn().mockResolvedValueOnce({});

    vi.mocked(Client).mockImplementation(function () {
      return {
        pages: { update },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    await provider.updateState("page-123", "open", baseConfig());

    expect(update).toHaveBeenCalledWith({
      page_id: "page-123",
      properties: {
        Status: {
          status: { name: "Not started" },
        },
      },
    });
  });

  it("uses custom statusProperty and doneValue", async () => {
    const update = vi.fn().mockResolvedValueOnce({});

    vi.mocked(Client).mockImplementation(function () {
      return {
        pages: { update },
      } as unknown as InstanceType<typeof Client>;
    });

    const provider = new NotionTicketProvider();
    const config: NotionProviderConfig = {
      ...baseConfig(),
      statusProperty: "Phase",
      doneValue: "Completed",
    };
    await provider.updateState("page-123", "closed", config);

    expect(update).toHaveBeenCalledWith({
      page_id: "page-123",
      properties: {
        Phase: {
          status: { name: "Completed" },
        },
      },
    });
  });
});
