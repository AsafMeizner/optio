import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ANTHROPIC_CATALOG, mergeLiveModels } from "@optio/shared";

const getAgentProviderOptions = vi.fn();
const listModelProviders = vi.fn();
const getMyGateway = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getAgentProviderOptions: (...args: unknown[]) => getAgentProviderOptions(...args),
    listModelProviders: (...args: unknown[]) => listModelProviders(...args),
    getMyGateway: (...args: unknown[]) => getMyGateway(...args),
  },
}));

// Upstream's cases run under the default deployment; the restricted deployment's are at the end.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import { ReviewAgentPicker } from "./review-agent-picker";
import { resetDefaultGatewayCache } from "@/hooks/use-default-gateway";
import { useGatewayStore } from "@/hooks/use-gateway";

/** The live list a key that can see Opus 5.5 would get. */
const liveCatalog = mergeLiveModels(ANTHROPIC_CATALOG, [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
]);

function modelSelect(): HTMLSelectElement {
  // Agent first, model second.
  return screen.getAllByRole("combobox")[1] as HTMLSelectElement;
}

beforeEach(() => {
  getAgentProviderOptions.mockReset();
  getAgentProviderOptions.mockResolvedValue({
    catalog: liveCatalog,
    source: "live",
    cached: true,
    refreshedAt: 1,
  });
});

afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});

describe("ReviewAgentPicker (#644)", () => {
  it("lists the live models, not only the baseline catalog", async () => {
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
      />,
    );
    expect(ANTHROPIC_CATALOG.models.some((m) => m.id === "claude-opus-5-5")).toBe(false);
    await within(modelSelect()).findByRole("option", { name: /Opus 5\.5/ });
    expect(getAgentProviderOptions).toHaveBeenCalledWith("anthropic");
  });

  it("keeps the baseline list when the live fetch fails", async () => {
    getAgentProviderOptions.mockRejectedValue(new Error("offline"));
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
      />,
    );
    await vi.waitFor(() => expect(getAgentProviderOptions).toHaveBeenCalled());
    const options = within(modelSelect()).getAllByRole("option");
    expect(options.length).toBe(ANTHROPIC_CATALOG.models.length + 1); // + "Default"
    expect(options.some((o) => /Opus 5\.5/.test(o.textContent ?? ""))).toBe(false);
  });

  it("keeps a saved model the list does not offer selectable", async () => {
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model="claude-opus-9-9"
        onModelChange={() => {}}
      />,
    );
    await within(modelSelect()).findByRole("option", { name: /Opus 5\.5/ });
    expect(modelSelect().value).toBe("claude-opus-9-9");
    expect(within(modelSelect()).getByRole("option", { name: "claude-opus-9-9" })).toBeTruthy();
  });

  it("fetches each agent's provider once, and nothing while inheriting", async () => {
    const { rerender } = render(
      <ReviewAgentPicker
        agentType={null}
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
        allowInherit
      />,
    );
    expect(getAgentProviderOptions).not.toHaveBeenCalled();
    rerender(
      <ReviewAgentPicker
        agentType="gemini"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
        allowInherit
      />,
    );
    await vi.waitFor(() => expect(getAgentProviderOptions).toHaveBeenCalledWith("gemini"));
    expect(getAgentProviderOptions).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewAgentPicker under the restricted deployment", () => {
  const agentSelect = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;

  beforeEach(() => {
    resetDefaultGatewayCache();
    useGatewayStore.getState().reset();
    listModelProviders.mockReset().mockResolvedValue({
      providers: [
        {
          id: "gw1",
          name: "LiteLLM",
          kind: "gateway",
          agents: ["claude-code"],
          ownerUserId: null,
          mine: false,
          models: { "claude-code": [{ id: "corp-opus", label: "Corp Opus" }] },
        },
      ],
    });
    getMyGateway.mockReset().mockResolvedValue({ gateway: { id: "gw1", name: "LiteLLM" } });
  });

  it("lists the restricted deployment's agents alone", () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    render(
      <ReviewAgentPicker
        agentType={null}
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
        allowInherit
      />,
    );
    expect(Array.from(agentSelect().options).map((o) => o.value)).toEqual([
      "__inherit__",
      "claude-code",
      "opencode",
    ]);
  });

  it("lists the default gateway's catalog and asks the options through it", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    getAgentProviderOptions.mockReturnValue(new Promise(() => {}));
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
      />,
    );
    await within(modelSelect()).findByRole("option", { name: "Corp Opus" });
    expect(getAgentProviderOptions).toHaveBeenLastCalledWith("anthropic", { gateway: "gw1" });
  });

  it("keeps the default deployment's agents and fetches no gateway there", () => {
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
      />,
    );
    expect(Array.from(agentSelect().options).map((o) => o.value)).toEqual([
      "claude-code",
      "codex",
      "copilot",
      "opencode",
      "gemini",
      "openclaw",
      "cursor",
    ]);
    expect(listModelProviders).not.toHaveBeenCalled();
  });
});
