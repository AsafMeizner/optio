import { createHash, randomBytes } from "node:crypto";
import { parseIntEnv } from "@optio/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localTerminals,
  sessionShares,
  sessionShareMembers,
  agentPods,
} from "../db/schema.js";
import { podIsolationKey } from "./pod-isolation.js";
import { isAuthDisabled } from "./oauth/index.js";
import { INSTANCE_ID } from "./instance.js";
import { onSessionBus, publishSessionBus } from "./session-bus.js";

export type SessionKind = "pod" | "local";
export interface SessionActor {
  id: string;
  workspaceId?: string | null;
}
export interface SessionTarget {
  id: string;
  userId: string | null;
  workspaceId: string | null;
}
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function shareTarget(kind: SessionKind, id: string): Promise<SessionTarget | null> {
  const table = kind === "pod" ? interactiveSessions : localTerminals;
  const [row] = await db
    .select({ id: table.id, userId: table.userId, workspaceId: table.workspaceId })
    .from(table)
    .where(eq(table.id, id));
  return row ?? null;
}

async function member(userId: string, workspaceId: string | null): Promise<boolean> {
  if (!workspaceId) return false;
  const { getUserRole } = await import("./workspace-service.js");
  const role = await getUserRole(workspaceId, userId);
  return role === "admin" || role === "member";
}

