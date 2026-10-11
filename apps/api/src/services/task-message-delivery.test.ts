/**
 * A mid-run message to a task's agent: appended to its stdin from any
 * instance, or — when the agent's stdin is already closed (its turn is
 * over) — refused and marked with a delivery error instead of delivered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunStdinClosedError } from "@optio/container-runtime";

const mockDeliverStdin = vi.fn();
const mockGetPod = vi.fn();
const mockMarkDelivered = vi.fn();
const mockMarkDeliveryError = vi.fn();
const mockPublish = vi.fn();

vi.mock("./container-service.js", () => ({
  getRuntime: () => ({ deliverStdin: (...a: unknown[]) => mockDeliverStdin(...a) }),
}));
vi.mock("./agent-pod-pool.js", () => ({
  getPod: (...a: unknown[]) => mockGetPod(...a),
  podHandle: (pod: { podName: string }) => ({ id: pod.podName, name: pod.podName }),
}));
vi.mock("./task-message-service.js", () => ({
  markDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markDeliveryError: (...a: unknown[]) => mockMarkDeliveryError(...a),
}));
vi.mock("./event-bus.js", () => ({ publishEvent: (...a: unknown[]) => mockPublish(...a) }));
vi.mock("../logger.js", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: () => log } };
});

import { TURN_OVER_ERROR, deliverTaskMessage } from "./task-message-delivery.js";

const task = {
  id: "task-1",
  execState: "started" as const,
  lastPodId: "pod-1",
  runTarget: "cluster",
};
const message = { messageId: "msg-1", content: "hello", mode: "soft" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPod.mockResolvedValue({ id: "pod-1", podName: "pod-1" });
  mockMarkDelivered.mockResolvedValue(undefined);
  mockMarkDeliveryError.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
});

describe("deliverTaskMessage", () => {
  it("appends the message to the agent's stdin and marks it delivered", async () => {
    mockDeliverStdin.mockResolvedValue(undefined);
    expect(await deliverTaskMessage(task as never, message)).toBe(true);
    expect(mockDeliverStdin).toHaveBeenCalledWith(
      { id: "pod-1", name: "pod-1" },
      expect.objectContaining({ runId: "task-1", runDir: "/home/agent/optio/runs/task-1" }),
    );
    expect(mockMarkDelivered).toHaveBeenCalledWith("msg-1");
    expect(mockMarkDeliveryError).not.toHaveBeenCalled();
  });

  it("after the agent's turn ended (stdin closed), marks a delivery error instead of delivered", async () => {
    mockDeliverStdin.mockRejectedValue(new RunStdinClosedError("/home/agent/optio/runs/task-1"));
    expect(await deliverTaskMessage(task as never, message)).toBe(false);
    expect(mockMarkDelivered).not.toHaveBeenCalled();
    expect(mockMarkDeliveryError).toHaveBeenCalledWith("msg-1", TURN_OVER_ERROR);
    expect(TURN_OVER_ERROR).toMatch(/already finished its turn/);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("a task with no started agent gets a delivery error, nothing appended", async () => {
    expect(await deliverTaskMessage({ ...task, execState: null } as never, message)).toBe(false);
    expect(mockDeliverStdin).not.toHaveBeenCalled();
    expect(mockMarkDeliveryError).toHaveBeenCalledWith(
      "msg-1",
      expect.stringContaining("not running"),
    );
  });
});
