import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect } from "vitest";
import {
  CLUSTER_RUN_LOCATION,
  agentRunsLocally,
  localAgentChoices,
  runLocationFromRow,
  runLocationPayload,
  defaultDir,
  joinSubpath,
  repoUrlFromRemote,
  rootDirFor,
  subpathError,
  subpathOf,
  shortRepo,
  usableDir,
} from "./run-location-picker";

describe("runLocationFromRow", () => {
  it("defaults to the cluster for missing rows and cluster rows", () => {
    expect(runLocationFromRow(null)).toEqual(CLUSTER_RUN_LOCATION);
    expect(runLocationFromRow({ runTarget: "cluster", localHostId: "h", localDir: "/x" })).toEqual(
      CLUSTER_RUN_LOCATION,
    );
  });

  it("reads a local row back, defaulting the session mode to headless", () => {
    expect(
      runLocationFromRow({ runTarget: "local", localHostId: "h1", localDir: "/home/dev/app" }),
    ).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/home/dev/app",
      localSessionMode: "headless",
    });
    expect(
      runLocationFromRow({
        runTarget: "local",
        localHostId: "h1",
        localDir: "/home/dev/app",
        localSessionMode: "interactive",
      }).localSessionMode,
    ).toBe("interactive");
  });

  it("reads saved remote-workspace work back so saving an edit keeps its workspace", () => {
    const fresh = {
      connectionId: "c1",
      templateId: "t1",
      templateVersionId: "v7",
      parameters: { repo_url: "https://git.corp/app.git", cpu: "4" },
      name: "nightly",
      checkoutDir: "/work/app",
    };
    const loaded = runLocationFromRow({
      runTarget: "local",
      localHostId: "pinned-host",
      localDir: "/work/app",
      remoteWorkspaceLaunch: fresh,
    });
    expect(loaded.localHostId).toBe("");
    expect(loaded.remoteWorkspace?.source).toBe("new");
    expect(runLocationPayload(loaded)).toMatchObject({
      runTarget: "local",
      localHostId: null,
      remoteWorkspace: { ...fresh, workspaceId: null },
    });
    const existing = runLocationFromRow({
      runTarget: "local",
      remoteWorkspaceLaunch: { connectionId: null, workspaceId: "ws-1", checkoutDir: null },
    });
    expect(existing.remoteWorkspace).toMatchObject({ source: "existing", workspaceId: "ws-1" });
    expect(runLocationPayload(existing)).toMatchObject({
      remoteWorkspace: {
        connectionId: null,
        workspaceId: "ws-1",
        templateId: null,
        parameters: null,
      },
    });
  });
});

describe("runLocationPayload", () => {
  it("clears the local fields when the target is the cluster", () => {
    expect(
      runLocationPayload({
        runTarget: "cluster",
        localHostId: "stale",
        localDir: "/stale",
        localSessionMode: "interactive",
      }),
    ).toEqual({ runTarget: "cluster", localHostId: null, localDir: null, localSessionMode: null });
  });

  it("passes a local location through", () => {
    expect(
      runLocationPayload({
        runTarget: "local",
        localHostId: "h1",
        localDir: "/home/dev/app",
        localSessionMode: "headless",
      }),
    ).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/home/dev/app",
      localSessionMode: "headless",
    });
  });
});

describe("runLocationPayload in a remote workspace", () => {
  const coder = {
    connectionId: "c1",
    source: "new" as const,
    workspaceId: "stale",
    templateId: "t2",
    parameters: { region: "us" },
    name: " my-ws ",
    checkoutDir: "",
    repoUrl: "https://gitlab.example.com/team/app",
  };

  it("stays a local run and carries where.remoteWorkspace, the machine left to the API", () => {
    expect(
      runLocationPayload({
        runTarget: "local",
        localHostId: "stale",
        localDir: "/stale",
        localSessionMode: "headless",
        remoteWorkspace: coder,
      }),
    ).toEqual({
      runTarget: "local",
      localHostId: null,
      localDir: null,
      localSessionMode: "headless",
      remoteWorkspace: {
        connectionId: "c1",
        workspaceId: null,
        templateId: "t2",
        parameters: { region: "us", repo_url: "https://gitlab.example.com/team/app" },
        name: "my-ws",
        checkoutDir: null,
      },
    });
  });

  it("starts an existing workspace with only the repo parameter", () => {
    const payload = runLocationPayload({
      runTarget: "local",
      localHostId: "",
      localDir: "",
      localSessionMode: "headless",
      remoteWorkspace: {
        ...coder,
        source: "existing",
        workspaceId: "w1",
        checkoutDir: "/src/app",
      },
    });
    expect(payload).toMatchObject({
      remoteWorkspace: {
        workspaceId: "w1",
        templateId: null,
        name: null,
        parameters: { repo_url: "https://gitlab.example.com/team/app" },
        checkoutDir: "/src/app",
      },
    });
  });
});

