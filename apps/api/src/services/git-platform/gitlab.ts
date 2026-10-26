import type {
  GitPlatform,
  RepoIdentifier,
  PullRequest,
  CICheck,
  Review,
  InlineComment,
  IssueComment,
  Issue,
  RepoMetadata,
  RepoContent,
} from "@optio/shared";

/**
 * A non-2xx answer from GitLab's API, with its HTTP status and the rate-limit
 * headers GitLab sends with it (`Retry-After`, `RateLimit-Remaining`,
 * `RateLimit-Reset`), so a caller can wait as long as GitLab asks.
 */
export class GitLabApiError extends Error {
  readonly retryAfterMs: number | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetMs: number | null;

  constructor(
    readonly status: number,
    body: string,
    meta: {
      retryAfterMs?: number | null;
      rateLimitRemaining?: number | null;
      rateLimitResetMs?: number | null;
    } = {},
  ) {
    super(`GitLab API error ${status}: ${body}`);
    this.name = "GitLabApiError";
    this.retryAfterMs = meta.retryAfterMs ?? null;
    this.rateLimitRemaining = meta.rateLimitRemaining ?? null;
    this.rateLimitResetMs = meta.rateLimitResetMs ?? null;
  }

  static fromResponse(res: Response, body: string): GitLabApiError {
    const header = (name: string): number | null => {
      const raw = res.headers?.get?.(name);
      if (raw == null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const retryAfter = header("retry-after");
    const reset = header("ratelimit-reset");
    return new GitLabApiError(res.status, body, {
      retryAfterMs: retryAfter == null ? null : Math.max(0, retryAfter) * 1000,
      rateLimitRemaining: header("ratelimit-remaining"),
      rateLimitResetMs: reset == null ? null : reset * 1000,
    });
  }
}

/** How many pages (of 100) of a thread's newest notes are read. */
const NOTE_PAGES = 3;

/** How many of an issue's newest comments a ticket's prompt carries (as GitHub's one page). */
const ISSUE_COMMENTS = 30;

/** The opening of a note that requests changes (`**Changes Requested:**`, `Changes requested:`). */
const CHANGE_REQUEST = /^\s*(?:\*\*)?\s*changes requested:/i;

/** Whether a note is a "Request changes" review: it opens with "Changes requested:". */
export function isChangeRequest(body: string | null | undefined): boolean {
  return CHANGE_REQUEST.test(body ?? "");
}

function toComment(n: any): IssueComment {
  return {
    author: n.author?.username ?? "unknown",
    body: n.body ?? "",
    createdAt: n.created_at ?? "",
  };
}

export class GitLabPlatform implements GitPlatform {
  readonly type = "gitlab" as const;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      "PRIVATE-TOKEN": this.token,
      "User-Agent": "Optio",
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private projectId(ri: RepoIdentifier): string {
    return encodeURIComponent(`${ri.owner}/${ri.repo}`);
  }

  private url(ri: RepoIdentifier, path: string): string {
    return `${ri.apiBaseUrl}/projects/${this.projectId(ri)}${path}`;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw GitLabApiError.fromResponse(res, body);
    }
    return (await res.json()) as T;
  }

  // ── PR/MR reads ───────────────────────────────────────────────────────────

  async getPullRequest(ri: RepoIdentifier, number: number): Promise<PullRequest> {
    const data = await this.fetchJson<any>(this.url(ri, `/merge_requests/${number}`), {
      headers: this.headers(),
    });
    return mapMr(data, ri, await this.forkPaths(ri, [data]));
  }

  private async forkPaths(ri: RepoIdentifier, mrs: any[]): Promise<Map<number, string>> {
    const ids = new Set<number>();
    for (const d of mrs) {
      if (
        d?.source_project_id &&
        d.target_project_id &&
        d.source_project_id !== d.target_project_id
      ) {
        ids.add(d.source_project_id);
      }
    }
    const paths = new Map<number, string>();
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          const project = await this.fetchJson<any>(`${ri.apiBaseUrl}/projects/${id}`, {
            headers: this.headers(),
          });
          if (typeof project?.path_with_namespace === "string") {
            paths.set(id, project.path_with_namespace);
          }
        } catch {
          // Not visible to this token: the MR's head repo stays unknown
        }
      }),
    );
    return paths;
  }

  /**
   * Keep the MR's `head_pipeline` for its head SHA, so the CI read that
   * follows (getCIChecks) uses the pipeline GitLab shows on the MR without
   * asking for it again. GitLab only returns a head pipeline that ran on
   * the MR's current head (its own SHA, or its source SHA for a
   * merged-results pipeline).
   */

  async listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number },
  ): Promise<PullRequest[]> {
    const params = new URLSearchParams({ state: "opened" });
    if (opts?.perPage) params.set("per_page", String(opts.perPage));
    if (opts?.branch) params.set("source_branch", opts.branch);
    const data = await this.fetchJson<any[]>(this.url(ri, `/merge_requests?${params}`), {
      headers: this.headers(),
    });
    const forks = await this.forkPaths(ri, data);
    return data.map((d: any) => mapMr(d, ri, forks));
  }

  async findPullRequestsByHeadPrefix(ri: RepoIdentifier, prefix: string): Promise<PullRequest[]> {
    const out: PullRequest[] = [];
    for (let page = 1; page <= 3; page++) {
      const params = new URLSearchParams({
        state: "opened",
        per_page: "100",
        page: String(page),
        order_by: "created_at",
        sort: "desc",
      });
      const data = await this.fetchJson<any[]>(this.url(ri, `/merge_requests?${params}`), {
        headers: this.headers(),
      });
      const forks = await this.forkPaths(ri, data);
      for (const d of data) {
        if (typeof d?.source_branch === "string" && d.source_branch.startsWith(prefix)) {
          out.push(mapMr(d, ri, forks));
        }
      }
      if (data.length < 100) break;
    }
    return out;
  }

  async getCIChecks(ri: RepoIdentifier, commitSha: string): Promise<CICheck[]> {
    // Get pipelines for the commit
    const pipelines = await this.fetchJson<any[]>(
      this.url(ri, `/pipelines?sha=${commitSha}&per_page=5`),
      { headers: this.headers() },
    );
    if (pipelines.length === 0) return [];

    // Get jobs from the most recent pipeline
    const pipelineId = pipelines[0].id;
    const jobs = await this.fetchJson<any[]>(
      this.url(ri, `/pipelines/${pipelineId}/jobs?per_page=100`),
      { headers: this.headers() },
    );

    return jobs.map((j: any) => ({
      name: j.name ?? "",
      status: mapGitLabJobStatus(j.status),
      conclusion: mapGitLabJobConclusion(j.status),
    }));
  }

  async getReviews(ri: RepoIdentifier, prNumber: number): Promise<Review[]> {
    // A read that failed for another reason than "this GitLab has no such
    // API" (404) leaves the list incomplete: automatic merging never goes
    // ahead on it (auto-merge-guard.ts), since a "Request changes" may be
    // what's missing.
    let incomplete = false;
    const notThere = (err: unknown) => err instanceof GitLabApiError && err.status === 404;

    // Fetch approvals
    let approvers: string[] = [];
    try {
      const approvals = await this.fetchJson<any>(
        this.url(ri, `/merge_requests/${prNumber}/approvals`),
        { headers: this.headers() },
      );
      approvers = (approvals.approved_by ?? []).map(
        (a: any) => (a.user?.username as string | undefined) ?? "unknown",
      );
    } catch (err) {
      // Approvals API may not be available on all tiers (a 404 on CE)
      if (!notThere(err)) incomplete = true;
    }

    // The MR's notes, oldest first. A note that opens with "Changes
    // requested:" is the GitLab form of a "Request changes" review (what
    // Optio's review agent and submitReview post; GitLab before 17 has no
    // reviewer state for it) until its thread is resolved. GitLab's
    // "approved this merge request" system notes date each approval, so a
    // reviewer's approval after their own change request supersedes it.
    let notes: any[] = [];
    try {
      notes = await this.mrNotes(ri, prNumber);
    } catch (err) {
      if (!notThere(err)) incomplete = true;
    }
    const approvedAt = new Map<string, string>();
    for (const note of notes) {
      if (note.system && /^approved this merge request/i.test(note.body ?? "")) {
        approvedAt.set(note.author?.username ?? "unknown", note.created_at ?? "");
      }
    }
    const dated: { at: number; review: Review }[] = [];
    const reviews: Review[] = [];
    for (const author of approvers) {
      const review: Review = { author, state: "APPROVED", body: "" };
      const at = Date.parse(approvedAt.get(author) ?? "");
      if (Number.isNaN(at)) reviews.push(review);
      else dated.push({ at, review });
    }
    for (const note of notes) {
      if (note.system) continue; // Skip system-generated notes
      if (!note.body?.trim()) continue;
      const requestsChanges = isChangeRequest(note.body) && !(note.resolvable && note.resolved);
      dated.push({
        at: Date.parse(note.created_at ?? "") || 0,
        review: {
          author: note.author?.username ?? "unknown",
          state: requestsChanges ? "CHANGES_REQUESTED" : "COMMENTED",
          body: note.body ?? "",
        },
      });
    }
    // Stable: notes keep their order when dates tie or are missing.
    dated.sort((a, b) => a.at - b.at);
    reviews.push(...dated.map((d) => d.review));

    // A reviewer's "Request changes" (GitLab 17+): last, so it is that
    // reviewer's latest say — automatic merging never goes over it.
    try {
      const reviewers = await this.fetchJson<any[]>(
        this.url(ri, `/merge_requests/${prNumber}/reviewers`),
        { headers: this.headers() },
      );
      for (const r of reviewers ?? []) {
        if (r?.state !== "requested_changes") continue;
        reviews.push({
          author: r.user?.username ?? "unknown",
          state: "CHANGES_REQUESTED",
          body: "",
        });
      }
    } catch (err) {
      // Older GitLab has no reviewer states (a 404)
      if (!notThere(err)) incomplete = true;
    }

    if (incomplete) throw new Error("GitLab review state is incomplete");
    return reviews;
  }

  /** Comments on lines of the diff, oldest first; a resolved thread is settled and left out. */

  async getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]> {
    const notes = await this.mrNotes(ri, prNumber);

    return notes
      .filter((n: any) => n.position && !n.system && !(n.resolvable && n.resolved))
      .map((n: any) => ({
        author: n.author?.username ?? "unknown",
        path: n.position?.new_path ?? n.position?.old_path ?? "",
        line: n.position?.new_line ?? n.position?.old_line ?? null,
        body: n.body ?? "",
        createdAt: n.created_at ?? "",
      }));
  }

  /** The MR's general discussion: its notes that are not on a line of the diff. */

  async getIssueComments(ri: RepoIdentifier, issueOrPrNumber: number): Promise<IssueComment[]> {
    const notes = await this.newestNotes(ri, `/issues/${issueOrPrNumber}/notes`, 1);
    return notes
      .filter((n: any) => !n.system)
      .slice(-ISSUE_COMMENTS)
      .map(toComment);
  }

  async getPullRequestComments(ri: RepoIdentifier, prNumber: number): Promise<IssueComment[]> {
    const notes = await this.mrNotes(ri, prNumber);
    return notes.filter((n: any) => !n.system && !n.position).map(toComment);
  }

  /** An issue's newest comments (up to 30), oldest first: what a ticket's prompt carries. */

  private mrNotes(ri: RepoIdentifier, prNumber: number): Promise<any[]> {
    return this.newestNotes(ri, `/merge_requests/${prNumber}/notes`);
  }

  /**
   * A thread's notes, oldest first: read newest first, up to `pages` pages
   * of 100, so a busy thread keeps its latest feedback.
   */

  private async newestNotes(ri: RepoIdentifier, path: string, pages = NOTE_PAGES): Promise<any[]> {
    const notes: any[] = [];
    for (let page = 1; page <= pages; page++) {
      const params = new URLSearchParams({
        sort: "desc",
        order_by: "created_at",
        per_page: "100",
        page: String(page),
      });
      const data = await this.fetchJson<any[]>(this.url(ri, `${path}?${params}`), {
        headers: this.headers(),
      });
      notes.push(...data);
      if (data.length < 100) break;
    }
    return notes.reverse();
  }

  // ── PR/MR writes ──────────────────────────────────────────────────────────

  /**
   * Merge the MR. GitLab's merge method (merge commit, semi-linear,
   * fast-forward) is the project's setting, not a parameter of the merge, so
   * "rebase" rebases the source branch onto the target first
   * (`PUT /rebase`, GitLab's own rebase) and then merges what that made.
   * GitLab answers 405/406 right after a push while it is still checking the
   * MR: polled until it says, then merged or `GitLabNotReadyError`. An MR
   * that only needs a rebase (`need_rebase`, a fast-forward project) is
   * rebased by GitLab rather than handed back as a conflict; when the merge
   * was guarded by a checked head SHA, the rebase made a new head that CI
   * must see first, so it comes back as not ready and is merged later.
   */

  async mergePullRequest(
    ri: RepoIdentifier,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
    expectedHeadSha?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      should_remove_source_branch: true,
      sha: expectedHeadSha,
    };
    if (method === "squash") body.squash = true;
    if (method === "rebase") body.merge_method = "rebase";

    await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/merge`), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
  }

  async submitReview(
    ri: RepoIdentifier,
    prNumber: number,
    review: {
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
      commitId?: string;
    },
  ): Promise<{ url: string }> {
    // GitLab has no atomic "submit review" — we make multiple calls

    // 1. Handle approval, of the commit that was reviewed when it is known:
    // GitLab refuses (409) when the MR has moved on since, and that refusal
    // stops the submission before anything is posted.
    if (review.event === "APPROVE") {
      const approve = () =>
        this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/approve`), {
          method: "POST",
          headers: this.headers(true),
          ...(review.commitId ? { body: JSON.stringify({ sha: review.commitId }) } : {}),
        });
      const movedOn = (err: unknown) => err instanceof GitLabApiError && err.status === 409;
      try {
        await approve();
      } catch (err) {
        if (movedOn(err)) throw err;
        // GitLab refuses an approval the user already gave, and no new
        // "approved this merge request" note is made, so a "Changes
        // requested:" this reviewer posted since would never be superseded
        // (getReviews). Withdraw the old approval and approve again. Any
        // other refusal: continue and post the review.
        if (await this.hasApproved(ri, prNumber)) {
          try {
            await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/unapprove`), {
              method: "POST",
              headers: this.headers(true),
            });
            await approve();
          } catch (retryErr) {
            if (movedOn(retryErr)) throw retryErr;
          }
        }
      }
    }

    // 2. Post the review body: a request for changes opens a resolvable
    // thread (GitLab's "all threads must be resolved" holds the merge, and
    // resolving it settles the request — see getReviews); the rest is a note.
    if (review.body?.trim()) {
      if (review.event === "REQUEST_CHANGES") {
        await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/discussions`), {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ body: `**Changes Requested:**\n\n${review.body}` }),
        });
      } else {
        await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/notes`), {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ body: review.body }),
        });
      }
    }

    // 3. Post inline comments as discussions
    if (review.comments?.length) {
      // Fetch MR diff_refs (required by GitLab for positioned discussions)
      let diffRefs: { base_sha: string; start_sha: string; head_sha: string } | null = null;
      try {
        const mrData = await this.fetchJson<{
          diff_refs?: { base_sha: string; start_sha: string; head_sha: string };
        }>(this.url(ri, `/merge_requests/${prNumber}`), { headers: this.headers() });
        diffRefs = mrData.diff_refs ?? null;
      } catch {
        // Continue without diff_refs — comments will be posted as plain notes below
      }

      for (const comment of review.comments) {
        if (diffRefs) {
          const position: Record<string, unknown> = {
            position_type: "text",
            new_path: comment.path,
            old_path: comment.path,
            base_sha: diffRefs.base_sha,
            start_sha: diffRefs.start_sha,
            head_sha: diffRefs.head_sha,
          };
          // A comment on a removed line (GitHub's side LEFT) is on the old file.
          if (comment.line) {
            position[comment.side === "LEFT" ? "old_line" : "new_line"] = comment.line;
          }
          try {
            await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/discussions`), {
              method: "POST",
              headers: this.headers(true),
              body: JSON.stringify({ body: comment.body, position }),
            });
            continue;
          } catch {
            // GitLab refused the position (a line outside the diff, an
            // unchanged line it needs both line numbers for): post it as a
            // located note below rather than lose the finding.
          }
        }
        try {
          const locationPrefix = comment.line
            ? `**${comment.path}:${comment.line}**\n\n`
            : `**${comment.path}**\n\n`;
          await this.fetchJson(this.url(ri, `/merge_requests/${prNumber}/notes`), {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ body: `${locationPrefix}${comment.body}` }),
          });
        } catch {
          // Individual comment failures are non-critical
        }
      }
    }

    // GitLab doesn't return a review URL; construct the MR URL
    const mrUrl = `${ri.apiBaseUrl.replace(/\/api\/v4$/, "")}/${ri.owner}/${ri.repo}/-/merge_requests/${prNumber}`;
    return { url: mrUrl };
  }

  /** Whether this token's user has approved the MR (false when GitLab can't say). */

  private async hasApproved(ri: RepoIdentifier, prNumber: number): Promise<boolean> {
    try {
      const approvals = await this.fetchJson<any>(
        this.url(ri, `/merge_requests/${prNumber}/approvals`),
        { headers: this.headers() },
      );
      return approvals?.user_has_approved === true;
    } catch {
      return false;
    }
  }

  // ── Issue reads/writes ────────────────────────────────────────────────────

  async listIssues(
    ri: RepoIdentifier,
    opts?: { state?: string; perPage?: number; labels?: string },
  ): Promise<Issue[]> {
    const params = new URLSearchParams({
      state: mapIssueStateToGitLab(opts?.state ?? "open"),
      per_page: String(opts?.perPage ?? 50),
      order_by: "updated_at",
      sort: "desc",
    });
    if (opts?.labels) params.set("labels", opts.labels);

    const data = await this.fetchJson<any[]>(this.url(ri, `/issues?${params}`), {
      headers: this.headers(),
    });

    return data.map((i: any) => ({
      id: i.id,
      number: i.iid,
      title: i.title ?? "",
      body: i.description ?? "",
      state: i.state === "opened" ? "open" : "closed",
      url: i.web_url ?? "",
      labels: i.labels ?? [],
      author: i.author?.username ?? "",
      assignee: i.assignee?.username ?? null,
      isPullRequest: false, // GitLab issues endpoint never includes MRs
      createdAt: i.created_at ?? "",
      updatedAt: i.updated_at ?? "",
    }));
  }

  async createLabel(
    ri: RepoIdentifier,
    label: { name: string; color: string; description?: string },
  ): Promise<void> {
    const res = await fetch(this.url(ri, "/labels"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        name: label.name,
        color: `#${label.color}`,
        description: label.description ?? "",
      }),
    });
    // Ignore 409 (label already exists)
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      throw GitLabApiError.fromResponse(res, body);
    }
  }

  async addLabelsToIssue(ri: RepoIdentifier, issueNumber: number, labels: string[]): Promise<void> {
    // GitLab: update issue with add_labels parameter
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}`), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify({ add_labels: labels.join(",") }),
    });
  }

  async createIssueComment(ri: RepoIdentifier, issueNumber: number, body: string): Promise<void> {
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}/notes`), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ body }),
    });
  }

  async closeIssue(ri: RepoIdentifier, issueNumber: number): Promise<void> {
    await this.fetchJson(this.url(ri, `/issues/${issueNumber}`), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify({ state_event: "close" }),
    });
  }

  // ── Repo reads ────────────────────────────────────────────────────────────

  async getRepoMetadata(ri: RepoIdentifier): Promise<RepoMetadata> {
    const data = await this.fetchJson<any>(`${ri.apiBaseUrl}/projects/${this.projectId(ri)}`, {
      headers: this.headers(),
    });
    return {
      fullName: data.path_with_namespace ?? `${ri.owner}/${ri.repo}`,
      defaultBranch: data.default_branch ?? "main",
      isPrivate: data.visibility !== "public",
    };
  }

  async listRepoContents(ri: RepoIdentifier, path = ""): Promise<RepoContent[]> {
    const params = new URLSearchParams({ per_page: "100" });
    if (path) params.set("path", path);
    const data = await this.fetchJson<any[]>(this.url(ri, `/repository/tree?${params}`), {
      headers: this.headers(),
    });
    return data.map((item: any) => ({
      name: item.name ?? "",
      type: item.type === "tree" ? "dir" : "file",
    }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapMr(data: any, ri: RepoIdentifier, forks?: Map<number, string>): PullRequest {
  const headRepo = forks?.get(data.source_project_id);
  return {
    number: data.iid,
    title: data.title ?? "",
    body: data.description ?? "",
    state: data.state === "merged" || data.state === "closed" ? "closed" : "open",
    merged: data.state === "merged",
    mergeable:
      data.merge_status === "can_be_merged"
        ? true
        : data.merge_status === "cannot_be_merged"
          ? false
          : null,
    draft: data.draft ?? data.work_in_progress ?? false,
    headSha: data.sha ?? data.diff_refs?.head_sha ?? "",
    baseBranch: data.target_branch ?? "",
    headBranch: data.source_branch ?? undefined,
    ...(headRepo ? { headRepo } : {}),
    url: data.web_url ?? `https://${ri.host}/${ri.owner}/${ri.repo}/-/merge_requests/${data.iid}`,
    author: data.author?.username ?? "",
    assignees: (data.assignees ?? []).map((a: any) => a.username ?? ""),
    labels: data.labels ?? [],
    createdAt: data.created_at ?? "",
    updatedAt: data.updated_at ?? "",
  };
}

/**
 * Map GitLab job status to CICheck status.
 * GitLab statuses: created, waiting_for_resource, preparing, pending, running,
 *                  success, failed, canceled, skipped, manual, scheduled
 */
function mapGitLabJobStatus(status: string): "queued" | "in_progress" | "completed" {
  switch (status) {
    case "success":
    case "failed":
    case "canceled":
    case "skipped":
    case "manual":
      return "completed";
    case "running":
      return "in_progress";
    default:
      return "queued";
  }
}

function mapGitLabJobConclusion(
  status: string,
): "success" | "failure" | "skipped" | "cancelled" | null {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "skipped":
    case "manual":
      return "skipped";
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

function mapIssueStateToGitLab(state: string): string {
  if (state === "open") return "opened";
  if (state === "closed") return "closed";
  return state; // "all" etc.
}
