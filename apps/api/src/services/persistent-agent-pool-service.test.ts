import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  status: vi.fn(),
  insertPod: vi.fn(),
  markPodReady: vi.fn(),
  markPodError: vi.fn(),
  deletePod: vi.fn(),
  provisioningAbandoned: vi.fn(),
  waitForProvisioning: vi.fn(),
  podHandle: (pod: { podId: string | null; podName: string }) => ({
    id: pod.podId ?? pod.podName,
    name: pod.podName,
  }),
  where: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: mocks.where,
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
}));
vi.mock("./container-service.js", () => ({ getRuntime: () => mocks }));
vi.mock("./agent-pod-pool.js", () => mocks);
vi.mock("./repo-pool-service.js", () => ({ resolveImage: () => "optio-agent:latest" }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("./pod-isolation.js", () => ({
  podIsolationKey: () => "boundary",
  workCredentialProfile: () => null,
}));

import { acquirePodForAgent } from "./persistent-agent-pool-service.js";

describe("persistent agent node placement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.where.mockResolvedValue([
      { id: "agent-1", slug: "agent", podLifecycle: "on-demand", agentRuntime: "claude-code" },
    ]);
    mocks.insertPod.mockResolvedValue({ id: "pod-1" });
    mocks.create.mockResolvedValue({ id: "runtime-id", name: "agent-pod" });
    mocks.markPodReady.mockResolvedValue({
      id: "pod-1",
      poolKey: "agent-1",
      podName: "agent-pod",
      state: "ready",
    });
    vi.stubEnv("OPTIO_AGENT_NODE_SELECTOR", JSON.stringify({ workload: "agent" }));
    vi.stubEnv(
      "OPTIO_AGENT_TOLERATIONS",
      JSON.stringify([{ key: "agent", operator: "Exists", effect: "NoSchedule" }]),
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes placement to the pod spec", async () => {
    await acquirePodForAgent("agent-1");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSelector: { workload: "agent" },
        tolerations: [{ key: "agent", operator: "Exists", effect: "NoSchedule" }],
      }),
    );
  });

  it("omits placement when unset", async () => {
    vi.stubEnv("OPTIO_AGENT_NODE_SELECTOR", undefined);
    vi.stubEnv("OPTIO_AGENT_TOLERATIONS", undefined);
    await acquirePodForAgent("agent-1");
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("nodeSelector");
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("tolerations");
  });

  it.each(["OPTIO_AGENT_NODE_SELECTOR", "OPTIO_AGENT_TOLERATIONS"])(
    "rejects malformed %s before creating a pod",
    async (name) => {
      vi.stubEnv(name, "{invalid");
      await expect(acquirePodForAgent("agent-1")).rejects.toThrow(`Invalid JSON in ${name}`);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.markPodError).toHaveBeenCalledWith("pod-1", expect.any(Error));
    },
  );
});

describe("an agent pod its creator abandoned mid-creation", () => {
  const agent = {
    id: "agent-1",
    slug: "agent",
    podLifecycle: "sticky",
    agentRuntime: "claude-code",
  };
  const provisioning = {
    id: "stuck-pod",
    state: "provisioning",
    podName: null,
    podId: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The agent, then its current pod (`currentPod`'s select … orderBy … limit).
    mocks.where
      .mockResolvedValueOnce([agent])
      .mockReturnValueOnce({ orderBy: () => ({ limit: async () => [provisioning] }) });
    mocks.insertPod.mockResolvedValue({ id: "pod-2" });
    mocks.create.mockResolvedValue({ id: "runtime-id", name: "agent-pod" });
    mocks.markPodReady.mockResolvedValue({
      id: "pod-2",
      poolKey: "agent-1",
      podName: "agent-pod",
      podId: "runtime-id",
      state: "ready",
    });
  });

  it("is not waited on once abandoned: the row goes and a new pod is made", async () => {
    mocks.provisioningAbandoned.mockReturnValue(true);
    const handle = await acquirePodForAgent("agent-1");
    expect(mocks.waitForProvisioning).not.toHaveBeenCalled();
    expect(mocks.deletePod).toHaveBeenCalledWith("stuck-pod");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(handle.podName).toBe("agent-pod");
  });

  it("is waited on while its creator may be alive, then taken over once abandoned", async () => {
    mocks.provisioningAbandoned.mockReturnValue(false);
    mocks.waitForProvisioning.mockResolvedValueOnce(null);
    await acquirePodForAgent("agent-1");
    expect(mocks.waitForProvisioning).toHaveBeenCalledWith(provisioning, 120_000);
    expect(mocks.deletePod).toHaveBeenCalledWith("stuck-pod");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("a creator that finishes in time hands its pod over", async () => {
    mocks.provisioningAbandoned.mockReturnValue(false);
    mocks.waitForProvisioning.mockResolvedValueOnce({
      id: "stuck-pod",
      state: "ready",
      podName: "finished",
      podId: "rt",
      poolKey: "agent-1",
    });
    const handle = await acquirePodForAgent("agent-1");
    expect(handle.podName).toBe("finished");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.deletePod).not.toHaveBeenCalled();
  });
});
