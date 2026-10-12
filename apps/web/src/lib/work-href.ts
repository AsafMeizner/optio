/** Keep legacy API hrefs compatible while the web uses one detail route. */
export function workHref(href: string): string {
  return href.replace(/^\/(?:tasks|local)\/([^/?#]+)(?=[?#]|$)/, (path, id) =>
    ["new", "scheduled", "automations"].includes(id) ? path : `/work/${id}`,
  );
}

/** A terminal link identifies an exact attempt, even after its task retries. */
export function terminalWorkHref(terminal: { id: string; taskId?: string | null }): string {
  return terminal.taskId
    ? `/work/${terminal.taskId}?session=${encodeURIComponent(terminal.id)}`
    : `/work/${terminal.id}`;
}
