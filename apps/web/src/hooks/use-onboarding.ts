"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-client";

/**
 * Whether a deployment admin turned the getting-started guide on (Settings →
 * Access → Getting-started guide, `GET /api/deployment-settings`
 * `onboarding`): the Overview's checklist, Help in the account menu and the
 * /help page follow it. Fetched once per page load and shared. Off until the
 * answer arrives, and off when it can't be read, so the app looks as it does
 * without the guide.
 *
 *   const { onboarding, loaded } = useOnboarding();
 */

interface OnboardingState {
  onboarding: boolean;
  /** The first fetch has settled (successfully or not). */
  loaded: boolean;
  load: () => Promise<void>;
  /** Fetch again (after a deployment admin changed it). */
  reload: () => Promise<void>;
  /** Forget the cached answer (tests). */
  reset: () => void;
}

let inflight: Promise<void> | null = null;

function fetchOnboarding(set: (s: Partial<OnboardingState>) => void): Promise<void> {
  if (inflight) return inflight;
  // `Promise.resolve().then` turns a client without `getDeploymentSettings`
  // (a test's partial mock) into the same "off" answer as a failed request.
  inflight = Promise.resolve()
    .then(() => api.getDeploymentSettings())
    .then((res) => set({ onboarding: res?.onboarding?.value === true, loaded: true }))
    .catch(() => set({ onboarding: false, loaded: true }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  onboarding: false,
  loaded: false,
  load: () => fetchOnboarding(set),
  reload: () => {
    inflight = null;
    return fetchOnboarding(set);
  },
  reset: () => {
    inflight = null;
    set({ onboarding: false, loaded: false });
  },
}));

export function useOnboarding(): { onboarding: boolean; loaded: boolean } {
  const onboarding = useOnboardingStore((s) => s.onboarding);
  const loaded = useOnboardingStore((s) => s.loaded);
  const load = useOnboardingStore((s) => s.load);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  return { onboarding, loaded };
}
