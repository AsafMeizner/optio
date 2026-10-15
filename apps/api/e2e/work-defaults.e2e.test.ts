import { afterAll, beforeAll, expect, it } from "vitest";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
beforeAll(async () => {
  server = await startApiServer();
}, 150_000);
afterAll(async () => {
  await server?.stop();
});

it("round-trips the end state through storage, preserves it for older clients, and rejects invalid choices", async () => {
  const url = `${server.baseUrl}/api/me/work-defaults`;
  const put = (body: unknown) =>
    fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await put({ then: "until-merged", runtime: "codex" })).status).toBe(200);
  expect((await (await fetch(url)).json()).defaults).toMatchObject({
    then: "until-merged",
    runtime: "codex",
  });
  expect((await put({ runtime: "claude-code" })).status).toBe(200);
  expect((await (await fetch(url)).json()).defaults).toMatchObject({
    then: "until-merged",
    runtime: "claude-code",
  });
  expect((await put({ then: "unknown-end-state" })).status).toBe(400);
  expect((await (await fetch(url)).json()).defaults.then).toBe("until-merged");
  expect((await put({ then: "exits" })).status).toBe(200);
  expect((await (await fetch(url)).json()).defaults.then).toBe("exits");
});
