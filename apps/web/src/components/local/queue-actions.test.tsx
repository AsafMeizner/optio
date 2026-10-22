import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueueActions, isQueued, queuePlace } from "./queue-actions";

const startLocalTerminal = vi.fn();
const moveLocalTerminalToFront = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    startLocalTerminal: (...args: unknown[]) => startLocalTerminal(...args),
    moveLocalTerminalToFront: (...args: unknown[]) => moveLocalTerminalToFront(...args),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("queue helpers", () => {
  it("knows a queued terminal and words its place", () => {
    expect(isQueued({ state: "pending", pendingReason: "capacity" })).toBe(true);
    expect(isQueued({ state: "pending", pendingReason: "hold" })).toBe(false);
    expect(isQueued({ state: "running", pendingReason: null })).toBe(false);
    expect(queuePlace({ queuePosition: 1 })).toBe("next in line");
    expect(queuePlace({ queuePosition: 3 })).toBe("#3 in line");
    expect(queuePlace({ queuePosition: null })).toBe("in line");
  });
});

describe("QueueActions", () => {
  it("starts now past the limit and reports the new row", async () => {
    startLocalTerminal.mockResolvedValue({ terminal: { id: "t", state: "launching" } });
    const onChanged = vi.fn();
    render(
      <QueueActions
        terminal={{ id: "t", queuePosition: 2 }}
        host={{ name: "laptop", maxConcurrentAgents: 1 }}
        onChanged={onChanged}
      />,
    );
    const now = screen.getByRole("button", { name: "Start now" });
    expect(now.title).toMatch(/past laptop's limit of 1 agent at once/);
    fireEvent.click(now);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ id: "t", state: "launching" }));
    expect(startLocalTerminal).toHaveBeenCalledWith("t", { now: true });
  });

  it("moves to the front, and offers no such move to the one already next", async () => {
    moveLocalTerminalToFront.mockResolvedValue({
      terminal: { id: "t", state: "pending", queuePosition: 1 },
    });
    const onChanged = vi.fn();
    const { rerender } = render(
      <QueueActions terminal={{ id: "t", queuePosition: 3 }} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move to front" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(moveLocalTerminalToFront).toHaveBeenCalledWith("t");

    rerender(<QueueActions terminal={{ id: "t", queuePosition: 1 }} onChanged={onChanged} />);
    expect(screen.queryByRole("button", { name: "Move to front" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start now" })).toBeTruthy();
  });
});
