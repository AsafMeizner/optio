"use client";

import { useState } from "react";
import { Check, X, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OptioPendingAction } from "@/hooks/use-optio-chat";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

interface ActionCardProps {
  action: OptioPendingAction;
  disabled?: boolean;
  onApprove: (actionId: string) => void;
  onDeny: (actionId: string, feedback: string) => void;
}

export function ActionCard({ action, disabled, onApprove, onDeny }: ActionCardProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const decided = action.decision !== null;
  const approved = action.decision === true;

  const handleDeny = () => {
    setShowFeedback(true);
  };

  const handleSubmitFeedback = () => {
    onDeny(action.id, feedback.trim() || "No changes specified");
    setShowFeedback(false);
  };

  return (
    <div
      className={cn(
        "rounded-lg border overflow-hidden transition-colors",
        decided
          ? approved
            ? "border-success/30 bg-success/5"
            : "border-error/30 bg-error/5"
          : "border-primary/30 bg-primary/5",
      )}
    >
      <div className="px-3.5 py-3">
        {action.description && (
          <p className="break-words text-sm text-text mb-2">{action.description}</p>
        )}

        {action.work?.map((work, index) => (
          <div key={index} className="my-3 space-y-3">
            <p className="break-words font-semibold text-text">{work.name}</p>
            <dl className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs [&_dd]:min-w-0 [&_dd]:break-words">
              <dt className="text-text-muted">When</dt>
              <dd>
                {work.when.type === "manual"
                  ? "Now"
                  : `${work.when.type} · ${JSON.stringify(work.when.config)}`}
              </dd>
              <dt className="text-text-muted">Where</dt>
              <dd className="break-all">
                {work.where.runTarget === "local"
                  ? work.where.localDir
                  : work.where.repoUrl || "Optio pod"}
                {work.where.localHostId && (
                  <span className="block text-text-muted">Machine: {work.where.localHostId}</span>
                )}
                {work.where.repoBranch && (
                  <span className="block">Branch: {work.where.repoBranch}</span>
                )}
              </dd>
              <dt className="text-text-muted">Who</dt>
              <dd>
                {work.who.runtime || "Terminal"}
                {work.who.model && ` · ${work.who.model}`}
                {work.who.agentOptions && ` · ${JSON.stringify(work.who.agentOptions)}`}
              </dd>
              <dt className="text-text-muted">Then</dt>
              <dd>
                {
                  {
                    "waits-for-me": "Wait for me",
                    exits: "Finish and exit",
                    "until-merged": "Work until merged",
                    "waits-for-messages": "Wait for messages",
                  }[work.then]
                }
              </dd>
            </dl>
            {work.what.prompt && (
              <p className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg/70 p-3 text-sm leading-relaxed">
                {work.what.prompt}
              </p>
            )}
            <details className="text-xs text-text-muted">
              <summary className="cursor-pointer">All work settings</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(work, null, 2)}
              </pre>
            </details>
          </div>
        ))}
        <ul className="space-y-1.5">
          {action.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-text-muted">
              <span className="text-primary mt-0.5 shrink-0">&bull;</span>
              <span className="break-all">{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <fieldset
        disabled={disabled}
        className="border-t border-inherit px-3.5 py-2.5 disabled:opacity-50"
      >
        {decided ? (
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium",
              approved ? "text-success" : "text-error",
            )}
          >
            {approved ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
            {action.expired
              ? "Expired · ask Optio for a new proposal"
              : approved
                ? "Approved"
                : "Denied"}
          </div>
        ) : showFeedback ? (
          <div className="space-y-2">
            <p className="text-xs text-text-muted">What should I change?</p>
            <div className="flex items-end gap-2">
              <input
                type="text"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmitFeedback();
                }}
                placeholder="Your feedback..."
                autoFocus
                className={inputClass({ size: "sm", className: "min-w-0 flex-1" })}
              />
              <button
                onClick={handleSubmitFeedback}
                className="shrink-0 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs font-medium hover:bg-error/20 transition-colors btn-press"
              >
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={handleDeny} className="btn-press">
              <MessageSquare />
              Deny
            </Button>
            <Button size="sm" onClick={() => onApprove(action.id)} className="btn-press">
              <Check />
              Approve
            </Button>
          </div>
        )}
      </fieldset>
    </div>
  );
}
