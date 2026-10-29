import type { PullRequest, Review } from "@optio/shared";

export type AutoMergeBlocker = "pr_draft" | "pr_not_mergeable" | "pr_changes_requested";

/**
 * Whether any reviewer's latest say on the PR is "changes requested" — a
 * later approval by someone else doesn't clear it, only that reviewer's own
 * approval (or the review being dismissed) does.
 */
export function hasChangesRequested(reviews: readonly Review[]): boolean {
  const latest = new Map<string, Review["state"]>();
  for (const r of reviews) {
    if (r.state === "COMMENTED") continue;
    latest.set(r.author, r.state);
  }
  return [...latest.values()].includes("CHANGES_REQUESTED");
}

/** The PR as the platform has it now, and its reviews. */
export function pullRequestBlocker(
  pr: Pick<PullRequest, "draft" | "mergeable">,
  reviews: readonly Review[],
): AutoMergeBlocker | null {
  if (pr.draft) return "pr_draft";
  if (pr.mergeable === false) return "pr_not_mergeable";
  if (hasChangesRequested(reviews)) return "pr_changes_requested";
  return null;
}
