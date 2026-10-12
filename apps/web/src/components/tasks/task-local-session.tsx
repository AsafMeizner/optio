"use client";

import type { ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { TerminalPane } from "@/components/local/terminal-pane";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import { splitHref } from "@/components/local/split-state";
import { LocalAttentionWatcher } from "@/components/local/attention-watcher";

type Pane = Omit<ComponentProps<typeof TerminalPane>, "onTitle" | "embedded">;

export function TaskLocalSession({ task, pane }: { task: any; pane?: Pane }) {
  // A Local URL may refer to an earlier attempt. Keep its exact terminal and split controls.
  return pane ? (
    <TerminalPane key={pane.terminalId} {...pane} embedded />
  ) : (
    <>
      <LocalAttentionWatcher />
      <TaskSession terminalId={task.localTerminalId} />
    </>
  );
}

function TaskSession({ terminalId }: { terminalId: string }) {
  const router = useRouter();
  const { hosts } = useLocalHosts();
  return (
    <TerminalPane
      key={terminalId}
      terminalId={terminalId}
      hosts={hosts}
      variant="primary"
      embedded
      onDeleted={() => router.push("/work")}
      chrome={{
        paneCount: 1,
        layout: "cols",
        onLayout: () => {},
        onOpenTerminal: (id) => router.push(splitHref(terminalId, [id], "cols")),
      }}
    />
  );
}
