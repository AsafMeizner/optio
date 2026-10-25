import type { ProviderCatalog } from "./types.js";

/** Pi's model/provider identifiers are supplied by the installed CLI. */
export const PI_CATALOG: ProviderCatalog = {
  provider: "pi",
  label: "Pi",
  modelField: "piModel",
  modelIsFreeText: true,
  modelPlaceholder: "Default (Pi selects an available model)",
  modelHelpText:
    "Use provider/model (for example anthropic/claude-sonnet-4-6). Run pi --list-models to list available models. Pod runs accept Anthropic, OpenAI, or Gemini API keys.",
  models: [],
  aliases: {},
  options: [
    {
      key: "piThinking",
      label: "Thinking level",
      kind: "select",
      choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
        value,
        label: value,
      })),
    },
  ],
  liveRefreshSupported: false,
};
