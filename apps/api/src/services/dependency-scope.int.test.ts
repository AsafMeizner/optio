/**
 * A task's dependencies come from its own workspace: a dependency's title and
 * state show on the task, and its completion releases it, so a task id from
 * another workspace must read as not found.
 */
import { describe, expect, it } from "vitest";
import { addDependencies, getDependencies } from "./dependency-service.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";

describe("addDependencies workspace scope", () => {
  it("refuses another workspace's task and accepts one from the same workspace", async () => {
    const mine = await insertWorkspace();
    const theirs = await insertWorkspace();
    const task = await insertTask({ workspaceId: mine.id, title: "mine" });
    const sibling = await insertTask({ workspaceId: mine.id, title: "sibling" });
    const foreign = await insertTask({ workspaceId: theirs.id, title: "their secret plan" });

    await expect(addDependencies(task.id, [foreign.id])).rejects.toThrow(
      `Dependency tasks not found: ${foreign.id}`,
    );
    expect(await getDependencies(task.id)).toEqual([]);

    await addDependencies(task.id, [sibling.id]);
    const deps = await getDependencies(task.id);
    expect(deps.map((d) => d.id)).toEqual([sibling.id]);
  });
});
