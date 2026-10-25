import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ api: {} }));

import {
  automationChoices,
  defaultEventSource,
  formFromBlueprint,
  previewLines,
  triggerSummary,
} from "./automations-section";

describe("formFromBlueprint", () => {
  it("round-trips promptTemplateId for agent automations", () => {
    const form = formFromBlueprint({
      name: "PR review",
      agent: "claude-code",
      commandTemplate: "",
      promptTemplateId: "tpl-1",
    });
    expect(form.promptTemplateId).toBe("tpl-1");
    expect(form.commandTemplate).toBe("");
  });

  it("defaults promptTemplateId to null and ignores it for shell automations", () => {
    expect(formFromBlueprint({ name: "x", commandTemplate: "ls" }).promptTemplateId).toBeNull();
    expect(
      formFromBlueprint({ name: "x", agent: null, commandTemplate: "ls", promptTemplateId: "t" })
        .promptTemplateId,
    ).toBeNull();
  });
});

describe("previewLines", () => {
  it("returns short text unchanged", () => {
    expect(previewLines("a\nb")).toBe("a\nb");
  });
  it("truncates to the first lines with an ellipsis", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(previewLines(text, 6)).toBe(
      ["line 0", "line 1", "line 2", "line 3", "line 4", "line 5", "…"].join("\n"),
    );
  });
});

describe("triggerSummary", () => {
  it("omits a blank login on github triggers", () => {
    expect(
      triggerSummary({ type: "github", config: { events: ["review_requested"], login: "" } }),
    ).toBe("review_requested");
  });

  it("says when a Linear trigger skips your own tickets", () => {
    expect(
      triggerSummary({
        type: "linear",
        config: { events: ["assigned"], user: "Ada", othersOnly: true },
      }),
    ).toBe("assigned → Ada · from others");
  });
});

describe("automationChoices (the deployment features)", () => {
  it("keeps upstream's pickers under the default deployment", () => {
    const c = automationChoices(featuresFromEnv({}));
    expect(c.agents).toEqual(["claude-code", "codex", "cursor", "gemini", "opencode"]);
    expect(c.ticketSources).toEqual(["github", "gitlab", "linear", "jira", "notion"]);
    expect(c.triggerTypes).toContain("github");
    expect(c.triggerTypes).toContain("slack");
    expect(c.presetIds).toEqual(["pr-review", "slack-channel", "linear-triage"]);
    expect(defaultEventSource(featuresFromEnv({}))).toBe("github");
  });

  it("offers the restricted deployment's runtimes, triggers and sources, GitLab by default", () => {
    const c = automationChoices(
      featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    );
    expect(c.agents).toEqual(["claude-code", "opencode"]);
    expect(c.ticketSources).toEqual(["gitlab", "jira"]);
    expect(c.triggerTypes).toEqual([
      "schedule",
      "webhook",
      "ticket",
      "gitlab",
      "jira",
      "sentry",
      "alertmanager",
    ]);
    expect(c.presetIds).toEqual([]);
    expect(
      defaultEventSource(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe("gitlab");
  });
});
