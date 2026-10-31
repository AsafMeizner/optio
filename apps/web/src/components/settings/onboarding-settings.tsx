"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DeploymentSettings } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { useOnboardingStore } from "@/hooks/use-onboarding";

/**
 * Settings → Access → Getting-started guide: the Overview's getting-started
 * checklist and Help → Using Optio in the account menu (docs/using-optio.md).
 * Off by default. Saved here, it wins over the deployment's own default
 * (`OPTIO_ONBOARDING`, chart `onboarding.enabled`); "Follow the deployment"
 * removes the saved value. Shown to deployment admins only; the API refuses
 * anyone else (services/deployment-admin-gates.ts).
 */

type Choice = "on" | "off" | "deployment";

const word = (on: boolean) => (on ? "On" : "Off");

export function OnboardingSettings() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  const sw = settings?.onboarding;
  if (!settings?.canEdit || !sw) return null;
  const choice: Choice = sw.source === "app" ? (sw.value ? "on" : "off") : "deployment";

  const pick = async (next: Choice) => {
    if (saving || next === choice) return;
    setSaving(true);
    try {
      setSettings(
        await api.updateDeploymentSettings({
          onboarding: next === "deployment" ? null : next === "on",
        }),
      );
      // The checklist and the Help menu follow at once.
      void useOnboardingStore.getState().reload();
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      label="Getting-started guide"
      hint="A checklist and a guide for new people"
      summary={word(sw.value)}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        On: the Overview shows each signed-in person a getting-started checklist (a repository, a
        first task, its review) until they finish or hide it, and the account menu gets Help → Using
        Optio. Off: neither shows.
      </p>
      <div data-testid="onboarding-switch">
        <Segmented
          value={choice}
          onChange={(next) => void pick(next)}
          aria-label="Show the getting-started guide"
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
            {
              value: "deployment",
              label: `Follow the deployment (${word(sw.environment).toLowerCase()})`,
            },
          ]}
        />
      </div>
    </SectionCard>
  );
}
