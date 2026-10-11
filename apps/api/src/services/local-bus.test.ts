/**
 * The Local bus's routing on an in-memory pub/sub: envelopes, per-channel
 * delivery, an instance never hearing itself, request / reply correlation
 * and timeouts, direct messages, and channels listened on before the bus
 * was up. Real Redis is local-bus.int.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedisClient } from "./redis-config.js";
import {
  LocalBus,
  decodeEnvelope,
  encodeEnvelope,
  localHostInChannel,
  localReplyChannel,
  localTermOutChannel,
  type BusMessage,
} from "./local-bus.js";

/** A pub/sub server in memory: PUBLISH reaches every connection subscribed to the channel. */
class Hub {
  subscribers = new Set<FakeSubscriber>();
  published: Array<{ channel: string; raw: Buffer }> = [];
  failPublish = false;

  publisher(): RedisClient {
    return {
      publish: async (channel: string, raw: Buffer) => {
        if (this.failPublish) throw new Error("redis down");
        this.published.push({ channel, raw });
        let n = 0;
        for (const sub of this.subscribers) {
          if (sub.channels.has(channel)) {
            n++;
            queueMicrotask(() => sub.emit(channel, raw));
          }
        }
        return n;
      },
    } as unknown as RedisClient;
  }

  subscriber(): RedisClient {
    const sub = new FakeSubscriber(this);
    return sub as unknown as RedisClient;
  }
}

class FakeSubscriber {
  channels = new Set<string>();
  private listener: ((channel: Buffer, raw: Buffer) => void) | null = null;
  constructor(private readonly hub: Hub) {
    hub.subscribers.add(this);
  }
  on(event: string, fn: (channel: Buffer, raw: Buffer) => void) {
    if (event === "messageBuffer") this.listener = fn;
    return this;
  }
  async subscribe(...channels: string[]) {
    for (const c of channels) this.channels.add(c);
    return this.channels.size;
  }
  async unsubscribe(...channels: string[]) {
    if (channels.length === 0) this.channels.clear();
    for (const c of channels) this.channels.delete(c);
    return this.channels.size;
  }
  disconnect() {
    this.hub.subscribers.delete(this);
  }
  emit(channel: string, raw: Buffer) {
    this.listener?.(Buffer.from(channel), raw);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 5));

function makeBus(hub: Hub, instanceId: string): LocalBus {
  return new LocalBus({
    instanceId,
    publisher: () => hub.publisher(),
    createSubscriber: () => hub.subscriber(),
  });
}

describe("envelopes", () => {
  it("round-trips a header and a binary payload", () => {
    const payload = Buffer.from([0, 255, 10, 27, 91]);
    const raw = encodeEnvelope({ k: "out", o: "a", v: "x" }, payload);
    const decoded = decodeEnvelope(raw)!;
    expect(decoded.header).toEqual({ k: "out", o: "a", v: "x" });
    expect(Buffer.compare(decoded.payload, payload)).toBe(0);
    expect(decodeEnvelope(encodeEnvelope({ k: "x", o: "a" }))!.payload).toHaveLength(0);
  });

  it("rejects what is not one", () => {
    expect(decodeEnvelope(Buffer.from("hi"))).toBeNull();
    expect(decodeEnvelope(Buffer.from([0, 0, 0, 50, 1, 2]))).toBeNull();
    const notJson = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("{x")]);
    expect(decodeEnvelope(notJson)).toBeNull();
    const noKind = encodeEnvelope({ o: "a" } as never);
    expect(decodeEnvelope(noKind)).toBeNull();
  });
});

