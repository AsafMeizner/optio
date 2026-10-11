/**
 * Requests to a host's daemon that it answers by id (`requestId`): dirs,
 * limits refresh, Claude credentials. One lifecycle for all of them: the
 * request is pending before its frame goes out (the answer may beat the
 * owner's acknowledgement back when the daemon is on another instance), it
 * fails at once when the frame certainly went nowhere (the host is offline),
 * and it times out when no answer comes. An answer counts only from the host
 * it was sent to.
 */
import { randomUUID } from "node:crypto";
import type { LocalServerMessage } from "@optio/shared";
import * as relay from "./local-relay.js";

interface Pending<R> {
  hostId: string;
  resolve: (answer: R) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class HostRequests<R extends { requestId: string }> {
  private readonly pending = new Map<string, Pending<R>>();

  constructor(
    private readonly opts: {
      timeoutMs: number;
      /** What the caller gets when no answer came in time. */
      timeoutError: () => Error;
      /** What the caller gets when the host is offline. */
      offlineError: () => Error;
    },
  ) {}

  /**
   * Sends `build(requestId)` to the host's daemon, wherever it is, and
   * resolves with its answer (`offlineError` overrides the default one).
   */
  ask(
    hostId: string,
    build: (requestId: string) => LocalServerMessage,
    offlineError: () => Error = this.opts.offlineError,
  ): Promise<R> {
    const requestId = randomUUID();
    const answer = new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(this.opts.timeoutError());
      }, this.opts.timeoutMs);
      this.pending.set(requestId, { hostId, resolve, reject, timer });
    });
    void relay
      .sendToHost(hostId, build(requestId))
      .catch(() => false)
      .then((sent) => {
        if (!sent) this.settle(requestId, (p) => p.reject(offlineError()));
      });
    return answer;
  }

  /** A daemon answered. Ignored unless the request is pending for that same host. */
  deliver(hostId: string, msg: R): boolean {
    const p = this.pending.get(msg.requestId);
    if (!p || p.hostId !== hostId) return false;
    this.settle(msg.requestId, (q) => q.resolve(msg));
    return true;
  }

  private settle(requestId: string, fn: (p: Pending<R>) => void): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    fn(p);
  }

  /** Test-only: forget every pending request. */
  reset(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
