import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { initTelemetry, registerMetricCallbacks, shutdownTelemetry } from "../telemetry.js";
import { recordTaskComplete } from "./metrics.js";

afterEach(async () => {
  await shutdownTelemetry();
  metrics.disable();
  vi.unstubAllEnvs();
});

it("serves existing counters and live callbacks without an OTLP collector", async () => {
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  vi.stubEnv("OPTIO_OTEL_ENABLED", "false");
  vi.stubEnv("OPTIO_METRICS_PORT", String(port));
  await initTelemetry();
  await registerMetricCallbacks({
    queueDepth: ({ state }) => (state === "queued" ? 7 : 0),
    activeTasks: () => 2,
    podCount: () => 1,
  });
  recordTaskComplete({ state: "completed" });
  await vi.waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/optio_queue_depth\{state="queued"\} 7/);
    expect(text).toMatch(/optio_active_tasks 2/);
    expect(text).toMatch(/optio_tasks_total\{state="completed"\} 1/);
  });
});
