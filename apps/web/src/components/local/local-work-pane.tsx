"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { Loader2 } from "lucide-react";
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

  if (link?.terminalId !== props.terminalId)
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading session…
      </div>
    );
  const { onTitle, ...pane } = props;
  return link.taskId ? (
    <TaskWorkspace key={link.taskId} id={link.taskId} localPane={pane} onTitle={onTitle} />
  ) : (
    <TerminalPane {...props} />
  );
}
