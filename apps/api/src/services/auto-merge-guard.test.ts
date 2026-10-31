import { describe, it, expect } from "vitest";
import type { Review } from "@optio/shared";
import { hasChangesRequested, pullRequestBlocker } from "./auto-merge-guard.js";
import { determineReviewStatus } from "../workers/pr-watcher-worker.js";
const review = (author: string, state: Review["state"]): Review => ({ author, state, body: "" });

describe("pullRequestBlocker", () => {
  it("a reviewer's latest changes-requested blocks, their own later approval clears it", () => {
    expect(hasChangesRequested([review("a", "CHANGES_REQUESTED"), review("b", "APPROVED")])).toBe(
      true,
    );
    expect(
      hasChangesRequested([
        review("a", "CHANGES_REQUESTED"),
        review("a", "COMMENTED"),
        review("a", "APPROVED"),
      ]),
    ).toBe(false);
  });

  it("drafts and conflicts block", () => {
    expect(pullRequestBlocker({ draft: true, mergeable: true }, [])).toBe("pr_draft");
    expect(pullRequestBlocker({ draft: false, mergeable: false }, [])).toBe("pr_not_mergeable");
    expect(pullRequestBlocker({ draft: false, mergeable: null }, [])).toBeNull();
  });
});

describe("determineReviewStatus agrees with the merge guard", () => {
  it.each([
    [[review("a", "CHANGES_REQUESTED"), review("b", "APPROVED")]],
    [[review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")]],
    [[review("a", "APPROVED"), review("b", "CHANGES_REQUESTED"), review("b", "COMMENTED")]],
    [[review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED"), review("b", "APPROVED")]],
    [[review("a", "APPROVED"), review("b", "APPROVED")]],
  ])("%j", (reviews) => {
    expect(determineReviewStatus(reviews).status === "changes_requested").toBe(
      hasChangesRequested(reviews),
    );
  });

  it("carries every open request's text", () => {
    const reviews: Review[] = [
      { author: "a", state: "CHANGES_REQUESTED", body: "Fix X" },
      { author: "b", state: "CHANGES_REQUESTED", body: "Fix Y" },
      { author: "c", state: "APPROVED", body: "" },
    ];
    expect(determineReviewStatus(reviews)).toEqual({
      status: "changes_requested",
      comments: "Fix X\n\nFix Y",
    });
  });
});
