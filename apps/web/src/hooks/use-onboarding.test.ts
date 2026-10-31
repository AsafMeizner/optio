import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getDeploymentSettings: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));

import { useOnboardingStore } from "./use-onboarding";

afterEach(() => {
  useOnboardingStore.getState().reset();
  vi.clearAllMocks();
});

const settings = (value: boolean) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  onboarding: { value, source: "app", environment: false },
  canEdit: false,
  mayCreateWorkspace: true,
});

describe("useOnboarding's store", () => {
  it("is off until the answer arrives, then follows it", async () => {
    expect(useOnboardingStore.getState()).toMatchObject({ onboarding: false, loaded: false });
    api.getDeploymentSettings.mockResolvedValue(settings(true));
    await useOnboardingStore.getState().load();
    expect(useOnboardingStore.getState()).toMatchObject({ onboarding: true, loaded: true });
  });

  it("stays off when the settings can't be read, or don't carry the switch (an older API)", async () => {
    api.getDeploymentSettings.mockRejectedValue(new Error("502"));
    await useOnboardingStore.getState().load();
    expect(useOnboardingStore.getState()).toMatchObject({ onboarding: false, loaded: true });

    useOnboardingStore.getState().reset();
    api.getDeploymentSettings.mockResolvedValue({ canEdit: false, mayCreateWorkspace: true });
    await useOnboardingStore.getState().load();
    expect(useOnboardingStore.getState()).toMatchObject({ onboarding: false, loaded: true });
  });

  it("reload reads it again after an admin changed it", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings(true));
    await useOnboardingStore.getState().load();
    api.getDeploymentSettings.mockResolvedValue(settings(false));
    await useOnboardingStore.getState().reload();
    expect(useOnboardingStore.getState().onboarding).toBe(false);
  });
});
