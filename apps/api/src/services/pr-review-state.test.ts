import { describe, expect, it, vi } from "vitest";
import type { GitPlatform, RepoIdentifier } from "@optio/shared";
import { readPrReviews } from "./pr-review-state.js";

const ri = { platform: "gitlab", owner: "acme", repo: "app" } as RepoIdentifier;
function platform(type: "github" | "gitlab") {
  return {
    type,
    getReviews: vi.fn().mockRejectedValue(new Error("review read failed")),
  } as unknown as GitPlatform;
}
describe("readPrReviews", () => {
  it("propagates unreadable open GitLab reviews instead of authorizing a merge", async () => {
    await expect(
      readPrReviews(platform("gitlab"), ri, 7, { merged: false, state: "open" }),
    ).rejects.toThrow("review read failed");
  });
  it("keeps completing an MR already merged or closed when reviews are unreadable", async () => {
    for (const pr of [
      { merged: true, state: "closed" as const },
      { merged: false, state: "closed" as const },
    ]) {
      expect(await readPrReviews(platform("gitlab"), ri, 7, pr)).toEqual([]);
    }
  });
  it("preserves the GitHub fallback", async () => {
    expect(
      await readPrReviews(platform("github"), ri, 7, { merged: false, state: "open" }),
    ).toEqual([]);
  });
  it("preserves readable change requests", async () => {
    const reviews = [{ author: "alice", state: "CHANGES_REQUESTED", body: "fix this" }];
    const p = {
      type: "gitlab",
      getReviews: vi.fn().mockResolvedValue(reviews),
    } as unknown as GitPlatform;
    expect(await readPrReviews(p, ri, 7, { merged: false, state: "open" })).toBe(reviews);
  });
});
