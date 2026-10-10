/**
 * The session bus: how session chat frames and session control reach every
 * API instance (docs/plans/scale-out.md §3).
 *
 * A pod session's chat turn runs on the instance that received the prompt,
 * and its viewers may be connected to any instance. Frames are published on
 * one Redis channel, `optio:session-bus`, that every instance subscribes to
 * once at boot (`startSessionBus`); each instance delivers what arrives to
 * its own sockets. Control messages (interrupt a turn, a session ended, a
 * share revoked) ride the same channel, so the instance running the turn or
 * holding the sockets acts wherever it is.
 *
 * The publishing instance acts on its own message **before** publishing
 * (synchronously, as the in-process maps always did), and skips its own
 * messages when they come back — so a local viewer never waits on Redis and
 * nothing is done twice. Redis is the transport, never the record: what
 * must survive a lost message is in Postgres (session-turn-service.ts).
 */
import { INSTANCE_ID } from "./instance.js";
import { createSubscriber, getRedisClient } from "./event-bus.js";
import type { RedisClient } from "./redis-config.js";
import { logger } from "../logger.js";

export const SESSION_BUS_CHANNEL = "optio:session-bus";

export type SessionScope = "pod" | "local";
export type SessionControlAction = "interrupt" | "end" | "share_revoked";

export type SessionBusMessage =
  | { kind: "chat"; sessionId: string; frame: Record<string, unknown>; origin: string }
  | {
      kind: "control";
      scope: SessionScope;
      sessionId: string;
      action: SessionControlAction;
      origin: string;
    };

type Handler<K extends SessionBusMessage["kind"]> = (
  message: Extract<SessionBusMessage, { kind: K }>,
) => void;

const handlers: { [K in SessionBusMessage["kind"]]: Set<Handler<K>> } = {
  chat: new Set(),
  control: new Set(),
};

/**
 * Registers what this instance does with a message from another instance.
 * Services register at import time; the handler never sees this instance's
 * own messages (those were acted on before publishing).
 */
export function onSessionBus<K extends SessionBusMessage["kind"]>(
  kind: K,
  handler: Handler<K>,
): () => void {
  const set = handlers[kind] as Set<Handler<K>>;
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

/** Delivers a message that arrived from the bus to this instance's handlers. */
export function dispatchSessionBusMessage(message: SessionBusMessage): void {
  if (message.origin === INSTANCE_ID) return;
  if (message.kind === "chat") {
    for (const h of handlers.chat) h(message);
  } else {
    for (const h of handlers.control) h(message);
  }
}

let publishFailures = 0;

/** Publishes to every instance (including this one, which ignores it). */
export async function publishSessionBus(message: SessionBusMessage): Promise<void> {
  try {
    await getRedisClient().publish(SESSION_BUS_CHANNEL, JSON.stringify(message));
    publishFailures = 0;
  } catch (err) {
    // The local effect already happened; other instances miss only the live
    // frame (a reconnect replays history) or the control nudge (the durable
    // flag in Postgres is honored on the turn's next poll). Log a burst once.
    if (publishFailures++ === 0) {
      logger.warn({ err, kind: message.kind }, "session bus publish failed");
    }
  }
}

let subscriber: RedisClient | null = null;
let starting: Promise<void> | null = null;

/**
 * Subscribes this instance to the bus. Idempotent; resolves once the
 * subscription is confirmed, so nothing published afterwards is missed.
 * ioredis re-subscribes by itself after a reconnect.
 */
export function startSessionBus(): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    const sub = createSubscriber();
    subscriber = sub;
    sub.on("message", (channel: string, raw: string) => {
      if (channel !== SESSION_BUS_CHANNEL) return;
      let message: SessionBusMessage;
      try {
        message = JSON.parse(raw) as SessionBusMessage;
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || typeof message.sessionId !== "string") return;
      try {
        dispatchSessionBusMessage(message);
      } catch (err) {
        logger.warn({ err, kind: message.kind }, "session bus handler failed");
      }
    });
    await sub.subscribe(SESSION_BUS_CHANNEL);
    logger.info({ channel: SESSION_BUS_CHANNEL }, "Session bus subscribed");
  })();
  starting.catch(() => {
    starting = null;
  });
  return starting;
}

/** Stops this instance's subscription (shutdown and tests). */
export async function stopSessionBus(): Promise<void> {
  const sub = subscriber;
  subscriber = null;
  starting = null;
  if (!sub) return;
  try {
    await sub.unsubscribe(SESSION_BUS_CHANNEL);
  } catch {
    // Already gone.
  }
  sub.disconnect();
}

/** Whether `startSessionBus` has been called and is live (for diagnostics and tests). */
export function isSessionBusStarted(): boolean {
  return subscriber !== null;
}
