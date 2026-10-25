import type { AgentLogEntry } from "@optio/shared";
import type { AgentEventParser } from "./event-parsers.js";

/** Pi 1.4 JSON mode. Only agent_settled is terminal: agent_end can precede retries. */
export const parsePiEvent: AgentEventParser = (line, taskId) => {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    const content = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\r/g, "").trim();
    return {
      entries: content
        ? [{ taskId, timestamp: new Date().toISOString(), type: "text", content }]
        : [],
    };
  }
  if (!event || typeof event !== "object") return { entries: [] };
  const entries: AgentLogEntry[] = [];
  const add = (
    type: AgentLogEntry["type"],
    content: string,
    metadata?: AgentLogEntry["metadata"],
  ) => {
    if (content)
      entries.push({ taskId, timestamp: new Date().toISOString(), type, content, metadata });
  };
  if (event.type === "session") {
    return { entries: [], sessionId: typeof event.id === "string" ? event.id : undefined };
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
      if (block?.type === "text" && typeof block.text === "string") add("text", block.text);
      if (block?.type === "thinking" && typeof block.thinking === "string")
        add("thinking", block.thinking);
    }
    if (["error", "aborted", "length"].includes(event.message.stopReason)) {
      add(
        "error",
        typeof event.message.errorMessage === "string"
          ? event.message.errorMessage
          : `Pi response ${event.message.stopReason}`,
      );
    }
  }
  if (event.type === "tool_execution_start") {
    add("tool_use", typeof event.toolName === "string" ? event.toolName : "tool", {
      toolName: event.toolName,
      toolInput: event.args,
      toolUseId: event.toolCallId,
    });
  }
  if (event.type === "tool_execution_end") {
    const content = Array.isArray(event.result?.content)
      ? event.result.content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n")
      : "";
    add("tool_result", content.slice(0, 300), {
      toolUseId: event.toolCallId,
      isError: event.isError,
    });
  }
  if (event.type === "auto_retry_start") add("info", `Pi retry ${event.attempt ?? ""}`);
  if (event.type === "auto_retry_end" && event.success === false)
    add("error", typeof event.finalError === "string" ? event.finalError : "Pi retries exhausted");
  return { entries, ...(event.type === "agent_settled" ? { isTerminal: true } : {}) };
};