describe("agentRunsLocally", () => {
  it("knows which agent runtimes the local daemon can launch", () => {
    for (const a of ["claude-code", "codex", "cursor", "gemini", "opencode"]) {
      expect(agentRunsLocally(a)).toBe(true);
    }
    expect(agentRunsLocally("copilot")).toBe(false);
    expect(agentRunsLocally("openclaw")).toBe(false);
    expect(agentRunsLocally(undefined)).toBe(false);
  });
});

describe("local directories", () => {
  const dirs = [
    { path: "/home/dev/notes" },
    { path: "/home/dev/app", repoUrl: "https://github.com/acme/app" },
  ];

  it("lets a Job use any directory but a Task only a git checkout", () => {
    expect(usableDir("job", dirs[0])).toBe(true);
    expect(usableDir("task", dirs[0])).toBe(false);
    expect(usableDir("task", dirs[1])).toBe(true);
  });

  it("defaults to the first usable directory, keeping a still-valid choice", () => {
    expect(defaultDir("job", dirs, "")).toBe("/home/dev/notes");
    expect(defaultDir("task", dirs, "")).toBe("/home/dev/app");
    expect(defaultDir("task", dirs, "/home/dev/notes")).toBe("/home/dev/app");
    expect(defaultDir("job", dirs, "/home/dev/app")).toBe("/home/dev/app");
    expect(defaultDir("task", [dirs[0]], "")).toBe("");
  });

  it("turns the daemon's remote into the https repo URL the API accepts", () => {
    expect(repoUrlFromRemote("git@github.com:acme/app.git")).toBe("https://github.com/acme/app");
    expect(repoUrlFromRemote("https://github.com/acme/app.git")).toBe(
      "https://github.com/acme/app",
    );
    expect(repoUrlFromRemote(undefined)).toBeNull();
  });

  it("shortens a remote for display", () => {
    expect(shortRepo("https://github.com/acme/app.git")).toBe("github.com/acme/app");
    expect(shortRepo("git@gitlab.com:acme/app.git")).toBe("gitlab.com/acme/app");
  });
});

describe("subdirectories of an allowlisted directory (#622)", () => {
  const dirs = [
    { path: "/home/dev/notes" },
    { path: "/home/dev/app", repoUrl: "git@github.com:acme/app.git" },
    { path: "/home/dev/app/vendor/lib" },
  ];

  it("finds the longest allowlisted root a directory sits under", () => {
    expect(rootDirFor(dirs, "/home/dev/app")?.path).toBe("/home/dev/app");
    expect(rootDirFor(dirs, "/home/dev/app/packages/api")?.path).toBe("/home/dev/app");
    expect(rootDirFor(dirs, "/home/dev/app/vendor/lib/src")?.path).toBe("/home/dev/app/vendor/lib");
    expect(rootDirFor(dirs, "/home/dev/application")).toBeUndefined();
    expect(rootDirFor(dirs, "")).toBeUndefined();
    expect(rootDirFor([{ path: "/" }], "/srv")?.path).toBe("/");
  });

  it("splits and joins the subpath", () => {
    expect(subpathOf("/home/dev/app", "/home/dev/app")).toBe("");
    expect(subpathOf("/home/dev/app", "/home/dev/app/packages/api")).toBe("packages/api");
    expect(joinSubpath("/home/dev/app", "")).toBe("/home/dev/app");
    expect(joinSubpath("/home/dev/app", " packages//api/ ")).toBe("/home/dev/app/packages/api");
    expect(joinSubpath("/home/dev/app/", "./src")).toBe("/home/dev/app/src");
    expect(joinSubpath("/", "srv")).toBe("/srv");
  });

  it("only accepts relative paths that stay inside the directory", () => {
    expect(subpathError("")).toBeNull();
    expect(subpathError("packages/api")).toBeNull();
    expect(subpathError("/etc")).toMatch(/relative/);
    expect(subpathError("~/x")).toMatch(/relative/);
    expect(subpathError("../other")).toMatch(/\.\./);
    expect(subpathError("a/../../b")).toMatch(/\.\./);
  });

  it("keeps a subdirectory selection when re-adopting a host's directory", () => {
    expect(defaultDir("task", dirs, "/home/dev/app/packages/api")).toBe(
      "/home/dev/app/packages/api",
    );
    // Under a non-checkout root a Task still moves to a checkout.
    expect(defaultDir("task", dirs, "/home/dev/notes/sub")).toBe("/home/dev/app");
    expect(defaultDir("job", dirs, "/home/dev/notes/sub")).toBe("/home/dev/notes/sub");
  });
});

describe("localAgentChoices (the deployment features)", () => {
  it("names every local agent CLI under the default deployment, as upstream's copy did", () => {
    expect(localAgentChoices(featuresFromEnv({}))).toBe(
      "Claude Code, Codex, Cursor, Gemini, or OpenCode",
    );
  });

  it("names the restricted deployment's two", () => {
    expect(
      localAgentChoices(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe("Claude Code or OpenCode");
  });
});
