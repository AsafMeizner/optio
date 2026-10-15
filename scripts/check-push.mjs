#!/usr/bin/env node
// Run long checks before opening Git's remote connection. The hook only verifies
// the receipt, so an idle SSH timeout cannot discard a successful eight-minute run.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const receiptPath = (root) =>
  resolve(root, git(root, "rev-parse", "--git-path", "optio-push-check.json"));

export function snapshot(root) {
  const hash = createHash("sha256");
  hash.update(`${process.platform}\0${process.arch}\0${process.version}\0`);
  const files = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const file of files) {
    hash.update(`${file}\0`);
    try {
      const path = resolve(root, file);
      const stat = lstatSync(path);
      hash.update(`${stat.mode}\0`);
      hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("missing");
    }
    hash.update("\0");
  }
  return { head: git(root, "rev-parse", "HEAD"), files: hash.digest("hex") };
}

const same = (a, b) => a?.head === b.head && a?.files === b.files;

export function verify(root) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath(root), "utf8"));
  } catch {
    throw new Error("No successful push checks. Run pnpm check:push, then git push.");
  }
  if (!same(receipt, snapshot(root))) {
    throw new Error(
      "Commit, files, or Node environment changed since verification. Run pnpm check:push again.",
    );
  }
}

export function verifyUpdates(root, input) {
  verify(root);
  const head = git(root, "rev-parse", "HEAD");
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const [, sha] = line.split(/\s+/);
    if (/^0+$/.test(sha)) continue; // deleting a remote ref
    if (git(root, "rev-parse", `${sha}^{commit}`) !== head) {
      throw new Error(
        "Push includes a commit other than the verified checkout. Check out and verify that commit first.",
      );
    }
  }
}

export function runChecks(root, commands) {
  // A receipt validates committed work, not edits that happen to be left unstaged.
  git(root, "diff", "--quiet", "HEAD", "--");
  const before = snapshot(root);
  // Invalidate an older success before a recheck, including a failed recheck.
  writeFileSync(receiptPath(root), "{}\n");
  for (const [command, ...args] of commands) {
    console.log(`\nChecking: ${[command, ...args].join(" ")}`);
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `${command} failed (${result.signal ?? result.status}); push remains blocked.`,
      );
  }
  if (!same(before, snapshot(root)))
    throw new Error("Files changed during checks; commit the changes and rerun pnpm check:push.");
  writeFileSync(receiptPath(root), `${JSON.stringify(before)}\n`);
  console.log(`Push checks passed for ${before.head}. You can now git push.`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = git(process.cwd(), "rev-parse", "--show-toplevel");
    if (process.argv[2] === "--verify") verifyUpdates(root, readFileSync(0, "utf8"));
    else
      runChecks(root, [
        ["node", "--test", "scripts/check-push.test.mjs"],
        ["pnpm", "format:check"],
        ["pnpm", "turbo", "typecheck"],
        ["bash", "scripts/check-swift-types.sh"],
        ["bash", "scripts/check-kotlin-types.sh"],
        ["pnpm", "turbo", "test"],
        ["pnpm", "--filter", "@optio/web", "test:e2e"],
      ]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
