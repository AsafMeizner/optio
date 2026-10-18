/** Names exposed by the Optio controller MCP, without its optio_ prefix. */
export const CONTROLLER_TOOL_CATEGORIES = [
  {
    name: "Discovery",
    tools: [
      { name: "context", description: "Workspace identity and access" },
      { name: "list_work", description: "Find work and sessions" },
      { name: "get_work", description: "Read work details" },
      { name: "list_repos", description: "Find repositories" },
      { name: "list_machines", description: "Find your machines" },
      { name: "list_runs", description: "Read run history" },
      { name: "get_run_logs", description: "Read run logs" },
      { name: "get_session_history", description: "Read your session conversations" },
    ],
  },
  {
    name: "Work and schedules",
    tools: [
      { name: "create_work", description: "Create work" },
      { name: "update_work", description: "Edit recurring work" },
      { name: "set_work_enabled", description: "Pause or enable work" },
      { name: "run_work", description: "Start a run" },
      { name: "list_triggers", description: "Read triggers" },
      { name: "set_schedule", description: "Set a schedule" },
      { name: "delete_schedule", description: "Remove a schedule" },
    ],
  },
  {
    name: "Agents",
    tools: [
      { name: "list_agents", description: "Find agents" },
      { name: "read_inbox", description: "Read agent messages" },
      { name: "send_message", description: "Message an agent" },
      { name: "send_session_message", description: "Send input to your interactive sessions" },
    ],
  },
];
export const ALL_CONTROLLER_TOOL_NAMES = CONTROLLER_TOOL_CATEGORIES.flatMap((c) =>
  c.tools.map((t) => t.name),
);
