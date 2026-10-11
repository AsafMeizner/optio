"use client";
import { useState } from "react";
import type { UsageBudget, UsageEntry } from "@optio/shared";
import { api } from "@/lib/api-client";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

export function BudgetDialog({
  budget,
  subject,
  onClose,
  onSaved,
}: {
  budget?: UsageBudget;
  subject?: Pick<UsageEntry, "id" | "kind" | "name">;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tokens, setTokens] = useState(budget?.tokenLimit?.toString() ?? "");
  const [cost, setCost] = useState(budget?.costLimit ?? "");
  const [action, setAction] = useState<"notify" | "pause_new">(budget?.action ?? "notify");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const name = budget?.name ?? subject?.name ?? "Organization";
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.saveUsageBudget({
        name,
        subjectKind: budget?.subjectKind ?? subject?.kind ?? "organization",
        subjectId: budget?.subjectId ?? subject?.id ?? null,
        tokenLimit: tokens ? Number(tokens) : null,
        costLimit: cost || null,
        action,
        enabled: true,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save budget");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!budget) return;
    setBusy(true);
    try {
      await api.deleteUsageBudget(budget.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove budget");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`${name} budget`}
      description="Limits reset at the start of each calendar month, in UTC."
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {budget && (
            <Button variant="ghost" disabled={busy} onClick={remove}>
              Remove budget
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy || (!tokens && !cost)} onClick={save}>
            {busy ? "Saving…" : "Save budget"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <label className="block text-sm">
          Monthly token limit
          <input
            type="number"
            min="1"
            step="1"
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
            placeholder="No token limit"
            className={inputClass({ className: "mt-2 w-full" })}
          />
        </label>
        <label className="block text-sm">
          Monthly cost limit (USD)
          <input
            type="number"
            min="0.000001"
            step="any"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="No cost limit"
            className={inputClass({ className: "mt-2 w-full" })}
          />
        </label>
        <label className="block text-sm">
          When either limit is reached
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
            className={inputClass({ className: "mt-2 w-full" })}
          >
            <option value="notify">Show an alert in Usage</option>
            <option value="pause_new">Pause new work</option>
          </select>
        </label>
        <p className="text-xs leading-relaxed text-text-muted">
          Limits use recorded tokens and costs, including estimates. Running work can finish and
          report additional usage. Unknown costs count toward token limits only. A pause lifts when
          the limit increases or the month resets.
        </p>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
