import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";

/**
 * An agent's result, read line by line as its output streams (a worker
 * never holds a run's whole output: docs/plans/scale-out.md §1). Lines come
 * in order, without their newline; `finish` reads the result once the
 * agent exited.
 */
export interface AgentResultParser {
  push(line: string): void;
  finish(exitCode: number): AgentResult;
}

export interface AgentAdapter {
  readonly type: string;
  readonly displayName: string;

  /** Validate that required secrets are available */
  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] };

  /** Build the container configuration for running this agent */
  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig;

  /** Parse agent output to determine the result (a whole output: `createResultParser` fed every line) */
  parseResult(exitCode: number, logs: string): AgentResult;

  /** A parser to feed the agent's output line by line as it streams */
  createResultParser(): AgentResultParser;
}

/** Feeds a whole output to a line parser: what every adapter's `parseResult` is. */
export function parseAllLines(
  parser: AgentResultParser,
  exitCode: number,
  logs: string,
): AgentResult {
  for (const line of logs.split("\n")) parser.push(line);
  return parser.finish(exitCode);
}

/**
 * The first match of `re` in an output read line by line — the same as
 * matching the whole text, for a pattern that never spans a newline.
 */
export function firstMatch(re: RegExp): {
  push(line: string): void;
  readonly value: RegExpMatchArray | null;
} {
  let value: RegExpMatchArray | null = null;
  return {
    push(line) {
      if (value === null) value = line.match(re);
    },
    get value() {
      return value;
    },
  };
}
