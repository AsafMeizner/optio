/**
 * The Local bus: how Optio Local frames cross API instances
 * (docs/plans/scale-out.md §4, docs/optio-local.md "Several API instances").
 *
 * A daemon is one socket on one instance (the host's **owner**); a viewer, a
 * REST call, or a worker that wants something from that daemon may be on
 * another. Three kinds of Redis channel carry what crosses:
 *
 * - `optio:local:host:<hostId>:in` — everything addressed to the daemon
 *   (viewer attach / input / resize / view reports, spawn, kill, requests).
 *   Only the owner subscribes, and only while it owns the host.
 * - `optio:local:term:<terminalId>:out` — what a terminal's viewers get
 *   (output, the attach snapshot, size and status frames). An instance
 *   subscribes only while it has a viewer of that terminal.
 * - `optio:local:reply:<instanceId>` — answers addressed to one instance:
 *   request replies (correlated by id, with a timeout) and daemon answers
 *   relayed back to the instance that asked.
 *
 * Messages are binary envelopes: a JSON header (`k` = kind, `o` = the
 * publishing instance) and an optional raw payload, so terminal bytes cross
 * without base64. One subscriber connection per instance (ioredis
 * `messageBuffer`), started after `listen` and retried with backoff, as the
 * session bus does; channels are added and dropped on it as viewers and
 * daemons come and go. An instance never sees its own messages: what it
 * publishes it has already acted on locally.
 *
 * Redis is transport only. Ownership is a lease in Postgres
 * (`local-host:<id>`, local-relay.ts); a lost message costs a frame or a
 * request timeout, never state.
 */
import { randomUUID } from "node:crypto";
import { INSTANCE_ID } from "./instance.js";
import { createSubscriber as createSharedSubscriber, getRedisClient } from "./event-bus.js";
import type { RedisClient } from "./redis-config.js";
import { logger } from "../logger.js";

export const localHostInChannel = (hostId: string) => `optio:local:host:${hostId}:in`;
export const localTermOutChannel = (terminalId: string) => `optio:local:term:${terminalId}:out`;
export const localReplyChannel = (instanceId: string) => `optio:local:reply:${instanceId}`;

/** A message's header: `k` its kind, `o` the instance that published it. */
export interface BusHeader {
  k: string;
  o: string;
  [field: string]: unknown;
}

export interface BusMessage {
  channel: string;
  header: BusHeader;
  payload: Buffer;
}

export type BusHandler = (message: BusMessage) => void;

const EMPTY = Buffer.alloc(0);
/** A header larger than this is not one of ours. */
const MAX_HEADER_BYTES = 64 * 1024;

/** `[u32 header length][header JSON][payload]`. */
export function encodeEnvelope(header: BusHeader, payload?: Buffer | null): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf-8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length, 0);
  return payload && payload.length > 0
    ? Buffer.concat([len, head, payload])
    : Buffer.concat([len, head]);
}

/** The header and payload of an envelope, or null when it isn't one. */
export function decodeEnvelope(raw: Buffer): { header: BusHeader; payload: Buffer } | null {
  if (raw.length < 4) return null;
  const len = raw.readUInt32BE(0);
  if (len === 0 || len > MAX_HEADER_BYTES || raw.length < 4 + len) return null;
  let header: unknown;
  try {
    header = JSON.parse(raw.subarray(4, 4 + len).toString("utf-8"));
  } catch {
    return null;
  }
  if (
    !header ||
    typeof header !== "object" ||
    typeof (header as BusHeader).k !== "string" ||
    typeof (header as BusHeader).o !== "string"
  ) {
    return null;
  }
  return { header: header as BusHeader, payload: raw.subarray(4 + len) };
}

interface Subscription {
  handlers: Set<BusHandler>;
  /** Resolves true once SUBSCRIBE is confirmed on a live subscriber, else false. */
  ready: Promise<boolean>;
}

interface PendingRequest {
  resolve: (message: BusMessage | null) => void;
  timer: NodeJS.Timeout;
}

export interface LocalBusOptions {
  instanceId: string;
  /** The connection PUBLISH goes out on (default: the shared client). */
  publisher?: () => RedisClient;
  /** A fresh connection for SUBSCRIBE (default: event-bus's). */
  createSubscriber?: () => RedisClient;
}

