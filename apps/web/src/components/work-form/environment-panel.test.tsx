import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { WorkEnvironmentEntry, WorkEnvironmentOptions } from "@optio/shared";

const mocks = vi.hoisted(() => ({
  getWorkEnvironment: vi.fn(),
  user: { userId: "member", isAdmin: false },
}));
vi.mock("@/lib/api-client", () => ({ api: { getWorkEnvironment: mocks.getWorkEnvironment } }));
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => mocks.user }));
// The gallery's creation form has its own tests. Exercise this panel's catalog
// refresh and ownership handoff without performing a second resource creation.
vi.mock("@/components/connections/connect-gallery", () => ({
  ConnectGallery: ({
    open,
    defaultOwner,
    onClose,
    onCreated,
  }: {
    open: boolean;
    defaultOwner: string;
    onClose: () => void;
    onCreated: (entry: { kind: string; id: string }) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Create connection">
        <span>Default owner: {defaultOwner}</span>
        <button onClick={onClose}>Close gallery</button>
        <button onClick={() => onCreated({ kind: "connection", id: "new" })}>
          Create connection
        </button>
      </div>
    ) : null,
}));

import { EnvironmentPanel } from "./environment-panel";

const entry = (id: string, kind: WorkEnvironmentEntry["kind"]): WorkEnvironmentEntry => ({
  id,
  name: id,
  kind,
  parts: kind === "secret" ? ["credentials"] : ["tools"],
  enabled: true,
  scope: "workspace",
  default: false,
});
const connection = entry("Issue tracker", "connection");
const secret = entry("DEPLOY_TOKEN", "secret");
const server = entry("Database tools", "mcpServer");
const newlyCreated = entry("new", "connection");

function catalog(overrides: Partial<WorkEnvironmentOptions> = {}): WorkEnvironmentOptions {
  return {
    connections: [],
    mcpServers: [],
    skills: [
      { id: "review", name: "Review guide", scope: "repo", default: true, detail: "Review safely" },
      { id: "deploy", name: "Deploy guide", scope: "workspace", default: false },
    ],
    catalog: [connection, secret, server],
    repo: {
      setupCommands: "npm ci",
      reviewEnabled: true,
      reviewTrigger: "on_ci_pass",
      cautiousMode: false,
      maxAutoResumes: 2,
    },
    ...overrides,
  };
}

function setup(overrides: Partial<ComponentProps<typeof EnvironmentPanel>> = {}) {
  const onChange = vi.fn();
  const onToggleEntry = vi.fn();
  const props: ComponentProps<typeof EnvironmentPanel> = {
    settings: {},
    repoUrl: "https://github.com/example/repo",
    agentType: "claude-code",
    owner: "me",
    prApplies: true,
    podSecrets: [],
    entryOn: (item) => item.default,
    onChange,
    onToggleEntry,
    ...overrides,
  };
  const view = render(<EnvironmentPanel {...props} />);
  return { ...view, props, onChange, onToggleEntry };
}

function openPanel() {
  const disclosure = screen.getByRole("button", { name: /Environment/ });
  if (disclosure.getAttribute("aria-expanded") === "false") fireEvent.click(disclosure);
}

async function loaded() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Environment/ })).not.toHaveTextContent("Loading…"),
  );
}

beforeEach(() => {
  mocks.getWorkEnvironment.mockReset().mockResolvedValue(catalog());
  mocks.user.isAdmin = false;
});
afterEach(cleanup);

