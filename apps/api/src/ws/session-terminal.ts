import { canJoinSession, watchSessionAccess } from "../services/session-sharing-service.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRuntime } from "../services/container-service.js";
import {
  getSession,
  addSessionPr,
  addSessionLinks,
} from "../services/interactive-session-service.js";
import { getPod } from "../services/agent-pod-pool.js";
import { logger } from "../logger.js";
import { shellQuote, createPodLinkScanner } from "@optio/shared";
import type { ContainerHandle, ExecSession } from "@optio/shared";
import { authenticateWs } from "./ws-auth.js";
import { requireWsRole } from "./ws-authz.js";
import { acceptWs, serializeWsInput } from "./ws-connection.js";
import { isMessageWithinSizeLimit, WS_CLOSE_MESSAGE_TOO_LARGE } from "./ws-limits.js";

export async function sessionTerminalWs(app: FastifyInstance) {
  app.get("/ws/sessions/:sessionId/terminal", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await: the client's first resize and any
    // early keystrokes are held until the shell exists (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const { sessionId } = z.object({ sessionId: z.string() }).parse(req.params);
    const query = z.object({ terminal: z.enum(["1", "2"]).optional() }).safeParse(req.query ?? {});
    if (!query.success) {
      socket.close(4400, "Invalid terminal pane");
      return conn.discard();
    }
    const terminal = query.data.terminal;
    const shellName = `session-${sessionId}${terminal ? `-terminal-${terminal}` : ""}`;
    const log = logger.child({ sessionId, terminal });

    const reject = (error: string) => {
      socket.send(JSON.stringify({ error }));
      socket.close();
      conn.discard();
    };

    const session = await getSession(sessionId);
    if (!session) return reject("Session not found");

    if (!(await canJoinSession("pod", session, user))) {
      socket.close(4403, "Not authorized for this session");
      return conn.discard();
    }

    // The terminal writes straight to a shell in the repo pod — viewers are
    // read-only and must not reach it.
    if (!(await requireWsRole(socket, user, "member", session.workspaceId))) {
      return conn.discard();
    }

    if (session.state !== "active") return reject("Session is not active");
    if (!session.podId) return reject("Session has no pod assigned");

    // Get pod info
    const pod = await getPod(session.podId);
    if (!pod || !pod.podName) {
      return reject(
        "Session pod was cleaned up due to inactivity. Please end this session and start a new one.",
      );
    }
    const mayInput = watchSessionAccess("pod", session, user, socket);
    if (conn.closed) return;

    const rt = getRuntime();
    const handle: ContainerHandle = { id: pod.podId ?? pod.podName, name: pod.podName };

    // Set up worktree and launch shell
    const worktreePath = session.worktreePath ?? "/workspace/repo";
    const branch = session.branch;

    const setupScript = [
      "set -e",
      // Wait for repo to be ready
      "for i in $(seq 1 60); do [ -f /workspace/.ready ] && break; sleep 1; done",
      '[ -f /workspace/.ready ] || { echo "Repo not ready"; exit 1; }',
      // Acquire repo lock for worktree setup
      "exec 9>/workspace/.repo-lock",
      "flock 9",
      "cd /workspace/repo",
      "git fetch origin 2>/dev/null || true",
      // Create worktree if not exists
      `if [ ! -d "${worktreePath}" ]; then`,
      `  git branch -D "${branch}" 2>/dev/null || true`,
      `  git worktree add "${worktreePath}" -b "${branch}" origin/$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main) 2>/dev/null || git worktree add "${worktreePath}" -b "${branch}" HEAD`,
      `fi`,
      "flock -u 9",
      "exec 9>&-",
      // Launch interactive shell in worktree. An exec gets no TERM or locale
      // of its own: without them programs drop to no color (or 256) and
      // mangle anything outside ASCII. The viewer is xterm.js.
      `cd "${worktreePath}"`,
      'export TERM=xterm-256color COLORTERM=truecolor LANG="${LANG:-C.UTF-8}"',
      "command -v tmux >/dev/null || { echo 'This agent image needs tmux for recoverable sessions. Update the image.'; exit 1; }",
      `terminalDir=${shellQuote(worktreePath)}`,
      ...(terminal
        ? [
            `currentDir=$(tmux -L optio display-message -p -t ${shellQuote(`session-${session.id}`)} '#{pane_current_path}' 2>/dev/null || true)`,
            '[ -z "$currentDir" ] || { [ ! -d "$currentDir" ] || terminalDir="$currentDir"; }',
          ]
        : []),
      `exec tmux -L optio -f /dev/null new-session -A -s ${shellQuote(shellName)} -c "$terminalDir" 'bash -l'`,
    ].join("\n");

    let execSession: ExecSession | null = null;
    const detected = new Set<string>();
    const scan = createPodLinkScanner(session.repoUrl);
    const decoder = new TextDecoder();
    let output = "";
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    let columns = 80;
    const flushLinks = (final = false) => {
      clearTimeout(scanTimer);
      scanTimer = undefined;
      const links = scan(output, columns, final).filter(
        (link) => !detected.has(`${link.kind}:${link.url}`),
      );
      output = "";
      if (!links.length) return;
      for (const link of links) detected.add(`${link.kind}:${link.url}`);
      addSessionLinks(sessionId, links).catch((err) =>
        log.warn({ err }, "Failed to register session links"),
      );
      for (const link of links.filter((link) => link.kind === "pr" && link.provider === "github")) {
        const prNumber = Number(link.url.split("/").pop());
        addSessionPr(sessionId, link.url, prNumber).catch((err) =>
          log.warn({ err }, "Failed to register session PR"),
        );
      }
    };
    const scanForWorkLinks = (chunk: Buffer) => {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-65536);
      if (!scanTimer) scanTimer = setTimeout(flushLinks, 150);
    };
    conn.onClose(() => flushLinks(true));

    try {
      execSession = await rt.exec(handle, ["bash", "-c", setupScript], { tty: true });
      // Registered before anything else so a client that left while the
      // shell was starting still gets it closed (right away, in that case).
      conn.onClose(() => {
        log.info("Session terminal disconnected");
        execSession?.close();
      });
      if (conn.closed) return;

      // Pipe exec stdout → WebSocket + scan for PR URLs
      execSession.stdout.on("data", (chunk: Buffer) => {
        if (socket.readyState === 1) {
          socket.send(chunk);
        }
        scanForWorkLinks(chunk);
      });

      execSession.stderr.on("data", (chunk: Buffer) => {
        if (socket.readyState === 1) {
          socket.send(chunk);
        }
        scanForWorkLinks(chunk);
      });

      // Handle exec session end
      execSession.stdout.on("end", () => {
        if (socket.readyState === 1) {
          socket.close();
        }
      });

      // Pipe WebSocket → exec stdin, starting with what arrived during setup.
      conn.ready(
        serializeWsInput(socket, async (data: Buffer | string) => {
          if (!(await mayInput())) return;
          if (!isMessageWithinSizeLimit(data)) {
            socket.close(WS_CLOSE_MESSAGE_TOO_LARGE, "Message too large");
            return;
          }

          const str = typeof data === "string" ? data : data.toString("utf-8");

          // Check for resize messages
          try {
            const parsed = JSON.parse(str);
            if (parsed.type === "resize" && parsed.cols && parsed.rows) {
              columns = parsed.cols;
              execSession?.resize(parsed.cols, parsed.rows);
              return;
            }
          } catch {
            // Not JSON, treat as terminal input
          }

          execSession?.stdin.write(typeof data === "string" ? data : data);
        }),
      );
    } catch (err) {
      log.error({ err }, "Failed to start terminal exec session");
      reject("Failed to start terminal");
    }
  });
}
