import { describe, expect, it } from "vitest";
import {
  buildChecklist,
  pickMyTasks,
  type ChecklistContext,
  type ChecklistSources,
} from "./getting-started-model";

const NOTHING_YET: ChecklistSources = {
  user: { id: "u1", email: "ann@example.com" },
  repoCount: 0,
  repoPlatforms: [],
  tasks: { started: null, waiting: null, merged: null },
};

const MEMBER: ChecklistContext = { isAdmin: false, isViewer: false };
const ADMIN: ChecklistContext = { isAdmin: true, isViewer: false };
const VIEWER: ChecklistContext = { isAdmin: false, isViewer: true };

const ALL_DONE: ChecklistSources = {
  ...NOTHING_YET,
  repoCount: 1,
  repoPlatforms: ["github"],
  tasks: {
    started: { id: "t1", title: "Fix the README" },
    waiting: null,
    merged: { id: "t1", title: "Fix the README", prUrl: "https://github.com/o/r/pull/1" },
  },
};

const ids = (src: ChecklistSources, ctx: ChecklistContext) =>
  buildChecklist(src, ctx).steps.map((s) => [s.id, s.state]);

describe("buildChecklist", () => {
  it("a new admin: signed in, everything else to do, in order", () => {
    const list = buildChecklist(NOTHING_YET, ADMIN);
    expect(list.steps.map((s) => [s.id, s.state])).toEqual([
      ["sign-in", "done"],
      ["repo", "todo"],
      ["first-task", "todo"],
      ["first-review", "todo"],
    ]);
    expect(list.steps[0].detail).toBe("Signed in as ann@example.com.");
    expect(list.steps[1]).toMatchObject({ href: "/repos/new", action: "Add repo" });
    expect(list.steps[2]).toMatchObject({ href: "/work/new", action: "New work" });
    expect(list).toMatchObject({ counted: 4, done: 1, complete: false, settled: false });
  });

  it("has these four steps and no others", () => {
    const steps = buildChecklist(NOTHING_YET, ADMIN).steps.map((s) => s.id);
    expect(steps).toEqual(["sign-in", "repo", "first-task", "first-review"]);
  });

  it("no repository: a member waits for a workspace admin, who adds it", () => {
    const member = buildChecklist(NOTHING_YET, MEMBER).steps.find((s) => s.id === "repo");
    expect(member).toMatchObject({ state: "waiting", href: null });
    expect(member?.detail).toMatch(/A workspace admin adds each repository under Repos/);
  });

  it("everything done: complete, and settled so it isn't asked again", () => {
    const list = buildChecklist(ALL_DONE, MEMBER);
    expect(list).toMatchObject({ counted: 4, done: 4, complete: true, settled: true });
    expect(list.steps.find((s) => s.id === "first-task")?.href).toBe("/work/t1");
  });

  it("complete but not for good isn't remembered: a viewer, a failed request", () => {
    // A viewer's list is the sign-in alone until they become a member.
    const viewer = buildChecklist(NOTHING_YET, VIEWER);
    expect(viewer.steps.map((s) => s.id)).toEqual(["sign-in"]);
    expect(viewer).toMatchObject({ complete: true, settled: false });

    // The repos couldn't be read: the step is left out, not done.
    const noRepos = buildChecklist({ ...ALL_DONE, repoCount: null }, MEMBER);
    expect(noRepos.steps.map((s) => s.id)).not.toContain("repo");
    expect(noRepos).toMatchObject({ complete: true, settled: false });

    // The tasks couldn't be read: generic task steps, still to do.
    const noTasks = buildChecklist({ ...ALL_DONE, tasks: null }, MEMBER);
    expect(noTasks.complete).toBe(false);
  });

  it("a pull request waiting for the person: the review step links to it", () => {
    const list = buildChecklist(
      {
        ...ALL_DONE,
        tasks: {
          started: { id: "t2", title: "Bump deps" },
          waiting: { id: "t2", title: "Bump deps", prUrl: "https://github.com/o/r/pull/2" },
          merged: null,
        },
      },
      MEMBER,
    );
    const review = list.steps.find((s) => s.id === "first-review");
    expect(review).toMatchObject({
      title: "Review your pull request",
      state: "todo",
      href: "/work/t2",
      action: "Open",
    });
    expect(review?.detail).toMatch(/"Bump deps" is waiting for you/);
  });

  it("speaks of pull requests by default and on GitHub", () => {
    const words = (src: ChecklistSources) =>
      buildChecklist(src, ADMIN)
        .steps.map((s) => `${s.title} ${s.detail}`)
        .join(" ");
    expect(words(NOTHING_YET)).toMatch(/pull request/);
    expect(words(NOTHING_YET)).not.toMatch(/merge request/);
    expect(words({ ...NOTHING_YET, repoPlatforms: ["github", "gitlab"] })).not.toMatch(
      /merge request/,
    );
  });

  it("speaks of merge requests where every repo is GitLab's, or the task's own is one", () => {
    const gitlab = buildChecklist(
      { ...NOTHING_YET, repoCount: 0, repoPlatforms: ["gitlab"] },
      ADMIN,
    );
    expect(gitlab.steps.find((s) => s.id === "first-review")?.title).toBe(
      "Review your first merge request",
    );
    expect(gitlab.steps.find((s) => s.id === "repo")?.detail).toMatch(/GitLab project/);

    const mr = buildChecklist(
      {
        ...ALL_DONE,
        repoPlatforms: [null],
        tasks: {
          started: { id: "t", title: null },
          waiting: {
            id: "t",
            title: null,
            prUrl: "https://gitlab.example.com/g/p/-/merge_requests/3",
          },
          merged: null,
        },
      },
      MEMBER,
    );
    expect(mr.steps.find((s) => s.id === "first-review")?.detail).toMatch(
      /^Your task is waiting for you: review the merge request/,
    );
  });

  it("a viewer gets no repository, task or review steps", () => {
    expect(ids(ALL_DONE, VIEWER)).toEqual([["sign-in", "done"]]);
  });
});

describe("pickMyTasks", () => {
  it("a merged task is a completed one whose pull request merged", () => {
    const got = pickMyTasks({
      started: [{ id: "a", title: "A" }],
      waiting: [],
      completed: [
        { id: "b", title: "No PR", prUrl: null, prState: null },
        { id: "c", title: "Closed?", prUrl: "https://github.com/o/r/pull/1", prState: "closed" },
        { id: "d", title: "Merged", prUrl: "https://github.com/o/r/pull/2", prState: "merged" },
      ],
    });
    expect(got).toEqual({
      started: { id: "a", title: "A", prUrl: null },
      waiting: null,
      merged: { id: "d", title: "Merged", prUrl: "https://github.com/o/r/pull/2" },
    });
  });

  it("nothing yet", () => {
    expect(pickMyTasks({ started: [], waiting: [], completed: [] })).toEqual({
      started: null,
      waiting: null,
      merged: null,
    });
  });
});