/** One instance's end of the Local bus. */
export class LocalBus {
  readonly instanceId: string;
  readonly replyChannel: string;
  private readonly publisher: () => RedisClient;
  private readonly newSubscriber: () => RedisClient;
  private readonly subs = new Map<string, Subscription>();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly direct = new Map<string, BusHandler>();
  private subscriber: RedisClient | null = null;
  private starting: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private publishFailures = 0;

  constructor(opts: LocalBusOptions) {
    this.instanceId = opts.instanceId;
    this.replyChannel = localReplyChannel(opts.instanceId);
    // Resolved when used, not here: importing this module never touches Redis.
    this.publisher = opts.publisher ?? (() => getRedisClient());
    this.newSubscriber = opts.createSubscriber ?? (() => createSharedSubscriber());
  }

  /** Whether this instance's subscriber is up (remote routing works). */
  get started(): boolean {
    return this.subscriber !== null;
  }

  /**
   * Starts listening on `channel`. `ready` resolves true once the channel's
   * SUBSCRIBE is confirmed (nothing published afterwards is missed), false
   * when the bus is not up — the handler is kept and subscribed when it is.
   * `close` drops this handler (and the channel with its last one).
   */
  listen(channel: string, handler: BusHandler): { ready: Promise<boolean>; close: () => void } {
    let sub = this.subs.get(channel);
    if (!sub) {
      sub = { handlers: new Set(), ready: this.subscribeChannel(channel) };
      this.subs.set(channel, sub);
    }
    sub.handlers.add(handler);
    const entry = sub;
    let closed = false;
    return {
      ready: entry.ready,
      close: () => {
        if (closed) return;
        closed = true;
        entry.handlers.delete(handler);
        if (entry.handlers.size > 0 || this.subs.get(channel) !== entry) return;
        this.subs.delete(channel);
        const s = this.subscriber;
        if (s) void s.unsubscribe(channel).catch(() => {});
      },
    };
  }

  /** How many channels this instance listens on beyond its reply channel (tests, diagnostics). */
  get channelCount(): number {
    return this.subs.size;
  }

  /** Whether this instance listens on `channel` (tests, diagnostics). */
  isListening(channel: string): boolean {
    return this.subs.has(channel);
  }

  private subscribeChannel(channel: string): Promise<boolean> {
    const s = this.subscriber;
    if (!s) return Promise.resolve(false);
    return s.subscribe(channel).then(
      () => true,
      (err) => {
        logger.warn({ err, channel }, "local bus: subscribe failed");
        return false;
      },
    );
  }

  /** Publishes to every instance listening on `channel` (never back to this one). */
  async publish(
    channel: string,
    header: { k: string; [field: string]: unknown },
    payload?: Buffer,
  ) {
    try {
      await this.publisher().publish(
        channel,
        encodeEnvelope({ ...header, o: this.instanceId }, payload),
      );
      this.publishFailures = 0;
      return true;
    } catch (err) {
      // The caller already acted locally; the other instances miss this
      // frame (a viewer reconnect replays the screen) or a request times out.
      if (this.publishFailures++ === 0) {
        logger.warn({ err, channel, kind: header.k }, "local bus publish failed");
      }
      return false;
    }
  }

