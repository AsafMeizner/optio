import { describe, it, expect, vi } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  promptTemplates: {
    id: "prompt_templates.id",
    isDefault: "prompt_templates.is_default",
    repoUrl: "prompt_templates.repo_url",
  },
  repos: {
    id: "repos.id",
    repoUrl: "repos.repo_url",
  },
}));

import { db } from "../db/client.js";
import {
  getPromptTemplate,
  renderTemplateString,
  platformTemplateParams,
  templateUsesPlatform,
} from "./prompt-template-service.js";

describe("renderTemplateString {{else}}", () => {
  it("keeps the {{else}} part of a block when the param is falsy", () => {
    const t = "a{{#if flag}}yes{{else}}no{{/if}}b";
    expect(renderTemplateString(t, { flag: true })).toBe("ayesb");
    expect(renderTemplateString(t, { flag: "" })).toBe("anob");
    expect(renderTemplateString(t, {})).toBe("anob");
  });
});

describe("platformTemplateParams", () => {
  it("names the repo's platform for a template that asks for it", () => {
    const t = "{{#if GIT_PLATFORM_GITLAB}}glab{{else}}gh{{/if}}";
    expect(platformTemplateParams(t, "gitlab")).toEqual({ GIT_PLATFORM_GITLAB: "true" });
    expect(platformTemplateParams(t, "github")).toEqual({ GIT_PLATFORM_GITLAB: "" });
    expect(platformTemplateParams(t, null)).toEqual({ GIT_PLATFORM_GITLAB: "" });
  });

  it("adds nothing to a template that doesn't", () => {
    expect(platformTemplateParams("Fix {{issue}}", "gitlab")).toEqual({});
    expect(templateUsesPlatform("Fix {{issue}}")).toBe(false);
  });
});

describe("getPromptTemplate's built-in prompt", () => {
  it("gives a GitLab repo the built-in prompt written for GitLab", async () => {
    const { DEFAULT_PROMPT_TEMPLATE, builtinPromptTemplates } = await import("@optio/shared");
    const GITLAB_PROMPT_TEMPLATE = builtinPromptTemplates("gitlab").task;
    expect(GITLAB_PROMPT_TEMPLATE).toContain("--target-branch {{BASE_BRANCH}}");
    const rows = (repo: Record<string, unknown> | null) => {
      let call = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            call++;
            return Promise.resolve(call === 1 && repo ? [repo] : []);
          }),
        }),
      }));
    };
    // gitlab.com, not added: the host says GitLab.
    rows(null);
    expect((await getPromptTemplate("https://gitlab.com/g/app")).template).toBe(
      GITLAB_PROMPT_TEMPLATE,
    );
    // A self-hosted host added as GitLab.
    rows({ id: "r", promptTemplateOverride: null, gitPlatform: "gitlab", autoMerge: false });
    expect((await getPromptTemplate("https://git.example.com/g/app")).template).toBe(
      GITLAB_PROMPT_TEMPLATE,
    );
    // GitHub keeps the default.
    rows({ id: "r", promptTemplateOverride: null, gitPlatform: "github", autoMerge: false });
    expect((await getPromptTemplate("https://github.com/o/r")).template).toBe(
      DEFAULT_PROMPT_TEMPLATE,
    );
  });
});
