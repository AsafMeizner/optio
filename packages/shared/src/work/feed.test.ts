import { describe, expect, it } from "vitest";
import { countWork, inView, shortDir, shortRepo, sortWork, type WorkRow } from "./feed.js";

const row = (overrides: Partial<WorkRow>): WorkRow => ({
  key: "task-1",
  id: "1",
  source: "repo-task",
  href: "/work/1",
  name: "Task",
  when: "now",
  where: { target: "pod", detail: null },
  who: "codex",
  then: "until-merged",
  status: "running",
  statusLabel: "Running",
  note: null,
  prUrl: null,
  lastActivity: null,
  recurring: false,
  editHref: null,
  spawned: false,
  ...overrides,
});

describe("work views and counts", () => {
  it("filters each view by its own behavior", () => {
    const rows = [
      row({ key: "running" }),
      row({ key: "queued", status: "queued" }),
      row({ key: "scheduled", status: "scheduled", source: "repo-blueprint", recurring: true }),
      row({ key: "agent", status: "waiting", source: "persistent-agent" }),
      row({ key: "done", status: "done" }),
      row({ key: "failed", status: "failed" }),
    ];
    const keys = (view: Parameters<typeof inView>[1]) =>
      rows.filter((item) => inView(item, view)).map((item) => item.key);
    expect(keys("active")).toEqual(["running", "queued", "agent"]);
    expect(keys("recurring")).toEqual(["scheduled"]);
    expect(keys("agents")).toEqual(["agent"]);
    expect(keys("history")).toEqual(["done", "failed"]);
    expect(keys("all")).toEqual(rows.map((item) => item.key));
  });

  it("excludes idle agents from waiting and paused definitions from armed recurring work", () => {
    expect(
      countWork([
        row({ status: "needs_you" }),
        row({ status: "running" }),
        row({ status: "queued" }),
        row({ status: "waiting" }),
        row({ status: "waiting", source: "persistent-agent" }),
        row({ status: "done", source: "persistent-agent" }),
        row({ status: "scheduled", recurring: true }),
        row({ status: "paused", recurring: true }),
      ]),
    ).toEqual({ needsYou: 1, running: 2, waiting: 1, recurring: 1, agents: 1 });
    expect(countWork([])).toEqual({ needsYou: 0, running: 0, waiting: 0, recurring: 0, agents: 0 });
  });

  it("shortens only known home-directory and repository URL prefixes", () => {
    expect(shortRepo("https://github.com/acme/app.git")).toBe("acme/app");
    expect(shortRepo("http://git.example/acme/app")).toBe("acme/app");
    expect(shortDir("/Users/jon/src/app")).toBe("~/src/app");
    expect(shortDir("/home/jon/src/app")).toBe("~/src/app");
    expect(shortDir("/srv/app")).toBe("/srv/app");
    for (const absent of [null, undefined, ""]) {
      expect(shortRepo(absent)).toBeNull();
      expect(shortDir(absent)).toBeNull();
    }
  });
});

describe("sortWork", () => {
  const r = (key: string, status: WorkRow["status"], at: string, orderAt?: string) =>
    ({ key, status, lastActivity: at, orderAt }) as WorkRow;

  it("doesn't float needs-you above other live rows", () => {
    const rows = sortWork([
      r("waits", "needs_you", "2026-09-01T00:00:00Z"),
      r("runs", "running", "2026-09-02T00:00:00Z"),
      r("done", "done", "2026-09-03T00:00:00Z"),
    ]);
    expect(rows.map((x) => x.key)).toEqual(["runs", "waits", "done"]);
  });

  it("orders a session row by orderAt (last typed / created), not its activity", () => {
    const rows = sortWork([
      r("busy", "running", "2026-09-30T00:00:00Z", "2026-09-01T00:00:00Z"),
      r("typed", "needs_you", "2026-09-02T00:00:00Z", "2026-09-10T00:00:00Z"),
    ]);
    expect(rows.map((x) => x.key)).toEqual(["typed", "busy"]);
  });

  it("breaks missing-date ties by key and does not reorder its input", () => {
    const input = [row({ key: "b" }), row({ key: "a" })];
    expect(sortWork(input).map((item) => item.key)).toEqual(["a", "b"]);
    expect(input.map((item) => item.key)).toEqual(["b", "a"]);
  });
});
