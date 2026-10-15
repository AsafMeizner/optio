import { StrictMode } from "react";
import { renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetSessionPane, rememberSessionLayout, useSessionLayout } from "./use-session-layout";

const nav = vi.hoisted(() => ({ path: "/work/a", query: "", replace: vi.fn() }));
const router = { replace: nav.replace };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => router,
}));
beforeEach(() => {
  window.sessionStorage.clear();
  nav.path = "/work/a";
  nav.query = "";
  nav.replace.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("restores each session after navigation, preserving layout and explicit ungrouping", () => {
  nav.query = "split=b&layout=rows";
  const { rerender } = renderHook(() => useSessionLayout("local"));
  nav.path = "/work/c";
  nav.query = "split=d";
  rerender();
  nav.path = "/work/a";
  nav.query = "";
  rerender();
  expect(nav.replace).toHaveBeenLastCalledWith("/work/a?split=b&layout=rows", { scroll: false });
  nav.query = "split=b&layout=rows";
  rerender();
  nav.query = "";
  rerender();
  nav.path = "/work/c";
  rerender();
  expect(nav.replace).toHaveBeenLastCalledWith("/work/c?split=d", { scroll: false });
  nav.replace.mockClear();
  nav.path = "/work/a";
  rerender();
  expect(nav.replace).not.toHaveBeenCalled();
});

it("survives remounts and Strict Mode without overwriting the saved panes", () => {
  window.sessionStorage.setItem("optio.session-layout:/work/a:", "split=b&layout=rows&ignored=x");
  renderHook(() => useSessionLayout("local"), { wrapper: StrictMode });
  expect(nav.replace).toHaveBeenCalledTimes(1);
  expect(nav.replace).toHaveBeenCalledWith("/work/a?split=b&layout=rows", { scroll: false });
  expect(window.sessionStorage.getItem("optio.session-layout:/work/a:")).toContain("split=b");
});

it("explicit links win, attempts are independent, and unrelated query parameters survive", () => {
  window.sessionStorage.setItem("optio.session-layout:/work/a:", "split=old");
  nav.query = "split=new";
  const { rerender } = renderHook(() => useSessionLayout("local"));
  expect(nav.replace).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem("optio.session-layout:/work/a:")).toBe("split=new");
  nav.query = "session=attempt";
  rerender();
  expect(nav.replace).not.toHaveBeenCalled();
  nav.query = "view=chat";
  rerender();
  expect(nav.replace).toHaveBeenCalledWith("/work/a?view=chat&split=new", { scroll: false });
});

it("restores pod terminals and tolerates unavailable storage", () => {
  window.sessionStorage.setItem("optio.session-layout:/work/a:", "terminals=1%2C2");
  const { unmount } = renderHook(() => useSessionLayout("pod"));
  expect(nav.replace).toHaveBeenCalledWith("/work/a?terminals=1%2C2", { scroll: false });
  unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => renderHook(() => useSessionLayout("pod"))).not.toThrow();
});

it("saves a layout change even when navigation interrupts the URL update", () => {
  nav.query = "split=b";
  const { unmount } = renderHook(() => useSessionLayout("local"));
  const next = "/work/a?split=b&layout=rows";
  expect(rememberSessionLayout(next)).toBe(next);
  // The router never commits the new query before the user leaves.
  unmount();
  nav.query = "";
  renderHook(() => useSessionLayout("local"));
  expect(nav.replace).toHaveBeenCalledWith(next, { scroll: false });
});

it("deleting a terminal removes it from every saved pane group", () => {
  rememberSessionLayout("/work/a?split=b,c&layout=rows");
  rememberSessionLayout("/work/d?split=b&layout=rows");
  rememberSessionLayout("/work/b?split=a");
  forgetSessionPane("b");
  expect(window.sessionStorage.getItem("optio.session-layout:/work/a:")).toBe(
    "split=c&layout=rows",
  );
  expect(window.sessionStorage.getItem("optio.session-layout:/work/d:")).toBe("");
  expect(window.sessionStorage.getItem("optio.session-layout:/work/b:")).toBeNull();
});
