import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db } from "../db/client.js";
import {
  localHosts,
  localTerminals,
  localTerminalTranscripts,
  persistentAgents,
  users,
} from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import type { ControllerPrincipal } from "./controller-auth.js";
import { controllerLogs, describeWork, getControllerWork } from "./controller-service.js";
import { createControllerMcp } from "./controller-mcp.js";
import { insertLog } from "./run-log-service.js";

async function setup() {
  const workspaceId = (await insertWorkspace()).id;
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@test.invalid`,
      displayName: "Owner",
    })
    .returning();
  const p: ControllerPrincipal = {
    actor: { userId: user.id, workspaceId, isAdmin: false },
    access: "read",
    name: "Reader",
  };
  const [host] = await db
    .insert(localHosts)
    .values({
      userId: user.id,
      workspaceId,
      name: "Laptop",
      hostname: randomUUID(),
      platform: "darwin",
    })
    .returning();
  const [terminal] = await db
    .insert(localTerminals)
    .values({
      hostId: host.id,
      userId: user.id,
      workspaceId,
      title: "Conversation",
      dir: "/tmp",
      spec: { kind: "agent", agent: "codex" },
      state: "exited",
    })
    .returning();
  const run = await insertTask({
    workspaceId,
    ownerUserId: user.id,
    runTarget: "local",
    localTerminalId: terminal.id,
  });
  await db.insert(localTerminalTranscripts).values([
    { terminalId: terminal.id, seq: 1, role: "user", kind: "text", text: "Find the regression" },
    {
      terminalId: terminal.id,
      seq: 2,
      role: "tool",
      kind: "tool_result",
      text: "Read file",
      detail: "Unique evidence " + "x".repeat(9000),
      toolName: "read_file",
    },
    {
      terminalId: terminal.id,
      seq: 3,
      role: "assistant",
      kind: "text",
      text: "Found the regression",
    },
  ]);
  await insertLog({ taskId: run.id }, { content: "Process exited", logType: "info" });
  return { p, terminal, run };
}

describe("Controller Local run logs", () => {
  it("returns saved agent configuration rather than just its description", async () => {
    const { p } = await setup();
    const [agent] = await db
      .insert(persistentAgents)
      .values({
        workspaceId: p.actor.workspaceId,
        ownerUserId: p.actor.userId,
        slug: randomUUID(),
        name: "Researcher",
        agentRuntime: "codex",
        model: "configured-model",
        systemPrompt: "Use the workspace tools",
        initialPrompt: "Investigate failures",
        agentOptions: { effort: "high" },
        branch: "main",
        settings: { controllerAccess: "read" },
      })
      .returning();
    expect(describeWork(await getControllerWork(p, agent.id))).toMatchObject({
      initialPrompt: "Investigate failures",
      systemPrompt: "Use the workspace tools",
      model: "configured-model",
      agentOptions: { effort: "high" },
      branch: "main",
      settings: { controllerAccess: "read" },
    });
  });

  it("reads the saved conversation by run ID, with stable pages, details and filters", async () => {
    const { p, run, terminal } = await setup();
    expect(describeWork(await getControllerWork(p, run.id))).toMatchObject({
      runTarget: "local",
      localTerminalId: terminal.id,
    });
    const first = await controllerLogs(p, run.id, { limit: 2, offset: 0 });
    expect(first).toMatchObject({
      source: "conversation",
      localTerminalId: terminal.id,
      nextOffset: 2,
    });
    expect(first.logs.map((l) => l.content)).toEqual([
      "Find the regression",
      expect.stringContaining("Unique evidence"),
    ]);
    expect(first.logs[1]).toMatchObject({
      truncated: true,
      logType: "tool_result",
      stream: "tool",
    });
    expect(first.logs[1].content).toHaveLength(8000);
    const next = await controllerLogs(p, run.id, { limit: 2, offset: 2 });
    expect(next.logs.map((l) => l.content)).toEqual(["Found the regression"]);
    expect(next.nextOffset).toBeNull();
    const filtered = await controllerLogs(p, run.id, {
      limit: 10,
      offset: 0,
      search: "unique EVIDENCE",
      logType: "tool_result",
    });
    expect(filtered.logs).toHaveLength(1);
    expect(
      (await controllerLogs(p, run.id, { limit: 10, offset: 0, search: "absent" })).logs,
    ).toEqual([]);
    const lifecycle = await controllerLogs(p, run.id, {
      limit: 10,
      offset: 0,
      source: "execution",
    });
    expect(lifecycle).toMatchObject({ source: "execution", logs: [{ content: "Process exited" }] });
  });

  it("keeps owner and workspace checks even if a run's terminal pointer is wrong", async () => {
    const { p, run, terminal } = await setup();
    await expect(
      controllerLogs({ ...p, actor: { ...p.actor, userId: null } }, run.id, {
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      controllerLogs({ ...p, actor: { ...p.actor, workspaceId: null } }, run.id, {
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await db.update(localTerminals).set({ userId: null }).where(eq(localTerminals.id, terminal.id));
    await expect(controllerLogs(p, run.id, { limit: 10, offset: 0 })).rejects.toMatchObject({
      status: 404,
    });
    await db
      .update(localTerminals)
      .set({ userId: p.actor.userId, workspaceId: null })
      .where(eq(localTerminals.id, terminal.id));
    await expect(controllerLogs(p, run.id, { limit: 10, offset: 0 })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("uses the frontend's classification of historical system turns", async () => {
    const { p, run, terminal } = await setup();
    await db.insert(localTerminalTranscripts).values({
      terminalId: terminal.id,
      seq: 4,
      role: "user",
      kind: "text",
      text: "<task-notification>\n<task-id>worker-1</task-id>\n<status>completed</status>\n<summary>Background check finished</summary>\n</task-notification>",
    });
    const result = await controllerLogs(p, run.id, { limit: 10, offset: 0 });
    expect(result.logs[3]).toMatchObject({ stream: "system", source: "task" });
  });

  it("preserves pod logs and Local provisioning errors before a conversation is attached", async () => {
    const { p } = await setup();
    for (const runTarget of ["cluster", "local"] as const) {
      const run = await insertTask({
        workspaceId: p.actor.workspaceId,
        ownerUserId: p.actor.userId,
        runTarget,
      });
      await insertLog({ taskId: run.id }, { content: "Provisioning failure", logType: "error" });
      expect(await controllerLogs(p, run.id, { limit: 10, offset: 0 })).toMatchObject({
        source: "execution",
        logs: [{ content: "Provisioning failure" }],
      });
      await expect(
        controllerLogs(p, run.id, { limit: 10, offset: 0, source: "conversation" }),
      ).rejects.toMatchObject({ status: runTarget === "local" ? 409 : 400 });
    }
  });

  it("exposes both sources through the actual MCP schema for a read-only caller", async () => {
    const { p, run } = await setup();
    const server = createControllerMcp(p);
    const client = new Client({ name: "local-log-reader", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      for (const source of ["auto", "execution"] as const) {
        const response = await client.callTool({
          name: "optio_get_run_logs",
          arguments: { id: run.id, source, limit: 10 },
        });
        expect(response.isError).not.toBe(true);
        const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
        expect(result.source).toBe(source === "auto" ? "conversation" : "execution");
        expect(result.logs).toHaveLength(source === "auto" ? 3 : 1);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
