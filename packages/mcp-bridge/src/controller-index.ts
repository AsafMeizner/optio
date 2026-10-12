import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectController } from "./controller.js";

try {
  const { client, server } = await connectController();
  server.onclose = () => {
    void client.close();
  };
  await server.connect(new StdioServerTransport());
} catch {
  // Never echo endpoint URLs, headers or tokens into an agent's run logs.
  process.stderr.write(
    "Optio controller MCP could not connect. Check the endpoint and controller access credential.\n",
  );
  process.exitCode = 1;
}
