import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { extractWorkLinks } from "@optio/shared";
import { PodSessionRail } from "./pod-session-rail";
const { listSessions } = vi.hoisted(() => ({ listSessions: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api: { listSessions } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/work/session",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("./local/session-rail-header", () => ({
  SessionRailHeader: ({ search, onSearch }: any) => (
    <input
      aria-label="Search sessions"
      value={search}
      onChange={(event) => onSearch(event.target.value)}
    />
  ),
}));
vi.mock("./local/session-rail-scroll", () => ({
  SessionRailScroll: ({ children }: any) => <div>{children}</div>,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows searchable references outside the session navigation link", async () => {
  listSessions.mockResolvedValue({
    sessions: [
      {
        id: "session",
        title: "Pod work",
        repoUrl: "https://github.com/acme/app",
        branch: "main",
        state: "active",
        links: extractWorkLinks("https://linear.app/acme/issue/ENG-9"),
      },
    ],
  });
  render(<PodSessionRail />);
  const badge = await screen.findByRole("link", { name: "ENG-9" });
  expect(badge).toHaveAttribute("href", "https://linear.app/acme/issue/ENG-9");
  expect(badge.parentElement?.closest("a")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
    target: { value: "ENG-9" },
  });
  expect(screen.getByRole("link", { name: /Pod work/ })).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
    target: { value: "ENG-999" },
  });
  expect(screen.queryByRole("link", { name: /Pod work/ })).toBeNull();
});
