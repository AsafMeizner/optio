"use client";

import { useState } from "react";
import { ChevronsUp, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/** A terminal waiting for a free agent slot on its machine. */
export function isQueued(terminal: { state: string; pendingReason: string | null }): boolean {
  return terminal.state === "pending" && terminal.pendingReason === "capacity";
}

/** "#2 of 3 in line" (or "next in line"), from the server's queue position. */
export function queuePlace(terminal: { queuePosition?: number | null }): string {
  const n = terminal.queuePosition;
  if (n == null) return "in line";
  return n === 1 ? "next in line" : `#${n} in line`;
}

/**
 * What a queued terminal can do: move to the front of its machine's queue
 * (the next to start when an agent finishes) or start now, past the
 * machine's agent limit. The limit holds back automations, not a person.
 */
export function QueueActions({
  terminal,
  host,
  onChanged,
  className,
  buttonClassName,
  compact,
}: {
  terminal: { id: string; queuePosition?: number | null };
  host?: { name: string; maxConcurrentAgents?: number } | null;
  onChanged: (terminal: any) => void;
  className?: string;
  buttonClassName?: string;
  /** Icons only on narrow panes. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<"front" | "now" | null>(null);
  const machine = host?.name ?? "the machine";
  const limit = host?.maxConcurrentAgents;

  const moveToFront = async () => {
    setBusy("front");
    try {
      const res = await api.moveLocalTerminalToFront(terminal.id);
      onChanged(res.terminal);
      toast.success(
        res.terminal.state === "pending"
          ? `Next in line on ${machine}`
          : `Starting on ${machine} — a slot was free`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to move to the front");
    }
    setBusy(null);
  };

  const startNow = async () => {
    setBusy("now");
    try {
      const res = await api.startLocalTerminal(terminal.id, { now: true });
      onChanged(res.terminal);
      toast.success(`Starting on ${machine} now`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start now");
    }
    setBusy(null);
  };

  const button = cn(
    "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50",
    buttonClassName,
  );
  return (
    <div className={cn("flex items-center gap-1", className)} data-testid="local-queue-actions">
      {terminal.queuePosition !== 1 && (
        <button
          type="button"
          onClick={moveToFront}
          disabled={busy !== null}
          title={`Make this the next session to start on ${machine}`}
          aria-label="Move to front"
          className={cn(button, "text-text-muted hover:text-text hover:bg-bg-hover/70")}
        >
          {busy === "front" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ChevronsUp className="h-3.5 w-3.5" />
          )}
          <span className={cn(compact && "hidden @3xl:inline")}>Move to front</span>
        </button>
      )}
      <button
        type="button"
        onClick={startNow}
        disabled={busy !== null}
        title={
          limit
            ? `Start it right away, past ${machine}'s limit of ${limit} agent${limit === 1 ? "" : "s"} at once`
            : `Start it right away, past ${machine}'s agent limit`
        }
        aria-label="Start now"
        className={cn(button, "bg-primary text-white hover:bg-primary/90")}
      >
        {busy === "now" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
        <span className={cn(compact && "hidden @3xl:inline")}>Start now</span>
      </button>
    </div>
  );
}
