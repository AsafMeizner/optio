# Pod and Local session parity

Pass through the web session surfaces, October 24, 2026.

## Implemented in this pass

| Capability           | Pod behavior                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR and ticket badges | Detect GitHub/GitLab PRs and issues, Linear/Jira URLs, and repository-relative `#N` references in chat, user messages, tool metadata, and terminal output. Reuse Local's icons, identity rules, expansion control, and link safety. |
| Durable references   | Store bounded, deduplicated references on the session, separately from chat retention. Serialize updates from simultaneous terminal panes and chat. Seed new agent sessions from their initial prompt.                              |
| Header visibility    | Show references for terminal and agent-only sessions, including ended sessions. Recorded PRs expose their existing state/check/review indicators in the header as well as the terminal footer.                                      |
| Work list            | Show discovered links on pod and Local rows, with searchable badges above the attributes. The pod session sidebar also shows and searches references.                                                                               |
| Ended sessions       | Read stored chat with the existing log viewer's search and filter controls. Do not open a live socket or display a message composer.                                                                                                |
| Naming               | Owner can rename a pod session inline, including after ending it. Reuse the Local title editor; Escape cancels an edit. Server enforces membership, ownership, and session access.                                                  |
| Browser title        | Use the pod session's title or branch in the browser tab.                                                                                                                                                                           |
| Terminal selection   | Send selected terminal text to the chat draft, including from extra terminal panes. This fills the composer without sending a message.                                                                                              |
| Keyboard and mobile  | Reuse Local's Shift+Enter sequence and touch-to-wheel handling for terminal TUIs.                                                                                                                                                   |
| Failure isolation    | A failed PR-status request no longer prevents opening the session.                                                                                                                                                                  |

Existing chat history is scanned when opened, so its references appear without replaying work. New references are saved server-side. There is no historical backfill for output that was never saved: reopening an active terminal can rediscover references in tmux's screen, but old terminal-only references outside that screen cannot be recovered.

## Existing capabilities retained

Both session surfaces already use the common session sidebar shell, layout memory, terminal hyperlinks and clipboard handling, collaboration links, recovery notices, and split panes. Pod chat already has approvals, queued messages, interruption, cost reporting, and the shared log viewer. Local's raw-terminal view and a pod's structured chat are different representations; there is no need to duplicate structured chat features inside the raw terminal.

## Remaining gaps requiring lifecycle work

| Gap                                | Why it remains                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved terminal screen after ending | Local owns a daemon recording. Pod terminals attach to tmux and ending a session kills its shells; a durable recording and replay protocol is needed. Saved chat is now readable.                                                                       |
| Resume an ended session            | Needs explicit recovery of the checkout, pod and harness session, with ownership checks and no accidental replay of completed turns.                                                                                                                    |
| Delete/archive and pin             | Local's controls and per-user ordering operate on Local terminal ids. Pod sessions need matching server operations and inclusion in those preferences. Ending remains supported.                                                                        |
| Attention/usage parity             | Local has daemon-reported attention, token/context usage, last interaction and pending state. Pod session state only says active/ended; turn and harness signals need a common projection before the sidebar can promise equivalent needs-you behavior. |
| Arbitrary session grouping         | Local groups terminals across sessions. Pod supports its chat plus the primary terminal and two extra terminals within one session; mixing separate pods needs routing/layout changes.                                                                  |
| Native clients                     | This pass changes the web UI. iOS/Android need their own presentation of the newly persisted references and equivalent session controls.                                                                                                                |

## Validation

Regression coverage includes terminal frame splitting (including inside PR numbers), OSC hyperlinks, deduplication and bounds, read-only history without a WebSocket, header badges for both pod session forms, renamed-session ownership, and concurrent database link updates. Database and browser suites require Docker; live verification also requires a configured Kubernetes cluster. Run those before publishing.
