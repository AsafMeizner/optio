/**
 * The Local bus and host ownership against real Redis and Postgres: two
 * bus instances route a request to the one listening and its reply back to
 * the one asking; a host's lease is per daemon connection, any instance
 * reads it as online, and a newer connection seizing it makes the old
 * owner close its daemon — on `host-taken`, or at its next renew — without
 * marking the host offline.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { localHosts } from "../db/schema.js";
import { leaseHolder, releaseLease, seizeLease } from "./lease-service.js";
import { LocalBus, localBus, localHostInChannel, type BusMessage } from "./local-bus.js";
import { markHostOffline, markHostOnline, registerHost } from "./local-host-service.js";
import * as relay from "./local-relay.js";
import { INSTANCE_ID } from "./instance.js";

class FakeSocket implements relay.RelaySocket {
  readyState = 1;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer) {
    if (typeof data === "string") this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
}

const others: LocalBus[] = [];
async function otherInstance(name: string): Promise<LocalBus> {
  const bus = new LocalBus({ instanceId: `${name}-${randomUUID().slice(0, 6)}` });
  others.push(bus);
  await bus.start();
  return bus;
}

beforeAll(async () => {
  await localBus.start();
});
afterAll(async () => {
  await localBus.stop();
});
beforeEach(() => {
  relay.resetRelayForTests();
  relay.enableLocalCluster();
});
afterEach(async () => {
  relay.resetRelayForTests();
  for (const b of others.splice(0)) await b.stop();
});

async function newHost() {
  return registerHost({
    userId: null,
    workspaceId: null,
    hostname: `it-bus-${randomUUID().slice(0, 8)}`,
    platform: "darwin",
    dirs: [],
  });
}

describe("two bus instances on real Redis", () => {
  it("route a request to the instance listening and its reply to the one asking", async () => {
    const owner = await otherInstance("owner");
    const asker = await otherInstance("asker");
    const bystander = await otherInstance("bystander");
    const channel = localHostInChannel(randomUUID());
    const seen: string[] = [];
    expect(
      await owner.listen(channel, (m: BusMessage) => {
        seen.push(`owner:${m.header.k}`);
        void owner.reply(m, { ok: true, got: m.payload.toString() });
      }).ready,
    ).toBe(true);
    // Someone else's channel: hears nothing.
    await bystander.listen(localHostInChannel(randomUUID()), () => seen.push("bystander")).ready;

    const reply = await asker.request(channel, { k: "send" }, 5_000, Buffer.from("spawn"));
    expect(reply?.header).toMatchObject({ k: "reply", ok: true, got: "spawn" });
    expect(reply?.header.o).toBe(owner.instanceId);
    expect(seen).toEqual(["owner:send"]);

    // Nobody listening: the request times out instead of hanging.
    expect(await asker.request(localHostInChannel(randomUUID()), { k: "send" }, 200)).toBeNull();
  });

  it("carry binary payloads and direct messages intact", async () => {
    const a = await otherInstance("a");
    const b = await otherInstance("b");
    const bytes = Buffer.from([0x1b, 0x5b, 0x48, 0x00, 0xff, 0xfe]);
    const got = new Promise<BusMessage>((resolve) => b.onDirect("daemon-reply", resolve));
    await a.sendDirect(b.instanceId, { k: "daemon-reply", h: "h1" }, bytes);
    const m = await got;
    expect(Buffer.compare(m.payload, bytes)).toBe(0);
    expect(m.header).toMatchObject({ h: "h1", o: a.instanceId });
  });
});

describe("host ownership", () => {
  it("is a lease per daemon connection that every instance reads", async () => {
    const host = await newHost();
    const daemon = new FakeSocket();
    relay.registerDaemon(host.id, null, daemon, { manageDirs: true, refreshLimits: true });
    await relay.claimHost(host.id, daemon);
    const holder = await leaseHolder(relay.hostLeaseKey(host.id));
    expect(holder?.startsWith(`${INSTANCE_ID}#`)).toBe(true);
    const [row] = await db.select().from(localHosts).where(eq(localHosts.id, host.id));
    expect(row.capabilities).toMatchObject({ manageDirs: true, refreshLimits: true });

    // Owned by another instance: online, with the capabilities it recorded.
    const elsewhere = await newHost();
    await db
      .update(localHosts)
      .set({ capabilities: { claudeCredentials: true } })
      .where(eq(localHosts.id, elsewhere.id));
    expect(await relay.isHostOnline(elsewhere.id)).toBe(false);
    await seizeLease(relay.hostLeaseKey(elsewhere.id), 30_000, "other:1#c");
    expect(await relay.isHostOnline(elsewhere.id)).toBe(true);
    expect((await relay.hostCapabilities(elsewhere.id))?.claudeCredentials).toBe(true);
    expect((await relay.hostCapabilities(elsewhere.id))?.manageDirs).toBe(false);
    expect((await relay.hostsWithClaudeCredentials()).map((h) => h.hostId)).toContain(elsewhere.id);
    await releaseLease(relay.hostLeaseKey(elsewhere.id), "other:1#c");
    expect(await relay.isHostOnline(elsewhere.id)).toBe(false);
    expect(await relay.hostCapabilities(elsewhere.id)).toBeNull();
  });

  it("seized by a newer connection elsewhere: the old owner closes on host-taken and the host stays online", async () => {
    const host = await newHost();
    const daemon = new FakeSocket();
    relay.registerDaemon(host.id, null, daemon);
    await relay.claimHost(host.id, daemon);
    await markHostOnline(host.id, {});

    const newOwner = await otherInstance("new-owner");
    await seizeLease(relay.hostLeaseKey(host.id), 30_000, `${newOwner.instanceId}#c2`);
    await newOwner.publish(localHostInChannel(host.id), { k: "host-taken" });

    await expect.poll(() => daemon.closedWith?.code, { timeout: 5_000 }).toBe(4000);
    // Its close is not the host going offline.
    expect(await relay.daemonDisconnected(host.id, daemon)).toBe(false);
    await markHostOffline(host.id); // what a late disconnect would try
    const [row] = await db.select().from(localHosts).where(eq(localHosts.id, host.id));
    expect(row.state).toBe("online");
    expect(await leaseHolder(relay.hostLeaseKey(host.id))).toBe(`${newOwner.instanceId}#c2`);
    expect(await relay.isHostOnline(host.id)).toBe(true);
  });

  it("seized without a word: the old owner finds out at its next renew", async () => {
    const host = await newHost();
    const daemon = new FakeSocket();
    relay.registerDaemon(host.id, null, daemon);
    await relay.claimHost(host.id, daemon);
    await relay.renewHostLeasesForTests();
    expect(daemon.closedWith).toBeNull();

    await seizeLease(relay.hostLeaseKey(host.id), 30_000, "elsewhere:1#c3");
    await relay.renewHostLeasesForTests();
    expect(daemon.closedWith?.code).toBe(4000);
    expect(await leaseHolder(relay.hostLeaseKey(host.id))).toBe("elsewhere:1#c3");
  });

  it("releases its own lease on disconnect, so the host reads offline everywhere", async () => {
    const host = await newHost();
    const daemon = new FakeSocket();
    relay.registerDaemon(host.id, null, daemon);
    await relay.claimHost(host.id, daemon);
    await markHostOnline(host.id, {});
    expect(await relay.daemonDisconnected(host.id, daemon)).toBe(true);
    expect(await leaseHolder(relay.hostLeaseKey(host.id))).toBeNull();
    await markHostOffline(host.id);
    const [row] = await db.select().from(localHosts).where(eq(localHosts.id, host.id));
    expect(row.state).toBe("offline");
  });

  it("a reconnect to the same instance keeps the new connection's lease", async () => {
    const host = await newHost();
    const first = new FakeSocket();
    relay.registerDaemon(host.id, null, first);
    await relay.claimHost(host.id, first);
    // The old socket closes first, then the daemon is back on this instance
    // before the release lands: the release must not take the new lease.
    const closing = relay.daemonDisconnected(host.id, first);
    const second = new FakeSocket();
    relay.registerDaemon(host.id, null, second);
    await relay.claimHost(host.id, second);
    expect(await closing).toBe(true);
    await relay.renewHostLeasesForTests();
    expect(second.closedWith).toBeNull();
    expect(await relay.isHostOnline(host.id)).toBe(true);
  });
});
