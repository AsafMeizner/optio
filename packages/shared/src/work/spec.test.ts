import { describe, expect, it } from "vitest";
import {
  deriveWorkKind,
  isWorkDefinitionKind,
  kindOfSpec,
  slugify,
  specWithRepo,
  type WorkKindAnswers,
  type WorkSpec,
} from "./spec.js";

describe("work kind selection", () => {
  const cases: [WorkKindAnswers, string][] = [
    [
      { then: "waits-for-messages", local: false, triggered: false, withRepo: true },
      "persistent-agent",
    ],
    [{ then: "waits-for-me", local: false, triggered: false, withRepo: true }, "pod-session"],
    [{ then: "waits-for-me", local: true, triggered: false, withRepo: false }, "local-terminal"],
    [{ then: "waits-for-me", local: true, triggered: true, withRepo: false }, "local-blueprint"],
    [{ then: "until-merged", local: false, triggered: false, withRepo: true }, "repo-task"],
    [{ then: "until-merged", local: false, triggered: true, withRepo: true }, "repo-blueprint"],
    [{ then: "exits", local: false, triggered: true, withRepo: false }, "standalone"],
  ];
  it.each(cases)("derives %j as %s", (answers, kind) => {
    expect(deriveWorkKind(answers)).toBe(kind);
  });
  it("only treats saved definitions as editable definitions", () => {
    for (const kind of ["repo-blueprint", "standalone", "local-blueprint"])
      expect(isWorkDefinitionKind(kind)).toBe(true);
    for (const kind of [
      "repo-task",
      "local-terminal",
      "persistent-agent",
      "pod-session",
      "unknown",
    ])
      expect(isWorkDefinitionKind(kind)).toBe(false);
  });
  it("requires a branch for local PR work and a URL for pod PR work", () => {
    expect(specWithRepo({ runTarget: "local", repoUrl: "https://github.com/acme/app" })).toBe(
      false,
    );
    expect(specWithRepo({ runTarget: "local", repoBranch: "feature" })).toBe(true);
    expect(specWithRepo({ runTarget: "cluster", repoBranch: "feature" })).toBe(false);
    expect(specWithRepo({ runTarget: "cluster", repoUrl: "https://github.com/acme/app" })).toBe(
      true,
    );
  });
  it("maps the complete trigger/location answers through the same rule", () => {
    const spec: Pick<WorkSpec, "when" | "where" | "then"> = {
      when: { type: "manual" },
      where: { runTarget: "cluster", repoUrl: "https://github.com/acme/app" },
      then: "until-merged",
    };
    expect(kindOfSpec(spec)).toBe("repo-task");
    expect(kindOfSpec({ ...spec, when: { type: "webhook", config: {} } })).toBe("repo-blueprint");
    expect(kindOfSpec({ ...spec, where: { runTarget: "local" }, then: "waits-for-me" })).toBe(
      "local-terminal",
    );
  });
  it("bounds and normalizes agent slugs", () => {
    expect(slugify("  Release & Review 42!  ")).toBe("release-review-42");
    expect(slugify("A".repeat(50))).toBe("a".repeat(40));
    expect(slugify("!@#")).toBe("");
  });
});
