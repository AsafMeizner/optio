import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ANTHROPIC_CATALOG,
  OPENAI_CATALOG,
  mergeCodexModels,
  mergeLiveModels,
} from "@optio/shared";

const getAgentProviderOptions = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getAgentProviderOptions: (...args: unknown[]) => getAgentProviderOptions(...args) },
}));

import { AgentOptionsPicker } from "./agent-options-picker";
import { gatewayCatalogFor } from "./gateway-catalog";

/** The live list a key that can see Opus 5.5 would get. */
const liveCatalog = mergeLiveModels(ANTHROPIC_CATALOG, [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
]);

beforeEach(() => {
  getAgentProviderOptions.mockReset();
  getAgentProviderOptions.mockResolvedValue({
    catalog: liveCatalog,
    source: "live",
    cached: true,
    refreshedAt: 1,
  });
});

afterEach(() => cleanup());

describe("AgentOptionsPicker latestAliases", () => {
  it("offers each family's alias as an always-latest choice, named by the live list", async () => {
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "opus" }}
        onChange={vi.fn()}
        modelOnly
        latestAliases
      />,
    );
    const select = screen.getByRole("combobox");
    // The stored alias stays the alias.
    expect(select).toHaveValue("opus");
    const group = await screen.findByRole("group", { name: "Always the latest" });
    // The group exists in the baseline list too; wait for the live alias itself.
    expect(await within(group).findByRole("option", { name: "Opus · now Opus 5.5" })).toHaveValue(
      "opus",
    );
    expect(within(group).getByRole("option", { name: /^Sonnet · now/ })).toHaveValue("sonnet");
    expect(screen.getByText(/moves to each new release on its own/)).toBeInTheDocument();
  });

  it("stores the alias or a pinned id as picked", async () => {
    const onChange = vi.fn();
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "opus" }}
        onChange={onChange}
        modelOnly
        latestAliases
      />,
    );
    await screen.findByRole("option", { name: "Opus · now Opus 5.5" });
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "claude-opus-5-5" } });
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "claude-opus-5-5" });
    fireEvent.change(select, { target: { value: "sonnet" } });
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "sonnet" });
  });

  it("without it, a stored alias shows as the model it names", () => {
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "opus" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("combobox")[0]).toHaveValue("claude-opus-4-8");
    expect(screen.queryByRole("group", { name: "Always the latest" })).not.toBeInTheDocument();
  });

  it("keeps showing a saved model the list doesn't offer", () => {
    getAgentProviderOptions.mockReturnValue(new Promise(() => {})); // live list never arrives
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-opus-9" }}
        onChange={vi.fn()}
        modelOnly
        latestAliases
      />,
    );
    expect(screen.getByRole("combobox")).toHaveValue("claude-opus-9");
    expect(screen.getByRole("option", { name: "claude-opus-9" })).toBeInTheDocument();
  });
});

/** What a machine whose Codex lists a newer model reports. */
const codexCatalog = mergeCodexModels(OPENAI_CATALOG, [
  {
    id: "gpt-5.7",
    displayName: "GPT-5.7",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
  },
]);

