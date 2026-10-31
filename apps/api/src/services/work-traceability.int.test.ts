/**
 * What a run tells the git host about its work (work-traceability.ts), with
 * the people in Postgres: the requester (whoever made the work; nobody for
 * ticket work), the run's link, and the switches: nothing unless the repo is
 * listed in OPTIO_WORK_TRACEABILITY_REPOS, no email unless
 * OPTIO_WORK_TRACEABILITY_EMAIL=true, and OPTIO_COMMIT_TRAILERS=false leaving
 * the commit trailers out.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { localTraceabilityNote, workTraceability } from "./work-traceability.js";

const uniq = () => randomBytes(4).toString("hex");
const TRACED_GROUP = "https://gitlab.example.test/platform";
let workspaceId: string;
let userId: string;
const tracedRepo = () => `${TRACED_GROUP}/app-${uniq()}`;

beforeAll(async () => {
  workspaceId = (await insertWorkspace()).id;
  const [u] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: `trace-${uniq()}`,
      email: "grace@example.test",
      displayName: "Grace Hopper",
    })
    .returning();
  userId = u.id;
});

beforeEach(() => vi.stubEnv("OPTIO_WORK_TRACEABILITY_REPOS", `${TRACED_GROUP}/*`));
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await getRedisClient().quit();
});

describe("off unless the repo is listed", () => {
  it("adds nothing with no repos listed", async () => {
    vi.stubEnv("OPTIO_WORK_TRACEABILITY_REPOS", "");
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    const task = await insertTask({
      title: "Fix",
      repoUrl: tracedRepo(),
      ticketSource: "jira",
      ticketExternalId: "PLAT-9",
      createdBy: userId,
      ownerUserId: userId,
      workspaceId,
    });
    expect(await workTraceability(task)).toEqual({ promptVars: {}, env: {} });
    expect(await localTraceabilityNote(task)).toBe("");
  });

  it("adds nothing for a repo outside the list", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    const task = await insertTask({ title: "Fix", createdBy: userId, workspaceId });
    expect(task.repoUrl.startsWith(TRACED_GROUP)).toBe(false);
    expect(await workTraceability(task)).toEqual({ promptVars: {}, env: {} });
    expect(await localTraceabilityNote(task)).toBe("");
  });
});

describe("a listed repo", () => {
  it("Jira work: the key and the run, and no requester", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test/");
    const task = await insertTask({
      title: "Add a /health endpoint",
      repoUrl: tracedRepo(),
      ticketSource: "jira",
      ticketExternalId: "PLAT-1",
      metadata: { ticketUrl: "https://jira.example.test/browse/PLAT-1" },
      createdBy: userId,
      ownerUserId: userId,
      workspaceId,
    });
    const { promptVars, env } = await workTraceability(task);
    expect(promptVars.MR_TITLE).toBe("PLAT-1: Add a /health endpoint");
    expect(promptVars.JIRA_KEY).toBe("PLAT-1");
    expect(promptVars.MR_FOOTER).toContain(
      "Jira: [PLAT-1](https://jira.example.test/browse/PLAT-1)",
    );
    expect(promptVars.MR_FOOTER).not.toContain("Requested by");
    expect(env).toEqual({
      OPTIO_JIRA_KEY: "PLAT-1",
      OPTIO_RUN_URL: `https://optio.example.test/work/${task.id}`,
    });
  });

  it("other work: names whoever made it, without their email", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    const task = await insertTask({
      title: "Refactor",
      repoUrl: tracedRepo(),
      createdBy: userId,
      workspaceId,
    });
    const { promptVars, env } = await workTraceability(task);
    expect(promptVars.MR_TITLE).toBe("Refactor");
    expect(promptVars.JIRA_KEY).toBe("");
    expect(promptVars.MR_FOOTER).toContain("Requested by: Grace Hopper");
    expect(JSON.stringify(promptVars)).not.toContain("grace@example.test");
    expect(env).toEqual({ OPTIO_RUN_URL: `https://optio.example.test/work/${task.id}` });
  });

  it("OPTIO_WORK_TRACEABILITY_EMAIL=true: the requester becomes a co-author", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    vi.stubEnv("OPTIO_WORK_TRACEABILITY_EMAIL", "true");
    const task = await insertTask({
      title: "Refactor",
      repoUrl: tracedRepo(),
      createdBy: userId,
      workspaceId,
    });
    const { env } = await workTraceability(task);
    expect(env).toEqual({
      OPTIO_COMMIT_CO_AUTHOR: "Grace Hopper <grace@example.test>",
      OPTIO_RUN_URL: `https://optio.example.test/work/${task.id}`,
    });
  });

  it("no PUBLIC_URL: no run link rather than a wrong one", async () => {
    const task = await insertTask({
      title: "Fix",
      repoUrl: tracedRepo(),
      ticketSource: "jira",
      ticketExternalId: "PLAT-2",
      workspaceId,
    });
    const { env } = await workTraceability(task);
    expect(env).toEqual({ OPTIO_JIRA_KEY: "PLAT-2" });
  });

  it("OPTIO_COMMIT_TRAILERS=false: no trailers, the MR title and footer stay", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    vi.stubEnv("OPTIO_COMMIT_TRAILERS", "false");
    const task = await insertTask({
      title: "Fix",
      repoUrl: tracedRepo(),
      ticketSource: "jira",
      ticketExternalId: "PLAT-3",
      createdBy: userId,
      workspaceId,
    });
    const { promptVars, env } = await workTraceability(task);
    expect(env).toEqual({});
    expect(promptVars.COMMIT_TRAILERS).toBe("");
    expect(promptVars.MR_TITLE).toBe("PLAT-3: Fix");
    expect(promptVars.MR_FOOTER).toContain("Optio run:");
  });
});

describe("a run in a person's own checkout (no hook there)", () => {
  it("gets the title, the footer and the trailers as words, once", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    const task = await insertTask({
      title: "Add a /health endpoint",
      repoUrl: tracedRepo(),
      ticketSource: "jira",
      ticketExternalId: "PLAT-4",
      ownerUserId: userId,
      workspaceId,
    });
    const note = await localTraceabilityNote(task);
    expect(note).toContain('Title the merge request "PLAT-4: Add a /health endpoint".');
    expect(note).toContain("End the merge request's description with:");
    expect(note).toContain(`Jira: PLAT-4\nOptio-Run: https://optio.example.test/work/${task.id}`);
  });

  it("is empty when there is nothing to say", async () => {
    const task = await insertTask({ title: "x", repoUrl: tracedRepo(), workspaceId });
    expect(await localTraceabilityNote(task)).toBe("");
  });
});
