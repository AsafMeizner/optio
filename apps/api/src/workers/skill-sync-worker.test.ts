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

const leaseFree = { value: true };
vi.mock("../services/poller-lease.js", () => ({
  underPollerLease: async (_name: string, fn: () => Promise<unknown>) =>
    leaseFree.value ? fn() : null,
}));

import {
  SKILL_SYNC_JOB_OPTIONS,
  SkillSyncBusyError,
  parseFrontmatter,
  processSkillSyncJob,
  readSkillDir,
} from "./skill-sync-worker.js";

describe("sync-one under another instance's lease", () => {
  it("throws a retryable busy error instead of dropping the sync", async () => {
    leaseFree.value = false;
    try {
      await expect(
        processSkillSyncJob({ name: "sync-one", data: { id: "skill-1" } }),
      ).rejects.toBeInstanceOf(SkillSyncBusyError);
    } finally {
      leaseFree.value = true;
    }
  });

  it("every job on the queue retries with exponential backoff", () => {
    expect(SKILL_SYNC_JOB_OPTIONS.attempts).toBeGreaterThan(1);
    expect(SKILL_SYNC_JOB_OPTIONS.backoff.type).toBe("exponential");
  });
});

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

  it("reads every file once: bytes, executable flag, manifest, frontmatter", async () => {
    const read = await readSkillDir(baseDir);
    const byPath = Object.fromEntries(read.files.map((f) => [f.relativePath, f]));
    expect(Object.keys(byPath).sort()).toEqual(["SKILL.md", "reference.md", "scripts/helper.sh"]);
    expect(byPath["scripts/helper.sh"].executable).toBe(true);
    expect(byPath["SKILL.md"].executable).toBe(false);
    expect(byPath["SKILL.md"].content.toString("utf8")).toMatch(/^---/);
    expect(read.hasExecutableFiles).toBe(true);
    expect(read.totalSizeBytes).toBe(read.files.reduce((n, f) => n + f.content.length, 0));
    expect(read.manifest.frontmatter).toEqual({ name: "test" });
    expect(read.manifest.files?.map((f) => f.relativePath).sort()).toEqual([
      "SKILL.md",
      "reference.md",
      "scripts/helper.sh",
    ]);
  });

  it("reads a subpath on its own", async () => {
    const read = await readSkillDir(path.join(baseDir, "scripts"));
    expect(read.files.map((f) => f.relativePath)).toEqual(["helper.sh"]);
    expect(read.manifest.frontmatter).toBeUndefined();
  });

  it("stops at the size cap", async () => {
    await expect(readSkillDir(baseDir, 5)).rejects.toThrow(/exceeds 5 byte cap/);
  });

  it("leaves out a root file named like the sync sentinel, and reads an empty skill", async () => {
    const dir = path.join(baseDir, "..", `optio-skill-sentinel-${Date.now()}`);
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, ".optio-synced"), "not ours");
    await fs.writeFile(path.join(dir, "nested", ".optio-synced"), "fine here");
    try {
      const read = await readSkillDir(dir);
      expect(read.files.map((f) => f.relativePath)).toEqual(["nested/.optio-synced"]);
      await fs.rm(path.join(dir, "nested"), { recursive: true });
      await fs.rm(path.join(dir, ".optio-synced"));
      const empty = await readSkillDir(dir);
      expect(empty.files).toEqual([]);
      expect(empty.totalSizeBytes).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