describe("LocalBus", () => {
  const buses: LocalBus[] = [];
  afterEach(async () => {
    for (const b of buses.splice(0)) await b.stop();
    vi.useRealTimers();
  });
  const bus = async (hub: Hub, id: string) => {
    const b = makeBus(hub, id);
    buses.push(b);
    await b.start();
    return b;
  };

  it("delivers a channel's messages to the instances listening on it, never back to the sender", async () => {
    const hub = new Hub();
    const a = await bus(hub, "a");
    const b = await bus(hub, "b");
    const c = await bus(hub, "c");
    const heard: Record<string, BusMessage[]> = { a: [], b: [], c: [] };
    const channel = localTermOutChannel("t1");
    expect(await a.listen(channel, (m) => heard.a.push(m)).ready).toBe(true);
    expect(await b.listen(channel, (m) => heard.b.push(m)).ready).toBe(true);
    // c listens elsewhere.
    c.listen(localTermOutChannel("t2"), (m) => heard.c.push(m));

    await a.publish(channel, { k: "out" }, Buffer.from("bytes"));
    await settle();
    expect(heard.a).toHaveLength(0);
    expect(heard.c).toHaveLength(0);
    expect(heard.b).toHaveLength(1);
    expect(heard.b[0].header).toMatchObject({ k: "out", o: "a" });
    expect(heard.b[0].payload.toString()).toBe("bytes");
    expect(heard.b[0].channel).toBe(channel);
  });

  it("keeps a channel while any handler listens and drops it with the last", async () => {
    const hub = new Hub();
    const a = await bus(hub, "a");
    const b = await bus(hub, "b");
    const channel = localHostInChannel("h1");
    const got: string[] = [];
    const one = b.listen(channel, () => got.push("one"));
    const two = b.listen(channel, () => got.push("two"));
    await one.ready;
    one.close();
    one.close(); // idempotent
    expect(b.isListening(channel)).toBe(true);
    await a.publish(channel, { k: "x" });
    await settle();
    expect(got).toEqual(["two"]);
    two.close();
    expect(b.isListening(channel)).toBe(false);
    await settle();
    await a.publish(channel, { k: "x" });
    await settle();
    expect(got).toEqual(["two"]);
  });

  it("correlates a request with its reply, whoever else is on the channel", async () => {
    const hub = new Hub();
    const asker = await bus(hub, "asker");
    const owner = await bus(hub, "owner");
    const bystander = await bus(hub, "bystander");
    const channel = localHostInChannel("h1");
    owner.listen(channel, (m) => {
      void owner.reply(m, { ok: true, echo: m.header.n }, Buffer.from("payload"));
    });
    // A bystander on the same channel that never answers changes nothing.
    bystander.listen(channel, () => {});
    await settle();

    const [r1, r2] = await Promise.all([
      asker.request(channel, { k: "send", n: 1 }, 1_000),
      asker.request(channel, { k: "send", n: 2 }, 1_000),
    ]);
    expect(r1?.header).toMatchObject({ k: "reply", ok: true, echo: 1, o: "owner" });
    expect(r2?.header).toMatchObject({ echo: 2 });
    expect(r1?.payload.toString()).toBe("payload");
    // Replies went to the asker's own channel only.
    const replies = hub.published.filter((p) => p.channel === localReplyChannel("asker"));
    expect(replies).toHaveLength(2);
  });

  it("resolves null when nobody answers in time, and ignores a late reply", async () => {
    const hub = new Hub();
    const asker = await bus(hub, "asker");
    const owner = await bus(hub, "owner");
    const channel = localHostInChannel("h1");
    let held: BusMessage | null = null;
    owner.listen(channel, (m) => {
      held = m;
    });
    await settle();
    const answer = asker.request(channel, { k: "send" }, 30);
    expect(await answer).toBeNull();
    // The late reply has nothing to settle.
    await owner.reply(held!, { ok: true });
    await settle();
  });

  it("answers at once with null while the bus is down or the publish fails", async () => {
    const hub = new Hub();
    const down = makeBus(hub, "down");
    buses.push(down);
    expect(await down.request(localHostInChannel("h1"), { k: "send" }, 10_000)).toBeNull();

    const up = await bus(hub, "up");
    hub.failPublish = true;
    const started = Date.now();
    expect(await up.request(localHostInChannel("h1"), { k: "send" }, 10_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await up.publish(localHostInChannel("h1"), { k: "x" })).toBe(false);
  });

  it("settles at once when nobody listens on the channel, and tells unheard from unanswered", async () => {
    const hub = new Hub();
    const asker = await bus(hub, "asker");
    const owner = await bus(hub, "owner");
    const started = Date.now();
    expect(await asker.request(localHostInChannel("nobody"), { k: "send" }, 10_000)).toBeNull();
    expect(await asker.ask(localHostInChannel("nobody"), { k: "send" }, 10_000)).toBe("unheard");
    expect(Date.now() - started).toBeLessThan(1_000);
    // Heard but never answered: a timeout, which may have been acted on.
    owner.listen(localHostInChannel("h1"), () => {});
    await settle();
    expect(await asker.ask(localHostInChannel("h1"), { k: "send" }, 30)).toBe("timeout");
  });

  it("delivers direct messages by kind to the one instance addressed", async () => {
    const hub = new Hub();
    const a = await bus(hub, "a");
    const b = await bus(hub, "b");
    const c = await bus(hub, "c");
    const gotB: BusMessage[] = [];
    const gotC: BusMessage[] = [];
    b.onDirect("daemon-reply", (m) => gotB.push(m));
    c.onDirect("daemon-reply", (m) => gotC.push(m));
    await a.sendDirect("b", { k: "daemon-reply", h: "h1" }, Buffer.from("{}"));
    await a.sendDirect("b", { k: "unknown-kind" });
    await settle();
    expect(gotB).toHaveLength(1);
    expect(gotB[0].header).toMatchObject({ k: "daemon-reply", h: "h1", o: "a" });
    expect(gotC).toHaveLength(0);
  });

  it("subscribes channels listened on before it was up once it starts", async () => {
    const hub = new Hub();
    const a = await bus(hub, "a");
    const late = makeBus(hub, "late");
    buses.push(late);
    const got: BusMessage[] = [];
    const early = late.listen(localTermOutChannel("t1"), (m) => got.push(m));
    expect(await early.ready).toBe(false);
    expect(late.started).toBe(false);
    await late.start();
    expect(late.started).toBe(true);
    expect(await late.listen(localTermOutChannel("t1"), () => {}).ready).toBe(true);
    await a.publish(localTermOutChannel("t1"), { k: "out" }, Buffer.from("x"));
    await settle();
    expect(got).toHaveLength(1);
  });

  it("drops envelopes it can't read and survives a throwing handler", async () => {
    const hub = new Hub();
    const a = await bus(hub, "a");
    const b = makeBus(hub, "b");
    buses.push(b);
    const got: string[] = [];
    b.listen("chan", () => {
      throw new Error("boom");
    });
    b.listen("chan", (m) => got.push(m.header.k));
    b.deliver("chan", Buffer.from("garbage"));
    b.deliver("chan", encodeEnvelope({ k: "ok", o: "a" }));
    expect(got).toEqual(["ok"]);
    void a;
  });
});
