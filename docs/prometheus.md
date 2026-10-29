# Prometheus monitoring

Metrics are off by default. Set OPTIO_METRICS_PORT=9464 to expose the existing task, queue, pod, worker and webhook instruments at /metrics on a separate listener. This works without an OTLP collector. When OPTIO_OTEL_ENABLED=true, the listener and the existing OTLP exporter receive the same metrics.

The Helm chart keeps this listener off the public ingress. Enable metrics.enabled and explicitly configure metrics.networkPolicy.namespaces (the namespace running Prometheus) or metrics.networkPolicy.from. The chart creates a dedicated ClusterIP Service and an ingress NetworkPolicy for that port, independently of the chart's optional agent egress policy. A CNI enforcing NetworkPolicy is required. Disable metrics.networkPolicy.enabled only when equivalent access controls already exist. Metrics cover the deployment and may contain existing repository labels: restrict access to monitoring operators.

With the Prometheus Operator CRDs installed, enable metrics.serviceMonitor.enabled. Add the labels required by your Prometheus serviceMonitorSelector. Enable metrics.prometheusRule.enabled for availability, queued-work and task-failure alerts. If another scrape configuration is used, set metrics.prometheusRule.job to its actual job label. Thresholds, alert labels and additional rules are configurable.

Enable metrics.grafanaDashboard.enabled to create a dashboard ConfigMap. Set its namespace to the namespace watched by your Grafana sidecar (cattle-dashboards for Rancher Monitoring) and configure its labels as needed. The dashboard uses the release namespace and metrics job, with a selectable Prometheus data source. It includes task/queue/pod activity, task duration and webhook deliveries.

Run helm test <release> --namespace <namespace> to verify the real metrics endpoint from the explicitly permitted test pod.
