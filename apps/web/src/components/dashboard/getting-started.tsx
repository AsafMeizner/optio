"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, CheckCircle2, Circle, Clock, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { cn } from "@/lib/utils";
import {
  buildChecklist,
  pickMyTasks,
  type ChecklistSources,
  type ChecklistStep,
  type StepState,
} from "./getting-started-model";
import { useGettingStartedStore } from "./getting-started-store";

/**
 * What the checklist reads for `user`; each failed request is `null`
 * (getting-started-model.ts). A viewer has no repository, task or review
 * steps, so nothing is asked for them.
 */
export async function loadChecklistSources(
  user: ChecklistSources["user"],
  { isViewer }: { isViewer: boolean },
): Promise<ChecklistSources> {
  if (isViewer) return { user, repoCount: null, repoPlatforms: null, tasks: null };
  const settle = <T,>(p: () => Promise<T>): Promise<T | null> =>
    Promise.resolve()
      .then(p)
      .catch(() => null);
  // Only the person's own tasks: `author` is their id.
  const mine = (extra: { state?: string; limit: number }) =>
    api.searchTasks({ author: user.id, taskType: "coding", ...extra }).then((r) => r.tasks);
  const [repos, tasks] = await Promise.all([
    settle(() => api.listRepos().then((r) => r.repos)),
    settle(async () => {
      const [started, waiting, completed] = await Promise.all([
        mine({ limit: 1 }),
        mine({ state: "pr_opened", limit: 1 }),
        mine({ state: "completed", limit: 25 }),
      ]);
      return pickMyTasks({ started, waiting, completed });
    }),
  ]);
  return {
    user,
    repoCount: repos ? repos.length : null,
    repoPlatforms: repos
      ? repos.map((r: { gitPlatform?: string | null }) => r.gitPlatform ?? null)
      : null,
    tasks,
  };
}

const STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  todo: "To do",
  waiting: "Waiting on someone else",
};

function StepIcon({ state }: { state: StepState }) {
  const cls = "w-4 h-4 shrink-0 mt-0.5";
  switch (state) {
    case "done":
      return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden />;
    case "waiting":
      return <Clock className={cn(cls, "text-text-muted")} aria-hidden />;
    default:
      return <Circle className={cn(cls, "text-text-muted/60")} aria-hidden />;
  }
}

function StepRow({ step }: { step: ChecklistStep }) {
  const done = step.state === "done";
  return (
    <li
      className="flex items-start gap-3 py-2.5"
      data-testid={`getting-started-${step.id}`}
      data-state={step.state}
    >
      <StepIcon state={step.state} />
      <span className="sr-only">{STATE_LABEL[step.state]}: </span>
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm font-medium", done ? "text-text-muted" : "text-text-heading")}>
          {step.title}
        </div>
        <p className="text-xs text-text-muted mt-0.5 break-words">{step.detail}</p>
      </div>
      {step.href && (
        <Link
          href={step.href}
          className={cn(
            "shrink-0 inline-flex items-center gap-1 text-xs rounded-md px-2 py-1 transition-colors",
            done
              ? "text-text-muted hover:text-text hover:bg-bg-hover"
              : "text-primary hover:bg-primary/10",
          )}
        >
          {step.action ?? (done ? "Open" : "Go")}
          <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </li>
  );
}

/**
 * The Overview's getting-started checklist for a new person
 * (docs/using-optio.md "Your first day"), while a deployment admin has the
 * getting-started guide on: signed in, a repository, a first task, a first
 * review. Each step reads the real state from APIs the app already has and
 * links to where it's done. "Hide" puts it away for this person (getting-started-store.ts); it
 * also goes away once every step is done (and stays away once that will
 * last: `settled`); Help → "Getting-started checklist" in the account menu
 * brings it back. Nothing shows while auth is off (no person to keep it for).
 * `onShowingChange` says whether it shows (or is loading): the welcome
 * screen keeps its own steps whenever it doesn't.
 */
export function GettingStarted({
  load = loadChecklistSources,
  className,
  onShowingChange,
}: {
  load?: typeof loadChecklistSources;
  className?: string;
  onShowingChange?: (showing: boolean) => void;
}) {
  const { user, authDisabled, loaded, isAdmin, isViewer } = useCurrentUser();
  const userId = authDisabled ? null : (user?.id ?? null);
  const hidden = useGettingStartedStore((s) => (userId ? s.isHidden(userId) : true));
  const dismiss = useGettingStartedStore((s) => s.dismiss);
  const markComplete = useGettingStartedStore((s) => s.markComplete);
  const [sources, setSources] = useState<ChecklistSources | null>(null);

  const email = user?.email ?? "";
  useEffect(() => {
    if (!userId || hidden) return;
    let live = true;
    void load({ id: userId, email }, { isViewer }).then((s) => {
      if (live) setSources(s);
    });
    return () => {
      live = false;
    };
  }, [userId, email, isViewer, hidden, load]);

  // Another person's answer (a sign-in switch on this page) never shows here.
  const mine = sources?.user.id === userId ? sources : null;
  const checklist = mine ? buildChecklist(mine, { isAdmin, isViewer }) : null;
  // Remembered only when it will stay complete; otherwise it is just not
  // shown this time, and asked again on the next visit.
  const settled = !!checklist?.settled;
  useEffect(() => {
    if (userId && settled) markComplete(userId);
  }, [userId, settled, markComplete]);

  // Still finding out who is signed in counts as showing, as loading does.
  const showing =
    (!loaded && !user && !authDisabled) || (!!userId && !hidden && !checklist?.complete);
  useEffect(() => {
    onShowingChange?.(showing);
  }, [showing, onShowingChange]);

  if (!userId || hidden || !checklist || checklist.complete) return null;

  const percent = checklist.counted ? (checklist.done / checklist.counted) * 100 : 0;
  return (
    <section
      aria-labelledby="getting-started-title"
      data-testid="getting-started"
      className={cn("rounded-xl border border-border/50 bg-bg-card p-4", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="getting-started-title" className="text-sm font-semibold text-text-heading">
            Getting started
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            {checklist.done} of {checklist.counted} done ·{" "}
            <Link
              href="/help"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <BookOpen className="w-3 h-3" />
              Using Optio, the guide
            </Link>
          </p>
        </div>
        <button
          type="button"
          onClick={() => dismiss(userId)}
          className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-muted hover:text-text hover:bg-bg-hover"
          title="Hide the checklist (Help in the account menu brings it back)"
        >
          <X className="w-3 h-3" />
          Hide
        </button>
      </div>
      <div
        className="mt-3 h-1 rounded-full bg-border/40 overflow-hidden"
        role="progressbar"
        aria-label="Getting started"
        aria-valuemin={0}
        aria-valuemax={checklist.counted}
        aria-valuenow={checklist.done}
      >
        <div className="h-full bg-success transition-all" style={{ width: `${percent}%` }} />
      </div>
      <ol className="mt-2 divide-y divide-border/40">
        {checklist.steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ol>
    </section>
  );
}
