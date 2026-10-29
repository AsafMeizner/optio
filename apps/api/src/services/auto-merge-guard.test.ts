import { describe, it, expect } from "vitest";
import type { Review } from "@optio/shared";
import { hasChangesRequested, pullRequestBlocker } from "./auto-merge-guard.js";
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
