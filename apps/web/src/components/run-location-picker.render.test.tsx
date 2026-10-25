import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const hostsState = vi.hoisted(() => ({
  hosts: [] as any[],
  loading: false,
  replaceHost: vi.fn(),
}));
vi.mock("@/hooks/use-local-hosts", () => ({
  useLocalHosts: () => ({ ...hostsState, refetch: vi.fn() }),
}));

const addLocalHostDir = vi.fn();
const coder = vi.hoisted(() => ({
  connections: [] as any[],
  templates: [] as any[],
  parameters: [] as any[],
  workspaces: [] as any[],
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    getAuthProviders: () => Promise.resolve({ providers: [], authDisabled: true }),
    addLocalHostDir: (...args: unknown[]) => addLocalHostDir(...args),
    removeLocalHostDir: vi.fn(),
    listRemoteWorkspaceConnections: () => Promise.resolve({ connections: coder.connections }),
    listRemoteWorkspaceTemplates: () =>
      Promise.resolve({ organizationId: "org1", templates: coder.templates }),
    getRemoteWorkspaceTemplateParameters: () => Promise.resolve({ parameters: coder.parameters }),
    listRemoteWorkspaces: () => Promise.resolve({ workspaces: coder.workspaces }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { RunLocationPicker, type RunLocationValue } from "./run-location-picker";
import { EMPTY_REMOTE_WORKSPACE } from "@/components/remote-workspaces/location";

const LOCAL: RunLocationValue = {
  runTarget: "local",
  localHostId: "",
  localDir: "",
  localSessionMode: "headless",
};

const laptop = (extra: Record<string, unknown> = {}) => ({
  id: "h1",
  name: "laptop",
  state: "online",
  manageDirs: true,
  dirs: [] as Array<{ path: string; repoUrl?: string }>,
  ...extra,
});

beforeEach(() => {
  coder.connections = [];
  coder.templates = [];
  coder.parameters = [];
  coder.workspaces = [];
  hostsState.hosts = [];
  hostsState.loading = false;
  hostsState.replaceHost.mockReset();
  addLocalHostDir.mockReset();
});

afterEach(() => cleanup());

describe("RunLocationPicker on my machine", () => {
  it("with no machine paired, shows how to pair one instead of empty dropdowns", async () => {
    render(<RunLocationPicker value={LOCAL} onChange={vi.fn()} kind="job" />);
    expect(screen.getByText(/No machine is paired yet/)).toBeInTheDocument();
    expect(await screen.findByText(/local up$/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps My machine pickable while none is paired, and says why to pick it", () => {
    const onChange = vi.fn();
    render(
      <RunLocationPicker
        value={{ ...LOCAL, runTarget: "cluster" }}
        onChange={onChange}
        kind="job"
      />,
    );
    const card = screen.getByRole("button", { name: /My machine/ });
    expect(card).toBeEnabled();
    expect(card).toHaveTextContent("None paired yet — pick it to see how.");
    fireEvent.click(card);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ runTarget: "local" }));
  });

  it("offers to add a directory on a machine that has none, and selects what it adds", async () => {
    const host = laptop();
    hostsState.hosts = [host];
    const added = { ...host, dirs: [{ path: "/Users/me/notes" }] };
    addLocalHostDir.mockResolvedValue({ host: added, path: "/Users/me/notes" });
    const onChange = vi.fn();
    render(
      <RunLocationPicker value={{ ...LOCAL, localHostId: "h1" }} onChange={onChange} kind="job" />,
    );

    const input = screen.getByLabelText("Directory on laptop");
    fireEvent.change(input, { target: { value: "~/notes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ localHostId: "h1", localDir: "/Users/me/notes" }),
      ),
    );
    expect(hostsState.replaceHost).toHaveBeenCalledWith(added);
  });

  it("puts '+ Add a directory…' in the Directory list and opens the form from it", () => {
    hostsState.hosts = [laptop({ dirs: [{ path: "/Users/me/app", repoUrl: "git@x:a/b.git" }] })];
    const onChange = vi.fn();
    render(
      <RunLocationPicker
        value={{ ...LOCAL, localHostId: "h1", localDir: "/Users/me/app" }}
        onChange={onChange}
        kind="job"
      />,
    );
    expect(screen.queryByLabelText("Directory on laptop")).not.toBeInTheDocument();
    const dirSelect = screen.getAllByRole("combobox")[1];
    fireEvent.change(dirSelect, { target: { value: "__add__" } });
    expect(screen.getByLabelText("Directory on laptop")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ localDir: "__add__" }));
  });

  it("lets a run use a subdirectory of an allowlisted directory (#622)", () => {
    hostsState.hosts = [laptop({ dirs: [{ path: "/Users/me/app" }] })];
    const onChange = vi.fn();
    render(
      <RunLocationPicker
        value={{ ...LOCAL, localHostId: "h1", localDir: "/Users/me/app/packages/api" }}
        onChange={onChange}
        kind="job"
      />,
    );
    // The select shows the allowlisted root, the input the part below it.
    expect(screen.getAllByRole("combobox")[1]).toHaveValue("/Users/me/app");
    const sub = screen.getByLabelText(/Subdirectory/);
    expect(sub).toHaveValue("packages/api");

    fireEvent.change(sub, { target: { value: "packages/web" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ localDir: "/Users/me/app/packages/web" }),
    );

    fireEvent.change(sub, { target: { value: "../secrets" } });
    expect(screen.getByText(/can't leave the directory/)).toBeInTheDocument();
  });

  it("gives the command to run when the machine can't take the request", () => {
    hostsState.hosts = [laptop({ manageDirs: false, state: "offline" })];
    render(
      <RunLocationPicker value={{ ...LOCAL, localHostId: "h1" }} onChange={vi.fn()} kind="job" />,
    );
    expect(screen.getByText(/laptop is offline — start optio local up on it/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Directory on laptop")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Add a directory/ })).not.toBeInTheDocument();
  });
});

const connection = (extra: Record<string, unknown> = {}) => ({
  id: "c1",
  provider: "coder",
  name: "Corp Coder",
  url: "https://coder.example.com",
  enabled: true,
  ownerUserId: null,
  ownerTeamId: null,
  templateId: "t1",
  templateVersionId: null,
  templateName: "Base",
  defaultParameters: { region: "eu" },
  ttlMs: 8 * 60 * 60_000,
  deleteWhenDone: false,
  ...extra,
});

const param = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  displayName: null,
  description: null,
  type: "string",
  mutable: true,
  required: false,
  defaultValue: null,
  ephemeral: false,
  options: [],
  setByOptio: name.startsWith("optio_"),
  ...extra,
});

const CODER: RunLocationValue = {
  ...LOCAL,
  remoteWorkspace: { ...EMPTY_REMOTE_WORKSPACE, connectionId: "c1" },
};

describe("RunLocationPicker in a remote workspace", () => {
  it("offers A remote workspace as a third place and picks it as a local run", () => {
    const onChange = vi.fn();
    render(
      <RunLocationPicker
        value={{ ...LOCAL, runTarget: "cluster" }}
        onChange={onChange}
        kind="task"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /A remote workspace/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ runTarget: "local", remoteWorkspace: EMPTY_REMOTE_WORKSPACE }),
    );
  });

  it("says where to add a connection when there is none", async () => {
    render(<RunLocationPicker value={CODER} onChange={vi.fn()} kind="job" />);
    expect(await screen.findByText("No remote-workspace connection yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Settings → Integrations → Remote workspaces/ }),
    ).toHaveAttribute("href", "/settings#remote-workspaces");
  });

  it("can't be picked when the form says so (an edit of work that runs elsewhere), and says why", () => {
    const reason = "Saved work keeps where it runs — start new work to use a remote workspace.";
    render(
      <RunLocationPicker
        value={{ ...LOCAL, runTarget: "cluster" }}
        onChange={vi.fn()}
        kind="job"
        remoteWorkspaceDisabled={reason}
      />,
    );
    const card = screen.getByRole("button", { name: /A remote workspace/ });
    expect(card).toBeDisabled();
    expect(card).toHaveTextContent(reason);
  });

  it("shows the default template's parameters, not the ones Optio fills", async () => {
    coder.connections = [connection()];
    coder.templates = [
      {
        id: "t1",
        name: "base",
        displayName: "Base",
        description: null,
        organizationId: "org1",
        activeVersionId: "v1",
      },
    ];
    coder.parameters = [
      param("optio_token"),
      param("optio_checkout_dir"),
      param("region", {
        displayName: "Region",
        options: [
          { name: "Europe", value: "eu", description: null },
          { name: "US", value: "us", description: null },
        ],
      }),
      param("repo_url"),
    ];
    const onChange = vi.fn();
    render(<RunLocationPicker value={CODER} onChange={onChange} kind="task" />);

    const region = await screen.findByLabelText("Region");
    // The connection's default shows until the work picks another value.
    expect(region).toHaveValue("eu");
    expect(screen.queryByLabelText("optio_token")).not.toBeInTheDocument();
    // A Task's repository has its own field (it is the template's repo_url too).
    expect(screen.queryByLabelText("repo_url")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Repository")).toBeInTheDocument();
    expect(screen.getByLabelText("Template")).toHaveTextContent("Default — Base");
    expect(
      screen.getByText(/stops when the run ends, or after 8 h at the latest/),
    ).toBeInTheDocument();

    fireEvent.change(region, { target: { value: "us" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        remoteWorkspace: expect.objectContaining({ parameters: { region: "us" } }),
      }),
    );
  });

  it("reports the typed repository as the Task's repo", async () => {
    coder.connections = [connection()];
    const onRepoUrlChange = vi.fn();
    render(
      <RunLocationPicker
        value={{
          ...CODER,
          remoteWorkspace: {
            ...CODER.remoteWorkspace!,
            repoUrl: "https://gitlab.example.com/team/app",
          },
        }}
        onChange={vi.fn()}
        onRepoUrlChange={onRepoUrlChange}
        kind="task"
      />,
    );
    await waitFor(() =>
      expect(onRepoUrlChange).toHaveBeenLastCalledWith("https://gitlab.example.com/team/app"),
    );
  });

  it("speaks each provider's words: a Daytona connection's snapshots and sandboxes", async () => {
    coder.connections = [
      connection({
        id: "d1",
        provider: "daytona",
        name: "Sandboxes",
        url: "",
        templateId: null,
        templateName: null,
        defaultParameters: {},
        ttlMs: null,
      }),
    ];
    coder.templates = [
      {
        id: "optio-node",
        name: "optio-node",
        displayName: null,
        description: null,
        organizationId: null,
        activeVersionId: "optio-node",
      },
    ];
    coder.parameters = [param("target", { displayName: "Region" })];
    render(
      <RunLocationPicker
        value={{ ...LOCAL, remoteWorkspace: { ...EMPTY_REMOTE_WORKSPACE, connectionId: "d1" } }}
        onChange={vi.fn()}
        kind="job"
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Snapshot")).toHaveTextContent("Pick a snapshot…"),
    );
    expect(screen.getByRole("button", { name: "New sandbox" })).toBeInTheDocument();
    expect(screen.getByLabelText("Checkout")).toHaveAttribute("placeholder", "/home/daytona/repo");
    expect(screen.getByText(/The sandbox stops when the run ends\./)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sandboxes · Daytona" })).toBeInTheDocument();
  });

  it("lists your running and stopped workspaces for Existing workspace", async () => {
    coder.connections = [connection()];
    coder.workspaces = [
      { id: "w1", name: "dev", status: "running", templateName: "Base" },
      { id: "w2", name: "old", status: "stopped", templateName: null },
      { id: "w3", name: "broken", status: "failed", templateName: null },
    ];
    render(
      <RunLocationPicker
        value={{
          ...CODER,
          remoteWorkspace: { ...CODER.remoteWorkspace!, source: "existing" },
        }}
        onChange={vi.fn()}
        kind="job"
      />,
    );
    expect(await screen.findByRole("option", { name: "dev — running · Base" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "old — stopped" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /broken/ })).not.toBeInTheDocument();
  });
});
