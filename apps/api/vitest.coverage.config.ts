import { defineConfig } from "vitest/config";
import unit from "./vitest.config.js";
import integration from "./vitest.integration.config.js";

/**
 * Measure the same API source across both testing tiers. Unit tests isolate
 * external services; integration tests exercise their database/Redis behavior.
 * Neither tier alone represents the API's tested coverage. Keep one source of
 * truth for the file set and thresholds in vitest.config.ts.
 */
const { coverage, ...unitTest } = unit.test!;
export default defineConfig({
  test: {
    maxWorkers: 4,
    coverage: { ...coverage, enabled: true },
    projects: [
      { test: { ...unitTest, name: "unit" } },
      { test: { ...integration.test, name: "integration" } },
    ],
  },
});
