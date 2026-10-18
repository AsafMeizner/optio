"use client";

import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/brand-icon";
import { runtimeLabel } from "@/components/agent-choice-model";
import { OptioMark } from "@/components/optio-mark";
import {
  Minus,
  ExternalLink,
  ArrowUp,
  Eraser,
  Loader2,
  Mic,
  Square,
  Maximize2,
  Minimize2,
  ArrowUpRight,
  AlertCircle,
  Anchor,
} from "lucide-react";
import { useOptioChatStore } from "@/hooks/use-optio-chat";
import { useOptioConnection } from "@/hooks/use-optio-connection";
import { useDictation } from "@/hooks/use-dictation";
import { ActionCard } from "./action-card.js";
import { api } from "@/lib/api-client";
import { ChatMarkdown } from "./chat-markdown.js";

const SUGGESTIONS = [
  {
    title: "Start a work session",
    detail: "Choose a machine, repo and agent together",
    prompt:
      "Help me start an agent work session. Show me my machines and repos so we can choose where it should run.",
  },
  {
    title: "Hand off a task",
    detail: "Describe a change and have an agent take it on",
    prompt:
      "I want to hand off a coding task. Help me choose a repo and an agent, then create the work.",
  },
  {
    title: "See what needs me",
    detail: "Catch up on work across the workspace",
    prompt: "Look at my work and summarize what needs my attention.",
  },
];

