import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
}));

vi.mock("./repo-pool-service.js", () => ({
  killOrphanedAgentInPod: vi.fn(),
  updateWorktreeState: vi.fn(),
}));

const signalRun = vi.fn();
vi.mock("./run-attachment.js", () => ({
  signalRun: (...args: unknown[]) => signalRun(...args),
}));

import { getTask } from "./task-service.js";
import { killOrphanedAgentInPod, updateWorktreeState } from "./repo-pool-service.js";
import { terminateTaskExecution } from "./task-cancellation-service.js";

describe("terminateTaskExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signals the run's process group under the protocol, from the database's pod and run dir", async () => {
    vi.mocked(getTask).mockResolvedValueOnce({
      id: "task-1",
      lastPodId: "pod-9",
      execState: "started",
    } as any);
    signalRun.mockResolvedValueOnce(true);

    const result = await terminateTaskExecution("task-1");

    // The pod from the database, the run directory from the run's id (signalRun).
    expect(signalRun).toHaveBeenCalledWith("pod-9", "task-1", "TERM");
    // The supervisor took the signal: no env-based sweep of the pod.
    expect(killOrphanedAgentInPod).not.toHaveBeenCalled();
    expect(updateWorktreeState).toHaveBeenCalledWith("task-1", "preserved");
    expect(result).toEqual({ signalled: true, agentKilled: false });
  });

  it("falls back to the env-based kill when no live supervisor took the signal", async () => {
    vi.mocked(getTask).mockResolvedValueOnce({
      id: "task-5",
      lastPodId: "pod-9",
      execState: "started",
    } as any);
    signalRun.mockResolvedValueOnce(false);
    vi.mocked(killOrphanedAgentInPod).mockResolvedValueOnce(true);

    const result = await terminateTaskExecution("task-5");

    expect(killOrphanedAgentInPod).toHaveBeenCalledWith("pod-9", "task-5");
    expect(result).toEqual({ signalled: false, agentKilled: true });
  });

  it("skips the protocol kill for a run that was never started", async () => {
    vi.mocked(getTask).mockResolvedValueOnce({
      id: "task-2",
      lastPodId: "pod-9",
      execState: null,
    } as any);
    vi.mocked(killOrphanedAgentInPod).mockResolvedValueOnce(true);

    const result = await terminateTaskExecution("task-2");

    expect(signalRun).not.toHaveBeenCalled();
    expect(result).toEqual({ signalled: false, agentKilled: true });
  });

  it("does nothing in the pod when the task never had one", async () => {
    vi.mocked(getTask).mockResolvedValueOnce({ id: "task-3", lastPodId: null } as any);

    const result = await terminateTaskExecution("task-3");

    expect(signalRun).not.toHaveBeenCalled();
    expect(killOrphanedAgentInPod).not.toHaveBeenCalled();
    expect(result).toEqual({ signalled: false, agentKilled: false });
  });

  it("never throws: a failing kill is logged and reported as not killed", async () => {
    vi.mocked(getTask).mockRejectedValueOnce(new Error("db down"));

    await expect(terminateTaskExecution("task-4")).resolves.toEqual({
      signalled: false,
      agentKilled: false,
    });
  });
});
