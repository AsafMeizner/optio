import { api } from "@/lib/api-client";

/** Wait for the daemon's exit acknowledgement before removing its session record. */
export async function deleteSession(id: string): Promise<void> {
  const active = (state: string) => state === "running" || state === "launching";
  let { terminal } = await api.getLocalTerminal(id);
  if (active(terminal.state)) {
    try {
      await api.killLocalTerminal(id, "SIGKILL");
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
        throw new Error("Still waiting for the session to stop. Try deleting it again shortly.");
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await api.deleteLocalTerminal(id);
}
