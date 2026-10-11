"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api-client";
import { createPrReviewLogClient, type WsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";
import { toLogEntry, type LogEntry } from "./use-logs";
import { resyncOnReconnect, SeenLogs } from "@/lib/log-resync";

const HISTORICAL_LIMIT = 10000;

/**
 * Mirror of `useLogs` for PR reviews. Returns the same `{ logs, connected,
 * capped, clear }` shape so it can be passed straight into `<LogViewer>` via
 * the `externalLogs` prop.
 *
 * Logs live in `task_logs` keyed by `pr_review_run_id`. The hook:
 *   1. Opens a WS to `/ws/pr-reviews/:id/logs` for live tailing
 *   2. Fetches historical logs for the latest run via REST
 *   3. Dedupes on `timestamp + content`
 */
export function usePrReviewLogs(prReviewId: string) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [capped, setCapped] = useState(false);
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    if (!prReviewId) return;

    const pendingLive: LogEntry[] = [];
    let merged = false;
    const seen = new SeenLogs();

    const client = createPrReviewLogClient(prReviewId, getWsTokenProvider());
    clientRef.current = client;

    client.on("pr_review_run:log", (event) => {
      // The WebSocket replays recent logs with `catchUp: true` on connect.
      // REST history is canonical, so ignore those replay frames.
      if (event.catchUp) return;

      const entry = toLogEntry(event);
      if (seen.has(entry)) return;
      seen.add([entry]);
      if (!merged) {
        pendingLive.push(entry);
      } else {
        setLogs((prev) => {
          const last = prev[prev.length - 1];
          if (
            last &&
            last.content === entry.content &&
            last.logType === entry.logType &&
            last.timestamp === entry.timestamp
          ) {
            return prev;
          }
          return [...prev, entry];
        });
      }
    });

    client.connect();
    setConnected(true);

    const history = api
      .listPrReviewLogs(prReviewId)
      .then((res) => {
        const historical: LogEntry[] = res.logs.map(toLogEntry);
        seen.add(historical);
        if (historical.length >= HISTORICAL_LIMIT) setCapped(true);

        const historicalKeys = new Set(historical.map((l) => l.timestamp + l.content));
        const uniqueLive = pendingLive.filter((l) => !historicalKeys.has(l.timestamp + l.content));

        setLogs([...historical, ...uniqueLive]);
        merged = true;
      })
      .catch(() => {
        setLogs(pendingLive);
        merged = true;
      });

    // The socket dropped and came back (its API pod went away, say): rows
    // stored meanwhile never arrive live. The review's log route has no
    // paging, so the resync reads it whole.
    resyncOnReconnect(client, {
      ready: history,
      seen,
      fetchFrom: () => api.listPrReviewLogs(prReviewId).then((res) => res.logs.map(toLogEntry)),
      setLogs,
    });

    return () => {
      client.disconnect();
      setConnected(false);
    };
  }, [prReviewId]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected, capped, clear };
}
