import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChecklistSources } from "./getting-started-model";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({
  currentUser: {} as any,
  api: {
    listRepos: vi.fn(),
    searchTasks: vi.fn(),
  },
}));
const { api } = mocks;
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock("@/lib/api-client", () => ({ api: mocks.api }));

import { GettingStarted, loadChecklistSources } from "./getting-started";
import { useGettingStartedStore } from "./getting-started-store";

const sources = (over: Partial<ChecklistSources> = {}): ChecklistSources => ({
  user: { id: "u1", email: "carol@example.com" },
  repoCount: 1,
  repoPlatforms: ["github"],
  tasks: { started: null, waiting: null, merged: null },
  ...over,
});

const DONE = sources({
  tasks: {
    started: { id: "a", title: "A" },
    waiting: null,
    merged: { id: "a", title: "A", prUrl: "https://github.com/o/r/pull/1" },
  },
});

const KEY = "optio.gettingStarted.hidden.u1";
const signedInAs = (id: string, extra: Record<string, unknown> = {}) => ({
  user: { id, email: `${id}@example.com` },
  authDisabled: false,
  loaded: true,
  isAdmin: false,
  isViewer: false,
  ...extra,
});

beforeEach(() => {
  window.localStorage.clear();
  useGettingStartedStore.setState({ hidden: {} });
  mocks.currentUser = signedInAs("u1", { user: { id: "u1", email: "carol@example.com" } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GettingStarted (the Overview's getting-started checklist)", () => {
  it("shows each step's real state, with links to where it's done", async () => {
    render(<GettingStarted load={async () => sources()} />);
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
    expect(screen.getByTestId("getting-started-sign-in")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("getting-started-repo")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("getting-started-first-task")).toHaveAttribute("data-state", "todo");
    expect(screen.getByRole("link", { name: /New work/ })).toHaveAttribute("href", "/work/new");
    expect(screen.getByText(/2 of 4 done/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByRole("link", { name: /Using Optio, the guide/ })).toHaveAttribute(
      "href",
      "/help",
    );
  });

  it("Hide puts it away for this person, and remembers it", async () => {
    render(<GettingStarted load={async () => sources()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Hide/ }));
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe("dismissed");

    // Next visit: nothing is fetched while it's hidden.
    cleanup();
    useGettingStartedStore.setState({ hidden: {} });
    const load = vi.fn(async () => sources());
    render(<GettingStarted load={load} />);
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();

    // Help → Getting-started checklist brings it back.
    act(() => useGettingStartedStore.getState().show("u1"));
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("another person on the same browser keeps their own: one hiding it doesn't hide it for the next", async () => {
    window.localStorage.setItem("optio.gettingStarted.hidden.someone-else", "dismissed");
    render(<GettingStarted load={async () => sources()} />);
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
  });

  it("never shows one person's checklist to the next person signed in on the same page", async () => {
    // u1's list is on screen; u2 signs in and theirs is still loading.
    let resolveU2: (s: ChecklistSources) => void = () => {};
    const load = vi
      .fn()
      .mockImplementationOnce(async () => sources({ repoCount: 5 }))
      .mockImplementationOnce(() => new Promise<ChecklistSources>((r) => (resolveU2 = r)));
    const { rerender } = render(<GettingStarted load={load} />);
    expect(await screen.findByText(/5 repositories/)).toBeInTheDocument();

    mocks.currentUser = signedInAs("u2");
    rerender(<GettingStarted load={load} />);
    expect(load).toHaveBeenLastCalledWith(
      { id: "u2", email: "u2@example.com" },
      { isViewer: false },
    );
    expect(screen.queryByText(/carol@example.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/5 repositories/)).not.toBeInTheDocument();

    await act(async () =>
      resolveU2(sources({ user: { id: "u2", email: "u2@example.com" }, repoCount: 0 })),
    );
    expect(screen.getByTestId("getting-started-sign-in")).toHaveTextContent(
      "Signed in as u2@example.com.",
    );
  });

  it("goes away once every step is done, and isn't fetched again", async () => {
    render(<GettingStarted load={async () => DONE} />);
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toBe("complete"));
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
  });

  it("complete only for now is shown no more this visit, but not remembered", async () => {
    // A viewer: the sign-in is all their list, until they become a member.
    mocks.currentUser = { ...mocks.currentUser, isViewer: true };
    const load = vi.fn(async () => sources({ repoCount: null, tasks: null }));
    render(<GettingStarted load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("says whether it shows: loading and showing yes, hidden no", async () => {
    const onShowing = vi.fn();
    render(<GettingStarted load={async () => sources()} onShowingChange={onShowing} />);
    expect(onShowing).toHaveBeenLastCalledWith(true);
    fireEvent.click(await screen.findByRole("button", { name: /Hide/ }));
    expect(onShowing).toHaveBeenLastCalledWith(false);
  });

  it("shows nothing with sign-in off (no person to keep it for)", async () => {
    mocks.currentUser = {
      user: null,
      authDisabled: true,
      loaded: true,
      isAdmin: true,
      isViewer: false,
    };
    const load = vi.fn(async () => sources());
    render(<GettingStarted load={load} />);
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
  });
});

describe("loadChecklistSources", () => {
  beforeEach(() => {
    api.listRepos.mockResolvedValue({
      repos: [
        { id: "r1", gitPlatform: "github" },
        { id: "r2", gitPlatform: "gitlab" },
      ],
    });
    api.searchTasks.mockImplementation(async ({ state }: { state?: string }) => ({
      tasks:
        state === "completed"
          ? [
              {
                id: "m",
                title: "Merged",
                prUrl: "https://github.com/o/r/pull/2",
                prState: "merged",
              },
            ]
          : state === "pr_opened"
            ? []
            : [{ id: "s", title: "Started" }],
    }));
  });

  it("reads the existing APIs: the workspace's repos and the person's own tasks only", async () => {
    const got = await loadChecklistSources(
      { id: "u1", email: "carol@example.com" },
      { isViewer: false },
    );
    expect(api.searchTasks).toHaveBeenCalledTimes(3);
    for (const [params] of api.searchTasks.mock.calls) {
      expect(params).toMatchObject({ author: "u1", taskType: "coding" });
    }
    expect(api.searchTasks).toHaveBeenCalledWith({
      author: "u1",
      taskType: "coding",
      state: "pr_opened",
      limit: 1,
    });
    expect(got.repoCount).toBe(2);
    expect(got.repoPlatforms).toEqual(["github", "gitlab"]);
    expect(got.tasks).toEqual({
      started: { id: "s", title: "Started", prUrl: null },
      waiting: null,
      merged: { id: "m", title: "Merged", prUrl: "https://github.com/o/r/pull/2" },
    });
  });

  it("a failed request leaves its source null instead of failing the checklist", async () => {
    api.listRepos.mockRejectedValue(new Error("500"));
    const got = await loadChecklistSources(
      { id: "u1", email: "carol@example.com" },
      { isViewer: false },
    );
    expect(got.repoCount).toBeNull();
    expect(got.tasks?.started?.id).toBe("s");
  });

  it("asks nothing for a viewer", async () => {
    const got = await loadChecklistSources(
      { id: "u1", email: "v@example.com" },
      { isViewer: true },
    );
    expect(api.listRepos).not.toHaveBeenCalled();
    expect(api.searchTasks).not.toHaveBeenCalled();
    expect(got).toEqual({
      user: { id: "u1", email: "v@example.com" },
      repoCount: null,
      repoPlatforms: null,
      tasks: null,
    });
  });
});
