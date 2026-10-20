import { api } from "@/lib/api-client";

const active = (state: string) => state === "running" || state === "launching";

/**
 * Kill a session's process and wait for the daemon's exit acknowledgement,
 * so the caller sees the session stopped (and can delete its record) once
 * this resolves. A session that is already stopped resolves at once.
 */
export async function stopSession(id: string, signal: "SIGTERM" | "SIGKILL" = "SIGKILL") {
  let { terminal } = await api.getLocalTerminal(id);
  if (!active(terminal.state)) return terminal;
  try {
    await api.killLocalTerminal(id, signal);
  } catch (error) {
    // The process may have exited between reading its state and sending kill.
    ({ terminal } = await api.getLocalTerminal(id));
    if (active(terminal.state)) throw error;
  }
  const deadline = Date.now() + 15_000;
  while (active(terminal.state)) {
    ({ terminal } = await api.getLocalTerminal(id));
    if (!active(terminal.state)) break;
    if (Date.now() >= deadline) {
      throw new Error("Still waiting for the session to stop. Try again shortly.");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return terminal;
}

/** Stop a running session, then remove its record. */
export async function deleteSession(id: string): Promise<void> {
  await stopSession(id);
  await api.deleteLocalTerminal(id);
}
