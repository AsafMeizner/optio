/**
 * Optio Local across API instances, against real Postgres and Redis: this
 * process is one instance; the other is a second bus (and the leases it
 * holds). A spawn whose owner acknowledges too late reaches the daemon once
 * and is never sent again; a daemon socket that closes while its claim runs
 * leaves no lease and the host offline; reads say "online" from the lease;
 * the interaction stamp is written once a minute across instances.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Short acknowledgement window for the late-ack case (read at import).
vi.hoisted(() => {
  process.env.OPTIO_LOCAL_SEND_ACK_TIMEOUT_MS = "300";
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { localHosts, localTerminals } from "../db/schema.js";
import { leaseHolder, releaseLease, seizeLease } from "./lease-service.js";
import { LocalBus, localBus, localHostInChannel, type BusMessage } from "./local-bus.js";
import {
  getHost,
  listHosts,
  markHostOffline,
  markHostOnline,
  pickOnlineHost,
  registerHost,
} from "./local-host-service.js";
import * as relay from "./local-relay.js";
import {
  createTerminal,
  flushParkedForOnlineHosts,
  flushParkedTerminals,
  getTerminal,
  handleStarted,
  noteInteraction,
} from "./local-terminal-service.js";

class FakeSocket implements relay.RelaySocket {
  readyState = 1;
  sent: string[] = [];
  closedWith: { code?: number } | null = null;
  send(data: string | Buffer) {
    if (typeof data === "string") this.sent.push(data);
  }
  close(code?: number) {
    this.readyState = 3;
    this.closedWith = { code };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const others: LocalBus[] = [];

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

async function otherInstance(): Promise<LocalBus> {
  const bus = new LocalBus({ instanceId: `other-${randomUUID().slice(0, 8)}` });
  others.push(bus);
  await bus.start();
  return bus;
}

async function newHost() {
  return registerHost({
    userId: null,
    workspaceId: null,
    hostname: `it-cluster-${randomUUID().slice(0, 8)}`,
    platform: "darwin",
    dirs: [{ path: "/tmp/it" }],
  });
}

describe("a spawn whose owner acknowledges too late (review fix 2)", () => {
  it("reaches the daemon once, stays launching, is never re-sent, and runs on `started`", async () => {
    const host = await newHost();
    const owner = await otherInstance();
    const holder = `${owner.instanceId}#c1`;
    await seizeLease(relay.hostLeaseKey(host.id), 30_000, holder);
    const spawns: string[] = [];
    expect(
      await owner.listen(localHostInChannel(host.id), (m: BusMessage) => {
        if (m.header.k !== "send" || m.header.h !== holder) return;
        const frame = JSON.parse(m.payload.toString("utf-8")) as {
          type: string;
          terminalId: string;
        };
        if (frame.type !== "spawn") return;
        spawns.push(frame.terminalId);
        // The daemon got it; the acknowledgement is just late.
        setTimeout(() => void owner.reply(m, { ok: true }), 800);
      }).ready,
    ).toBe(true);

    const row = await createTerminal({
      host: (await getHost(host.id))!,
      userId: null,
      workspaceId: null,
      dir: "/tmp/it",
      spec: { kind: "shell" },
    });
    expect(row.state).toBe("launching");
    expect(spawns).toEqual([row.id]);

    // Nothing sends it again: not a hello's flush, not the sweep.
    await flushParkedTerminals(host.id);
    await flushParkedForOnlineHosts();
    await sleep(1_000);
    expect(spawns).toEqual([row.id]);
    expect((await getTerminal(row.id))!.state).toBe("launching");

    // The daemon says it runs (relayed by its owner's frame handling).
    await handleStarted(host.id, row.id);
    expect((await getTerminal(row.id))!.state).toBe("running");
  });

  it("a `started` settles even a row judged undelivered (pending)", async () => {
    const host = await newHost();
    const row = await createTerminal({
      host: (await getHost(host.id))!,
      userId: null,
      workspaceId: null,
      dir: "/tmp/it",
      spec: { kind: "shell" },
    });
    expect(row.state).toBe("pending"); // offline: parked
    await handleStarted(host.id, row.id);
    const after = (await getTerminal(row.id))!;
    expect(after.state).toBe("running");
    expect(after.pendingReason).toBeNull();
  });
});

describe("a daemon socket that closes while its claim runs (review fix 6)", () => {
  it("leaves no lease behind and the host offline, wherever the close lands", async () => {
    for (const delayMs of [0, 1, 3, 8, 15]) {
      const host = await newHost();
      await markHostOnline(host.id, {});
      const daemon = new FakeSocket();
      relay.registerDaemon(host.id, null, daemon);
      const claiming = relay.claimHost(host.id, daemon);
      await sleep(delayMs);
      daemon.readyState = 3;
      // What the daemon WebSocket's close handler does.
      const disconnected = relay.daemonDisconnected(host.id, daemon).then(async (wasCurrent) => {
        if (wasCurrent) await markHostOffline(host.id);
        return wasCurrent;
      });
      await claiming;
      expect(await disconnected).toBe(true);
      expect(await leaseHolder(relay.hostLeaseKey(host.id))).toBeNull();
      const [row] = await db.select().from(localHosts).where(eq(localHosts.id, host.id));
      expect(row.state, `close after ${delayMs} ms`).toBe("offline");
      expect(await relay.isHostOnline(host.id)).toBe(false);
    }
  });
});

describe("online is the lease (review fix 12)", () => {
  it("getHost / listHosts / pickOnlineHost say online iff the lease is live; the column is last-known", async () => {
    const host = await newHost();
    await markHostOnline(host.id, {}); // the column says online
    expect((await getHost(host.id))!.state).toBe("offline"); // nobody holds it
    expect((await listHosts(null)).find((h) => h.id === host.id)!.state).toBe("offline");

    await seizeLease(relay.hostLeaseKey(host.id), 30_000, "other:1#c");
    expect((await getHost(host.id))!.state).toBe("online");
    expect((await listHosts(null)).find((h) => h.id === host.id)!.state).toBe("online");
    expect((await pickOnlineHost(null))?.id).toBe(host.id);

    await releaseLease(relay.hostLeaseKey(host.id), "other:1#c");
    expect((await getHost(host.id))!.state).toBe("offline");
    const [row] = await db.select().from(localHosts).where(eq(localHosts.id, host.id));
    expect(row.state).toBe("online"); // last-known, for the alerts and the sweep
  });

  it("the host list reads capabilities off the rows it loaded", async () => {
    const host = await newHost();
    await db
      .update(localHosts)
      .set({ capabilities: { manageDirs: true } })
      .where(eq(localHosts.id, host.id));
    await seizeLease(relay.hostLeaseKey(host.id), 30_000, "other:1#c");
    const loaded = (await listHosts(null)).find((h) => h.id === host.id)!;
    expect(relay.capabilitiesOf(loaded)).toMatchObject({ manageDirs: true, refreshLimits: false });
    await releaseLease(relay.hostLeaseKey(host.id), "other:1#c");
    expect(relay.capabilitiesOf((await getHost(host.id))!)).toBeNull();
  });
});

describe("the interaction stamp (review fix 13)", () => {
  it("is written once a minute across instances, and this instance's throttle starts from the stored stamp", async () => {
    const host = await newHost();
    const row = await createTerminal({
      host: (await getHost(host.id))!,
      userId: null,
      workspaceId: null,
      dir: "/tmp/it",
      spec: { kind: "shell" },
      hold: true,
    });
    const read = async () =>
      (
        await db.select().from(localTerminals).where(eq(localTerminals.id, row.id))
      )[0].lastInteractedAt!.getTime();
    // Another instance stamped it just under a minute ago.
    const other = new Date(Date.now() - 59_700);
    await db
      .update(localTerminals)
      .set({ lastInteractedAt: other })
      .where(eq(localTerminals.id, row.id));
    await noteInteraction(row.id);
    expect(await read()).toBe(other.getTime()); // within its minute: not written

    // A minute after THAT stamp (not after our call) the next keystroke
    // writes: a throttle started from "now" would hold it for another minute.
    await sleep(600);
    const before = Date.now();
    await noteInteraction(row.id);
    expect(await read()).toBeGreaterThanOrEqual(before - 5);
  });
});
