"use client";

import { X, ListOrdered } from "lucide-react";

export function QueuedMessages({
  messages,
  onCancel,
}: {
  messages: { requestId: string; content: string }[];
  onCancel: (requestId: string) => void;
}) {
  if (!messages.length) return null;
  return (
    <section
      aria-label="Queued messages"
      className="mb-2 rounded-lg border border-border bg-bg-card p-2"
    >
      <p className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
        <ListOrdered className="h-3 w-3" />
        Queued · {messages.length}
      </p>
      <ol className="max-h-28 overflow-auto">
        {messages.map((message) => (
          <li key={message.requestId} className="flex items-center gap-2 py-1">
            <span className="min-w-0 flex-1 truncate text-xs" title={message.content}>
              {message.content}
            </span>
            <button
              type="button"
              onClick={() => onCancel(message.requestId)}
              aria-label={`Remove queued message: ${message.content}`}
              title="Remove queued message"
              className="shrink-0 rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
