import { expect, it } from "vitest";
import { getEventParser } from "./event-parsers.js";
import { parsePiEvent } from "./pi-event-parser.js";

const parse = (event: unknown) => parsePiEvent(JSON.stringify(event), "task");
it("registers Pi and exposes the exact session id", () => {
  expect(getEventParser("pi")).toBe(parsePiEvent);
  expect(parse({ type: "session", id: "exact-id" }).sessionId).toBe("exact-id");
});
it("waits for settlement rather than terminating before an automatic retry", () => {
  expect(parse({ type: "agent_end", willRetry: true }).isTerminal).toBeUndefined();
  expect(parse({ type: "agent_settled", aborted: false }).isTerminal).toBe(true);
});
it("renders completed assistant text and thinking only once", () => {
  expect(
    parse({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } })
      .entries,
  ).toEqual([]);
  expect(
    parse({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think" },
          { type: "text", text: "hello" },
        ],
      },
    }).entries.map((e) => e.type),
  ).toEqual(["thinking", "text"]);
  expect(parse({ type: "turn_end", message: { role: "assistant" } }).entries).toEqual([]);
});
it("correlates tool calls/results and keeps tool errors separate from run completion", () => {
  const started = parse({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "call",
    args: { command: "pwd" },
  });
  expect(started.entries[0]).toMatchObject({
    type: "tool_use",
    metadata: { toolName: "bash", toolUseId: "call" },
  });
  const ended = parse({
    type: "tool_execution_end",
    toolCallId: "call",
    isError: true,
    result: { content: [{ type: "text", text: "failed" }] },
  });
  expect(ended.entries[0]).toMatchObject({
    type: "tool_result",
    metadata: { toolUseId: "call", isError: true },
  });
  expect(ended.isTerminal).toBeUndefined();
});
it("handles primitive and non JSON records", () => {
  expect(parse(null).entries).toEqual([]);
  expect(parsePiEvent("shell diagnostic", "task").entries[0].content).toBe("shell diagnostic");
});
