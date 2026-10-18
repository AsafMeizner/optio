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
      { name: "create_trigger", description: "Attach an event trigger" },
      { name: "update_trigger", description: "Edit triggers" },
      { name: "delete_trigger", description: "Remove triggers" },
      { name: "get_task_activity", description: "Read task comments and events" },
      { name: "write_task_comment", description: "Write task comments" },
      { name: "control_run", description: "Cancel, retry and resume runs" },
      { name: "delete_work", description: "Delete recurring work" },
    ],
  },
  {
    name: "Agents",
    tools: [
      { name: "control_agent", description: "Pause, resume and archive agents" },
      { name: "control_session", description: "Interrupt and end sessions" },
      { name: "list_agents", description: "Find agents" },
      { name: "read_inbox", description: "Read agent messages" },
      { name: "send_message", description: "Message an agent" },
      { name: "send_session_message", description: "Send input to your interactive sessions" },
    ],
  },
  {
    name: "Library",
    tools: [
      { name: "list_prompts", description: "Browse prompts" },
      { name: "get_prompt", description: "Read prompts" },
      { name: "preview_prompt", description: "Preview rendered prompts" },
      { name: "create_prompt", description: "Save prompts" },
      { name: "update_prompt", description: "Edit prompts" },
      { name: "delete_prompt", description: "Delete prompts" },
      { name: "get_models", description: "Find models and runtime options" },
      { name: "get_environment", description: "Find connections, tools and skills" },
    ],
  },
  {
    name: "Reviews",
    tools: [
      { name: "create_review", description: "Launch PR reviews" },
      { name: "update_review", description: "Edit review drafts" },
      { name: "control_review", description: "Cancel, re-review and submit reviews" },
      { name: "get_review_chat", description: "Read review conversations" },
      { name: "send_review_message", description: "Message review agents" },
      { name: "merge_pr", description: "Merge a work pull request" },
      { name: "get_pr_status", description: "Read PR checks and merge state" },
    ],
  },
];
export const ALL_CONTROLLER_TOOL_NAMES = CONTROLLER_TOOL_CATEGORIES.flatMap((c) =>
  c.tools.map((t) => t.name),
);
