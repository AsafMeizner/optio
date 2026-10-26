# Conversational work creation

Open **Ask Optio** in the sidebar. Describe the work, or click **Dictate**,
stop recording, review the draft, and send. For example:

> Start a Codex session on my Mac in the Optio repo to investigate the login issue.

Optio discovers repositories and paired machines, asks about ambiguous destinations,
and proposes work through the Optio controller MCP and the same work service as the
form. The review card shows When, Where, Who, Then and the prompt. Approval executes
the tool once and the response links to the work. Settings → Agents → Optio agent
controls the harness, its options, enabled controller tools and write approvals.

Ask Optio is an ordinary **waits for me** pod work session with an Optio prompt and
controller MCP access. The floating panel and its **Open in session** icon show
the same saved conversation at `/work/:id`. Older `/sessions/:id` links redirect there,
including terminal pane selections. Use **All work** to return to the unified list. It supports Claude Code, Codex, Copilot, Gemini,
OpenCode and Cursor through the existing harness command and credential machinery.
Changing the harness applies on the next request. Each request launches a harness
turn with the saved conversation; it does not migrate a provider's native session
or automatically replay an interrupted request.

## Where a turn runs

By default a turn runs in a pooled **agent pod** per conversation
(`OPTIO_ASSISTANT_PLACEMENT=agent-pod`; Helm `optio.assistant.placement`): the
assistant is isolated from the API — its own CPU and memory, and nothing of the
API's filesystem, environment or service-account token within reach of a
prompt-injected harness.

`api-pod` is an explicit opt-in that runs the turn **in the API pod itself**, as a
child process of the API, saving the pod an agent pod would cost. The API image
carries Claude Code and Codex for it (and the same MCP bridge bundle as the agent
images at `/opt/optio`, so the controller MCP loads), and the chart mounts an agent
home (`/home/agent`, an emptyDir) where the turn's run home, setup files and harness
config land as they would in a pod. The process runtime
(`packages/container-runtime/src/process.ts`) speaks the same run protocol as the
pod runtimes — the same run-directory files, start / attach / stdin / kill — with
no detached supervisor: the agent is the API's child, in its own process group,
and an API restart ends its turn (the next message starts a new one). The API pod
runs up to `OPTIO_ASSISTANT_IN_POD_MAX` turns at once (default 3).

**Security of `api-pod`.** The harness runs with its permission checks skipped, as
the API's own user, in the API's container. The child's environment is scrubbed,
but a same-user process can still read the API's: anyone who can use Ask Optio —
or text the assistant reads through the controller MCP (run logs, messages) — can
have it read `/proc/<api pid>/environ` (`OPTIO_ENCRYPTION_KEY`, `DATABASE_URL`,
`REDIS_URL`, OAuth client secrets), the API's service-account token (namespace
secrets, pod exec) and other users' concurrent in-pod turns (their harness and
controller credentials). Enable it only where every member is trusted with the
deployment's secrets.

A turn goes to an agent pod regardless when the session has a repo
(checkouts live in pods), when its harness is not in the API image (Copilot,
Gemini, OpenCode, Cursor), or when the pod already runs its in-pod maximum; the
API log says which (`Assistant turn runs in an agent pod`, with the reason).
`services/assistant-placement.ts` holds the rule.

The optional legacy dedicated Optio pod (`optio.enabled`) is not used by either
placement. Pod startup, harness credentials and provider errors appear in the
conversation. The controller grants expire with their turn and remain restricted
to its owner and workspace; no user API token is forwarded into the pod.

Conversation history and pending approvals survive refresh and reconnect. Several
clients can view the same session. Send another message while it is working to queue
it: pending messages persist on the server, appear on every client, and execute in
order with one active turn. Remove a queued message before it starts; up to 20 can
wait. Reconnecting never replays a started turn. Approval
decisions are single-use and synchronized between clients. Clear conversation is
available after the current request, queued messages and approvals finish. Closing the panel
keeps its connection; dismissing the native assistant disconnects its viewer.
Neither operation automatically retries a message or an action.

On wide screens, the **anchor** docks the assistant beside the page, reserving its
own column. Click again to float it. The browser remembers this preference; closing
a docked panel gives its space back to the page. Below 1024px the panel floats and
on phones it fills the screen.

The iOS and Android apps have a dedicated **Optio Agent** tab, alongside Overview,
Work, Library and More. Insights remains available in More. They
show the same conversation and approval cards. Use the system keyboard's microphone
for dictation. Drafts stay local to the client; saved history comes from the session.

## Dictation prototype

This version uses browser `SpeechRecognition` / `webkitSpeechRecognition` with
interim results. Final words append to an editable draft; neither speech nor stopping
the microphone sends the message. Closing the panel stops listening. Microphone
errors leave typed text intact. Dictation can edit a draft even while chat is disconnected or busy. Unsupported browsers, silent endings and startup/finish timeouts show an explanation; speech-service failures are distinguished from denied microphone access.

It needs a secure context (HTTPS or localhost), microphone permission and a browser
with speech recognition. Browser support and service availability vary. The browser
may send audio to its speech provider; Optio receives only the text you send. Use OS
keyboard dictation or typing when browser recognition is unavailable. Dictate is
disabled in that case, with the explanation in its tooltip.

For broader browser support, the next step is a MediaRecorder capture and authenticated
server transcription endpoint, with explicit provider configuration, upload limits,
and short-lived audio handling. That would replace the recognition hook while keeping
the same draft → review → send interaction. A continuous voice conversation would be
a separate interaction, including interruption and spoken responses.

Reference: [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

## Implementation and verification

- `session-harness-service.ts`: ordinary session creation and shared harness execution.
- `harness-session-chat.ts`: WebSocket presentations for the panel and session page.
- `controller-mcp.ts` and `controller-auth.ts`: controller tools and scoped turn credentials.
- `session-tool-approval.ts`: durable, single-use approvals.
- `use-dictation.ts`: browser microphone lifecycle and editable transcription draft.

Integration tests cover private session creation, turn credential revocation and a
real MCP work creation gated by approval. Pipeline tests run the real server with
the fake runtime, restoring history, deduplicating requests and switching between
Claude Code and Cursor. Browser tests cover dictation, approval cards, real saved
history, docking and narrow layouts in Chromium and Firefox. Other harnesses use
the command, environment and parser tests shared with other pod work. These tests
do not establish live provider availability or microphone quality.
