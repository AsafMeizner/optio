/** Stdio adapter for the controller's Streamable HTTP MCP. The controller
 * owns the tool schemas and authorization; this adapter never duplicates
 * its API or grants access to arbitrary URLs via a tool argument.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function controllerUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error(
      "OPTIO_MCP_URL must be an HTTP(S) endpoint without credentials, query or fragment",
    );
  }
  return url;
}

export function createControllerProxy(client: Client): Server {
  const server = new Server(
    { name: "optio-controller", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: client.getInstructions(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
    client.callTool(req.params, undefined, { signal: extra.signal }),
  );
  return server;
}

export async function connectController(env: NodeJS.ProcessEnv = process.env) {
  const url = controllerUrl(env.OPTIO_MCP_URL ?? "http://localhost:30400/api/mcp");
  const headers: Record<string, string> = {};
  if (env.OPTIO_MCP_TOKEN) headers.Authorization = `Bearer ${env.OPTIO_MCP_TOKEN}`;
  if (env.OPTIO_WORKSPACE_ID) headers["X-Workspace-Id"] = env.OPTIO_WORKSPACE_ID;
  const client = new Client({ name: "optio-controller-stdio", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers, redirect: "error" },
    }),
  );
  return { client, server: createControllerProxy(client) };
}
