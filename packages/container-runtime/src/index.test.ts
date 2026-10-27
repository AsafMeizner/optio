import { describe, it, expect, vi } from "vitest";

vi.mock("./docker.js", () => ({
  DockerContainerRuntime: vi.fn().mockImplementation(function (opts: any) {
    return { _type: "docker", _opts: opts };
  }),
}));

vi.mock("./kubernetes.js", () => ({
  KubernetesContainerRuntime: vi.fn().mockImplementation(function (namespace: any) {
    return { _type: "kubernetes", _namespace: namespace };
  }),
}));

import { createRuntime } from "./index.js";
import { DockerContainerRuntime } from "./docker.js";
import { KubernetesContainerRuntime } from "./kubernetes.js";

describe("createRuntime", () => {
  it("creates DockerContainerRuntime for type docker", () => {
    const rt = createRuntime({ type: "docker" });
    expect(DockerContainerRuntime).toHaveBeenCalledWith(undefined);
    expect((rt as any)._type).toBe("docker");
  });

  it("passes docker options to DockerContainerRuntime", () => {
    const opts = { host: "tcp://localhost", port: 2375 };
    createRuntime({ type: "docker", docker: opts });
    expect(DockerContainerRuntime).toHaveBeenCalledWith(opts);
  });

  it("creates KubernetesContainerRuntime for type kubernetes", () => {
    const rt = createRuntime({ type: "kubernetes" });
    expect(KubernetesContainerRuntime).toHaveBeenCalledWith(undefined);
    expect((rt as any)._type).toBe("kubernetes");
  });

  it("passes namespace to KubernetesContainerRuntime", () => {
    createRuntime({ type: "kubernetes", kubernetes: { namespace: "custom-ns" } });
    expect(KubernetesContainerRuntime).toHaveBeenCalledWith("custom-ns");
  });

  it("throws for unknown runtime type", () => {
    expect(() => createRuntime({ type: "podman" as any })).toThrow("Unknown runtime type: podman");
  });
});
