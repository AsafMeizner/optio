import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { interactiveSessions, persistentAgents, prReviews, workRuns } from "../db/schema.js";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getRecentEvents } from "../services/task-service.js";
import { acceptWs } from "./ws-connection.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/**
 * Frames that carry run output or message bodies. Each also goes to its own
 * per-entity channel, served by a socket that checks the caller may read that
 * entity (`/ws/logs/:id`, `/ws/workflow-runs/:id/logs`, ...); the shared
 * stream fans out to every signed-in user, so they never ride it.
 */
const CONTENT_FRAMES = new Set([
  "task:log",
  "workflow_run:log",
  "persistent_agent:log",
  "pr_review_run:log",
  "task:message",
  "persistent_agent:message",
]);

type ScopedTable = "run" | "agent" | "review" | "session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The entity an event is about, by the id field it carries. */
export function eventScope(
  evt: Record<string, unknown>,
): { table: ScopedTable; id: string } | null {
  const pick = (v: unknown) => (typeof v === "string" ? v : null);
  const runId = pick(evt.taskId) ?? pick(evt.workflowRunId);
  if (runId) return { table: "run", id: runId };
  const agentId = pick(evt.agentId);
  if (agentId) return { table: "agent", id: agentId };
  const reviewId = pick(evt.prReviewId);
  if (reviewId) return { table: "review", id: reviewId };
  const sessionId = pick(evt.sessionId);
  if (sessionId) return { table: "session", id: sessionId };
  return null;
}

// An entity's workspace never changes, so one answer per id is shared by
// every socket on this instance (bounded; cleared when full).
const WORKSPACE_CACHE_MAX = 10_000;
const workspaceCache = new Map<string, string | null>();

/** The workspace of the entity (null = none), or undefined when it doesn't exist. */
async function entityWorkspace(table: ScopedTable, id: string): Promise<string | null | undefined> {
  if (!UUID.test(id)) return undefined;
  const key = `${table}:${id}`;
  if (workspaceCache.has(key)) return workspaceCache.get(key);
  const t =
    table === "run"
      ? workRuns
      : table === "agent"
        ? persistentAgents
        : table === "review"
          ? prReviews
          : interactiveSessions;
  const [row] = await db.select({ workspaceId: t.workspaceId }).from(t).where(eq(t.id, id));
  if (!row) return undefined;
  if (workspaceCache.size >= WORKSPACE_CACHE_MAX) workspaceCache.clear();
  workspaceCache.set(key, row.workspaceId ?? null);
  return row.workspaceId ?? null;
}

export async function eventsWs(app: FastifyInstance) {
  app.get("/ws/events", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const authOff = isAuthDisabled();
    const isAdmin = authOff || user.workspaceRole === "admin";
    const workspaceId = user.workspaceId ?? null;

    // Send catch-up: recent state-change events so reconnecting clients stay in sync
    try {
      const recentEvents = await getRecentEvents({
        limit: 20,
        ...(authOff ? {} : { actor: { userId: user.id, workspaceId, isAdmin } }),
      });
      for (const event of recentEvents) {
        socket.send(
          JSON.stringify({
            type: "task:state_changed",
            taskId: event.taskId,
            fromState: event.fromState,
            toState: event.toState,
            timestamp: event.createdAt,
            catchUp: true,
          }),
        );
      }
    } catch {
      // ignore catch-up errors — still subscribe to live events
    }
    if (conn.closed) return;

    const subscriber = createSubscriber();
    const channel = "optio:events";
    // A socket that closes at once disconnects the subscriber mid-command;
    // the rejection that follows is expected.
    subscriber.subscribe(channel).catch(() => {});

    // This channel fans out to every authenticated user on the deployment,
    // so each frame is checked before it is forwarded:
    //  - run output and message bodies never go out here (CONTENT_FRAMES);
    //  - a frame about a run / agent / review / session goes only to people
    //    in that entity's workspace;
    //  - `local:changed` nudges go only to their user, and events about
    //    **private work** (an `ownerUserId`) only to its owner and workspace
    //    admins (services/ownership.ts).
    // Dev / auth-disabled has one user and null owners, so everything but
    // the content frames passes.
    const allowed = async (message: string): Promise<boolean> => {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(message) as Record<string, unknown>;
      } catch {
        return false;
      }
      if (typeof evt.type === "string" && CONTENT_FRAMES.has(evt.type)) return false;
      if (evt.type === "local:changed" && evt.userId && evt.userId !== user.id) return false;
      if (evt.ownerUserId && evt.ownerUserId !== user.id && !isAdmin) return false;
      if (authOff) return true;
      const scope = eventScope(evt);
      if (!scope) return true;
      const entityWs = await entityWorkspace(scope.table, scope.id).catch(() => undefined);
      return entityWs !== undefined && entityWs === workspaceId;
    };

    // Lookups are async; a chain keeps frames in publish order.
    let queue: Promise<void> = Promise.resolve();
    subscriber.on("message", (_ch: string, message: string) => {
      queue = queue
        .then(async () => {
          if (conn.closed) return;
          if (await allowed(message)) socket.send(message);
        })
        .catch(() => {});
    });

    conn.onClose(() => {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    });
    // Server → client only: client frames are ignored.
    conn.ready(() => {});
  });
}
