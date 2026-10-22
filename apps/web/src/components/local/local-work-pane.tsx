"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { SessionSkeleton } from "@/components/skeleton";
import { api } from "@/lib/api-client";
import { TerminalPane } from "./terminal-pane";
import { TaskWorkspace } from "@/components/tasks/task-workspace";

/** Local session URLs keep their split state while gaining the linked task's full context. */
export function LocalWorkPane(props: ComponentProps<typeof TerminalPane>) {
  const [link, setLink] = useState<{ terminalId: string; taskId: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getLocalTerminal(props.terminalId)
      .then(({ terminal }) => {
        if (!cancelled) setLink({ terminalId: props.terminalId, taskId: terminal.taskId ?? null });
      })
      .catch(() => {
        if (!cancelled) setLink({ terminalId: props.terminalId, taskId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [props.terminalId]);

  if (link?.terminalId !== props.terminalId) return <SessionSkeleton label="Loading session" />;
  const { onTitle, ...pane } = props;
  return link.taskId ? (
    <TaskWorkspace key={link.taskId} id={link.taskId} localPane={pane} onTitle={onTitle} />
  ) : (
    <TerminalPane {...props} />
  );
}