export function OptioChatPanel() {
  const { isOpen, messages, prefillInput, status, confirmWrites, agentRuntime, agentModel } =
    useOptioChatStore();
  const connection = useOptioConnection();
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [docked, setDocked] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const appendTranscript = useCallback((text: string) => {
    if (text) setInput((draft) => (draft ? `${draft.trimEnd()} ${text}` : text));
  }, []);
  const dictation = useDictation(appendTranscript);
  const pending = messages.some((m) => m.action?.decision === null);
  const busy = status === "thinking";
  const connected = status === "ready" || busy;
  const statusLabel =
    status === "starting"
      ? "Connecting"
      : busy
        ? "Working"
        : !connected
          ? "Disconnected"
          : pending
            ? "Awaiting approval"
            : "Ready";
  const canCompose = status === "ready" && !pending;

  useEffect(() => {
    try {
      setDocked(localStorage.getItem("optio.assistant.docked") === "true");
    } catch {
      // Docking still works when browser storage is unavailable.
    }
  }, []);

  const toggleDocked = () => {
    const next = !docked;
    setDocked(next);
    try {
      localStorage.setItem("optio.assistant.docked", String(next));
    } catch {
      // Keep the preference for this visit.
    }
  };

  useEffect(() => {
    api
      .getOptioSettings()
      .then(({ settings }) => {
        const store = useOptioChatStore.getState();
        store.setConfirmWrites(settings.confirmWrites);
        if (!store.agentRuntime) store.setAgentConfiguration(settings.agentRuntime, settings.model);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (prefillInput && isOpen) {
      setInput(prefillInput);
      useOptioChatStore.getState().setPrefillInput("");
    }
  }, [prefillInput, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      dictation.cancel();
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        useOptioChatStore.getState().close();
      }
      // The desktop panel is non-modal; only trap focus in the mobile overlay.
      if (event.key === "Tab" && window.matchMedia("(max-width: 767px)").matches) {
        const controls = panelRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href]",
        );
        if (!controls?.length) return;
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [isOpen, dictation.cancel]);

  useEffect(() => {
    if (isOpen && follow.current && scrollRef.current)
      scrollRef.current.scrollTop = messages.length ? scrollRef.current.scrollHeight : 0;
  }, [messages, busy, isOpen]);

  useEffect(() => {
    const field = inputRef.current;
    if (field) {
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
    }
  }, [input, isOpen]);

  const send = () => {
    if (dictation.active || !canCompose) return;
    if (connection.send(input)) {
      setInput("");
      follow.current = true;
    }
  };
  const iconButton =
    "rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-primary";

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => useOptioChatStore.getState().close()}
        />
      )}
      <aside
        ref={panelRef}
        role="dialog"
        aria-label="Optio assistant"
        aria-hidden={!isOpen}
        inert={!isOpen}
        data-docked={docked}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex min-h-0 h-[var(--app-height,100dvh)] w-full flex-col overflow-hidden md:h-auto border-l border-border bg-bg shadow-2xl md:inset-y-3 md:right-3 md:rounded-2xl md:border",
          expanded ? "md:w-[min(720px,calc(100vw-280px))]" : "md:w-[480px]",
          docked &&
            "lg:static lg:z-10 lg:h-full lg:shrink-0 lg:rounded-none lg:border-0 lg:border-l lg:shadow-none",
          docked && (expanded ? "lg:w-[min(640px,45vw)]" : "lg:w-[clamp(360px,32vw,480px)]"),
          !isOpen && "hidden",
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <OptioMark className="h-5 w-5 text-primary" />
              {agentRuntime && (
                <span
                  role="img"
                  aria-label={`${runtimeLabel(agentRuntime)} · ${agentModel || "Default model"}`}
                  title={`${runtimeLabel(agentRuntime)} · ${agentModel || "Default model"}`}
                  className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-md border border-border bg-bg-card shadow-sm"
                >
                  <AgentIcon runtime={agentRuntime} colored className="h-3 w-3" />
                </span>
              )}
            </div>
            <h2
              aria-label="Optio Agent"
              className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-heading"
            >
              <span className="truncate">Optio Agent</span>
              <span
                role="status"
                aria-label={statusLabel}
                title={statusLabel}
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  busy || status === "starting"
                    ? "animate-pulse bg-primary"
                    : pending
                      ? "bg-warning"
                      : connected
                        ? "bg-success"
                        : "bg-text-muted/50",
                )}
              />
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {connection.sessionHref && (
              <Link
                href={connection.sessionHref}
                onClick={() => useOptioChatStore.getState().close()}
                className={iconButton}
                aria-label="Open in session"
                title="Open in session"
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            )}
            <button
              className={cn(iconButton, "hidden lg:block", docked && "bg-primary/10 text-primary")}
              title={docked ? "Float assistant" : "Dock assistant beside the page"}
              aria-label={docked ? "Float assistant" : "Dock assistant"}
              aria-pressed={docked}
              onClick={toggleDocked}
            >
              <Anchor className="h-4 w-4" />
            </button>
            <button
              className={iconButton}
              title="Clear conversation history"
              aria-label="Clear conversation"
              disabled={status !== "ready" || pending}
              onClick={() => {
                dictation.cancel();
                connection.reset();
                setInput("");
              }}
            >
              <Eraser className="h-4 w-4" />
            </button>
            <button
              className={cn(iconButton, "hidden md:block")}
              title={expanded ? "Narrow panel" : "Expand panel"}
              aria-label={expanded ? "Narrow panel" : "Expand panel"}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              className={iconButton}
              title="Minimize (Esc)"
              aria-label="Minimize Optio"
              onClick={() => useOptioChatStore.getState().close()}
            >
              <Minus className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6"
          data-testid="optio-conversation-scroll"
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {messages.length === 0 ? (
            <div className="flex min-h-full flex-col pb-2">
              <p className="mb-3 text-xs font-medium text-primary">FROM IDEA TO RUNNING WORK</p>
              <h3 className="max-w-sm text-3xl font-semibold tracking-tight text-text-heading">
                What would you like
                <br />
                to get done?
              </h3>
              <p className="mt-3 max-w-sm text-sm leading-relaxed text-text-muted">
                Tell me what you have in mind. I can find the right repo, start an agent, and set up
                the work with you.
              </p>
              <div className="mt-8 space-y-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion.title}
                    onClick={() => {
                      setInput(suggestion.prompt);
                      inputRef.current?.focus();
                    }}
                    className="group flex w-full items-center justify-between gap-3 rounded-xl border border-border/70 bg-bg-card px-4 py-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                  >
                    <span>
                      <span className="block text-sm font-medium text-text">
                        {suggestion.title}
                      </span>
                      <span className="mt-1 block text-xs text-text-muted">
                        {suggestion.detail}
                      </span>
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-text-muted group-hover:text-primary" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6" role="log" aria-label="Conversation">
              {messages.map((msg) => (
                <div key={msg.id} className={cn("min-w-0", msg.role === "user" && "ml-8")}>
                  {msg.role === "user" ? (
                    <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3 text-sm leading-relaxed text-text">
                      {msg.content}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
                        <OptioMark className="h-3.5 w-3.5 text-primary" />
                        Optio
                      </div>
                      {msg.action ? (
                        <ActionCard
                          action={msg.action}
                          disabled={!connected || busy}
                          onApprove={(id) => connection.decide(id, true)}
                          onDeny={(id, feedback) => connection.decide(id, false, feedback)}
                        />
                      ) : (
                        <div
                          className={cn(
                            "break-words",
                            msg.isError && "rounded-xl border border-error/20 bg-error/5 p-3",
                          )}
                        >
                          <ChatMarkdown content={msg.content} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {busy && (
                <div role="status" className="flex items-center gap-2 text-xs text-text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Working on it…
                </div>
              )}
            </div>
          )}
        </div>

        <div
          className="max-h-[60%] shrink-0 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          data-testid="optio-composer"
        >
          {!connected && status !== "starting" && (
            <div className="mb-3 rounded-xl border border-warning/20 bg-warning/5 p-3 text-xs text-text">
              <p>Connection lost. Actions won’t be retried automatically.</p>
              <button
                onClick={connection.reconnect}
                className="mt-2 font-medium text-primary hover:underline"
              >
                Reconnect
              </button>
            </div>
          )}
          {pending && connected && (
            <p className="pb-3 text-xs text-text-muted">
              Review the proposed action above to continue.
            </p>
          )}

          <div
            className={cn(
              "optio-composer rounded-xl border bg-bg-card p-2 transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10",
              dictation.active ? "border-primary/60" : "border-border",
            )}
          >
            <textarea
              ref={inputRef}
              aria-label="Message Optio"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Message Optio…"
              rows={1}
              className="block min-h-8 max-h-[min(120px,calc(var(--app-height,100dvh)*0.25))] w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-text outline-none placeholder:text-text-muted"
            />
            {dictation.active && (
              <div
                role="status"
                className="mb-2 rounded-lg bg-primary/5 px-2 py-2 text-xs text-primary"
              >
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                  {dictation.state === "starting"
                    ? "Opening microphone…"
                    : dictation.state === "stopping"
                      ? "Finishing dictation…"
                      : "Listening…"}
                </span>
                {dictation.interim && (
                  <p className="mt-1.5 leading-relaxed text-text-muted">{dictation.interim}</p>
                )}
              </div>
            )}
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={dictation.active ? dictation.stop : dictation.start}
                disabled={dictation.state === "stopping"}
                aria-label={dictation.active ? "Stop dictation" : "Start dictation"}
                aria-pressed={dictation.active}
                title={
                  dictation.supported
                    ? "Dictate a message"
                    : "Use keyboard dictation or a supported browser on HTTPS"
                }
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors disabled:opacity-40",
                  dictation.active
                    ? "bg-primary/10 text-primary"
                    : "text-text-muted hover:bg-bg-hover hover:text-text",
                )}
              >
                {dictation.active ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {dictation.active ? "Stop dictation" : "Dictate"}
              </button>
              <button
                onClick={send}
                aria-label="Send message"
                title="Send (Enter)"
                disabled={!input.trim() || !canCompose || dictation.active}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </div>
          {dictation.unavailable && !dictation.error && (
            <p className="mt-2 px-1 text-xs text-text-muted">{dictation.unavailable}</p>
          )}
          {dictation.error && (
            <p role="alert" className="mt-2 flex items-start gap-1.5 px-1 text-xs text-error">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {dictation.error}
            </p>
          )}
          {(dictation.active || !confirmWrites) && (
            <p className="mt-2 px-1 text-center text-[11px] leading-relaxed text-text-muted">
              {dictation.active
                ? "Review your words, then send. Audio is handled by your browser’s speech service."
                : "Actions run directly · confirmation is off in Settings."}
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
