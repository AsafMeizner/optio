// Exercise the installed binary's stdio protocol without credentials or network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const server = spawn("mcp-server-filesystem", [tmpdir()], { stdio: ["pipe", "pipe", "inherit"] });
const timer = setTimeout(() => {
  console.error("Filesystem MCP did not initialize within 10 seconds");
  server.kill();
  process.exitCode = 1;
}, 10_000);
let buffer = "";
let initialized = false;
server.on("error", (error) => {
  console.error(error.message);
  clearTimeout(timer);
  process.exitCode = 1;
});
server.stdout.setEncoding("utf8").on("data", (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    if (response.id !== 1) continue;
    assert.ok(response.result?.protocolVersion, JSON.stringify(response));
    assert.ok(response.result?.serverInfo?.name, JSON.stringify(response));
    initialized = true;
    clearTimeout(timer);
    server.kill();
  }
});
server.on("exit", () => {
  clearTimeout(timer);
  if (!initialized) process.exitCode = 1;
});
server.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "optio-image-check", version: "1.0.0" },
    },
  }) + "\n",
);
