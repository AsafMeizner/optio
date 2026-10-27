import { BlockList, isIP } from "node:net";
import { describe, expect, it } from "vitest";
import { restrictedAgentNetworkPolicy } from "./agent-network-policy.js";

interface Peer {
  ipBlock?: { cidr: string; except?: string[] };
  namespaceSelector?: { matchLabels: Record<string, string> };
  podSelector?: { matchLabels: Record<string, string> };
}
interface Target {
  ip: string;
  namespace?: string;
  labels?: Record<string, string>;
  port: number;
  protocol?: string;
}

function inCidr(ip: string, cidr: string): boolean {
  const [network, bits] = cidr.split("/");
  if (isIP(ip) !== isIP(network)) return false;
  const block = new BlockList();
  const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
  block.addSubnet(network, Number(bits), family);
  return block.check(ip, family);
}

function allows(target: Target, deniedCidrs: string[] = []): boolean {
  const { egress } = restrictedAgentNetworkPolicy("repo-0", "optio", 4000, deniedCidrs).spec;
  return egress.some(
    (rule) =>
      rule.ports.some(
        (port) => port.port === target.port && port.protocol === (target.protocol ?? "TCP"),
      ) &&
      (rule.to as Peer[]).some((peer) => {
        if (peer.ipBlock)
          return (
            inCidr(target.ip, peer.ipBlock.cidr) &&
            !peer.ipBlock.except?.some((cidr) => inCidr(target.ip, cidr))
          );
        return (
          (!peer.namespaceSelector ||
            peer.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] ===
              target.namespace) &&
          (!peer.podSelector ||
            Object.entries(peer.podSelector.matchLabels).every(
              ([key, value]) => target.labels?.[key] === value,
            ))
        );
      }),
  );
}

describe("restricted agent egress", () => {
  it("keeps deployment-specific exclusions in the additive repo policy", () => {
    const denied = ["1.1.1.0/24", "2606:4700:4700::/48"];
    expect(allows({ ip: "1.1.1.1", port: 443 }, denied)).toBe(false);
    expect(allows({ ip: "2606:4700:4700::1111", port: 443 }, denied)).toBe(false);
    expect(allows({ ip: "8.8.8.8", port: 443 }, denied)).toBe(true);
    expect(allows({ ip: "1.1.1.1", port: 443 })).toBe(true);
  });
  it.each([null, {}, ["bad"], ["1.1.1.1/33"], ["::1/129"]])(
    "fails closed for invalid deployment exclusions %j",
    (denied) => {
      expect(() => restrictedAgentNetworkPolicy("repo-0", "optio", 4000, denied)).toThrow(
        "Invalid agent denied egress",
      );
    },
  );
  it.each([
    "169.254.169.254",
    "169.254.170.2",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "127.0.0.1",
    "fd00:ec2::254",
    "fe80::1",
    "::1",
  ])("blocks internal/metadata destination %s even on HTTPS", (ip) => {
    expect(allows({ ip, port: 443 })).toBe(false);
    expect(allows({ ip, port: 80 })).toBe(false);
  });
  it("allows public HTTPS, the API port and CoreDNS", () => {
    expect(allows({ ip: "1.1.1.1", port: 443 })).toBe(true);
    expect(allows({ ip: "2606:4700:4700::1111", port: 443 })).toBe(true);
    expect(
      allows({ ip: "10.0.0.2", namespace: "optio", labels: { app: "optio-api" }, port: 4000 }),
    ).toBe(true);
    expect(
      allows({
        ip: "10.0.0.3",
        namespace: "kube-system",
        labels: { "k8s-app": "kube-dns" },
        port: 53,
        protocol: "UDP",
      }),
    ).toBe(true);
  });
  it("never grants all namespace ports or arbitrary DNS/HTTPS destinations", () => {
    expect(
      allows({ ip: "10.0.0.2", namespace: "optio", labels: { app: "redis" }, port: 6379 }),
    ).toBe(false);
    expect(
      allows({ ip: "10.0.0.3", namespace: "optio", labels: { app: "postgres" }, port: 5432 }),
    ).toBe(false);
    expect(
      allows({ ip: "10.0.0.4", namespace: "optio", labels: { app: "other" }, port: 443 }),
    ).toBe(false);
    expect(
      allows({ ip: "10.0.0.5", namespace: "other", labels: { app: "optio-api" }, port: 4000 }),
    ).toBe(false);
    expect(allows({ ip: "10.0.0.3", namespace: "optio", port: 53, protocol: "UDP" })).toBe(false);
  });
});
