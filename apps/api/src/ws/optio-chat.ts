/** Ask Optio is a view of the user's ordinary interactive work session. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateWs } from "./ws-auth.js";
import { requireWsRole } from "./ws-authz.js";
import { acceptWs } from "./ws-connection.js";
import { ensureOptioSession } from "../services/session-harness-service.js";
import { attachHarnessChat } from "./harness-session-chat.js";
import { isAuthDisabled } from "../services/oauth/index.js";

export async function optioChatWs(app: FastifyInstance) {
  app.get("/ws/optio/chat", { websocket: true }, async (socket, req) => {
    const conn = acceptWs(socket, req);
    if (!conn) return;
    try {
      let user = await authenticateWs(socket, req);
      if (!user) return conn.discard();
      const header = req.headers["x-workspace-id"];
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)optio_workspace=([^;]*)/)?.[1];
      const workspace =
        typeof header === "string"
          ? header
          : cookie
            ? decodeURIComponent(cookie)
            : user.workspaceId;
      if (workspace && !z.string().uuid().safeParse(workspace).success) {
        socket.close(4403, "Invalid workspace");
        return conn.discard();
      }
      user = { ...user, workspaceId: workspace };
      if (!(await requireWsRole(socket, user, "member")) || conn.closed) return conn.discard();
      const session = await ensureOptioSession(
        isAuthDisabled() && user.id === "local" ? null : user.id,
        workspace ?? null,
      );
      const actor = user;
      await attachHarnessChat(
        socket,
        conn,
        session.id,
        () => requireWsRole(socket, actor, "member"),
        true,
      );
    } catch (err) {
      app.log.error({ err }, "Unable to open Optio session");
      if (!conn.closed) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "Could not open the Optio work session. Reconnect to try again.",
          }),
        );
        socket.close(1011);
      }
      conn.discard();
    }
  });
}
