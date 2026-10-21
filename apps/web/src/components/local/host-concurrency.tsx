"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";

/** The most a machine can be set to run at once (`LOCAL_MAX_CONCURRENT_AGENTS_CAP`). */
const MAX = 50;

/**
 * A machine's agent limit: how many agent terminals run on it at once. Agents
 * that automations, Jobs and Tasks start past it wait ("Waiting for a slot")
 * and start as others finish; a session you open by hand always starts. The
 * machines' answer to a repo's concurrency limit.
 */
export function HostConcurrency({
  host,
  onChanged,
}: {
  host: { id: string; maxConcurrentAgents?: number };
  onChanged: (host: any) => void;
}) {
  const { canMutate } = useCurrentUser();
  const current = host.maxConcurrentAgents ?? 3;
  const [value, setValue] = useState(String(current));
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(String(current)), [current]);

  const parsed = Number.parseInt(value, 10);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX;
  const dirty = valid && parsed !== current;

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const { host: updated } = await api.updateLocalHost(host.id, { maxConcurrentAgents: parsed });
      onChanged(updated);
      toast.success(`Up to ${parsed} agent${parsed === 1 ? "" : "s"} at once`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the limit");
      setValue(String(current));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
      <Gauge className="w-3.5 h-3.5 shrink-0" />
      <label htmlFor={`host-${host.id}-max-agents`}>Agents at once</label>
      {canMutate ? (
        <input
          id={`host-${host.id}-max-agents`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX}
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label="Agents the machine runs at once"
          className={cn(
            "w-14 px-1.5 py-0.5 rounded-md border bg-bg text-text text-xs tabular-nums",
            valid ? "border-border/70" : "border-danger/70",
          )}
        />
      ) : (
        <span className="text-text tabular-nums">{current}</span>
      )}
      <span className="text-text-muted/70 hidden sm:inline">
        automation agents past this wait for a free slot
      </span>
    </div>
  );
}
