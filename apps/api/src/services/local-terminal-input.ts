import { sendToHost } from "./local-relay.js";
import { splitSubmit, SUBMIT_GAP_MS } from "../utils/terminal-input.js";
import { setTimeout as delay } from "node:timers/promises";

/** Shared input transport for the chat composer and controller. Callers authorize the terminal. */
export async function sendLocalTerminalInput(
  terminal: { id: string; hostId: string; state: string },
  input: string,
): Promise<{ error: string } | null> {
  if (terminal.state !== "running") return { error: `Terminal is ${terminal.state}` };
  // Separate Enter from the text so TUIs do not mistake submission for a paste.
  for (const [i, data] of splitSubmit(input).entries()) {
    if (i > 0) await delay(SUBMIT_GAP_MS);
    if (
      !(await sendToHost(terminal.hostId, {
        type: "input",
        terminalId: terminal.id,
        dataB64: Buffer.from(data, "utf-8").toString("base64"),
      }))
    )
      return { error: "Host is offline" };
  }
  return null;
}
