import type { GitPlatform, PullRequest, RepoIdentifier, Review } from "@optio/shared";

/** An unreadable open GitLab MR is never treated as having no blocking reviews. */
export async function readPrReviews(
  platform: GitPlatform,
  ri: RepoIdentifier,
  prNumber: number,
  pr: Pick<PullRequest, "merged" | "state">,
): Promise<Review[]> {
  try {
    return await platform.getReviews(ri, prNumber);
  } catch (err) {
    if (platform.type === "gitlab" && !pr.merged && pr.state !== "closed") throw err;
    return [];
  }
}
