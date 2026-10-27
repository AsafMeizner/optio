#!/usr/bin/env node
// Exercise the native CLI through docker exec, past startup/GC, without a
// provider credential or a paid model request. Run after building agent images:
//   node scripts/smoke-claude-exec.mjs optio-base:latest
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const TEXT_MARKER = "OPTIO_CLAUDE_SECURITY_SMOKE_OK";
const TOOL_MARKER = "OPTIO_CLAUDE_BASH_OK";

if (process.argv[2] === "--serve") {
  let count = 0;
  createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (!req.url.includes("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const body = JSON.parse(raw);
      const seenTool = (body.messages || []).some(
        (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"),
      );
      const content = seenTool
        ? { type: "text", text: TEXT_MARKER }
        : {
            type: "tool_use",
            id: "audit_tool_1",
            name: "Bash",
            input: { command: `printf ${TOOL_MARKER}`, description: "deterministic smoke test" },
          };
      const stop = seenTool ? "end_turn" : "tool_use";
      const message = {
        id: `msg_audit_${++count}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [content],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10 },
      };
      // --version is too quick to reproduce the old Bun GC crash. Two turns
      // with delayed replies also exercise Bash spawning and stream parsing.
      setTimeout(() => {
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(message));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type, data) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("message_start", { message: { ...message, content: [], stop_reason: null } });
        event("content_block_start", {
          index: 0,
          content_block:
            content.type === "text" ? { type: "text", text: "" } : { ...content, input: {} },
        });
        event("content_block_delta", {
          index: 0,
          delta:
            content.type === "text"
              ? { type: "text_delta", text: content.text }
              : { type: "input_json_delta", partial_json: JSON.stringify(content.input) },
        });
        event("content_block_stop", { index: 0 });
        event("message_delta", {
          delta: { stop_reason: stop, stop_sequence: null },
          usage: { output_tokens: 10 },
        });
        event("message_stop", {});
        res.end();
      }, 2000);
    });
  }).listen(18084, "127.0.0.1");
} else {
  const [image, binary = "claude"] = process.argv.slice(2);
  if (!image) throw new Error("Usage: node scripts/smoke-claude-exec.mjs IMAGE [CLAUDE_BINARY]");
  const name = `optio-claude-audit-${randomUUID()}`;
  const docker = (...args) => {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `docker ${args[0]} failed: ${result.error?.message ?? result.stderr}\n${result.stdout ?? ""}`,
      );
    }
    return result.stdout;
  };
  try {
    docker(
      "run",
      "--rm",
      "-d",
      "--network",
      "none",
      "--name",
      name,
      "--entrypoint",
      "sleep",
      "--user",
      "root",
      image,
      "infinity",
    );
    docker("cp", fileURLToPath(import.meta.url), `${name}:/tmp/optio-claude-audit.mjs`);
    docker("exec", "-d", name, "node", "/tmp/optio-claude-audit.mjs", "--serve");
    const output = docker(
      "exec",
      "--user",
      "1001:1001",
      "-w",
      "/tmp",
      "-e",
      "HOME=/tmp/optio-audit-home",
      "-e",
      "CLAUDE_CONFIG_DIR=/tmp/optio-audit-config",
      "-e",
      "ANTHROPIC_API_KEY=audit-dummy-key",
      "-e",
      "ANTHROPIC_BASE_URL=http://127.0.0.1:18084",
      "-e",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      name,
      "timeout",
      "45",
      binary,
      "--print",
      "--dangerously-skip-permissions",
      "--tools",
      "Bash",
      "--max-turns",
      "3",
      "--output-format",
      "stream-json",
      "--verbose",
      "Run the deterministic shell smoke test and report its marker.",
    );
    const frames = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      frames.some((f) => f.type === "user" && f.tool_use_result?.stdout === TOOL_MARKER),
      "Bash tool did not run",
    );
    assert(
      frames.some(
        (f) => f.type === "result" && f.subtype === "success" && f.result === TEXT_MARKER,
      ),
      "CLI did not complete",
    );
    const version = frames.find((f) => f.subtype === "init")?.claude_code_version;
    process.stdout.write(
      `Claude ${version}: docker exec, native Bash tool and streamed completion passed (network disabled).\n`,
    );
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
  }
}
