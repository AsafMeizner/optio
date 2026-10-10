/**
 * The review row a launch builds on, against the real database: an active
 * review is picked over a historical cancelled duplicate of the same PR URL
 * whatever their order; with no active one, the newest.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { prReviews } from "../db/schema.js";
import { findReviewByUrl } from "./pr-review-service.js";

async function insertReview(prUrl: string, state: string, updatedAt: Date) {
  const [row] = await db
    .insert(prReviews)
    .values({
      prUrl,
      prNumber: 7,
      repoOwner: "o",
      repoName: "r",
      repoUrl: "https://github.com/o/r",
      headSha: "abc",
      state: state as never,
      updatedAt,
    })
    .returning();
  return row;
}

describe("findReviewByUrl", () => {
  it("prefers the active review over a newer cancelled duplicate", async () => {
    const url = "https://github.com/o/r/pull/7";
    const older = new Date(Date.now() - 3_600_000);
    const newer = new Date();
    const active = await insertReview(url, "reviewing", older);
    await insertReview(url, "cancelled", newer);
    expect((await findReviewByUrl(url))?.id).toBe(active.id);
  });

  it("prefers the active review over an older cancelled duplicate", async () => {
    const url = "https://github.com/o/r/pull/8";
    await insertReview(url, "cancelled", new Date(Date.now() - 3_600_000));
    const active = await insertReview(url, "ready", new Date());
    expect((await findReviewByUrl(url))?.id).toBe(active.id);
  });

  it("with no active review, picks the most recently updated", async () => {
    const url = "https://github.com/o/r/pull/9";
    await insertReview(url, "cancelled", new Date(Date.now() - 3_600_000));
    const newest = await insertReview(url, "submitted", new Date());
    expect((await findReviewByUrl(url))?.id).toBe(newest.id);
    expect(await findReviewByUrl("https://github.com/o/r/pull/404")).toBeUndefined();
  });

  it("the unique index keeps a second active review out", async () => {
    const url = "https://github.com/o/r/pull/10";
    await insertReview(url, "queued", new Date());
    await expect(insertReview(url, "reviewing", new Date())).rejects.toSatisfy((err: unknown) => {
      const cause = (err as { cause?: { message?: string } }).cause;
      return /pr_reviews_active_pr_url_key/.test(cause?.message ?? (err as Error).message);
    });
    await db.execute(sql`DELETE FROM "pr_reviews" WHERE "pr_url" = ${url}`);
  });
});
