import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const listLocalHosts = vi.fn();
const refreshClaudeTokenFromHost = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    createSecret: vi.fn(),
    listLocalHosts: (...args: unknown[]) => listLocalHosts(...args),
    refreshClaudeTokenFromHost: (...args: unknown[]) => refreshClaudeTokenFromHost(...args),
  },
}));

// The banner is upstream's: it shows under the default deployment alone (a
// gateway-only deployment has no Claude OAuth token to refresh).
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import { TokenRefreshBanner } from "./token-refresh-banner";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  features = featuresFromEnv({});
});

describe("TokenRefreshBanner under the restricted deployment", () => {
  it("stays quiet: there is no Claude OAuth token in a gateway-only deployment", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    listLocalHosts.mockResolvedValue({ hosts: [] });
    const { container } = render(<TokenRefreshBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("TokenRefreshBanner → refresh from a paired machine", () => {
  it("offers one click per online host that can supply the token, and keeps the paste flow", async () => {
    listLocalHosts.mockResolvedValue({
      hosts: [
        { id: "h1", name: "laptop", state: "online", claudeCredentials: true },
        { id: "h2", name: "desktop", state: "online", claudeCredentials: false },
        { id: "h3", name: "old", state: "offline", claudeCredentials: true },
      ],
    });
    refreshClaudeTokenFromHost.mockResolvedValue({ ok: true, hostId: "h1" });
    const onSaved = vi.fn();
    render(<TokenRefreshBanner onSaved={onSaved} />);

    const button = await screen.findByRole("button", { name: /Refresh from laptop/ });
    expect(screen.queryByRole("button", { name: /Refresh from desktop/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Refresh from old/ })).toBeNull();
    expect(screen.getByPlaceholderText(/Paste token here/)).toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => expect(refreshClaudeTokenFromHost).toHaveBeenCalledWith("h1"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("shows only the paste flow when no machine can help", async () => {
    listLocalHosts.mockResolvedValue({ hosts: [] });
    render(<TokenRefreshBanner />);
    await waitFor(() => expect(listLocalHosts).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Refresh from/ })).toBeNull();
    expect(screen.getByPlaceholderText(/Paste token here/)).toBeInTheDocument();
  });
});