export async function canJoinSession(
  kind: SessionKind,
  target: SessionTarget,
  actor?: SessionActor,
): Promise<boolean> {
  if (isAuthDisabled()) return true;
  if (!actor || (target.workspaceId ?? null) !== (actor.workspaceId ?? null)) return false;
  if (target.userId === actor.id) return true;
  if (!target.userId) return true;
  if (
    !(await member(actor.id, target.workspaceId)) ||
    !(await member(target.userId, target.workspaceId))
  )
    return false;
  const [grant] = await db
    .select({ id: sessionShares.id })
    .from(sessionShares)
    .innerJoin(sessionShareMembers, eq(sessionShareMembers.shareId, sessionShares.id))
    .where(
      and(
        eq(sessionShares.kind, kind),
        eq(sessionShares.targetId, target.id),
        eq(sessionShares.ownerUserId, target.userId),
        eq(sessionShares.workspaceId, target.workspaceId!),
        eq(sessionShareMembers.userId, actor.id),
        isNull(sessionShares.revokedAt),
        gt(sessionShares.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!grant;
}

async function isShareablePod(target: SessionTarget): Promise<boolean> {
  const [row] = await db
    .select({ isolationKey: agentPods.isolationKey })
    .from(interactiveSessions)
    .innerJoin(agentPods, eq(interactiveSessions.podId, agentPods.id))
    .where(eq(interactiveSessions.id, target.id));
  return (
    row?.isolationKey ===
    podIsolationKey({
      workspaceId: target.workspaceId,
      ownerUserId: target.userId,
      isolationPurpose: `session:${target.id}`,
    })
  );
}

export async function createSessionShare(
  kind: SessionKind,
  target: SessionTarget,
  actor: SessionActor,
  hours: number,
) {
  if (
    !target.userId ||
    target.userId !== actor.id ||
    !target.workspaceId ||
    target.workspaceId !== actor.workspaceId ||
    !(await member(actor.id, target.workspaceId))
  ) {
    throw new Error("Only the session owner can share it with their organization");
  }
  if (kind === "pod" && !(await isShareablePod(target))) {
    throw new Error(
      "This session uses a legacy or unavailable pod. Start an isolated session before sharing.",
    );
  }
  const token = randomBytes(32).toString("base64url");
  const [share] = await db
    .insert(sessionShares)
    .values({
      kind,
      targetId: target.id,
      ownerUserId: actor.id,
      workspaceId: target.workspaceId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + hours * 3600_000),
    })
    .returning();
  return { id: share.id, expiresAt: share.expiresAt, token };
}

export async function redeemSessionShare(token: string, actor: SessionActor) {
  const [share] = await db
    .select()
    .from(sessionShares)
    .where(
      and(
        eq(sessionShares.tokenHash, tokenHash(token)),
        isNull(sessionShares.revokedAt),
        gt(sessionShares.expiresAt, new Date()),
      ),
    );
  if (
    !share ||
    share.workspaceId !== actor.workspaceId ||
    !(await member(actor.id, share.workspaceId)) ||
    !(await member(share.ownerUserId, share.workspaceId))
  )
    return null;
  const target = await shareTarget(share.kind, share.targetId);
  if (!target || target.userId !== share.ownerUserId || target.workspaceId !== share.workspaceId)
    return null;
  if (share.kind === "pod" && !(await isShareablePod(target))) return null;
  await db
    .insert(sessionShareMembers)
    .values({ shareId: share.id, userId: actor.id })
    .onConflictDoNothing();
  return { kind: share.kind, targetId: share.targetId, expiresAt: share.expiresAt };
}

// Live streams are per instance: each instance keeps the sockets it holds
// for a session, closes them at once when it revokes or ends the session
// itself, and closes them when another instance says so over the session
// bus. Every socket is also rechecked periodically and before input — the
// session still active (a pod session not ended), and, with auth on, the
// person still a member with access — so a socket on an instance that
// missed the bus message is closed within one recheck interval anyway.
// (A Local terminal's stream outlives the terminal's exit on purpose: a
// viewer replays its final screen.)
type Socket = {
  close(code?: number, reason?: string): void;
  on(event: "close", cb: () => void): unknown;
};
const collaborators = new Map<string, Set<Socket>>();
const sessionStreams = new Map<string, Set<Socket>>();

/** Whether the session itself is still live: a pod session not ended. */
async function sessionLive(kind: SessionKind, id: string): Promise<boolean> {
  if (kind !== "pod") return true;
  const [row] = await db
    .select({ state: interactiveSessions.state })
    .from(interactiveSessions)
    .where(eq(interactiveSessions.id, id));
  return row?.state === "active";
}

export function watchSessionAccess(
  kind: SessionKind,
  target: SessionTarget,
  actor: SessionActor,
  socket: Socket,
) {
  const key = `${kind}:${target.id}`;
  const streams = sessionStreams.get(key) ?? new Set<Socket>();
  streams.add(socket);
  sessionStreams.set(key, streams);
  socket.on("close", () => {
    streams.delete(socket);
    if (!streams.size) sessionStreams.delete(key);
  });
  const authOn = !isAuthDisabled();
  const sockets = collaborators.get(key) ?? new Set<Socket>();
  if (authOn && target.userId !== actor.id) {
    sockets.add(socket);
    collaborators.set(key, sockets);
  }
  // The session's liveness is read on the timer (a database blip keeps the
  // socket; the bus carries the end too); input checks the last answer
  // rather than adding a query per keystroke.
  let ended = false;
  const check = async () => {
    if (ended) {
      socket.close(4403, "Session ended");
      return false;
    }
    if (!authOn) return true;
    const allowed = await (async () =>
      (await member(actor.id, target.workspaceId)) &&
      (await canJoinSession(kind, target, actor)))().catch(() => false);
    if (!allowed) socket.close(4403, "Session access expired or was revoked");
    return allowed;
  };
  const recheck = async () => {
    if (!(await sessionLive(kind, target.id).catch(() => true))) ended = true;
    await check();
  };
  const timer = setInterval(
    () => {
      void recheck();
    },
    parseIntEnv("OPTIO_SESSION_ACCESS_RECHECK_MS", 10_000),
  );
  timer.unref();
  socket.on("close", () => {
    clearInterval(timer);
    sockets.delete(socket);
    if (!sockets.size) collaborators.delete(key);
  });
  return check;
}

export async function listSessionShares(kind: SessionKind, targetId: string) {
  return db
    .select({
      id: sessionShares.id,
      expiresAt: sessionShares.expiresAt,
      revokedAt: sessionShares.revokedAt,
      createdAt: sessionShares.createdAt,
    })
    .from(sessionShares)
    .where(and(eq(sessionShares.kind, kind), eq(sessionShares.targetId, targetId)));
}

/** This instance's collaborator sockets for the session, closed. */
function closeLocalCollaborators(kind: SessionKind, targetId: string) {
  for (const socket of collaborators.get(`${kind}:${targetId}`) ?? [])
    socket.close(4403, "Session sharing revoked");
}

/** This instance's sockets (owner and collaborators) for the session, closed. */
function closeLocalStreams(kind: SessionKind, id: string) {
  for (const socket of sessionStreams.get(`${kind}:${id}`) ?? [])
    socket.close(4403, "Session ended");
}

/** How many sockets this instance holds for the session (diagnostics / tests). */
export function sessionStreamCount(kind: SessionKind, id: string): number {
  return sessionStreams.get(`${kind}:${id}`)?.size ?? 0;
}

onSessionBus("control", (m) => {
  if (m.action === "share_revoked") closeLocalCollaborators(m.scope, m.sessionId);
  else if (m.action === "end") closeLocalStreams(m.scope, m.sessionId);
});

/**
 * Revokes a share link: the grant is gone in the database (what every later
 * check reads), this instance's collaborator sockets close now, and every
 * other instance closes its own on the bus message.
 */
export async function revokeSessionShare(kind: SessionKind, targetId: string, id: string) {
  await db
    .update(sessionShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessionShares.id, id),
        eq(sessionShares.kind, kind),
        eq(sessionShares.targetId, targetId),
      ),
    );
  closeLocalCollaborators(kind, targetId);
  await publishSessionBus({
    kind: "control",
    scope: kind,
    sessionId: targetId,
    action: "share_revoked",
    origin: INSTANCE_ID,
  });
}

/**
 * The session ended: this instance's sockets for it close now, every other
 * instance's on the bus message. The session row's state is what a socket
 * that missed the message is checked against.
 */
export async function closeSessionStreams(kind: SessionKind, id: string): Promise<void> {
  closeLocalStreams(kind, id);
  await publishSessionBus({
    kind: "control",
    scope: kind,
    sessionId: id,
    action: "end",
    origin: INSTANCE_ID,
  });
}
