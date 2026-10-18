import { describe, expect, it } from "vitest";
import { approvalFrame } from "../services/session-tool-approval.js";
const spec = {
  name: "Investigate login",
  when: { type: "manual" },
  where: { runTarget: "cluster" },
  who: { runtime: "codex" },
  what: { prompt: "Investigate login" },
  then: "waits-for-me",
};
describe("Controller MCP work previews", () => {
  it("previews the exact WorkSpec the real MCP tool will execute", () => {
    expect(approvalFrame({ id: "approval-1", tool: "create_work", args: { spec } })).toMatchObject({
      type: "action_proposal",
      actionId: "approval-1",
      work: [spec],
      items: [],
    });
  });
  it("does not turn invalid arguments into a misleading valid work preview", () => {
    expect(
      approvalFrame({ id: "approval-2", tool: "create_work", args: { spec: { name: "Bad" } } }),
    ).toMatchObject({ work: [], items: [expect.stringContaining("create_work")] });
  });
  it("shows other mutations for review", () => {
    expect(
      approvalFrame({ id: "approval-3", tool: "delete_work", args: { id: "work-1" } }).items,
    ).toEqual(['delete_work({"id":"work-1"})']);
  });
});
