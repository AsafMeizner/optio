"use client";

import { useState } from "react";
import { compareSessions } from "./session-order";

/** Freeze recency while the rail is open. Live row data and explicit pins
 * still update; typing or switching sessions must not move a click target. */
export function useSessionOrder(terminals: any[]): any[] {
  const [snapshot, setSnapshot] = useState({ input: terminals, rows: terminals });
  let rows = snapshot.rows;
  if (snapshot.input !== terminals) {
    const previous = new Map(rows.map((t) => [t.id, t]));
    rows = terminals.map((t) => ({
      ...t,
      lastInteractedAt: previous.has(t.id)
        ? previous.get(t.id).lastInteractedAt
        : t.lastInteractedAt,
    }));
    setSnapshot({ input: terminals, rows });
  }
  const rank = new Map([...rows].sort(compareSessions).map((t, i) => [t.id, i]));
  return [...terminals].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
}
