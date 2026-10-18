import { OPTIO_TOOL_SCHEMAS } from "../optio-tools.js";

export interface OptioSettings {
  id: string;
  /**
   * An alias ("opus", "sonnet", "haiku", "fable": always the newest of that
   * family) or a specific model id, pinned.
   */
  agentRuntime: string;
  agentOptions: Record<string, string | boolean>;
  model: string;
  systemPrompt: string;
  enabledTools: string[];
  confirmWrites: boolean;
  maxTurns: number;
  /**
   * Workspace-level review-agent fallback. When a repo doesn't set its own
   * `reviewAgentType` and `defaultAgentType`, the resolver in
   * `apps/api/src/services/review-config.ts` picks this up. Null = no
   * preference (resolver continues falling back through its chain).
   */
  defaultReviewAgentType: string | null;
  defaultReviewModel: string | null;
  workspaceId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateOptioSettingsInput {
  agentRuntime?: string;
  agentOptions?: Record<string, string | boolean>;
  model?: string;
  systemPrompt?: string;
  enabledTools?: string[];
  confirmWrites?: boolean;
  maxTurns?: number;
  defaultReviewAgentType?: string | null;
  defaultReviewModel?: string | null;
}

/** Tool category for UI grouping */
export interface OptioToolCategory {
  name: string;
  tools: OptioToolDefinition[];
}

export interface OptioToolDefinition {
  name: string;
  description: string;
  category: string;
}

/** All available Optio tools, grouped by category */
export const OPTIO_TOOL_CATEGORIES: OptioToolCategory[] = Array.from(
  new Set(OPTIO_TOOL_SCHEMAS.map((tool) => tool.category)),
  (name) => ({
    name,
    tools: OPTIO_TOOL_SCHEMAS.filter((tool) => tool.category === name).map(
      ({ name, description, category }) => ({ name, description, category }),
    ),
  }),
);

/** Flat list of all tool names */
export const ALL_OPTIO_TOOL_NAMES: string[] = OPTIO_TOOL_CATEGORIES.flatMap((cat) =>
  cat.tools.map((t) => t.name),
);
