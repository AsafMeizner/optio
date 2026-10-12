/**
 * Split view state belongs to the current URL, never to stored sessions.
 * Reloading this view keeps it; other devices open independent sessions:
 *   /work/<primary>?split=<id2>,<id3>&layout=cols|rows
 * The primary pane is the resolved session: a standalone terminal, the task's
 * current terminal, or its selected `?session=` attempt. `split` lists extra panes. At most MAX_PANES terminals are shown at once.
 */

export type SplitLayout = "cols" | "rows";
export const MAX_PANES = 3;

export interface SplitState {
  split: string[];
  layout: SplitLayout;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSplit(
  params: { get(name: string): string | null } | null | undefined,
  primary?: string,
): SplitState {
  const raw = params?.get("split") ?? "";
  const seen = new Set<string>();
  const split: string[] = [];
  for (const id of raw.split(",")) {
    const v = id.trim();
    if (!UUID_RE.test(v) || v === primary || seen.has(v)) continue;
    seen.add(v);
    split.push(v);
    if (split.length >= MAX_PANES - 1) break;
  }
  const layout = params?.get("layout") === "rows" ? "rows" : "cols";
  return { split, layout };
}

export function splitHref(
  primary: string,
  split: string[],
  layout: SplitLayout,
  baseHref = `/work/${primary}`,
): string {
  const extra = split.filter((id) => id !== primary).slice(0, MAX_PANES - 1);
  const [base, hash] = baseHref.split("#", 2);
  const [path, query] = base!.split("?", 2);
  const qs = new URLSearchParams(query);
  qs.delete("split");
  qs.delete("layout");
  if (extra.length > 0) qs.set("split", extra.join(","));
  if (extra.length > 0 && layout === "rows") qs.set("layout", "rows");
  const q = qs.toString();
  return `${path}${q ? `?${q}` : ""}${hash ? `#${hash}` : ""}`;
}

/** Add `id` as an extra pane next to `primary`; drops the oldest extra when full. */
export function addToSplit(primary: string, state: SplitState, id: string): string[] {
  if (id === primary || state.split.includes(id)) return state.split;
  const next = [...state.split, id];
  return next.slice(Math.max(0, next.length - (MAX_PANES - 1)));
}
