/**
 * Sync worker for marketplace-sourced skills (`installed_skills`).
 *
 * Two job types:
 *   - "sync-one"  { id }  → on-demand, fired by POST /api/installed-skills/:id/sync
 *   - "sync-due"  {}      → periodic; finds rows never synced, or whose files at
 *                          their resolved_sha are not in the database
 *
 * For each row, the worker:
 *   1. Resolves `ref` → SHA via `git ls-remote` (cheap, no clone).
 *   2. If the row already carries that SHA and its files are in the database,
 *      there is nothing to do.
 *   3. Otherwise shallow-clones into a scratch directory, walks
 *      `<clone>/<subpath>/`, parses SKILL.md frontmatter, sums file sizes,
 *      flags executable files, and writes the manifest **and every file** to
 *      the database (`installed_skill_files`) in one transaction.
 *
 * The files live in Postgres, not on a volume: a run spawned on any API
 * instance reads them (`readInstalledSkillFiles`), whichever instance did
 * the sync. The scratch directory (`OPTIO_SKILLS_SCRATCH_DIR`, default
 * `<tmpdir>/optio-skills`) is only ever a clone in flight; the API container's
 * root filesystem is read-only, so it is under /tmp.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import type { InstalledSkillManifest } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { db } from "../db/client.js";
import { installedSkillFiles, installedSkills } from "../db/schema.js";
import { and, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { recordSyncResult, type SyncedSkillFile } from "../services/installed-skill-service.js";

const execFileP = promisify(execFile);
const bullmqOpts = getBullMQOptions();

export const skillSyncQueue = new Queue("skill-sync", { ...bullmqOpts });

function scratchDir(): string {
  return process.env.OPTIO_SKILLS_SCRATCH_DIR ?? path.join(tmpdir(), "optio-skills");
}
const CLONE_TIMEOUT_MS = parseIntEnv("OPTIO_SKILL_CLONE_TIMEOUT_MS", 60_000);
const SYNC_INTERVAL_MS = parseIntEnv("OPTIO_SKILL_SYNC_INTERVAL", 300_000); // 5 min
/** Hard cap per skill — anything bigger is rejected to keep OPTIO_SETUP_FILES sane. */
const MAX_SKILL_BYTES = parseIntEnv("OPTIO_SKILL_MAX_BYTES", 1_048_576); // 1 MiB

export function startSkillSyncWorker() {
  // Periodic sweep for rows that need a sync.
  skillSyncQueue.add(
    "sync-due",
    {},
    {
      repeat: { every: SYNC_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );

  const worker = new Worker(
    "skill-sync",
    async (job) => {
      if (job.name === "sync-due") {
        await syncDue();
      } else if (job.name === "sync-one") {
        const { id } = job.data as { id: string };
        await syncOne(id);
      }
    },
    { ...bullmqOpts, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobName: job?.name, jobId: job?.id }, "skill-sync job failed");
  });

  return worker;
}

/**
 * The rows that need a sync: never synced, or synced at a commit whose files
 * are not in the database (a skill synced to the former cache volume before
 * the upgrade, or a write that never landed).
 */
