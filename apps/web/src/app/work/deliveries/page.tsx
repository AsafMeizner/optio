"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { History, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/hooks/use-page-title";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { formatRelativeTime } from "@/lib/utils";

type DeliveryPage = Awaited<ReturnType<typeof api.listTriggerDeliveries>>;
export default function DeliveriesPage() {
  usePageTitle("Trigger history");
  const [data, setData] = useState<DeliveryPage | null>(null),
    [state, setState] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [version, setVersion] = useState(0),
    [before, setBefore] = useState<string | undefined>();
  useEffect(() => {
    let active = true;
    api
      .listTriggerDeliveries({ state: state || undefined, before })
      .then((d) => {
        if (active) {
          setData(d);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [state, before, version]);
  async function retry(id: string) {
    setBusy(id);
    try {
      await api.retryTriggerDelivery(id);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="page-column py-6 space-y-6">
      <PageHeader
        icon={History}
        title="Trigger history"
        description="See what started your work and retry deliveries that could not be dispatched."
        actions={
          <Button variant="secondary" size="sm" onClick={() => setVersion((v) => v + 1)}>
            <RefreshCw />
            Refresh
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-4">
        <Segmented
          aria-label="Delivery state"
          value={state}
          onChange={(v) => {
            setState(v);
            setBefore(undefined);
          }}
          options={[
            { value: "", label: "All" },
            { value: "pending", label: "Pending" },
            { value: "started", label: "Dispatched" },
            { value: "failed", label: "Failed" },
            { value: "skipped", label: "Skipped" },
          ]}
        />
        <Link href="/work" className="text-xs text-text-muted ml-auto">
          Back to Work →
        </Link>
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <Panel title="Deliveries">
        {!data ? (
          <PanelEmpty>Loading deliveries…</PanelEmpty>
        ) : !data.rows.length ? (
          <PanelEmpty className="py-12 text-center">
            No deliveries in this view. Scheduled and incoming triggers appear here when received.
          </PanelEmpty>
        ) : (
          <div className="divide-y divide-border/40">
            {data.rows.map((r) => (
              <div key={r.id} className="p-4 flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <Link
                    href={
                      r.targetType === "persistent_agent"
                        ? `/agents/${r.targetId}`
                        : r.targetType === "pr_review"
                          ? `/reviews/${r.targetId}`
                          : r.targetType === "job"
                            ? `/jobs/${r.targetId}`
                            : r.targetType === "task_config"
                              ? `/tasks/scheduled/${r.targetId}`
                              : `/local/automations/${r.targetId}`
                    }
                    className="text-sm font-medium hover:text-primary"
                  >
                    {r.name}
                  </Link>
                  <p className="text-xs text-text-muted mt-1">
                    {r.source} · {formatRelativeTime(r.receivedAt)} · {r.attempts}{" "}
                    {r.attempts === 1 ? "attempt" : "attempts"}
                  </p>
                  {r.error && <p className="text-xs text-warning mt-2">{r.error}</p>}
                  {r.state === "pending" && r.attempts > 0 && (
                    <p className="text-xs text-text-muted mt-1">
                      Next attempt {new Date(r.nextAttemptAt).toLocaleTimeString()}
                    </p>
                  )}
                </div>
                <span
                  className={`text-xs rounded-full px-2 py-1 ${r.state === "failed" ? "bg-error/10 text-error" : r.state === "started" ? "bg-success/10 text-success" : "bg-bg-hover text-text-muted"}`}
                >
                  {r.state === "started"
                    ? "Dispatched"
                    : r.state[0].toUpperCase() + r.state.slice(1)}
                </span>
                {r.canRetry && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => retry(r.id)}
                  >
                    {busy === r.id ? "Retrying…" : "Retry delivery"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
      <div className="flex justify-between items-center">
        <p className="text-xs text-text-muted">
          Delivery status tracks dispatch. Work may still be queued or running. Retries reuse the
          original run identity.
        </p>
        <div className="flex gap-2">
          {before && (
            <Button size="sm" variant="ghost" onClick={() => setBefore(undefined)}>
              Latest
            </Button>
          )}
          {data?.next && (
            <Button size="sm" variant="secondary" onClick={() => setBefore(data.next!)}>
              Older
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