describe("AgentOptionsPicker on a machine", () => {
  it("offers Claude Code's effort and permissions, not the pod-only fields", () => {
    render(
      <AgentOptionsPicker provider="anthropic" values={{}} onChange={vi.fn()} runsOn="local" />,
    );
    // Unset effort on a machine is the machine's own default, not the pods' "high".
    const effort = screen.getByRole("combobox", { name: "Effort Level" });
    expect(effort).toHaveValue("");
    expect(within(effort).getByRole("option", { name: "Default" })).toBeInTheDocument();
    // Checks are skipped unless the form says otherwise, the way pods always do.
    const permissions = screen.getByRole("combobox", { name: "Permissions" });
    expect(permissions).toHaveValue("bypassPermissions");
    expect(within(permissions).getByRole("option", { name: "Auto" })).toHaveValue("auto");
    expect(screen.queryByRole("combobox", { name: "Context Window" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Extended Thinking" })).not.toBeInTheDocument();
  });

  it("keeps the permissions choice off a run in a pod", () => {
    render(<AgentOptionsPicker provider="anthropic" values={{}} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Context Window" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Permissions" })).not.toBeInTheDocument();
  });

  it("asks for the machine's own Codex list and says where it came from", async () => {
    getAgentProviderOptions.mockResolvedValue({
      catalog: codexCatalog,
      source: "live",
      cached: false,
      refreshedAt: Math.floor(Date.now() / 1000),
      liveFrom: "Codex on MacBook-Pro",
    });
    render(
      <AgentOptionsPicker
        provider="openai"
        values={{}}
        onChange={vi.fn()}
        runsOn="local"
        hostId="host-1"
      />,
    );
    expect(getAgentProviderOptions).toHaveBeenCalledWith("openai", {
      refresh: false,
      hostId: "host-1",
    });
    expect(await screen.findByText(/Models from Codex on MacBook-Pro/)).toBeInTheDocument();
    const model = screen.getByRole("combobox", { name: "Model" });
    // One list in Codex's order, its default first.
    expect(within(model).getAllByRole("option")[1]).toHaveTextContent("GPT-5.7 (latest)");
    expect(within(model).queryAllByRole("group")).toHaveLength(0);
  });

  it("narrows the reasoning effort to the picked model's own", async () => {
    getAgentProviderOptions.mockResolvedValue({
      catalog: codexCatalog,
      source: "live",
      cached: false,
      refreshedAt: 1,
    });
    render(
      <AgentOptionsPicker
        provider="openai"
        values={{ copilotModel: "gpt-5.7" }}
        onChange={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: /GPT-5.7/ });
    const effort = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect(
      within(effort)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Default (Medium)", "Low", "Medium", "High", "Max"]);
  });

  it("drops an effort the newly picked model doesn't take", async () => {
    getAgentProviderOptions.mockResolvedValue({
      catalog: codexCatalog,
      source: "live",
      cached: false,
      refreshedAt: 1,
    });
    const onChange = vi.fn();
    render(
      <AgentOptionsPicker
        provider="openai"
        values={{ copilotModel: "gpt-5.6-sol", copilotEffort: "ultra" }}
        onChange={onChange}
      />,
    );
    await screen.findByRole("option", { name: /GPT-5.7/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
      target: { value: "gpt-5.7" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ copilotModel: "gpt-5.7", copilotEffort: "" });
  });
});

/** A model gateway's catalog rows (Settings → Model gateway; docs/model-gateway.md). */
const gatewayModels = [
  {
    id: "claude-sonnet-internal",
    label: "Sonnet (internal)",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    role: "sonnet" as const,
  },
  { id: "claude-haiku-internal", label: "Haiku (internal)", efforts: [] },
  { id: "claude-old", missing: true },
];

describe("AgentOptionsPicker through a model gateway", () => {
  it("offers the gateway's catalog, narrows efforts to the model's, hides the context window", async () => {
    getAgentProviderOptions.mockResolvedValue({
      catalog: gatewayCatalogFor(ANTHROPIC_CATALOG, "LiteLLM", gatewayModels),
      source: "live",
      cached: false,
      refreshedAt: 1,
      gateway: { id: "g1", name: "LiteLLM", lastSyncedAt: null },
    });
    const onChange = vi.fn();
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-sonnet-internal" }}
        onChange={onChange}
        providerModels={gatewayModels}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    expect(getAgentProviderOptions).toHaveBeenCalledWith("anthropic", {
      refresh: false,
      hostId: undefined,
      gateway: "g1",
    });
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(model).toHaveValue("claude-sonnet-internal");
    // The gateway's models, not the stock list; a missing one says so.
    expect(within(model).getByRole("option", { name: "Sonnet (internal)" })).toBeInTheDocument();
    expect(within(model).getByRole("option", { name: "claude-old (missing)" })).toBeInTheDocument();
    expect(within(model).queryByRole("option", { name: /Opus 4\.8/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("gateway-model-hint")).toHaveTextContent(
      "200K context · 32K max output · via LiteLLM",
    );
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Context Window" })).not.toBeInTheDocument();

    const effort = screen.getByRole("combobox", { name: "Effort Level" });
    const choices = within(effort)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(choices).toEqual(["Low", "Medium", "High"]);
    // The pod default ("high") still applies as the value the run gets.
    expect(effort).toHaveValue("high");

    // A model that takes no effort hides the field; its hint shows no limits.
    fireEvent.change(model, { target: { value: "claude-haiku-internal" } });
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "claude-haiku-internal" });
  });

  it("starts from the catalog Settings holds while the API's answer is on the way", () => {
    getAgentProviderOptions.mockReturnValue(new Promise(() => {}));
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-haiku-internal", claudeEffort: "high" }}
        onChange={vi.fn()}
        providerModels={gatewayModels}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(within(model).getByRole("option", { name: "Haiku (internal)" })).toBeInTheDocument();
    expect(within(model).queryByRole("option", { name: /Opus/ })).not.toBeInTheDocument();
    // No efforts on this model: no effort field at all.
    expect(screen.queryByRole("combobox", { name: "Effort Level" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Context Window" })).not.toBeInTheDocument();
    expect(screen.getByTestId("gateway-model-hint")).toHaveTextContent("via LiteLLM");
  });

  it("a gateway model that lists no efforts at all takes none either", () => {
    getAgentProviderOptions.mockReturnValue(new Promise(() => {}));
    const onChange = vi.fn();
    const models = [...gatewayModels, { id: "plain-model", label: "Plain" }];
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-sonnet-internal", claudeEffort: "high" }}
        onChange={onChange}
        providerModels={models}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Effort Level" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
      target: { value: "plain-model" },
    });
    // The saved effort goes with the switch.
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "plain-model", claudeEffort: "" });
    cleanup();
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "plain-model" }}
        onChange={vi.fn()}
        providerModels={models}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Effort Level" })).not.toBeInTheDocument();
  });
});
