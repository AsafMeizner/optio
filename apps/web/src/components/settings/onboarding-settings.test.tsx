import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  updateDeploymentSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { OnboardingSettings } from "./onboarding-settings";
import { useOnboardingStore } from "@/hooks/use-onboarding";

const settings = (over: Record<string, unknown> = {}) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  onboarding: { value: false, source: "environment", environment: false },
  canEdit: true,
  mayCreateWorkspace: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useOnboardingStore.getState().reset();
});

describe("OnboardingSettings", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings({ canEdit: false }));
    const { container } = render(<OnboardingSettings />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("is off by default, turns on for everyone at once, and can follow the deployment again", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.updateDeploymentSettings.mockResolvedValue(
      settings({ onboarding: { value: true, source: "app", environment: false } }),
    );
    render(<OnboardingSettings />);
    const follow = await screen.findByRole("button", { name: "Follow the deployment (off)" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");

    api.getDeploymentSettings.mockResolvedValue(
      settings({ onboarding: { value: true, source: "app", environment: false } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenCalledWith({ onboarding: true }),
    );
    // The checklist and the Help menu read the new value without a reload.
    await waitFor(() => expect(useOnboardingStore.getState().onboarding).toBe(true));

    api.updateDeploymentSettings.mockResolvedValue(settings());
    fireEvent.click(await screen.findByRole("button", { name: "Follow the deployment (off)" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenLastCalledWith({ onboarding: null }),
    );
  });
});
