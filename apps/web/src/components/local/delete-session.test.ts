import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api-client";
import { deleteSession } from "./delete-session";

vi.mock("@/lib/api-client", () => ({
  api: { getLocalTerminal: vi.fn(), killLocalTerminal: vi.fn(), deleteLocalTerminal: vi.fn() },
}));
const state = (value: string) => ({ terminal: { state: value } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("deleteSession", () => {
  it("waits for the daemon to acknowledge exit before deleting", async () => {
    vi.mocked(api.getLocalTerminal)
      .mockResolvedValueOnce(state("running"))
      .mockResolvedValueOnce(state("running"))
      .mockResolvedValueOnce(state("exited"));
    const pending = deleteSession("session");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.killLocalTerminal).toHaveBeenCalledWith("session", "SIGKILL");
    expect(api.deleteLocalTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(api.deleteLocalTerminal).toHaveBeenCalledWith("session");
  });

  it("deletes finished sessions without sending kill", async () => {
    vi.mocked(api.getLocalTerminal).mockResolvedValue(state("exited"));
    await deleteSession("session");
    expect(api.killLocalTerminal).not.toHaveBeenCalled();
    expect(api.deleteLocalTerminal).toHaveBeenCalledWith("session");
  });

  it("handles a process exiting just before kill", async () => {
    vi.mocked(api.getLocalTerminal)
      .mockResolvedValueOnce(state("launching"))
      .mockResolvedValueOnce(state("exited"));
    vi.mocked(api.killLocalTerminal).mockRejectedValue(new Error("Terminal is exited"));
    await deleteSession("session");
    expect(api.deleteLocalTerminal).toHaveBeenCalledWith("session");
  });

  it("keeps the record if stopping fails", async () => {
    vi.mocked(api.getLocalTerminal).mockResolvedValue(state("running"));
    vi.mocked(api.killLocalTerminal).mockRejectedValue(new Error("Cannot stop session"));
    await expect(deleteSession("session")).rejects.toThrow("Cannot stop session");
    expect(api.deleteLocalTerminal).not.toHaveBeenCalled();
  });

  it("keeps the record if the daemon never acknowledges exit", async () => {
    vi.mocked(api.getLocalTerminal).mockResolvedValue(state("running"));
    const pending = expect(deleteSession("session")).rejects.toThrow("Still waiting");
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(api.deleteLocalTerminal).not.toHaveBeenCalled();
  });
});
