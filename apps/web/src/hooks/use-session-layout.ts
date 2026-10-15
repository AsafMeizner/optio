"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Save the user's choice before Next's asynchronous navigation can be interrupted. */
export function rememberSessionLayout(href: string): string {
  try {
    const url = new URL(href, window.location.origin);
    const names = url.pathname.startsWith("/sessions/") ? ["terminals"] : ["split", "layout"];
    const layout = new URLSearchParams();
    for (const name of names) {
      if (url.searchParams.has(name)) layout.set(name, url.searchParams.get(name)!);
    }
    const key = `optio.session-layout:${url.pathname}:${url.searchParams.get("session") ?? ""}`;
    window.sessionStorage.setItem(key, layout.toString());
  } catch {
    // A blocked store must not prevent navigation.
  }
  return href;
}

/** Keep each session's panes when returning from another page. Tab-local so
 * separate browser tabs can still arrange the same session independently.
 * URLs with explicit panes win; subsequent URL edits (including ungrouping)
 * replace the saved choice. Only layout parameters are restored.
 */
export function useSessionLayout(kind: "local" | "pod") {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const entry = useRef<{ key: string; pending?: string } | null>(null);
  const query = params.toString();
  const attempt = params.get("session") ?? "";
  const key = `optio.session-layout:${pathname}:${attempt}`;

  useEffect(() => {
    const names = kind === "local" ? ["split", "layout"] : ["terminals"];
    const current = new URLSearchParams(query);
    const layout = new URLSearchParams();
    for (const name of names) {
      if (current.has(name)) layout.set(name, current.get(name)!);
    }
    try {
      if (entry.current?.key !== key) {
        entry.current = { key };
        const saved = window.sessionStorage.getItem(key);
        if (!layout.size && saved) {
          const stored = new URLSearchParams(saved);
          for (const name of names) {
            if (stored.has(name)) current.set(name, stored.get(name)!);
          }
          if (current.toString() !== query) {
            entry.current.pending = query;
            router.replace(`${pathname}?${current}${window.location.hash}`, { scroll: false });
            return;
          }
        }
      }
      // Strict Mode can run this effect again before replace reaches the URL.
      if (entry.current.pending !== undefined && entry.current.pending === query) return;
      entry.current.pending = undefined;
      window.sessionStorage.setItem(key, layout.toString());
    } catch {
      // Blocked storage leaves the existing URL-based controls working.
    }
  }, [key, kind, pathname, query, router]);
}