export async function dueSkillIds(): Promise<string[]> {
  const rows = await db
    .select({ id: installedSkills.id })
    .from(installedSkills)
    .where(
      or(
        isNull(installedSkills.resolvedSha),
        eq(installedSkills.lastSyncError, ""),
        and(
          eq(installedSkills.enabled, true),
          isNotNull(installedSkills.resolvedSha),
          notExists(
            db
              .select({ one: sql`1` })
              .from(installedSkillFiles)
              .where(
                and(
                  eq(installedSkillFiles.skillId, installedSkills.id),
                  eq(installedSkillFiles.resolvedSha, installedSkills.resolvedSha),
                ),
              ),
          ),
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/** Find all rows that need syncing and enqueue a sync-one for each. */
async function syncDue(): Promise<void> {
  for (const id of await dueSkillIds()) {
    await skillSyncQueue.add("sync-one", { id }, { removeOnComplete: true });
  }
}

/** Whether the skill's files for `sha` are already in the database. */
async function filesSynced(skillId: string, sha: string): Promise<boolean> {
  const [row] = await db
    .select({ path: installedSkillFiles.path })
    .from(installedSkillFiles)
    .where(and(eq(installedSkillFiles.skillId, skillId), eq(installedSkillFiles.resolvedSha, sha)))
    .limit(1);
  return !!row;
}

export async function syncOne(id: string): Promise<void> {
  const log = logger.child({ skillId: id });
  const [row] = await db.select().from(installedSkills).where(eq(installedSkills.id, id));
  if (!row) {
    log.warn("skill row vanished before sync");
    return;
  }
  if (!row.enabled) {
    log.info("skill disabled; skipping sync");
    return;
  }

  let clone: string | null = null;
  try {
    const sha = await resolveRefToSha(row.sourceUrl, row.ref);
    if (row.resolvedSha === sha && !row.lastSyncError && (await filesSynced(id, sha))) {
      log.info({ sha }, "already synced at this commit; nothing to do");
      return;
    }

    clone = await cloneIntoScratch(row.sourceUrl, sha, log);
    const subpathDir = path.join(clone, row.subpath === "." ? "" : row.subpath);
    if (!(await pathExists(subpathDir))) {
      throw new Error(`subpath '${row.subpath}' not found in source@${sha}`);
    }

    const inspected = await inspectSkillDir(subpathDir);
    if (inspected.totalSizeBytes > MAX_SKILL_BYTES) {
      throw new Error(
        `skill exceeds ${MAX_SKILL_BYTES} byte cap (got ${inspected.totalSizeBytes})`,
      );
    }
    const files = await collectSkillFiles(subpathDir);

    await recordSyncResult(id, {
      ok: true,
      resolvedSha: sha,
      manifest: inspected.manifest,
      hasExecutableFiles: inspected.hasExecutableFiles,
      totalSizeBytes: inspected.totalSizeBytes,
      files,
    });
    log.info(
      { sha, fileCount: files.length, bytes: inspected.totalSizeBytes },
      "installed skill synced",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "installed skill sync failed");
    await recordSyncResult(id, { ok: false, error: msg });
  } finally {
    if (clone) await fs.rm(path.dirname(clone), { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveRefToSha(sourceUrl: string, ref: string): Promise<string> {
  // ls-remote returns "<sha>\trefs/heads/<branch>" lines. We try the requested
  // ref directly and fall back to bare HEAD if the ref doesn't exist.
  const { stdout } = await execFileP("git", ["ls-remote", sourceUrl, ref, `refs/tags/${ref}`], {
    timeout: CLONE_TIMEOUT_MS,
  });
  const line = stdout.trim().split("\n")[0];
  if (line) {
    const sha = line.split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  // Fallback: ls-remote with no ref returns HEAD.
  const head = await execFileP("git", ["ls-remote", sourceUrl, "HEAD"], {
    timeout: CLONE_TIMEOUT_MS,
  });
  const headSha = head.stdout.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`could not resolve ref '${ref}' for ${sourceUrl}`);
  }
  return headSha;
}

/**
 * A shallow clone of the source at `sha` in a fresh scratch directory.
 * Resolves the clone's path; the caller removes its parent when done.
 */
async function cloneIntoScratch(
  sourceUrl: string,
  sha: string,
  log: { info: (...args: unknown[]) => void },
): Promise<string> {
  await fs.mkdir(scratchDir(), { recursive: true });
  const tmpRoot = await fs.mkdtemp(path.join(scratchDir(), "skill-"));
  const tmpClone = path.join(tmpRoot, "clone");
  log.info({ sourceUrl, sha }, "shallow-cloning skill source");
  // Clone with depth=1 then check out the exact SHA.
  await execFileP("git", ["clone", "--depth", "1", "--no-tags", sourceUrl, tmpClone], {
    timeout: CLONE_TIMEOUT_MS,
  });
  // Best-effort: fetch + checkout the exact SHA in case the default ref isn't
  // what we resolved (e.g. tag vs branch).
  try {
    await execFileP("git", ["-C", tmpClone, "fetch", "--depth", "1", "origin", sha], {
      timeout: CLONE_TIMEOUT_MS,
    });
    await execFileP("git", ["-C", tmpClone, "checkout", "--detach", sha], {
      timeout: CLONE_TIMEOUT_MS,
    });
  } catch {
    // If fetch-by-sha is unsupported (older servers) the depth-1 clone of
    // the resolved branch should already be at the right SHA.
  }
  // The files, not the history.
  await fs.rm(path.join(tmpClone, ".git"), { recursive: true, force: true });
  return tmpClone;
}

interface InspectionResult {
  manifest: InstalledSkillManifest;
  hasExecutableFiles: boolean;
  totalSizeBytes: number;
}

/** The skill directory's manifest: every file with its size and mode, and SKILL.md's frontmatter. */
export async function inspectSkillDir(dir: string): Promise<InspectionResult> {
  const files: NonNullable<InstalledSkillManifest["files"]> = [];
  let hasExecutableFiles = false;
  let totalSizeBytes = 0;

  async function walk(current: string, rel: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, relPath);
      } else if (ent.isFile()) {
        const stat = await fs.stat(full);
        const executable = (stat.mode & 0o111) !== 0;
        if (executable) hasExecutableFiles = true;
        totalSizeBytes += stat.size;
        files.push({ relativePath: relPath, sizeBytes: stat.size, executable });
      }
    }
  }
  await walk(dir, "");

  let frontmatter: Record<string, unknown> | undefined;
  const skillMd = files.find((f) => f.relativePath.toLowerCase() === "skill.md");
  if (skillMd) {
    try {
      const content = await fs.readFile(path.join(dir, skillMd.relativePath), "utf8");
      frontmatter = parseFrontmatter(content);
    } catch {
      // non-fatal — manifest is best-effort
    }
  }

  return {
    manifest: { frontmatter, files },
    hasExecutableFiles,
    totalSizeBytes,
  };
}

/** Every file under `dir`, with its bytes and executable bit, paths relative to `dir`. */
export async function collectSkillFiles(dir: string): Promise<SyncedSkillFile[]> {
  const out: SyncedSkillFile[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, relPath);
      } else if (ent.isFile()) {
        const stat = await fs.stat(full);
        out.push({
          relativePath: relPath,
          content: await fs.readFile(full),
          executable: (stat.mode & 0o111) !== 0,
        });
      }
    }
  }
  await walk(dir, "");
  return out;
}

/**
 * Tiny YAML-frontmatter parser. Handles `key: value` lines (string values)
 * and ignores anything more complex. Good enough for SKILL.md surfaces like
 * `name`, `description`, `version`. Returns undefined when no frontmatter
 * block is present.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!match) return undefined;
  const out: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    let value: string = m[2];
    // Strip a single layer of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The materialized files of an installed skill, from the database, for the
 * worker injecting the skill into a run's worktree at spawn time — on any
 * instance, whichever one synced it. With `expectedSha`, files from another
 * commit (a sync in flight) are refused rather than injected half-updated.
 */
export async function readInstalledSkillFiles(
  skillId: string,
  expectedSha?: string | null,
): Promise<Array<{ relativePath: string; content: Buffer; executable: boolean }>> {
  const rows = await db
    .select({
      path: installedSkillFiles.path,
      content: installedSkillFiles.content,
      executable: installedSkillFiles.executable,
      resolvedSha: installedSkillFiles.resolvedSha,
    })
    .from(installedSkillFiles)
    .where(eq(installedSkillFiles.skillId, skillId))
    .orderBy(installedSkillFiles.path);
  if (rows.length === 0) {
    throw new Error(`no synced files for installed skill ${skillId}`);
  }
  if (expectedSha) {
    const other = rows.find((r) => r.resolvedSha && r.resolvedSha !== expectedSha);
    if (other) {
      throw new Error(
        `installed skill ${skillId} files are at ${other.resolvedSha}, expected ${expectedSha}`,
      );
    }
  }
  return rows.map((r) => ({
    relativePath: r.path,
    content: Buffer.from(r.content),
    executable: r.executable,
  }));
}
