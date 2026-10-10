import { describe, expect, it } from "vitest";
import { viewSourceColumns, withoutColumns } from "./migrate-safe.js";
import { RUN_VIEWS_SQL } from "./run-views.js";

const VIEW = `CREATE VIEW "workflow_runs" AS
     SELECT "id", "kind", "work_id" AS "workflow_id", "trigger_id",
       "recovery_required", "exec_state", "consumed_bytes",
       "created_at", "updated_at"
     FROM "tasks" WHERE "kind" = 'standalone'
     WITH CASCADED CHECK OPTION`;

describe("run views between historical migrations", () => {
  it("knows the source columns a view selects, aliases included as their source", () => {
    expect(viewSourceColumns(VIEW)).toEqual([
      "id",
      "kind",
      "work_id",
      "trigger_id",
      "recovery_required",
      "exec_state",
      "consumed_bytes",
      "created_at",
      "updated_at",
    ]);
    expect(
      viewSourceColumns(`CREATE VIEW "repo_tasks" AS SELECT * FROM "tasks" WHERE "kind" = 'repo'`),
    ).toEqual([]);
    expect(
      viewSourceColumns(`ALTER VIEW "workflow_runs" ALTER COLUMN "kind" SET DEFAULT 'standalone'`),
    ).toEqual([]);
  });

  it("leaves out the columns a later migration adds, keeping every other item intact", () => {
    const out = withoutColumns(VIEW, ["exec_state", "consumed_bytes", "recovery_required"]);
    expect(out).toContain(
      `SELECT "id", "kind", "work_id" AS "workflow_id", "trigger_id", "created_at", "updated_at" FROM "tasks" WHERE "kind" = 'standalone'`,
    );
    expect(out).toContain("WITH CASCADED CHECK OPTION");
    expect(withoutColumns(VIEW, [])).toBe(VIEW);
    expect(withoutColumns(`SELECT * FROM "tasks"`, ["exec_state"])).toBe(`SELECT * FROM "tasks"`);
  });

  it("the real views' later columns need no list: each is derived from the SQL", () => {
    const columns = RUN_VIEWS_SQL.flatMap(viewSourceColumns);
    for (const c of [
      "exec_state",
      "exec_pid",
      "consumed_bytes",
      "attached_by",
      "attach_lease_until",
      "recovery_required",
    ]) {
      expect(columns).toContain(c);
    }
    const stripped = RUN_VIEWS_SQL.map((s) => withoutColumns(s, ["attach_lease_until"]));
    expect(stripped.join("\n")).not.toContain("attach_lease_until");
    expect(stripped.join("\n")).toContain('"attached_by"');
  });
});
