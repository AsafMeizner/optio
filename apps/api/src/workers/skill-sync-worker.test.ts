import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Stub BullMQ so importing the module doesn't try to talk to Redis.
vi.mock("bullmq", () => ({
  Queue: class {
    add() {
      return Promise.resolve();
    }
  },
  Worker: class {
    on() {}
    close() {
      return Promise.resolve();
    }
  },
}));
vi.mock("../services/redis-config.js", () => ({
  getBullMQConnectionOptions: () => ({ url: "redis://localhost:6379", maxRetriesPerRequest: null }),
  getBullMQOptions: () => ({
    connection: { url: "redis://localhost:6379", maxRetriesPerRequest: null },
    prefix: "bull",
  }),
}));
vi.mock("../db/client.js", () => ({ db: {} }));

import { collectSkillFiles, inspectSkillDir, parseFrontmatter } from "./skill-sync-worker.js";

describe("a cloned skill directory", () => {
  const baseDir = path.join(tmpdir(), `optio-skill-test-${Date.now()}`);

  beforeAll(async () => {
    await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "SKILL.md"), "---\nname: test\n---\n\nbody", "utf8");
    await fs.writeFile(path.join(baseDir, "reference.md"), "ref", "utf8");
    const helper = path.join(baseDir, "scripts", "helper.sh");
    await fs.writeFile(helper, "#!/bin/sh\necho hi", "utf8");
    await fs.chmod(helper, 0o755);
  });

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("collects each file with its bytes and executable flag", async () => {
    const files = await collectSkillFiles(baseDir);
    const byPath = Object.fromEntries(files.map((f) => [f.relativePath, f]));
    expect(Object.keys(byPath).sort()).toEqual(["SKILL.md", "reference.md", "scripts/helper.sh"]);
    expect(byPath["scripts/helper.sh"].executable).toBe(true);
    expect(byPath["SKILL.md"].executable).toBe(false);
    expect(byPath["SKILL.md"].content.toString("utf8")).toMatch(/^---/);
  });

  it("inspects the manifest: sizes, the executable bit, SKILL.md frontmatter", async () => {
    const inspected = await inspectSkillDir(baseDir);
    expect(inspected.hasExecutableFiles).toBe(true);
    expect(inspected.totalSizeBytes).toBeGreaterThan(0);
    expect(inspected.manifest.frontmatter).toEqual({ name: "test" });
    expect(inspected.manifest.files?.map((f) => f.relativePath).sort()).toEqual([
      "SKILL.md",
      "reference.md",
      "scripts/helper.sh",
    ]);
  });

  it("collects a subpath on its own", async () => {
    const files = await collectSkillFiles(path.join(baseDir, "scripts"));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("helper.sh");
  });
});

describe("parseFrontmatter", () => {
  it("reads key: value lines and strips one layer of quotes", () => {
    expect(parseFrontmatter("---\nname: \"a b\"\nversion: '1'\n---\nbody")).toEqual({
      name: "a b",
      version: "1",
    });
  });
  it("is undefined without a block", () => {
    expect(parseFrontmatter("# no frontmatter")).toBeUndefined();
  });
});
