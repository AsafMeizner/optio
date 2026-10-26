import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockGetPromptTemplate = vi.fn();
const mockSaveDefaultPromptTemplate = vi.fn();
const mockSaveRepoPromptTemplate = vi.fn();
const mockListPromptTemplates = vi.fn();

vi.mock("../services/prompt-template-service.js", () => ({
  getPromptTemplate: (...args: unknown[]) => mockGetPromptTemplate(...args),
  saveDefaultPromptTemplate: (...args: unknown[]) => mockSaveDefaultPromptTemplate(...args),
  saveRepoPromptTemplate: (...args: unknown[]) => mockSaveRepoPromptTemplate(...args),
  listPromptTemplates: (...args: unknown[]) => mockListPromptTemplates(...args),
}));

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbInsert = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => mockDbSelect(...args),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockDbUpdate(...args),
      }),
    }),
    insert: () => ({
      values: (...args: unknown[]) => mockDbInsert(...args),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  promptTemplates: { id: "id", name: "name", repoUrl: "repoUrl" },
}));

vi.mock("@optio/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@optio/shared")>()),
  DEFAULT_PROMPT_TEMPLATE: "Default template content {{TASK_FILE}}",
  DEFAULT_REVIEW_PROMPT_TEMPLATE: "Default review template",
}));

import { promptTemplateRoutes } from "./prompt-templates.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(promptTemplateRoutes);
}

describe("GET /api/prompt-templates/effective", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns effective template", async () => {
    mockGetPromptTemplate.mockResolvedValue({ template: "Custom template", isDefault: false });

    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/effective" });

    expect(res.statusCode).toBe(200);
    expect(res.json().template).toBe("Custom template");
  });

  it("passes repoUrl query param", async () => {
    mockGetPromptTemplate.mockResolvedValue({ template: "Repo template" });

    await app.inject({
      method: "GET",
      url: "/api/prompt-templates/effective?repoUrl=https://github.com/org/repo",
    });

    expect(mockGetPromptTemplate).toHaveBeenCalledWith("https://github.com/org/repo");
  });
});

describe("GET /api/prompt-templates/builtin-default", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns the hardcoded default template", async () => {
    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/builtin-default" });

    expect(res.statusCode).toBe(200);
    expect(res.json().template).toContain("TASK_FILE");
  });
});

describe("GET /api/prompt-templates", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists all templates", async () => {
    mockListPromptTemplates.mockResolvedValue([{ id: "t-1", name: "default" }]);

    const res = await app.inject({ method: "GET", url: "/api/prompt-templates" });

    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toHaveLength(1);
  });
});

describe("POST /api/prompt-templates", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("saves a global default template", async () => {
    mockSaveDefaultPromptTemplate.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "New global template" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockSaveDefaultPromptTemplate).toHaveBeenCalledWith("New global template", false);
  });

  it("saves a repo-scoped template", async () => {
    mockSaveRepoPromptTemplate.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: {
        template: "Repo template",
        repoUrl: "https://github.com/org/repo",
        autoMerge: true,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockSaveRepoPromptTemplate).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "Repo template",
      true,
    );
  });

  it("saves a review template", async () => {
    // No existing review template
    mockDbSelect.mockResolvedValue([]);
    mockDbInsert.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Review template", isReview: true },
    });

    expect(res.statusCode).toBe(201);
    expect(mockDbInsert).toHaveBeenCalled();
  });

  it("rejects empty template (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "" },
    });

    expect(res.statusCode).toBe(400);
  });
});
