import { describe as suite, it, expect } from "vitest";
import {
  EMPTY_DRAFT,
  describe,
  missingFields,
  normalize,
  remoteWorkspaceDisabled,
  thenOptions,
  type WorkDraft,
} from "./model";
const text = (d: WorkDraft) =>
  describe(d)
    .map((p) => ("missing" in p ? p.missing : p.text))
    .join(" ");
const enabled = <T>(choices: Array<{ value: T; disabled?: string }>) =>
  choices.filter((c) => !c.disabled).map((c) => c.value);
suite("A remote workspace", () => {
  const inRemoteWorkspace = (d: WorkDraft): WorkDraft => ({
    ...d,
    location: {
      ...d.location,
      runTarget: "local",
      localHostId: "",
      localDir: "",
      remoteWorkspace: {
        connectionId: "c1",
        source: "new",
        workspaceId: "",
        templateId: "",
        parameters: {},
        name: "",
        checkoutDir: "",
        repoUrl: "",
      },
    },
  });

  it("is for new work, and for saved work that has one", () => {
    expect(remoteWorkspaceDisabled(EMPTY_DRAFT)).toBeUndefined();
    expect(remoteWorkspaceDisabled(EMPTY_DRAFT, true)).toMatch(/start new work/);
    expect(remoteWorkspaceDisabled(inRemoteWorkspace(EMPTY_DRAFT), true)).toBeUndefined();
  });

  it("stays on a trigger or a schedule — the workspace starts when the work fires", () => {
    expect(remoteWorkspaceDisabled({ ...EMPTY_DRAFT, when: "schedule" })).toBeUndefined();
    const next = normalize({ ...inRemoteWorkspace(EMPTY_DRAFT), when: "schedule" });
    expect(next.location.runTarget).toBe("local");
    expect(next.location.remoteWorkspace?.connectionId).toBe(
      inRemoteWorkspace(EMPTY_DRAFT).location.remoteWorkspace?.connectionId,
    );
  });

  it("can't wait for you", () => {
    const d = inRemoteWorkspace({ ...EMPTY_DRAFT, runtime: "claude-code" });
    expect(thenOptions(d).find((t) => t.value === "waits-for-me")?.disabled).toMatch(
      /remote workspace/,
    );
    expect(enabled(thenOptions(d))).toContain("exits");
  });

  it("says it in the sentence, and asks a Task for its repo", () => {
    const job = inRemoteWorkspace({ ...EMPTY_DRAFT, runtime: "claude-code", withRepo: false });
    expect(text(job)).toContain("in a new remote workspace");
    expect(missingFields(job)).not.toContain("machine");
    const task = inRemoteWorkspace({ ...EMPTY_DRAFT, runtime: "claude-code", withRepo: true });
    expect(missingFields(task)).toContain("repo");
    const noConnection = inRemoteWorkspace(EMPTY_DRAFT);
    noConnection.location.remoteWorkspace!.connectionId = "";
    expect(missingFields(noConnection)).toContain("machine");
  });
});
