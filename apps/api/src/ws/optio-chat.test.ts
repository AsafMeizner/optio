import { describe, it, expect, beforeEach } from "vitest";
import {
  toolRequiresConfirmation,
  buildToolDefinitionsBlock,
  buildSystemPrompt,
  parseActionProposal,
  parseActionResult,
  toAnthropicTools,
  streamAnthropicResponse,
} from "./optio-chat.js";
import { OPTIO_TOOL_SCHEMAS } from "@optio/shared";

describe("optio-chat", () => {
  // ─── toolRequiresConfirmation ───

  describe("toolRequiresConfirmation", () => {
    it("returns true for write tool prefixes", () => {
      expect(toolRequiresConfirmation("create_task")).toBe(true);
      expect(toolRequiresConfirmation("retry_task")).toBe(true);
      expect(toolRequiresConfirmation("cancel_task")).toBe(true);
      expect(toolRequiresConfirmation("update_repo")).toBe(true);
      expect(toolRequiresConfirmation("bulk_retry")).toBe(true);
      expect(toolRequiresConfirmation("assign_issue")).toBe(true);
      expect(toolRequiresConfirmation("delete_repo")).toBe(true);
      expect(toolRequiresConfirmation("restart_pod")).toBe(true);
      expect(toolRequiresConfirmation("manage_secrets")).toBe(true);
      expect(toolRequiresConfirmation("manage_schedules")).toBe(true);
    });

    it("returns false for read tool prefixes", () => {
      expect(toolRequiresConfirmation("list_tasks")).toBe(false);
      expect(toolRequiresConfirmation("get_task_details")).toBe(false);
      expect(toolRequiresConfirmation("get_cost_analytics")).toBe(false);
      expect(toolRequiresConfirmation("get_cluster_status")).toBe(false);
      expect(toolRequiresConfirmation("list_repos")).toBe(false);
      expect(toolRequiresConfirmation("list_issues")).toBe(false);
      expect(toolRequiresConfirmation("list_pods")).toBe(false);
    });
  });

  // ─── buildToolDefinitionsBlock (backward compat) ───

  describe("buildToolDefinitionsBlock", () => {
    it("returns all tools when enabledTools is empty", () => {
      const block = buildToolDefinitionsBlock([]);
      expect(block).toContain("list_tasks");
      expect(block).toContain("create_task");
      expect(block).toContain("get_cost_analytics");
      expect(block).toContain("manage_secrets");
    });

    it("filters to only enabled tools", () => {
      const block = buildToolDefinitionsBlock(["list_tasks", "retry_task"]);
      expect(block).toContain("list_tasks");
      expect(block).toContain("retry_task");
      expect(block).not.toContain("create_task");
      expect(block).not.toContain("manage_secrets");
    });

    it("includes requiresConfirmation tag", () => {
      const block = buildToolDefinitionsBlock(["list_tasks", "create_task"]);
      expect(block).toContain("list_tasks: List and search tasks [requiresConfirmation: false]");
      expect(block).toContain("create_task: Create a new task [requiresConfirmation: true]");
    });
  });

  // ─── toAnthropicTools ───

  describe("toAnthropicTools", () => {
    it("returns all tools when enabledTools is empty", () => {
      const tools = toAnthropicTools(OPTIO_TOOL_SCHEMAS, []);
      expect(tools.length).toBe(OPTIO_TOOL_SCHEMAS.length);
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_tasks");
      expect(names).toContain("get_task");
      expect(names).toContain("create_task");
      expect(names).toContain("get_cost_analytics");
    });

    it("filters to enabled tools", () => {
      const tools = toAnthropicTools(OPTIO_TOOL_SCHEMAS, ["list_tasks", "get_task"]);
      expect(tools.length).toBe(2);
      expect(tools[0].name).toBe("list_tasks");
      expect(tools[1].name).toBe("get_task");
    });

    it("returns tools in Anthropic format with name, description, input_schema", () => {
      const tools = toAnthropicTools(OPTIO_TOOL_SCHEMAS, ["list_tasks"]);
      expect(tools.length).toBe(1);
      const tool = tools[0];
      expect(tool).toHaveProperty("name", "list_tasks");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("input_schema");
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.properties).toBeDefined();
      // Should NOT include endpoint or method (Anthropic format only)
      expect(tool).not.toHaveProperty("endpoint");
      expect(tool).not.toHaveProperty("method");
      expect(tool).not.toHaveProperty("category");
    });

    it("preserves input_schema properties and required fields", () => {
      const tools = toAnthropicTools(OPTIO_TOOL_SCHEMAS, ["create_task"]);
      const tool = tools[0];
      expect(tool.input_schema.properties).toHaveProperty("title");
      expect(tool.input_schema.properties).toHaveProperty("repoUrl");
      expect(tool.input_schema.properties).toHaveProperty("prompt");
      expect(tool.input_schema.required).toEqual(["title", "repoUrl", "prompt"]);
    });
  });

  // ─── buildSystemPrompt ───

  describe("buildSystemPrompt", () => {
    it("includes Optio persona", () => {
      const prompt = buildSystemPrompt({
        systemPrompt: "",
        confirmWrites: true,
      });
      expect(prompt).toContain("You are Optio");
      expect(prompt).toContain("operations assistant");
    });

    it("includes instructions about using tools", () => {
      const prompt = buildSystemPrompt({
        systemPrompt: "",
        confirmWrites: false,
      });
      expect(prompt).toContain("Use the provided tools");
      expect(prompt).toContain("Be concise and direct");
    });

    it("includes write operation policy when confirmWrites is true", () => {
      const prompt = buildSystemPrompt({
        systemPrompt: "",
        confirmWrites: true,
      });
      expect(prompt).toContain("Write Operation Policy");
      expect(prompt).toContain("confirmation automatically");
    });

    it("omits write operation policy when confirmWrites is false", () => {
      const prompt = buildSystemPrompt({
        systemPrompt: "",
        confirmWrites: false,
      });
      expect(prompt).not.toContain("Write Operation Policy");
      expect(prompt).not.toContain("confirmation automatically");
    });

    it("appends custom system prompt", () => {
      const prompt = buildSystemPrompt({
        systemPrompt: "Always respond in Japanese.",
        confirmWrites: true,
      });
      expect(prompt).toContain("Additional Instructions");
      expect(prompt).toContain("Always respond in Japanese.");
    });

    it("omits additional instructions when systemPrompt is empty", () => {
      const prompt = buildSystemPrompt({
        systemPrompt: "",
        confirmWrites: true,
      });
      expect(prompt).not.toContain("Additional Instructions");
    });
  });

  // ─── parseActionProposal ───

  describe("parseActionProposal", () => {
    it("parses a valid action proposal", () => {
      const text = `I'd like to do the following:

ACTION_PROPOSAL: {"description": "Retry 3 failed tasks", "items": ["Retry task #201", "Retry task #203"]}

Let me know if this looks good.`;

      const result = parseActionProposal(text);
      expect(result).not.toBeNull();
      expect(result!.description).toBe("Retry 3 failed tasks");
      expect(result!.items).toEqual(["Retry task #201", "Retry task #203"]);
    });

    it("returns null for text without proposal", () => {
      const text = "Here are your running tasks: task-1, task-2, task-3.";
      expect(parseActionProposal(text)).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      const text = "ACTION_PROPOSAL: {not valid json}";
      expect(parseActionProposal(text)).toBeNull();
    });

    it("returns null when JSON lacks required fields", () => {
      const text = 'ACTION_PROPOSAL: {"description": "test"}';
      expect(parseActionProposal(text)).toBeNull();
    });

    it("returns null when items is not an array", () => {
      const text = 'ACTION_PROPOSAL: {"description": "test", "items": "not-array"}';
      expect(parseActionProposal(text)).toBeNull();
    });
  });

  // ─── parseActionResult ───

  describe("parseActionResult", () => {
    it("parses a valid action result", () => {
      const text = `Done!

ACTION_RESULT: {"success": true, "summary": "Retried 3 tasks successfully"}`;

      const result = parseActionResult(text);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.summary).toBe("Retried 3 tasks successfully");
    });

    it("parses a failure result", () => {
      const text =
        'ACTION_RESULT: {"success": false, "summary": "Failed to cancel task #201: not running"}';
      const result = parseActionResult(text);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.summary).toContain("Failed to cancel");
    });

    it("returns null for text without result", () => {
      const text = "I completed the operation.";
      expect(parseActionResult(text)).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      const text = "ACTION_RESULT: {invalid}";
      expect(parseActionResult(text)).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      const text = 'ACTION_RESULT: {"success": true}';
      expect(parseActionResult(text)).toBeNull();
    });
  });

  // ─── streamAnthropicResponse ───

  describe("streamAnthropicResponse", () => {
    /** Build a fake Response from SSE lines. */
    function fakeSSEResponse(events: string[]): Response {
      const body = events.join("\n") + "\n";
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return new Response(stream);
    }

    it("streams text deltas to send callback", async () => {
      const events = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        'data: {"type":"message_stop"}',
      ];

      const sent: Record<string, unknown>[] = [];
      const result = await streamAnthropicResponse(fakeSSEResponse(events), (msg) =>
        sent.push(msg),
      );

      expect(sent).toEqual([
        { type: "text", content: "Hello" },
        { type: "text", content: " world" },
      ]);
      expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(result.stopReason).toBe("end_turn");
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
    });

    it("collects tool_use blocks from streaming", async () => {
      const events = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":20}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking..."}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"list_tasks","input":{}}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"state\\":"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"failed\\"}"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}',
        'data: {"type":"message_stop"}',
      ];

      const sent: Record<string, unknown>[] = [];
      const result = await streamAnthropicResponse(fakeSSEResponse(events), (msg) =>
        sent.push(msg),
      );

      // Only text deltas should be sent to client
      expect(sent).toEqual([{ type: "text", content: "Checking..." }]);

      expect(result.content.length).toBe(2);
      expect(result.content[0]).toEqual({ type: "text", text: "Checking..." });
      expect(result.content[1]).toEqual({
        type: "tool_use",
        id: "toolu_123",
        name: "list_tasks",
        input: { state: "failed" },
      });
      expect(result.stopReason).toBe("tool_use");
    });

    it("handles empty stream gracefully", async () => {
      const events = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0}}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
        'data: {"type":"message_stop"}',
      ];

      const sent: Record<string, unknown>[] = [];
      const result = await streamAnthropicResponse(fakeSSEResponse(events), (msg) =>
        sent.push(msg),
      );

      expect(sent).toEqual([]);
      expect(result.content).toEqual([]);
      expect(result.stopReason).toBe("end_turn");
    });
  });
});
