import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TitleEditor } from "./title-editor";
const { renameSession, updateLocalTerminal } = vi.hoisted(() => ({
  renameSession: vi.fn(),
  updateLocalTerminal: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api: { renameSession, updateLocalTerminal } }));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each(["pod", "local"] as const)("renames a %s session using its own API", async (kind) => {
  const saved = vi.fn();
  renameSession.mockResolvedValue({ session: { title: "New title" } });
  updateLocalTerminal.mockResolvedValue({ terminal: { title: "New title" } });
  render(<TitleEditor terminalId="session" kind={kind} title="Old title" onSaved={saved} />);
  const input = screen.getByRole("textbox", { name: "Session title" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: " New title " } });
  fireEvent.blur(input);
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ title: "New title" }));
  if (kind === "pod") expect(renameSession).toHaveBeenCalledWith("session", "New title");
  else expect(updateLocalTerminal).toHaveBeenCalledWith("session", { title: "New title" });
});

it("Escape discards the edit without saving on blur", () => {
  render(<TitleEditor terminalId="session" kind="pod" title="Old title" />);
  const input = screen.getByRole("textbox", { name: "Session title" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Discard me" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.blur(input);
  expect(input).toHaveValue("Old title");
  expect(renameSession).not.toHaveBeenCalled();
});
