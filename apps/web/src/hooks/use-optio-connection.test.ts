import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOptioConnection } from "./use-optio-connection";
import { useOptioChatStore } from "./use-optio-chat";

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    Socket.all.push(this);
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const state = () => useOptioChatStore.getState();
beforeEach(() => {
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  useOptioChatStore.setState({
    isOpen: false,
    messages: [],
    queuedMessages: [],
    status: "ready",
    exchangeCount: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const connect = () => {
  const hook = renderHook(() => useOptioConnection());
  act(() => state().open());
  const socket = Socket.all[0];
  act(() => socket.receive({ type: "status", status: "ready" }));
  return { ...hook, socket };
};

describe("Optio connection", () => {
  it("connects lazily, streams real replies and stays connected when hidden", () => {
    const hook = renderHook(() => useOptioConnection());
    expect(Socket.all).toHaveLength(0);
    act(() => state().open());
    const socket = Socket.all[0];
    expect(socket.url).toContain("/ws/optio/chat");
    expect(hook.result.current.send("too soon")).toBe(false);
    act(() => socket.receive({ type: "status", status: "ready" }));
    act(() => {
      expect(hook.result.current.send("Start Codex")).toBe(true);
    });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: "message",
      content: "Start Codex",
      requestId: expect.any(String),
    });
    act(() =>
      socket.receive({
        type: "user_message",
        content: "Start Codex",
        requestId: JSON.parse(socket.send.mock.calls[0][0]).requestId,
      }),
    );
    act(() => socket.receive({ type: "text", content: "I found " }));
    act(() => socket.receive({ type: "text", content: "your Mac." }));
    expect(state().messages[1].content).toBe("I found your Mac.");
    act(() => state().close());
    expect(socket.close).not.toHaveBeenCalled();
  });
  it("waits for approval, sends a decision once and leaves conversation context on the server", () => {
    const { result, socket } = connect();
    act(() =>
      socket.receive({
        type: "action_proposal",
        actionId: "a1",
        description: "Create work",
        items: ["Start Codex"],
      }),
    );

    act(() => result.current.decide("a1", true));
    act(() => result.current.decide("a1", true));
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      type: "approve",
      actionId: "a1",
    });
    act(() => socket.receive({ type: "action_result", success: true, summary: "Created" }));
    act(() => socket.receive({ type: "status", status: "ready" }));
    act(() => result.current.send("What is next?"));
    expect(JSON.parse(socket.send.mock.calls[1][0])).toMatchObject({
      type: "message",
      content: "What is next?",
      requestId: expect.any(String),
    });
    expect(JSON.parse(socket.send.mock.calls[1][0])).not.toHaveProperty("conversationContext");
  });
  it("does not replay messages or approvals after a disconnect", () => {
    const { result, socket } = connect();
    act(() =>
      socket.receive({
        type: "action_proposal",
        actionId: "a1",
        description: "Create work",
        items: [],
      }),
    );
    act(() => socket.onclose?.());
    expect(state().status).toBe("disconnected");
    act(() => result.current.decide("a1", true));
    expect(socket.send).not.toHaveBeenCalled();
    act(() => result.current.reconnect());
    expect(Socket.all).toHaveLength(2);
    act(() => Socket.all[1].receive({ type: "status", status: "ready" }));
    expect(Socket.all[1].send).not.toHaveBeenCalled();
    expect(state().messages[0].action?.decision).toBe(false);
    act(() => socket.receive({ type: "text", content: "late" }));
    expect(state().messages.some((m) => m.content === "late")).toBe(false);
  });
});

it("restores saved history and settles a proposal decided from another client", () => {
  const { result, socket } = connect();
  act(() =>
    socket.receive({
      type: "history",
      href: "/sessions/12345678-1234-1234-1234-123456789abc",
      frames: [
        { type: "user_message", content: "Saved request" },
        { type: "text", content: "Saved reply" },
      ],
    }),
  );
  expect(state().messages.map((m) => m.content)).toEqual(["Saved request", "Saved reply"]);
  expect(result.current.sessionHref).toContain("/work/");
  act(() =>
    socket.receive({
      type: "action_proposal",
      actionId: "approval",
      description: "Create work",
      items: [],
    }),
  );
  act(() => result.current.reset());
  expect(socket.send).not.toHaveBeenCalled();
  act(() => socket.receive({ type: "action_decision", actionId: "approval", approved: true }));
  expect(state().messages.at(-1)?.action?.decision).toBe(true);
  act(() => result.current.reset());
  expect(state().messages).toHaveLength(3);
  act(() => socket.receive({ type: "history", frames: [] }));
  expect(state().messages).toHaveLength(0);
});

it("updates the harness badge from the session's runtime and model", () => {
  const { socket } = connect();
  act(() =>
    socket.receive({ type: "status", status: "thinking", runtime: "codex", model: "test-model" }),
  );
  expect(state()).toMatchObject({ agentRuntime: "codex", agentModel: "test-model" });
  act(() => socket.receive({ type: "status", status: "ready" }));
  expect(state().agentModel).toBe("test-model");
  act(() => socket.receive({ type: "status", status: "thinking", runtime: "cursor", model: "" }));
  expect(state()).toMatchObject({ agentRuntime: "cursor", agentModel: "" });
});

it("accepts messages while thinking and waiting for approval, restores the queue and cancels without replay", () => {
  const { result, socket } = connect();
  act(() => socket.receive({ type: "status", status: "thinking" }));
  act(() => expect(result.current.send("Next request")).toBe(true));
  const sent = JSON.parse(socket.send.mock.calls[0][0]);
  expect(state().messages).toEqual([]);
  act(() =>
    socket.receive({
      type: "queue",
      messages: [{ requestId: sent.requestId, content: sent.content }],
    }),
  );
  expect(state().queuedMessages).toHaveLength(1);
  act(() => result.current.reset());
  expect(socket.send).toHaveBeenCalledTimes(1);
  act(() => result.current.cancelQueued(sent.requestId));
  expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({
    type: "cancel_queued",
    requestId: sent.requestId,
  });
  act(() => socket.receive({ type: "queue", messages: [] }));
  act(() =>
    socket.receive({
      type: "action_proposal",
      actionId: "proposal",
      description: "Confirm",
      items: [],
    }),
  );
  act(() => expect(result.current.send("After this approval")).toBe(true));
  expect(state().queuedMessages).toEqual([]);
});
