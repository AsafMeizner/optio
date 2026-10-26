import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { extractWorkLinks } from "@optio/shared";
import { db } from "../db/client.js";
import { interactiveSessions, sessionChatEvents } from "../db/schema.js";
import {
  addSessionLinks,
  addSessionPr,
  appendSessionChatEvent,
} from "./interactive-session-service.js";

it("keeps links from concurrent terminal panes and chat after history is removed", async () => {
  const [session] = await db
    .insert(interactiveSessions)
    .values({ repoUrl: "https://github.com/acme/app", branch: "main" })
    .returning();
  await Promise.all([
    addSessionLinks(session.id, extractWorkLinks("https://github.com/acme/app/pull/123")),
    addSessionLinks(session.id, extractWorkLinks("https://linear.app/acme/issue/ENG-4")),
    appendSessionChatEvent({ sessionId: session.id, content: "Fix #12", logType: "user_message" }),
  ]);
  await addSessionLinks(session.id, extractWorkLinks("https://github.com/acme/app/pull/123"));
  await db.delete(sessionChatEvents).where(eq(sessionChatEvents.sessionId, session.id));
  const [saved] = await db
    .select()
    .from(interactiveSessions)
    .where(eq(interactiveSessions.id, session.id));
  expect(saved.links.map((l) => l.label).sort()).toEqual(["#12", "ENG-4", "acme/app#123"]);
});

it("records one PR when two panes detect it together", async () => {
  const [session] = await db
    .insert(interactiveSessions)
    .values({ repoUrl: "https://github.com/acme/app", branch: "main" })
    .returning();
  const prs = await Promise.all(
    Array.from({ length: 3 }, () =>
      addSessionPr(session.id, "https://github.com/acme/app/pull/123", 123),
    ),
  );
  expect(new Set(prs.map((pr) => pr.id)).size).toBe(1);
});
