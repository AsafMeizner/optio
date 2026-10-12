import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { controllerUrl, createControllerProxy } from "./controller.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((f) => f()));
});
it("relays discovery, schemas, instructions and tool errors through stdio without duplicating the API", async () => {
  const remote = new McpServer(
    { name: "remote", version: "1" },
    { instructions: "Read the workspace first" },
  );
  remote.registerTool(
    "optio_get_work",
    { inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => ({ isError: true, content: [{ type: "text", text: `Missing ${id}` }] }),
  );
  const upstream = new Client({ name: "proxy", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await remote.connect(a);
  await upstream.connect(b);
  const proxy = createControllerProxy(upstream);
  const downstream = new Client({ name: "agent", version: "1" });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await proxy.connect(c);
  await downstream.connect(d);
  closes.push(
    () => downstream.close(),
    () => proxy.close(),
    () => upstream.close(),
    () => remote.close(),
  );
  expect(downstream.getInstructions()).toBe("Read the workspace first");
  expect((await downstream.listTools()).tools[0]).toMatchObject({
    name: "optio_get_work",
    annotations: { readOnlyHint: true },
    inputSchema: { required: ["id"] },
  });
  expect(
    await downstream.callTool({ name: "optio_get_work", arguments: { id: "missing" } }),
  ).toMatchObject({ isError: true, content: [{ type: "text", text: "Missing missing" }] });
});
it("rejects credential-bearing and non-HTTP endpoint URLs", () => {
  for (const url of [
    "file:///etc/passwd",
    "https://user:secret@example.com/api/mcp",
    "https://example.com/api/mcp?token=secret",
  ])
    expect(() => controllerUrl(url)).toThrow();
  expect(controllerUrl("http://localhost:30400/api/mcp").pathname).toBe("/api/mcp");
});
