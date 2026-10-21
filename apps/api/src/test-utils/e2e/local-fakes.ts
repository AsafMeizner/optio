/**
 * Test clients for Optio Local against a real API server: a scripted daemon
 * that speaks the /ws/local/daemon protocol (hello → spawn ack → output /
 * attention / exit) and a viewer on /ws/local/terminals/:id/stream. Never a
 * real daemon or a real terminal: these are plain WebSockets the test drives.
 *
 * Uses Node's global WebSocket (undici) — no extra deps.
 */

export type Json = Record<string, unknown>;

export interface CloseInfo {
  code: number;
  reason: string;
}

/** Minimal scripted daemon speaking the /ws/local/daemon protocol. */
export class FakeDaemon {
  ws!: WebSocket;
  inbox: Json[] = [];
  /** Settles when the server (or the test) closes this connection. */
  closed!: Promise<CloseInfo>;
  closeInfo: CloseInfo | null = null;
  private waiters: Array<{ match: (m: Json) => boolean; resolve: (m: Json) => void }> = [];

  /** `wsBase` is the server's `ws://host:port`; `nextTimeoutMs` the default wait in `next`. */
  constructor(
    private readonly wsBase: string,
    private readonly nextTimeoutMs = 15_000,
  ) {}

  async connect(
    hostId: string,
    dirs: Json[],
    terminals: Json[] = [],
    capabilities: Json = {},
  ): Promise<void> {
    this.ws = new WebSocket(`${this.wsBase}/ws/local/daemon`);
    this.closeInfo = null;
    this.closed = new Promise<CloseInfo>((resolve) => {
      this.ws.addEventListener("close", (ev) => {
        this.closeInfo = { code: ev.code, reason: ev.reason };
        resolve(this.closeInfo);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("daemon ws failed"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Json;
      const idx = this.waiters.findIndex((w) => w.match(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    };
    this.send({
      type: "hello",
      hostId,
      daemonVersion: "0.0.0-e2e",
      dirs,
      terminals,
      ...capabilities,
    });
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Await a message matching `match`, checking the inbox first. */
  async next(match: (m: Json) => boolean, timeoutMs = this.nextTimeoutMs): Promise<Json> {
    const idx = this.inbox.findIndex(match);
    if (idx >= 0) return this.inbox.splice(idx, 1)[0];
    return new Promise<Json>((resolve, reject) => {
      const waiter = {
        match,
        resolve: (m: Json) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      // A timed-out waiter leaves the queue: it must not swallow the message
      // a later `next` is waiting for (a test asserting "no spawn yet" would
      // otherwise eat the spawn it then waits for).
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`fake daemon: timed out waiting for message`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

/** Fake browser viewer for /ws/local/terminals/:id/stream. */
export class FakeViewer {
  ws!: WebSocket;
  binary: Buffer[] = [];
  control: Json[] = [];
  /** Every frame in arrival order — "control:<type>" or "binary". */
  order: string[] = [];
  /** Settles when the connection closes. */
  closed!: Promise<CloseInfo>;
  closeInfo: CloseInfo | null = null;

  constructor(private readonly wsBase: string) {}

  async connect(terminalId: string): Promise<void> {
    this.ws = new WebSocket(`${this.wsBase}/ws/local/terminals/${terminalId}/stream`);
    this.ws.binaryType = "arraybuffer";
    this.closeInfo = null;
    this.closed = new Promise<CloseInfo>((resolve) => {
      this.ws.addEventListener("close", (ev) => {
        this.closeInfo = { code: ev.code, reason: ev.reason };
        resolve(this.closeInfo);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("viewer ws failed"));
    });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as Json;
        this.control.push(msg);
        this.order.push(`control:${String(msg.type)}`);
      } else {
        this.binary.push(Buffer.from(ev.data as ArrayBuffer));
        this.order.push("binary");
      }
    };
  }

  text(): string {
    return Buffer.concat(this.binary).toString("utf-8");
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