describe("EnvironmentPanel", () => {
  it("loads defaults for the selected work and keeps controller access opt-in", async () => {
    const { onChange } = setup();
    expect(screen.getByRole("button", { name: /Environment/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByLabelText("Optio controller")).not.toBeInTheDocument();
    await loaded();
    expect(mocks.getWorkEnvironment).toHaveBeenCalledWith({
      repoUrl: "https://github.com/example/repo",
      agentType: "claude-code",
      owner: "me",
    });
    expect(screen.getByRole("button", { name: /Environment/ })).toHaveTextContent(
      "nothing connected · 1 skill",
    );
    openPanel();
    expect(screen.getByLabelText("Optio controller")).toHaveValue("off");
    fireEvent.change(screen.getByLabelText("Optio controller"), { target: { value: "read" } });
    expect(onChange).toHaveBeenLastCalledWith({ controllerAccess: "read" });
    fireEvent.change(screen.getByLabelText("Optio controller"), { target: { value: "manage" } });
    expect(onChange).toHaveBeenLastCalledWith({ controllerAccess: "manage" });
    expect(screen.queryByTestId("work-environment-reset")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Environment/ }));
    expect(screen.queryByLabelText("Optio controller")).not.toBeInTheDocument();
  });

  it("stores only skill overrides and preserves other settings when changing setup commands", async () => {
    const { onChange } = setup({ settings: { controllerAccess: "read" } });
    await loaded();
    const skills = screen.getByRole("group", { name: "Skills" });
    const defaultSkill = within(skills).getByRole("button", { name: /Review guide/ });
    expect(defaultSkill).toHaveAttribute("aria-pressed", "true");
    expect(defaultSkill).toHaveAttribute("title", "Review safely");
    fireEvent.click(defaultSkill);
    expect(onChange).toHaveBeenLastCalledWith({
      controllerAccess: "read",
      skills: { remove: ["review"] },
    });
    fireEvent.click(within(skills).getByRole("button", { name: /Deploy guide/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      controllerAccess: "read",
      skills: { add: ["deploy"] },
    });
    fireEvent.change(screen.getByLabelText("Setup commands"), {
      target: { value: "npm run check" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      controllerAccess: "read",
      setupCommands: "npm run check",
    });
    expect(screen.getByText(/repo's own setup commands still run/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("work-environment-reset"));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("offers command jobs only secrets, without agent tools or controller access", async () => {
    const { onToggleEntry } = setup({
      command: true,
      prApplies: false,
      podSecrets: [secret.id],
      entryOn: () => true,
    });
    await loaded();
    const summary = screen.getByRole("button", { name: /Environment/ });
    expect(summary).toHaveTextContent("DEPLOY_TOKEN");
    expect(summary).not.toHaveTextContent("Issue tracker");
    expect(summary).not.toHaveTextContent("skill");
    expect(screen.queryByLabelText("Optio controller")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Skills" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Auto-resumes")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Setup commands")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Add a connection"));
    const choices = screen.getAllByRole("option");
    expect(choices).toHaveLength(1);
    expect(choices[0]).toHaveTextContent("DEPLOY_TOKEN");
    fireEvent.click(choices[0]);
    expect(onToggleEntry).toHaveBeenCalledWith(secret, false);
  });

  it("shows workspace defaults and no invented skills or PR settings for standalone commands", async () => {
    mocks.getWorkEnvironment.mockResolvedValue(catalog({ repo: null, skills: [] }));
    const { onChange } = setup({
      repoUrl: null,
      command: true,
      prApplies: false,
      settings: { setupCommands: "echo ready" },
    });
    await loaded();
    expect(screen.getByRole("button", { name: /Environment/ })).toHaveTextContent(
      "1 change from the workspace's defaults · no secrets",
    );
    expect(screen.getByLabelText("Setup commands")).toHaveValue("echo ready");
    expect(screen.queryByText(/repo's own setup/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pod itself/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the workspace's defaults" }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it.each([
    [true, "on_pr", "Repo (on PR)"],
    [true, "on_ci_pass", "Repo (after CI)"],
    [true, "manual", "Repo (manual)"],
    [false, null, "Repo (off)"],
  ])(
    "explains the repository's review policy: %s / %s",
    async (reviewEnabled, reviewTrigger, label) => {
      mocks.getWorkEnvironment.mockResolvedValue(
        catalog({ repo: { ...catalog().repo!, reviewEnabled, reviewTrigger } }),
      );
      const { onChange } = setup();
      await loaded();
      openPanel();
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Review when the PR opens" }));
      expect(onChange).toHaveBeenLastCalledWith({ review: { enabled: true, trigger: "on_pr" } });
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onChange).toHaveBeenLastCalledWith({ review: undefined });
    },
  );

  it("allows stricter PR settings, caps auto-resumes, and restores inherited settings", async () => {
    const { onChange } = setup({
      settings: { review: { enabled: true }, cautiousMode: true, maxAutoResumes: 1 },
    });
    await loaded();
    expect(screen.getByRole("button", { name: "Review once CI passes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Draft — a person merges" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const input = screen.getByLabelText("Auto-resumes");
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "2");
    fireEvent.change(input, { target: { value: "99" } });
    expect(onChange).toHaveBeenLastCalledWith({
      review: { enabled: true },
      cautiousMode: true,
      maxAutoResumes: 2,
    });
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({
      review: { enabled: true },
      cautiousMode: true,
      maxAutoResumes: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "Repo (ready for review)" }));
    expect(onChange).toHaveBeenLastCalledWith({
      review: { enabled: true },
      cautiousMode: undefined,
      maxAutoResumes: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft — a person merges" }));
    expect(onChange).toHaveBeenLastCalledWith({
      review: { enabled: true },
      cautiousMode: true,
      maxAutoResumes: 1,
    });
  });

  it("inherits a repository's draft requirement and the default auto-resume cap", async () => {
    mocks.getWorkEnvironment.mockResolvedValue(
      catalog({
        skills: [],
        repo: { ...catalog().repo!, cautiousMode: true, maxAutoResumes: null },
      }),
    );
    setup({ settings: { cautiousMode: true, review: { enabled: false } } });
    await loaded();
    expect(screen.getByRole("button", { name: "Repo (draft)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Repo (ready for review)" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Auto-resumes")).toHaveAttribute("max", "10");
    expect(screen.getByLabelText("Auto-resumes")).toHaveAttribute("placeholder", "10");
    expect(screen.getByText("No custom skills configured.")).toBeInTheDocument();
  });

  it.each([
    [false, "workspace", "private"],
    [true, "workspace", "organization"],
    [true, "me", "private"],
  ] as const)(
    "passes the safe gallery owner for admin=%s and work owner=%s",
    async (isAdmin, owner, expected) => {
      mocks.user.isAdmin = isAdmin;
      setup({ owner });
      await loaded();
      openPanel();
      fireEvent.click(screen.getByLabelText("Add a connection"));
      fireEvent.click(screen.getByRole("button", { name: "Connect something new…" }));
      expect(screen.getByRole("dialog")).toHaveTextContent(`Default owner: ${expected}`);
      fireEvent.click(screen.getByRole("button", { name: "Close gallery" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it.each([false, true])(
    "refreshes newly created connections without double-toggling connected=%s",
    async (connected) => {
      mocks.getWorkEnvironment
        .mockResolvedValueOnce(catalog())
        .mockResolvedValueOnce(catalog({ catalog: [connection, newlyCreated] }));
      const { onToggleEntry } = setup({ entryOn: (item) => connected && item.id === "new" });
      await loaded();
      openPanel();
      fireEvent.click(screen.getByLabelText("Add a connection"));
      fireEvent.click(screen.getByRole("button", { name: "Connect something new…" }));
      fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
      await waitFor(() => expect(mocks.getWorkEnvironment).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      if (connected) {
        await waitFor(() => expect(screen.getByTestId("connected-chip")).toHaveTextContent("new"));
        expect(onToggleEntry).not.toHaveBeenCalled();
      } else {
        await waitFor(() =>
          expect(onToggleEntry).toHaveBeenCalledExactlyOnceWith(newlyCreated, true),
        );
      }
    },
  );

  it("does not display invented catalog entries when loading fails", async () => {
    mocks.getWorkEnvironment.mockRejectedValue(new Error("Unavailable"));
    setup({ settings: { controllerAccess: "off" } });
    await act(async () => {});
    openPanel();
    expect(screen.getByRole("button", { name: /Environment/ })).toHaveTextContent("Loading…");
    expect(screen.queryByRole("group", { name: "Skills" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("connected-chip")).not.toBeInTheDocument();
  });

  it("ignores a previous work owner's late catalog response", async () => {
    let resolveOld!: (value: WorkEnvironmentOptions) => void;
    mocks.getWorkEnvironment
      .mockReturnValueOnce(
        new Promise<WorkEnvironmentOptions>((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce(catalog({ skills: [], repo: null, catalog: [secret] }));
    const { props, rerender } = setup({ entryOn: () => true });
    rerender(<EnvironmentPanel {...props} owner="workspace" repoUrl={null} />);
    await loaded();
    expect(screen.getByRole("button", { name: /Environment/ })).toHaveTextContent("DEPLOY_TOKEN");
    await act(async () => {
      resolveOld(catalog());
    });
    expect(screen.getByRole("button", { name: /Environment/ })).not.toHaveTextContent(
      "Issue tracker",
    );
    expect(mocks.getWorkEnvironment).toHaveBeenLastCalledWith({
      repoUrl: null,
      agentType: "claude-code",
      owner: "workspace",
    });
  });
});
