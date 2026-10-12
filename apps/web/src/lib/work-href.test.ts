import { describe, expect, it } from "vitest";
import { terminalWorkHref, workHref } from "./work-href";
import { splitHref } from "@/components/local/split-state";

describe("Work links", () => {
  it("canonicalizes run links without changing recurring, review, or creation destinations", () => {
    expect(workHref("/tasks/t?session=s#result")).toBe("/work/t?session=s#result");
    expect(workHref("/local/s?split=a")).toBe("/work/s?split=a");
    for (const path of [
      "/tasks/new",
      "/tasks/scheduled/t",
      "/local/automations/a",
      "/jobs/j",
      "/reviews/r",
    ])
      expect(workHref(path)).toBe(path);
  });

  it("pins terminal links to their attempt while split changes preserve the task identity", () => {
    const href = terminalWorkHref({ id: "attempt-1", taskId: "task" });
    expect(href).toBe("/work/task?session=attempt-1");
    expect(splitHref("attempt-1", ["shell"], "rows", href)).toBe(
      "/work/task?session=attempt-1&split=shell&layout=rows",
    );
    expect(splitHref("attempt-1", [], "cols", `${href}&split=shell&layout=rows#result`)).toBe(
      "/work/task?session=attempt-1#result",
    );
    expect(terminalWorkHref({ id: "shell" })).toBe("/work/shell");
  });
});
