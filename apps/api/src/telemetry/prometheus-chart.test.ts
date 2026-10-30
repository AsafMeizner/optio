import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const args = [
  "template",
  "metrics",
  "helm/optio",
  "--kube-version",
  "1.35.0",
  "--set",
  "postgresql.auth.password=fixture-not-a-real-password",
  "--set",
  "encryption.key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "--set",
  "publicUrl=https://optio.example.test",
];
function render(...settings: string[]) {
  const text = execFileSync("helm", [...args, ...settings.flatMap((s) => ["--set", s])], {
    cwd: root,
    encoding: "utf8",
  });
  return parseAllDocuments(text).map((d) => {
    expect(d.errors).toEqual([]);
    return d.toJSON();
  });
}

const hasHelm = spawnSync("helm", ["version", "--short"]).status === 0;

describe.skipIf(!hasHelm)("Prometheus chart", () => {
  it("renders no metrics listener or monitoring resources by default", () => {
    const docs = render();
    expect(
      docs.some((d) => /api-metrics|grafana-dashboard|metrics-policy/.test(d.metadata.name)),
    ).toBe(false);
    const api = docs.find((d) => d.kind === "Deployment" && d.metadata.name === "metrics-api");
    expect(
      api.spec.template.spec.containers[0].env.some(
        (e: { name: string }) => e.name === "OPTIO_METRICS_PORT",
      ),
    ).toBe(false);
  });

  it("requires an explicit monitoring audience", () => {
    const result = spawnSync("helm", [...args, "--set", "metrics.enabled=true"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("metrics.networkPolicy.namespaces");
  });

  it("restricts metrics independently of the agent policy and binds monitoring to the service", () => {
    const docs = render(
      "metrics.enabled=true",
      "metrics.networkPolicy.namespaces[0]=monitoring",
      "metrics.serviceMonitor.enabled=true",
      "metrics.prometheusRule.enabled=true",
    );
    const policy = docs.find(
      (d) => d.kind === "NetworkPolicy" && d.metadata.name === "metrics-api-metrics-policy",
    );
    expect(policy.spec.ingress[1].from).toContainEqual({
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } },
    });
    expect(policy.spec.ingress[1].ports).toEqual([{ protocol: "TCP", port: 9464 }]);
    expect(docs.find((d) => d.kind === "ServiceMonitor").spec.endpoints[0]).toMatchObject({
      port: "metrics",
      path: "/metrics",
    });
    expect(
      docs
        .find((d) => d.kind === "PrometheusRule")
        .spec.groups[0].rules.map((r: { alert: string }) => r.alert),
    ).toEqual(["OptioDown", "OptioQueueGrowing", "OptioTaskFailureRate"]);
  });

  it("renders a parseable dashboard in the explicitly chosen namespace", () => {
    const docs = render(
      "metrics.enabled=true",
      "metrics.networkPolicy.namespaces[0]=monitoring",
      "metrics.grafanaDashboard.enabled=true",
      'metrics.prometheusRule.job=custom"job',
      "metrics.grafanaDashboard.namespace=cattle-dashboards",
    );
    const config = docs.find(
      (d) => d.kind === "ConfigMap" && d.metadata.name === "metrics-grafana-dashboard",
    );
    expect(config.metadata.namespace).toBe("cattle-dashboards");
    const dashboard = JSON.parse(Object.values(config.data)[0] as string);
    expect(dashboard.panels).toHaveLength(6);
    expect(dashboard.templating.list.find((v: { name: string }) => v.name === "job").query).toBe(
      'custom"job',
    );
    expect(
      dashboard.templating.list.find((v: { name: string }) => v.name === "namespace").query,
    ).toBe("optio");
  });
});
