import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const listConnectionProviders = vi.fn();
const createConnection = vi.fn();
const testConnection = vi.fn();
const createSecret = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    listConnectionProviders: (...a: unknown[]) => listConnectionProviders(...a),
    createConnection: (...a: unknown[]) => createConnection(...a),
    testConnection: (...a: unknown[]) => testConnection(...a),
    createSecret: (...a: unknown[]) => createSecret(...a),
    listRepos: () => Promise.resolve({ repos: [] }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: { id: "u1", displayName: "Jon Wiggins" },
    userId: "u1",
    isAdmin: false,
    loaded: true,
    authDisabled: false,
    isDeploymentAdmin: false,
  }),
}));

// Upstream's cases run under the default deployment; the restricted deployment's are at the end.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import {
  ConnectGallery,
  galleryOffers,
  serviceProviders,
  defaultConnectionName,
} from "./connect-gallery";

const provider = (slug: string, extra: Record<string, unknown> = {}) => ({
  id: `p-${slug}`,
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  description: `${slug} service`,
  icon: slug,
  category: "productivity",
  type: "mcp",
  builtIn: true,
  parts: ["credentials"],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

const PROVIDERS = [
  provider("custom-mcp"),
  provider("slack"),
  provider("github-enhanced", { name: "GitHub (enhanced)" }),
  provider("pylon", {
    configSchema: {
      properties: {
        apiToken: { type: "string", title: "API token", format: "secret" },
        region: {
          type: "string",
          title: "Region",
          enum: ["us", "eu"],
          enumTitles: ["US", "EU"],
          default: "us",
        },
      },
      required: ["apiToken"],
    },
    note: "Use the pylon tools.",
  }),
  provider("custom-http"),
];

beforeEach(() => {
  listConnectionProviders.mockReset().mockResolvedValue({ providers: PROVIDERS });
  createConnection.mockReset();
  testConnection.mockReset();
  createSecret.mockReset();
});
afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});

describe("serviceProviders / defaultConnectionName", () => {
  it("orders the catalog, drops the custom providers, and names the GitHub tile", () => {
    expect(serviceProviders(PROVIDERS as never).map((p) => p.slug)).toEqual([
      "github-enhanced",
      "slack",
      "pylon",
    ]);
    expect(defaultConnectionName({ slug: "aws", name: "AWS" }, "private", "Jon Wiggins")).toBe(
      "Jon's AWS",
    );
    expect(defaultConnectionName({ slug: "aws", name: "AWS" }, "private", "")).toBe("My AWS");
    expect(defaultConnectionName({ slug: "aws", name: "AWS" }, "organization", "Jon")).toBe("AWS");
  });

  it("puts the GitLab tile next to GitHub's, in the full profile only", () => {
    const withGitLab = [...PROVIDERS, provider("gitlab", { name: "GitLab" })];
    expect(serviceProviders(withGitLab as never, "full").map((p) => p.slug)).toEqual([
      "github-enhanced",
      "gitlab",
      "slack",
      "pylon",
    ]);
    expect(galleryOffers("gitlab", "full")).toBe(true);
    expect(galleryOffers("gitlab", "standard")).toBe(false);
  });
});

describe("ConnectGallery", () => {
  it("shows service tiles from the catalog plus the Something-else tiles", async () => {
    render(<ConnectGallery open onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByTestId("connect-gallery")).toBeInTheDocument();
    await screen.findByTestId("connect-tile-pylon");
    expect(screen.getByTestId("connect-tile-github-enhanced")).toHaveTextContent("GitHub");
    expect(screen.queryByTestId("connect-tile-custom-mcp")).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-tile-secret")).toBeInTheDocument();
    expect(screen.getByTestId("connect-tile-mcp")).toBeInTheDocument();
  });

  it("picking pylon shows its fields and Save posts the connection", async () => {
    const onCreated = vi.fn();
    createConnection.mockResolvedValue({ connection: { id: "c1", name: "Jon's Pylon" } });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.click(await screen.findByTestId("connect-tile-pylon"));

    const nameInput = screen.getByLabelText("Connection name") as HTMLInputElement;
    expect(nameInput.value).toBe("Jon's Pylon");
    const region = screen.getByLabelText(/Region/) as HTMLSelectElement;
    expect(region.tagName).toBe("SELECT");
    expect(screen.getByText("What the agent is told")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/API token/), { target: { value: "tok" } });
    fireEvent.change(region, { target: { value: "eu" } });
    fireEvent.click(save);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createConnection).toHaveBeenCalledWith({
      providerSlug: "pylon",
      name: "Jon's Pylon",
      owner: "me",
      config: { apiToken: "tok", region: "eu" },
      assignments: [{ repoId: null, agentTypes: [] }],
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith({ kind: "connection", id: "c1", name: "Jon's Pylon" });
  });

  it("the Secret tile posts a private secret", async () => {
    const onCreated = vi.fn();
    createSecret.mockResolvedValue({ name: "MY_TOKEN", scope: "user" });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.click(await screen.findByTestId("connect-tile-secret"));
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "my-token" } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "s3cr3t" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createSecret).toHaveBeenCalledWith({ name: "MY_TOKEN", value: "s3cr3t", scope: "user" });
    expect(onCreated).toHaveBeenCalledWith({ kind: "secret", id: "MY_TOKEN", name: "MY_TOKEN" });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ConnectGallery open onClose={onClose} onCreated={vi.fn()} />);
    await screen.findByTestId("connect-tile-pylon");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConnectGallery under the restricted deployment", () => {
  const STANDARD_CATALOG = [
    ...PROVIDERS,
    provider("postgres"),
    provider("filesystem"),
    provider("aws"),
    provider("custom-http"),
    provider("forge", { builtIn: false }),
  ];

  it("offers the restricted deployment's providers and a workspace's own, nothing cloud-only", () => {
    expect(
      serviceProviders(
        STANDARD_CATALOG as never,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ).map((p) => p.slug),
    ).toEqual(["postgres", "filesystem", "forge"]);
    expect(
      galleryOffers(
        "github-enhanced",
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(false);
    expect(
      galleryOffers(
        "custom-mcp",
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(true);
    // The default deployment keeps every tile.
    expect(galleryOffers("github-enhanced", featuresFromEnv({}))).toBe(true);
    expect(
      serviceProviders(STANDARD_CATALOG as never, featuresFromEnv({})).map((p) => p.slug),
    ).toContain("pylon");
  });

  it("renders no GitHub, Slack or Pylon tile", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    listConnectionProviders.mockResolvedValue({ providers: STANDARD_CATALOG });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByTestId("connect-tile-postgres");
    expect(screen.queryByTestId("connect-tile-github-enhanced")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connect-tile-slack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connect-tile-pylon")).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-tile-secret")).toBeInTheDocument();
  });

  it("won't open straight on a provider the restricted deployment doesn't offer", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={vi.fn()} initialProvider="pylon" />);
    await waitFor(() => expect(listConnectionProviders).toHaveBeenCalled());
    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  });
});
