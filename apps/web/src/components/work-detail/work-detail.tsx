"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { terminalWorkHref } from "@/lib/work-href";
import { usePageTitle } from "@/hooks/use-page-title";
import { LocalWorkPane } from "@/components/local/local-work-pane";
import { TerminalPane } from "@/components/local/terminal-pane";
import { useLocalFeed } from "@/components/local/local-feed";
import {
  addToSplit,
  parseSplit,
  splitHref,
  type SplitLayout,
} from "@/components/local/split-state";
import { TaskWorkspace } from "@/components/tasks/task-workspace";
import { useWorkSession } from "./session-context";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";

type Resolved = { kind: "task" | "terminal"; work: any };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function WorkDetail({ id }: { id: string }) {
  const router = useRouter();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Resolve once. TaskWorkspace owns live task updates; the shared Local feed owns sessions.
    const redirect = (href: string) => {
      if (cancelled) return;
      const [path, query] = href.split("?", 2);
      const params = new URLSearchParams(window.location.search);
      new URLSearchParams(query).forEach((value, key) => params.set(key, value));
      router.replace(`${path}${params.size ? `?${params}` : ""}${window.location.hash}`);
    };
    (async () => {
      try {
        const result = await api.getWork(id);
        if (cancelled) return;
        if (result.source === "repo-task") setResolved({ kind: "task", work: result.work });
        else if (result.source === "local-terminal")
          setResolved({ kind: "terminal", work: result.work });
        else redirect(result.row.href);
      } catch {
        // Linked terminals are omitted from /api/work to avoid duplicate list rows.
        // Resolve old bookmarks using the terminal endpoint's own access checks.
        try {
          const { terminal } = await api.getLocalTerminal(id);
          if (cancelled) return;
          if (terminal.taskId) redirect(terminalWorkHref(terminal));
          else setResolved({ kind: "terminal", work: terminal });
        } catch {
          // A readable attempt remains useful even if its parent task was removed
          // or its owner can no longer read that task. Never infer task access from it.
          const selected = new URLSearchParams(window.location.search).get("session");
          if (selected && UUID.test(selected)) {
            try {
              const { terminal } = await api.getLocalTerminal(selected);
              if (terminal.taskId === id) {
                if (!cancelled) setResolved({ kind: "terminal", work: terminal });
                return;
              }
            } catch {
              /* Leave the unavailable-work message below. */
            }
          }
          try {
            const { review } = await api.getPrReview(id);
            if (review) redirect(`/reviews/${id}`);
          } catch {
            if (!cancelled)
              setError(
                "Work could not be loaded. It may be unavailable or you may not have access.",
              );
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, router, reload]);

  if (error)
    return (
      <div role="alert" className="p-6 text-sm text-text-muted">
        {error}{" "}
        <button className="ml-2 text-primary underline" onClick={() => setReload((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  if (!resolved) return <div className="p-6 text-sm text-text-muted">Loading work…</div>;
  return <Workspace id={id} resolved={resolved} />;
}

function Workspace({ id, resolved }: { id: string; resolved: Resolved }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { terminals, hosts } = useLocalFeed();
  const [task, setTask] = useState(resolved.kind === "task" ? resolved.work : null);
  const [title, setTitle] = useState(resolved.work.title ?? "Work");
  usePageTitle(title);
  const onTitle = useCallback((value: string) => setTitle(value), []);
  const onTask = useCallback((value: any) => setTask(value), []);
  const requested = task ? params.get("session") : null;
  const [checked, setChecked] = useState<{ id: string; valid: boolean } | null>(null);
  useEffect(() => {
    if (!requested) return;
    if (!UUID.test(requested)) {
      setChecked({ id: requested, valid: false });
      return;
    }
    let cancelled = false;
    api
      .getLocalTerminal(requested)
      .then(({ terminal }) => {
        if (!cancelled) setChecked({ id: requested, valid: terminal.taskId === id });
      })
      .catch(() => {
        if (!cancelled) setChecked({ id: requested, valid: false });
      });
    return () => {
      cancelled = true;
    };
  }, [requested, id]);

  const primary = task ? (requested ?? task.localTerminalId ?? null) : resolved.work.id;
  const valid = !requested || (checked?.id === requested && checked.valid);
  const { split, layout } = parseSplit(params, primary ?? undefined);
  const local = resolved.kind === "terminal" || task?.runTarget === "local";
  useEffect(() => {
    if (!local || !valid) return;
    useWorkSession.setState({ pathname, terminalId: primary });
    return () => {
      useWorkSession.setState({ pathname: null, terminalId: null });
    };
  }, [local, valid, pathname, primary]);

  const baseHref = `${pathname}${params.size ? `?${params}` : ""}`;
  const href = (nextSplit: string[], nextLayout = layout) =>
    splitHref(primary ?? id, nextSplit, nextLayout, baseHref);
  const chooseSession = (session: string) => {
    const next = new URLSearchParams(params);
    if (session) next.set("session", session);
    else next.delete("session");
    // A former secondary may become the selected primary.
    router.push(
      splitHref(
        session || task.localTerminalId || id,
        split,
        layout,
        `${pathname}${next.size ? `?${next}` : ""}`,
      ),
    );
  };
  // The shared feed contains the owner's 200 most recent sessions; exact older
  // bookmarks are validated separately and stay selectable even outside this window.
  const attempts = terminals
    .filter((t) => t.taskId === id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const older = attempts.filter((t) => t.id !== task?.localTerminalId);
  const picker =
    task && local && (older.length > 0 || requested) ? (
      <label className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
        Session
        <select
          aria-label="Task session"
          className={cn(inputClass, "max-w-64 py-1 text-xs")}
          value={requested ?? ""}
          onChange={(e) => chooseSession(e.target.value)}
        >
          <option value="">Latest session (follows retries)</option>
          {requested === task.localTerminalId && (
            <option value={requested!}>Selected session · current</option>
          )}
          {older.map((t) => (
            <option key={t.id} value={t.id}>
              {new Date(t.createdAt).toLocaleString()} · {t.state}
            </option>
          ))}
          {requested &&
            !attempts.some((t) => t.id === requested) &&
            requested !== task.localTerminalId && <option value={requested}>Linked session</option>}
        </select>
      </label>
    ) : null;

  if (!valid)
    return (
      <div className="p-6 text-sm text-text-muted" role="status">
        {checked?.id === requested
          ? "This session is unavailable or does not belong to this work."
          : "Loading session…"}
        {checked?.id === requested && (
          <button className="ml-2 text-primary underline" onClick={() => chooseSession("")}>
            Open current session
          </button>
        )}
      </div>
    );

  const paneIds: (string | null)[] = local ? [primary, ...split] : [null];
  const paneProps = (terminalId: string, index: number) => ({
    terminalId,
    hosts,
    variant: index === 0 ? ("primary" as const) : ("split" as const),
    onDeleted: () => router.push("/work"),
    chrome: {
      paneCount: paneIds.length,
      layout,
      onLayout: (next: SplitLayout) => router.replace(href(split, next)),
      onOpenTerminal: (next: string) =>
        router.replace(href(addToSplit(primary ?? id, { split, layout }, next))),
      onClose: index
        ? () => router.replace(href(split.filter((t) => t !== terminalId)))
        : undefined,
      onFocus: index
        ? () =>
            router.push(
              splitHref(
                terminalId,
                [primary!, ...split.filter((t) => t !== terminalId)],
                layout,
                terminalWorkHref(terminals.find((t) => t.id === terminalId) ?? { id: terminalId }),
              ),
            )
        : undefined,
    },
  });
  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0",
        layout === "cols" ? "flex-col md:flex-row" : "flex-col",
      )}
    >
      {paneIds.map((terminalId, index) => (
        <div
          key={index === 0 ? "primary" : terminalId}
          data-session-pane={terminalId ?? undefined}
          className={cn(
            "min-h-0 min-w-0 flex-1 basis-0",
            index > 0 &&
              (layout === "cols"
                ? "border-t md:border-t-0 md:border-l border-border"
                : "border-t border-border"),
          )}
        >
          {index === 0 && task ? (
            <TaskWorkspace
              id={id}
              onTask={onTask}
              onTitle={onTitle}
              sessionPicker={picker}
              currentSessionHref={splitHref(task.localTerminalId ?? id, split, layout, pathname)}
              localPane={terminalId ? paneProps(terminalId, index) : undefined}
            />
          ) : (
            terminalId &&
            (index === 0 ? (
              <TerminalPane {...paneProps(terminalId, index)} onTitle={onTitle} />
            ) : (
              <LocalWorkPane {...paneProps(terminalId, index)} />
            ))
          )}
        </div>
      ))}
    </div>
  );
}