  /**
   * Publishes a request and waits for its reply (or null after
   * `timeoutMs`, or at once when the bus is down). The header gets `rid`
   * (the request id) and `rt` (this instance's reply channel name).
   */
  async request(
    channel: string,
    header: { k: string; [field: string]: unknown },
    timeoutMs: number,
    payload?: Buffer,
  ): Promise<BusMessage | null> {
    if (!this.started) return null;
    const rid = randomUUID();
    const answer = new Promise<BusMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        this.requests.delete(rid);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.requests.set(rid, { resolve, timer });
    });
    if (!(await this.publish(channel, { ...header, rid, rt: this.instanceId }, payload))) {
      this.settle(rid, null);
    }
    return answer;
  }

  /** Answers a request that arrived on the bus (`message.header.rid` / `rt`). */
  async reply(
    to: BusMessage,
    header: { [field: string]: unknown } = {},
    payload?: Buffer,
  ): Promise<boolean> {
    const rid = to.header.rid;
    const rt = to.header.rt;
    if (typeof rid !== "string" || typeof rt !== "string") return false;
    return this.publish(localReplyChannel(rt), { ...header, k: "reply", rid }, payload);
  }

  /** Sends one message to one instance (its reply channel), outside any request. */
  async sendDirect(
    instanceId: string,
    header: { k: string; [field: string]: unknown },
    payload?: Buffer,
  ): Promise<boolean> {
    return this.publish(localReplyChannel(instanceId), header, payload);
  }

  /** What this instance does with a direct message of kind `k` (one handler per kind). */
  onDirect(kind: string, handler: BusHandler): void {
    this.direct.set(kind, handler);
  }

  private settle(rid: string, message: BusMessage | null): void {
    const pending = this.requests.get(rid);
    if (!pending) return;
    this.requests.delete(rid);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  /** Delivers one raw message from Redis (exported for tests through `deliver`). */
  deliver(channel: string, raw: Buffer): void {
    const decoded = decodeEnvelope(raw);
    if (!decoded) return;
    const { header, payload } = decoded;
    if (header.o === this.instanceId) return;
    const message: BusMessage = { channel, header, payload: payload.length ? payload : EMPTY };
    if (channel === this.replyChannel) {
      if (header.k === "reply" && typeof header.rid === "string") {
        this.settle(header.rid, message);
      } else {
        const handler = this.direct.get(header.k);
        if (handler) this.run(handler, message);
      }
      return;
    }
    const sub = this.subs.get(channel);
    if (!sub) return;
    for (const handler of [...sub.handlers]) this.run(handler, message);
  }

  /** One handler's failure is its own: the others still hear the message. */
  private run(handler: BusHandler, message: BusMessage): void {
    try {
      handler(message);
    } catch (err) {
      logger.warn(
        { err, channel: message.channel, kind: message.header.k },
        "local bus handler failed",
      );
    }
  }

  /** One attempt: a fresh subscriber on the reply channel and every channel listened on. */
  private async subscribeOnce(): Promise<void> {
    const sub = this.newSubscriber();
    sub.on("messageBuffer", (channel: Buffer | string, raw: Buffer) => {
      this.deliver(typeof channel === "string" ? channel : channel.toString("utf-8"), raw);
    });
    try {
      await sub.subscribe(this.replyChannel);
    } catch (err) {
      sub.disconnect();
      throw err;
    }
    if (this.stopped) {
      sub.disconnect();
      return;
    }
    this.subscriber = sub;
    // Channels listened on before the bus was up: subscribe them now. Ones
    // added from here on subscribe themselves (subscribeChannel).
    const waiting = [...this.subs.keys()];
    if (waiting.length > 0) {
      try {
        await sub.subscribe(...waiting);
        for (const channel of waiting) {
          const entry = this.subs.get(channel);
          if (entry) entry.ready = Promise.resolve(true);
        }
      } catch (err) {
        logger.warn({ err }, "local bus: re-subscribe failed");
      }
    }
    logger.info({ channel: this.replyChannel }, "Local bus subscribed");
  }

  /** Subscribes once; resolves when up, rejects (leaving nothing behind) when not. */
  start(): Promise<void> {
    if (this.subscriber) return Promise.resolve();
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.subscribeOnce().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Boot: subscribes in the background, retrying with backoff (1 s doubling
   * to 30 s). Never throws: until the bus is up, Local works on this
   * instance alone (its own daemons and viewers).
   */
  startInBackground(): void {
    this.stopped = false;
    this.attempt(0);
  }

  private attempt(n: number): void {
    if (this.subscriber || this.stopped) return;
    this.start().catch((err) => {
      if (this.stopped) return;
      const delayMs = Math.min(30_000, 1_000 * 2 ** n);
      logger.warn({ err, retryInMs: delayMs }, "local bus subscribe failed; retrying");
      this.retryTimer = setTimeout(() => this.attempt(n + 1), delayMs);
      this.retryTimer.unref?.();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.starting?.catch(() => {});
    for (const rid of [...this.requests.keys()]) this.settle(rid, null);
    const sub = this.subscriber;
    this.subscriber = null;
    if (!sub) return;
    try {
      await sub.unsubscribe();
    } catch {
      // Already gone.
    }
    sub.disconnect();
  }
}

/** This instance's bus. */
export const localBus = new LocalBus({ instanceId: INSTANCE_ID });
