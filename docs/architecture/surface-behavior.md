# Surface behavior: workspace and interaction contracts

This document owns the durable, non-transcript workspace and interaction
behavior of the TUI. Each section names the current contract, its source
authority and sink, and the shortcuts that must not be introduced. Host business
authority stays in [host-client.md](./host-client.md); transcript cards/folding in
[transcript.md](./transcript.md); seat/modal/lease mechanics in
[overlay-focus.md](./overlay-focus.md); untrusted-text projection and copy rules
in [terminal-output.md](./terminal-output.md); geometry/tokens in
[design-language.md](./design-language.md).

## Quit (`exit`)

Only the exact trimmed, lowercase word `exit`, submitted from an empty editor,
quits before session creation. `/exit` remains an explicit command. `exit!`,
`Exit`, `exit now` and any other wording are ordinary model prompts.

The decision runs at the top of submission dispatch
(`isPlainExitPrompt` in `src/domain/command/policy.ts`), before any session
creation, history write, viewer gate or busy-Enter steer gate. The exit
controller then latches, disposes the Client surface, prepares the owned-session
retirement and requests `appExit` (see
[concurrency.md](./concurrency.md)).

## Pending input and the queue plane

- `queued`, `steering` and non-user `context` placements are projected from the
  one semantic pending-input reader. The queue pane shows only authoritative
  `queued` rows in projection order; a client-local `sending…` echo stays until
  the matching authoritative occurrence arrives.
- A Direct echo is correlated with the authoritative Host Inbox by exact
  `rpcId` only: the matching insertion records that occurrence's target/index
  and durable event seq, later splices move or clear that receipt, and a
  reinsertion of the same identity — in the same mutation (edit/replace) or a
  later one (a queued message promoted to steering) — rebinds it. An Inbox
  removal, including the producer's `canceled` splice marker, proves only that
  the occurrence left its list; it is never a business terminal by itself, and
  a promoted occurrence follows the authoritative steering placement.
- A Direct echo whose Inbox occurrence was claimed (removed from the inbox) and
  whose receipt seq is strictly earlier than a later `request/context` or
  `turn/end`, with no durable `user/message` for that identity, retires as
  failed: the local row stops claiming to send. A genuine queue removal this
  Client issued retires only that exact echo at the committed write settlement
  (application identity, never the splice marker). This is not a generic
  `turn/end` clear — `compaction/end`, `agent/error`, status changes, unrelated
  turn boundaries, still-queued or claimed-but-not-yet-ended occurrences, and
  same-text different identities never retire an echo, and no timeout ever
  guesses a terminal state. Remote still delegates its echo and retirement
  entirely to the official Client `pendingSubmissions`.
- Steering and non-user Context render in ONE ordered ephemeral tail. They are
  never folded into the durable TranscriptFolder, never durable, and never part
  of transcript search.
- A non-user Context body is bounded to two visible rows; it is not exposed as a
  producer source.
- One atomic `setPendingInputPresentation` update owns the pane. Delivery mode
  is captured at the gesture boundary, not re-read during asynchronous
  preparation.
- Local transcript-lane input forces the virtual window to the latest row;
  background steering/context never steals the viewport.
- Local-only rows carry no bulk hint; the hint is scoped to accepted rows.
- A preserved Host queue is explained ONLY by the live projection: an idle
  subject (`running === false`) holding at least one authoritative `queued`
  occurrence shows the next-prompt wake hint ("waiting for the next prompt —
  send a message to continue"). A BUSY subject's queued rows are ordinary
  queueing and show no such hint, and a client-local `sending…` echo alone never
  earns it. Both renderers derive the same condition from the one presentation
  (PiTui queue pane, TSP Dock); there is no `parked` flag, no second state
  source and no automatic wake — the park ends when the user sends a real
  prompt.
- `Alt+Up` is recall-all and `Ctrl+S` is a FIFO steer-all. They remain bulk
  affordances; per-occurrence STEER is still not offered. Per-occurrence
  **edit/remove** is owned by the ONE Queue manager controller
  (`src/app/queue/manager.ts`), reached from three equivalent entries:
  `/queue`, the `app.queue.open` action (default `Alt+I`) and the Dock Queue
  header/row pointer entry. The PiTui entry is the 88-column Wide Overlay
  (`browse → edit | confirm-delete`, ONE component); TSP renders the SAME
  controller as native `picker`/`overlay`/`editor`/`button` sheets. A client-local
  `sending…` echo, a `steering` occurrence and a `context` occurrence are never
  addressable; only an authoritative `placement: 'queued'` occurrence is.
- Editing is admitted by the occurrence's RAW content: every block must be text
  (the display summary is never the classifier). The editor holds the official
  `textOf()` projection (text blocks joined with `''`) and writes one
  `updateQueue(id, {kind: 'edit', content: [{type: 'text', text}]})`; a
  non-whitespace result is required and a cross-client change detected before
  the write is refused rather than overwritten. Removing any queued occurrence
  is one `updateQueue(id, {kind: 'remove'})` after explicit confirmation and is
  never restored to the composer. Every write captures the exact Session owner
  and occurrence id synchronously, enters the existing `withWriter` admission,
  and settles with the existing `WriteOutcome` vocabulary; `indeterminate`
  never retries automatically. The Dock itself never edits or deletes: it only
  opens the manager (`Manage` and one clickable row per message).
- Mouse: PiTui enables application mouse reporting on the fullscreen alt screen
  alone, so the Dock pointer entry is fullscreen-only; the regular main screen
  keeps `/queue` and the effective `app.queue.open` key. TSP admits pointer
  clicks only from native nodes of the CURRENT frame with the exact occurrence
  id.
- Pointer currentness in the Fullscreen Queue surface is last-painted and
  gesture-scoped: the Browser list wheel only navigates; an effective wheel,
  keyboard input or a changed painted row retires an unfinished action-bar
  press, and the owning surface retires a delegated picker item press at those
  same boundaries (a wheel outside the picker's item rows included), so a
  release on the old cell never acts on the newly selected occurrence. A
  painted-geometry change retires the gesture permanently — restoring the same
  cells before the release never revives it. In Edit, a click on a body row
  this frame ACTUALLY paints positions the draft cursor through the fork
  Editor's own visual-row mapping but never saves or writes the Host; chrome,
  blanks, notices and clipped-away rows are not cursor targets. Every clickable
  action must be painted completely: over-wide bars shorten whole segments
  first and drop whole low-priority segments, a bar too narrow for the whole
  `Esc` paints no token, and deletion still requires its own confirmation.
- `Alt+Up` refuses the WHOLE recall when ANY queued occurrence carries a durable
  generic FILE: no draft is staged and no occurrence is removed (both Direct and
  Remote). The notification names `/queue` as the way to remove the file-bearing
  occurrence before recalling again. This is not a transport capability
  difference: no official Client can re-bind a stored file's upload receipt.

Authority: `src/app/surface/pending-presentation.ts`
(`buildPendingPresentation`, `foldQueueRows`) over the Direct/Remote
`PendingSubmissions` seam; the per-occurrence owner is
`src/app/queue/manager.ts` over `PendingInputReader` + `SessionWriter.updateQueue`;
sink: `TuiApp.setPendingInputPresentation` and the shared Queue panel/sheet.

Must-not: add a source-specific classifier/filter, correlate echoes by text,
make a local echo addressable through `updateQueue`, render `context` as a user
row, claim exact-occurrence actions from the bulk gestures, store a durable
queue mirror in a renderer, decide editability from the display summary, or
perform an optimistic local removal before the writer confirms it.

## Composer submission policy

The Web `ComposerSubmissionPolicy` applies unchanged:

- not running → the draft is queued;
- while running, Enter follows the configured `busyEnter` preference;
- the accelerated chord always performs the OPPOSITE of `busyEnter`.

Public queue-draft/submit-draft extension actions and a replacement editor's
`queue-submit` are explicit commands, never gestures. Resolve the mode once per
submission (`src/domain/command/policy.ts` + the submission controller).

### Submission attempt and the acceptance handoff

`submitted != accepted != durable != execution_success`. An ordinary prompt
(single Enter/Send, explicit queue action, the accelerated steer gesture) goes
through ONE Client-local submission attempt owned by `src/app/submission/**`:

- The renderer asks the synchronous admission before it mutates the document.
  A normal prompt is HELD: the attempt is registered, the dispatch starts, and
  the composer stays read-only with exactly the submitted draft (its Undo
  history, paste registry and attachment references intact) — typing, paste,
  history recall, an interactive completion and a repeated submit are consumed,
  while Escape/Ctrl+C, overlays, Questions/Approvals, pickers and Session
  navigation keep their own seats. A command, `!`/`!!` shell line, skill
  delivery or viewer submit keeps its pre-existing clear-first contract: this
  transaction covers ordinary prompts only.
- The ONLY normal authority that clears the committed draft is the Host
  accepting the message: Direct's successful synchronous inbox insertion, or
  the official Remote `beginSubmission.onAccept` (either the receipt or the
  Inbox row may prove it first). The accepted handoff clears the draft through
  the renderer's own undo-retiring clear, retires nothing of a sibling's
  attachment leases, records the accepted input into that renderer's recall
  history and publishes the local pending echo, whose presentation stays hidden
  until this moment (the live draft was the pre-acceptance presentation).
  Acceptance is one-way: an accepted prompt that later errors is an EXECUTION
  failure — the draft is not restored and nothing is re-sent.
- A proven pre-acceptance refusal (`WriteOutcome.rejected` before dispatch,
  a transition-fence refusal, a session/owner replacement) releases the lock
  and keeps the draft, Undo history and attachments editable. An indeterminate
  outcome does the same with an explicit "result unknown, inspect first"
  notice and no automatic retry; a LATE acceptance may still reconcile the
  Host-side pending/durable projection but never clears the editor the user
  may already be editing again.
- The attempt is single-flight per live composer: while one is sending, a
  second submit gesture is a no-op (no request identity, no history row, no
  second writer). Empty-input gestures never create an attempt, and the empty
  Ctrl+S queue sweep keeps its existing per-occurrence steer behavior.
- The history row (and the renderer's recall occurrence) completes at the
  acceptance boundary: the original submit timestamp and the FINAL session id
  are preserved, and a proven-unreceived prompt leaves no "sent" row. A late
  acceptance never writes into another Session's history.
- A line the final command catalog claims after an ordinary admission is
  handed to that command's own contract (its draft disposition and terminal
  settlement stay authoritative); it never fabricates a prompt acceptance.

The Host-owned side of the same handoff — writer ownership, the pending echo
ledger and the Host pending projection — is documented in
`docs/architecture/host-client.md`; the process-local ownership and generation
fences are in `docs/architecture/concurrency.md`.

Authority: `src/app/submission/controller.ts` (`beginComposerSubmission`, the
composer attempt), `src/app/submission/runtime.ts` (`submitPrompt` /
`steerSubmission` acceptance settlement), `src/runtime/session-writer-port.ts`
(`prompt({onAccepted})`) with `src/runtime/direct/session-writer-direct.ts` and
`src/runtime/remote/session-writer-remote.ts`, `src/app/submission/pending-submission.ts`
(hidden registration → `accept`), and the renderer ports
`src/app/submission/composer-port.ts` (`holdSubmission`/`settleSubmission`)
implemented by `src/tui-app.ts` and `src/tui/tsp/session.ts`.

Must-not: treat the prompt Promise, `turn/start`, `request/context`,
`compaction/end`, the working row, the agent status or equal text as Host
acceptance; clear the draft before the Host accepted; consume or drop the
attachments/Undo of a refused draft; replay an unknown outcome; clear a
successor Session's editor with an old attempt's acceptance; or add a second
draft copy/queue/ledger for the attempt.

## Subagent viewer

Interactivity is keyed only to the catalog mode (`continuable` = interactive,
`one-shot` = read-only) plus access depth: a depth-1 continuable child is
interactive; a nested child is read-only and never relabeled.

- A continuable viewer's editor is plain text. A non-empty prompt takes exactly
  one path through `SubagentPort` / the official `ctx.subagents.prompt` with a
  caller-minted `requestId`.
- An empty accelerated submit is the child steer-all; it never calls the child
  prompt API.
- Child queue reads/writes use the viewer's semantic writer subject.
- A failure restores the child's own draft slot; a stale viewer restores to the
  old child, never the parent.
- No fake child user row is injected; images are out of scope.
- The footer switches to the viewed child (display subject) while main-only
  chrome hides.

Authority: `src/app/surface/viewer-runtime.ts` (`ViewerRuntime`,
`ViewerAccess`), `viewer-submission.ts`, `src/runtime/subagent-port.ts`; sink:
viewer/footer/status.

Must-not: use `sendMessage`/a direct child followup, submit through the parent,
guess the mode from running/inactive state, or share editor history between
viewers.

## Task Center and Task Browser

One durable descendant catalog plus its runtime projection feeds both Quick and
Full:

- The stable DSH pre-order is never re-sorted; runtime activity is a
  commit-time fact; finished one-shot children stay reachable.
- Jobs form a separate flat group. The footer badge counts running descendants
  at every depth.
- Catalog refreshes are coalesced single-flight; the first frame seeds from the
  cache. A session switch clears browser/badge synchronously.
- Question attention is a separate non-work dataset with its own `?N` footer
  fact. Quick shows hidden actionable attention plus active work; Full shows all
  attention plus tracked work.
- Stop is confirmed and capability-gated. In the Full Task Center's fullscreen
  Action Bar, the complete visible Stop span only enters the existing pending
  confirmation. The detail identifies the target once (`Stop <task label>?`);
  the existing Action Bar is the sole place that names `Confirm stop [Y]` and
  `Cancel [Esc]`. In Regular/Main the existing keyboard Action Bar (`s stop`;
  pending `Y confirm stop · Esc cancel`) stays and there is no application mouse
  route; the pending detail still names only the target.
  Fullscreen pending Confirm and Cancel spans act on that same stable task value
  and use the existing `confirmStop` / pending-clear paths. TaskRuntime remains
  the final Session/Job capability and currentness authority.
- While a stop is pending, the first pointer press on another task row cancels
  confirmation and selects that row, but its matching release cannot open it;
  opening requires a second independent click. Stale row/capability, resized or
  reprojected action geometry and a retired Browser cannot consume an old action
  release. Only the complete painted spans of the contracted exits are pointer
  targets: `Close [Esc]` on Work/Team enters the browser's existing `onCancel`,
  `Back [Esc]` while Work/Team search is being edited exits that page's search
  mode (keeping the query and the browser), and `Cancel [Esc]` in the Work type
  filter closes only the filter list without changing the active type. The Stop
  pending Action Bar keeps its existing `Confirm stop [Y]` / `Cancel [Esc]`
  targets and offers no close. Every other Action Bar hint remains inert: a row
  click already opens Work items and expands narrow Team tasks, so `Enter open` /
  `Enter details` are not duplicated as buttons, and the scope, refresh, tree,
  search, type and paging hints stay keyboard-only. Regular/Main has no
  application mouse route at all.
- This pointer path is Fullscreen-only. Regular/Main retains terminal-native
  selection and scrolling behavior and has no application Task pointer routing.
- Reading Job output belongs to the Job Workspace, not the Task Browser.
- The Full Task Center is ONE physical overlay with two pages: `Work`
  (default) and `Team`. A proved Root `agentTeam` projection shows the
  `[Work] Team` tabs. A browser whose Root eligibility is still UNPROVEN — for
  example a Remote browser whose exact binding has not materialized yet — may
  show a recoverable Team error page while it keeps a subscription, until the
  identity is proven; a proven Child Session, and any Workflow-scoped browser,
  is Work-only. `Tab`/`Shift+Tab` switch pages and each page keeps its OWN
  query, selection, scroll and disclosure (never a shared draft). The Team page is
  READ-ONLY: it presents the official `agentTeam` projection's shared tasks plus
  the Root (`lead`) and the already-read Subagent catalog members; there is NO
  Team write, claim, stop, member navigation or `/team` command. An
  `Agent Team: Off` board still shows its retained tasks, and an official
  `failure` is shown beside the still-listed valid tasks; a `stale` read is an
  explicit error page (never a fabricated empty board and never a cached old
  board). The `f` key opens the explicit Work type list
  (`All` + the types the current Work rows own); `Tab` no longer cycles types.

Authority: `src/app/surface/task-browser-runtime.ts`, `task-runtime.ts`
(`openTasksBrowser`, `quickTaskProjection`), `task-presentation.ts`,
`task-attention.ts`; sink: `TaskPanel`, footer, Quick.

Must-not: add job tombstones/history caches, infer provenance from kind/args/
transcript/timing, count Question rows as work, or read job output through the
Task Browser.

## Job Workspace

A selected Job opens one dedicated fullscreen screen lease and returns to the
SAME paused Task Browser (lease ownership: [overlay-focus.md](./overlay-focus.md)).

- Capture one `JobInspectorState` plus the retained tail only. Do not promise
  full history.
- `End` is the ONLY follow re-arm; every manual browse pauses.
- Find is Job-local over the current retained output, never transcript search.
  Edit and result-navigation states are distinct, with `i/N` status.
- Empty/refused bodies are honest. `[GAP]`, `[ERROR]` and `[SETTLED]` facts stay
  independent.
- The Action Bar / `planChrome` budgets rows in fixed priority; every Host
  string crosses the display boundary before theme styling.
- A shell Job with an observed non-empty label gains a Command page in the same
  workspace/screen/observer. `Tab` toggles Output ↔ Command in both directions,
  `Esc` returns to Output, `v` is inert. Both bodies are mounted once and made
  mutually invisible, so each keeps its own follow/viewport/anchor/query and its
  own Find. `C`/`c` copy only when Find does not own the keys.
- Command copy uses the original label bytes verbatim; Output copy uses the
  captured snapshot text. Selection copy is `label.slice(start, end)`. Copy
  only proves emission, never an OS-clipboard receipt; the raw-text policy is
  owned by [terminal-output.md](./terminal-output.md).
- **The pinned Action Bar is the workspace's ONE pointer action row.** Only its
  complete visible `Verb [Esc]` segment is a target (a truncated or dropped
  segment publishes none); a same-cell release replays the CURRENT Esc outcome
  through the panel's own key dispatch — `Leave find`, `Output`, or `Back` — so a
  Find-open bar can never close the lease in one click and the Command page
  returns to Output without releasing the observation. The Header's
  Command/Copy affordances remain the only other pointer targets; the Stop verb
  stays keyboard-only. A press records the LIVE terminal grant and the painted
  frame geometry; a resize before the next paint, or a repaint at another
  grant/chrome layout, revokes the gesture, so an old physical cell never
  replays the previous Esc outcome.

Authority: `TuiApp.openJobInspector` + `JobInspectorPanel` (`planChrome`,
`deriveJobInspectorView`), `JobOutputScrollView`, `JobOutputSearch`,
`src/app/surface/task-runtime.ts`; sink: screen/body/Action Bar.

Must-not: add a second observer/screen owner, concatenate status/label/output,
claim full history, move the background transcript, or give a Label Job a
Command page.

## Session Workspace

The current, sole owning contract for this behavior is
[Session Workspace behavior](./surface-session.md). This heading retains existing entry links; do not
maintain a second copy of the behavior here.

## Web frontend control (`/web`)

`/web` is ONE local, sessionless Client command that controls the Split Host's
official Web frontend. It never creates a Session, submits a prompt, starts a
second Host, changes the default backend or disconnects the TUI; on the Direct
backend it answers `Web frontend controls are available only in a Split Client.`
and opens nothing. The menu is a SHORT operation list, never a second Settings
workspace: the default PiTui presentation is one `app.openSettings` overlay, and
the experimental TSP renderer presents one native `ui.picker` plus ONE read-only
Details Reading. Both consume the SAME application-level presentation request,
so the action vocabulary cannot fork between renderers.

The menu reads the Host's current state on entry and offers exactly what that
state admits:

| Host state | Menu actions | What an action really does |
|---|---|---|
| `disabled` | Enable Web, Details | the Host's own `setEnabled(true)` |
| `enabled` | Open Browser, Copy Link, Disable Web, Details | official authenticated URL for the explicit opener/clipboard, or `setEnabled(false)` |
| `changing` | Details (no write) | nothing concurrent is submitted |
| `unavailable` | Details (the reason is shown) | no implicit recovery or retry |
| connection unreadable | the explicit unavailable statement, esc | no guessed Off, no write |

Every operation is committed by the command, never by the presenter: one Host
call, then ONE authoritative status re-read whose result is what the menu
re-projects. Pointer activation of the short menu is the `SettingsList`
component's own mouse contract and is delivered by the fullscreen/alt-screen
surface (the host enables terminal mouse reporting only there); the regular
screen deliberately keeps the terminal's native selection behavior and has no
overlay pointer capture, and this menu adds no custom mouse routing or fork
divergence. A dismissal retires the menu only and never undoes a Host-accepted
change. Open Browser issues the Client-local platform opener and only ever
states `Opening browser…`; the authenticated URL contains the Host's official
launch token and never enters a notice, the transcript, the Details page, a
diagnostic or a trace. Copy Link reports only the clipboard's boolean
acknowledgement (`Link copied` or `Clipboard unavailable`). Details is read-only
and states the loopback Host, the current state, the frontend-only meaning of
enable/disable, the next-launch lifetime of the preference and that the page
opens the Web home where the user chooses a session — there is no TUI→browser
session navigation or deep-link synthesis.

The `Start Web automatically` row in `/settings → General` is a different
fact with a different lifetime: it persists a PROFILE preference
(`pi-tui-web-preferences.autoStart`, default Off, options On/Off) for the NEXT
Split Host launch, read by the Host cold boot before Ready. Saving it never
changes the current Host's FINAL Web state, the row never reports the current
Web frontend state, and `/web` remains the immediate control. Saving any
Settings value recomposes the Host profile, so the Web rows are briefly
unloaded and re-mounted by the Host's own repair through the official
`app-boot/config-reload`; the final state is preserved, a browser connection may
drop and reconnect during that window, and the preference still applies only to
the next launch. A non-current configuration backend offers no confirmable
candidate, and the authoritative re-read confirms only the persisted
preference.

The local ACP v1 listener is exposed through TWO independent Settings rows that
never share one authority. `ACP Server` stays in `/settings → Tools` and is the
RUNTIME row: its value is the LIVE listener state read from the Host's
private `piTuiAcpAccess` service (`On`/`Off`; a bind/close in flight is
`Changing…` and offers no candidate; an unreadable/`unavailable`/non-Split
Host is `Unavailable`, and a Direct backend states `Unavailable — Split Host
only`). Confirming On/Off sends exactly ONE `setEnabled`, then re-reads the
authoritative listener state; only an agreeing re-read is `Verified`, a
rejected or unreadable outcome is classified from a fresh read and never
replayed. `Start ACP automatically` lives in `/settings → General` (the SAME row
id and preference authority as before the migration) and is the PERSISTED row
(`pi-tui-acp-preferences.autoStart`, default `Off (default)`, options On/Off,
revision-checked user patch) that applies to the NEXT Split Host start; saving
it never changes the current listener, and its Detail states that explicitly.
On Direct the runtime row is a truthful Unavailable while the persisted
preference stays editable for the Split Host the user may later start.

## ACP quick control (`/acp`)

`/acp` is ONE local, sessionless Client command that controls the Split Host's
local ACP v1 Unix-socket listener. It never creates a Session or Agent, submits
a prompt, opens a browser or a Host, changes the default backend or disconnects
the TUI; on the Direct backend it answers
`ACP server controls are available only in a Split Client.` and opens nothing.
The menu is a SHORT operation list, never a second Settings workspace: the
default PiTui presentation is one `app.openSettings` overlay, and the TSP
renderer presents one native `ui.picker` plus ONE read-only Details Reading.
Both consume the SAME application-level presentation request, so the action
vocabulary cannot fork between renderers.

The menu reads the Host's current listener state on entry through the existing
private `piTuiAcpAccess` port and offers exactly what that state admits:

| Host state | Menu actions | What an action really does |
|---|---|---|
| `disabled` | Enable ACP, Details | the Host's own `setEnabled(true)` |
| `enabled` | Disable ACP, Details | the Host's own `setEnabled(false)` |
| `changing` | Details (no write) | nothing concurrent is submitted |
| `unavailable` | Details (the reason is shown) | no implicit recovery or retry |
| connection unreadable | the explicit unavailable statement, esc | no guessed Off, no write |

Every operation is committed by the command, never by the presenter: one Host
call, then ONE authoritative status re-read whose result is what the menu
re-projects. The command binds the mutation to the Connection generation that
produced the visible state, so an old menu cannot write to a newly connected
Host; a refused write is stated once and never retried automatically. A
dismissal retires the menu only and never undoes a Host-accepted change.

Details is read-only and states that the host is the local Split Host for the
same OS user with no TCP/HTTP, the current state, that enable/disable serves or
retires this Host's listener, that `Start ACP automatically` in
`/settings → General` applies on the next Host start, and that closing an ACP
View only detaches it. No socket path, credential, cookie or private bind name
enters the menu or Details; headless endpoint discovery stays `daemon status`.

`/acp` and `/settings → Tools → ACP Server` share the same Host controller but
remain independent entries: `/acp` is the immediate quick control and the
Settings row stays the runtime control inside Settings. The persisted
`pi-tui-acp-preferences.autoStart` preference remains a DIFFERENT authority
(`/settings → General → Start ACP automatically`) and is never written by
`/acp`. The TUI command never calls the daemon status HTTP route, and the daemon
status command never opens a TUI.

## Save Location

`/export` and `/transcript` open the ONE Client-local Save Location prompt in
the editor seat. It is filesystem UI, never an agent question, and it never
introduces a second artifact writer: the artifact filename is FIXED and
read-only, only the directory (resolved against the Client process cwd) is
editable, and the existing per-artifact local writer stays the only commit
sink.

Fullscreen paints the complete action row for the CURRENT state, and a pointer
click is equivalent to that state's keyboard verb:

- editing with no suggestions: `Save [Enter]` validates and saves exactly like
  Enter, and `Cancel [Esc]` cancels exactly like Esc;
- editing with suggestions visible: `Dismiss suggestions [Esc]` only closes the
  suggestion list (the next frame then offers `Cancel [Esc]`); clicking a
  suggestion row still selects/accepts it with the Tab semantic;
- a target-file collision: `Yes [Y]` is the ONE overwrite consent for that
  validated target, and `No [N]` (like Esc in that state) returns to directory
  editing without cancelling or writing.

A verb is painted WHOLE or dropped, with the safe exit kept first, and a
truncated or off-frame verb is never a hit target. The complete click target is
proven against the last-painted frame and the current prompt state, so a key,
wheel, resize, async suggestion refresh, preempting seat or already-settled
prompt can never replay an old gesture. The per-open settle latch still permits
exactly ONE `selected`/`cancelled` result.

## Settings Workspace

The current, sole owning contract for this behavior is
[Settings Workspace behavior](./surface-settings.md). This heading retains existing entry links; do not
maintain a second copy of the behavior here.

## Model picker (`/model`)

The PiTui `/model` overlay is ONE capturing surface: one provider-grouped,
searchable model list plus three composed strips below it (a full-width
separator, the Reasoning Effort strip, the Agent Team row) and a footer hint.
The overlay requests the `88×28` wide step and subtracts those four fixed rows
from the list's row grant, so the list keeps more rows than the old narrow step
and no control row is clipped at `min(terminal, 88×28)`.

Keyboard is a three-zone state machine over the SAME component:

- **Models** (initial): `↑/↓/PageUp/PageDown` and typing stay the list's;
  `Enter` enters the selected reasoning model's Effort strip (no Host write) or
  commits a model with no reasoning metadata in one press; `Tab` moves to Agent
  Team when the composition serves it; `Esc` closes.
- **Effort**: `←/→` cycle only the official catalogue candidates of the bound
  `(provider, model)` identity, `Enter` commits that model with the visible
  effort, `Esc` returns to the list keeping the draft, and every other key is
  consumed. The draft is picker-local and per identity; it never becomes a
  second Host truth.
- **Agent Team**: `Enter`/`Space` toggles, `Tab`/`Shift+Tab` return to the list,
  `Esc` returns without a write, and every other key is consumed. The bracket
  marks the SAVED state (`On [Off]` / `[On] Off`); focus is the `> ` prefix and
  `primary` ink, so color is never the only signal.

Model selection and Team mode are TWO INDEPENDENT Host writes. A model `apply`
never writes Team mode, and a Team gesture never rides on a model selection.
The Team row reflects the exact Root Session's official `agentTeam` projection
and the official `modelSelection.lastUsed` fact: it paints `Checking…`,
`Unavailable: <reason>`, `Saving…`, `Checking saved state…`, `Save failed: …` or
`Outcome unknown — R recheck` rather than a guessed On/Off. `R` in the Team zone
is a read-only recheck, never an automatic retry.

Disabling a Root Session that already recorded a model request opens a SEPARATE
single-purpose confirmation seat (`src/tui/pickers/team-disable-confirmation.ts`)
mounted next to the picker. It is a logical Root seat of its own: closing
`/model` does not cancel it, `Cancel`/`Esc` perform zero Host writes, the
default focus is Cancel, and an indeterminate write offers only a read-only
Recheck/Close. A committed write stays on `Checking saved state…`; a fresh
projection read that equals the target proves it and closes the seat once. Only
an in-flight Host **request** (`Saving…`) is uncloseable. `Checking saved
state…` is not an in-flight request, so `Esc` (or the owning surface) may close
the seat safely without claiming the write landed, and a `stale` authority
(superseded Session / lost Connection) retires it automatically; a transiently
`unavailable` readback stays `Checking…` but remains exitable.

The Fullscreen pointer contract follows the same last-painted-frame rule:
complete visible Team `On`/`Off` tokens, Effort candidates and currently reachable
Action Bar spans are hittable. The bar replays the existing keyboard handlers:
Models offers `Effort [Enter]` or `Select [Enter]` for a valid selected route and
`Close [Esc]`; Effort offers `Select [Enter]` and `Back [Esc]`; Team offers
`Toggle [Enter]`, a failed write's `Retry [Enter]`, or an unknown outcome's
read-only `Recheck [R]`, plus `Back [Esc]`. Pending Team writes offer no second
commit, and an in-flight model apply offers no commit or cancellation action.
Loading, error and non-model rows never offer model selection or a catalog Retry.
When the list or Effort strip is not granted by a short row budget, its hidden
model/Effort commit action is not offered; a visible Team row keeps only its own
state-appropriate Team action. Escape stays last and names its actual level.
Only whole painted spans have hits; separators, browsing hints and dropped or
truncated segments remain inert.

A press followed by a semantic change, resize, re-hydration, focus transfer or
replacement never commits. An Effort hit is bound to the `(provider, model)`
identity that PAINTED it, so a selection move before the repaint cannot retarget
another model; an Effort click changes the draft only and never submits the
model. Team OFF retains its independent confirmation seat. Below `64` content
columns the strip compacts to `Effort: <value>`; the Team row and state-specific
bar remain visible down to `44×8`. A one-row grant retains only the exit bar.
A directory refresh that retires the effort-bound model keeps a pointer Close
reachable while the ambiguous next keyboard key stays consumed; a deliberate
body pointer press releases that transition for the newer pointer intent.
Regular/Main has no application mouse route.

## Task Quick

Current behavior:

- Hidden by default and paints zero rows. `focused` is the ONE visibility
  authority.
- The only automatic crossing is an effective `app.tasks.open` Down from the
  physically focused Host editor at its last visual line while
  `quickDownEligible` holds (live surface, active tasks, at least one row, no
  blocker/tenant/overlay/workspace).
- Navigation is `task[0..N-1]` plus an optional `Open Task Center…` row; no
  wrap; Up at the first row exits; Esc exits. Enter routes through the shared
  `resolveTaskSelection` with value/session re-proof.
- The hidden-entry Footer hint and the Down route share one predicate.
- The band sits under the whole Footer with ONE top separator and at most five
  rows (separator + identity + navigation).
- Every blocking owner terminates it.

Authority: `src/tui/panels/task-quick-accessory.ts` (`TaskQuickAccessory`,
`planTaskQuickLayout`, `TASK_QUICK_MAX_ROWS = 5`),
`quickTaskProjection`, `TuiApp.quickDownEligible`.

Must-not: add a second catalog/ack ledger/focus owner; a transient row failure
keeps the retained snapshot; passive paint/refresh/wheel never acknowledge.

## Plugin Manager and Plugin Detail

The current, sole owning contract for this behavior is
[Plugin Manager and Plugin Detail behavior](./surface-plugins.md). This heading retains existing entry links; do not
maintain a second copy of the behavior here.

## Schedule workspace (`/schedule`)

`/schedule` is the ONE Client entry of the Host Schedule manager. It is a
sessionless local command: it never creates or opens a Session, never submits a
prompt and never calls a model, and it takes no arguments (`/schedule <text>` is
an explicit parameter error, not a task). It is not an alias of `/tasks`, which
keeps its Job/Subagent Task Center semantics.

The leased fullscreen workspace (see `overlay-focus.md` §10.6) is ONE
`ScheduleWorkspacePanel` whose states share the lease:

- **List** — Host tasks are browsed as two-line items: the task title first, then
  the official occurrence and a compact repeat summary. The four filters are
  `Enabled`, `Paused`, `Ended`, and `All` (internally `active`, `paused`,
  `ended`, and `all`); the initial filter is `All`. `Tab` / `Shift+Tab` cycle Enabled →
  Paused → Ended → All in either narrow or wide layouts. Legacy `A / P / E / L`
  shortcuts keep their Enabled / Paused / Ended / All mapping. Counts come from
  the full committed Host catalog, not the filtered or searched rows; before the
  first successful read they are unknown, and a stale catalog keeps its last
  successful counts and stale notice. Search covers title+prompt and remains a
  LOCAL projection of the committed catalog (no Host read per keystroke); Tab
  while Search is focused only returns to the list and does not change its filter.
  The occurrence is the Host-committed `scheduledAt` displayed in the rule's
  official zone (UTC for rules without one). An active task with a later
  `deliveryFloorEndsAt` is labelled `Eligible from`, not `Next`; paused and ended
  tasks are labelled `Paused · Scheduled` and `Ended · Final`. The repeat summary
  never evaluates cron/RRULE or predicts a new occurrence. `R` re-reads the
  authoritative catalog; a failed read keeps the last successful rows labelled
  stale. On a wide List, the task catalog stays left and a read-only Detail
  preview stays right; each task's two lines share one click target, and wheel
  input scrolls the pane under the pointer. Filter and Search chrome appears only
  on List; the other modes retain their own page title, body and keyboard owner.
- **Detail** — the official `view` record: full prompt, official timing and
  time zone, target, task status, `executionActive` and `deliveryFloorEndsAt`
  as SEPARATE facts, and the latest delivery receipt. Execution is `In progress` for explicit `true`, `Not running` for explicit
  `false`, and `Not reported for this target` when absent. The current Host
  contract emits only `true` or omission; a missing field is never inferred as
  idle. The Host floor is labelled `Host minimum interval ends` and
  displays only the Host instant (or `No active floor reported`), never a
  Client-clock countdown or a promised execution time. `o` opens the latest
  receipt's `targetSessionId`; without a receipt, only an existing `session`
  target can be opened. A `new_once` reservation is not an existing Session:
  Detail says `Pending first delivery; conversation not created yet.`; an
  undelivered `new` target says `No delivery yet.`. `r` refreshes the one
  Session roster used for link availability.
- **History** — newest-first delivery pages of 20, with paging only by the
  official `nextBefore` cursor. Each receipt keeps its own `targetSessionId` and
  optional immutable sent `prompt`; the current task target/prompt never fills a
  legacy receipt. `earlierRecordsUnavailable` and `earlierRecordsPruned` are
  separate notes; the pruned note appears only on the final page, and a vanished
  cursor ends the page. `↑/↓` or `j/k` selects a receipt by `messageId`; `Enter`
  opens that receipt's receiver, `x` expands/collapses only its saved instruction,
  `m` loads the next Host page, and `r` refreshes Session-link availability.
  `PgUp/PgDn` scroll the page. `Delivered to conversation inbox; does not prove
  Agent execution.` is the shared History/Detail receipt qualification.
- **Conversation navigation** — a Session link is enabled only from the current
  successful `SessionReader.list(undefined)` roster, excluding subagents. Every
  navigation captures the current `SessionScope` synchronously, re-reads that
  roster, and then delegates to the existing `switchSessionOutcome` transition
  gate. Only `committed` and `already-current` close the Schedule lease. A
  missing row is `Not in available Sessions (possibly removed or archived)`;
  this is not proof of archive or deletion. An unavailable or failed roster
  disables links and says that availability could not be verified. A failed,
  superseded or indeterminate switch keeps the same Schedule page and selection.
  Detail/History roster checks and navigation are Client-local presentation over
  the Host-backed reader; the Schedule Host port and wire contract are unchanged.
- **Editor** — one official timing out of seven (`after`, `at`, `every`, `daily`, `weekly`, `cron`, `rrule`) and one official target out of three (`session`, `new_once`, `new`). Its guided Repeat choices are Once · after delay, Once · at date/time, Every · minutes, Every · hours, Every · exact seconds (advanced), Daily, Weekly, Custom · Cron and Custom · RRULE. A new task starts at `after_seconds: 3600` with `new_once`; the delay begins only when the Host accepts creation, and no Client time zone is guessed. Quantity units and the composite Weekdays chooser edit the typed draft only; they do not add a Client schedule or alter the Host timing union. Time and target fields use the labels `Time zone`, `Existing conversation`, `Create and reuse conversation` and `New conversation each run`. Session candidates appear only in their chooser.
  `Ctrl+S` is the only Save: local structural refusals happen first, then one Host `create`/`edit`. An edit sends the minimal CAS patch with `expectedUpdatedAt`; an untouched timing or target is never re-sent. `Esc` with dirty fields asks to discard, never auto-saves. A `schedule_conflict` or an unknown edit outcome blocks Save until `Ctrl+G` reads the latest official record and rebases the four atomic groups (title, instruction, timing, target): locally changed groups stay in the draft, unchanged groups adopt the Host value, and overlapping groups are disclosed. Review is read-only; the next explicit Save uses the latest Host revision. `Ctrl+R` remains the distinct lossy reload and asks before discarding a dirty draft. A missing task blocks Save and can only be discarded. An unknown Create stays locked in that editor after the catalog refresh; leave it and inspect the task list before deciding whether to create a new task. Neither a catalog refresh nor a read result retries a dispatched write.

- **Confirmation** — Run now, Delete and Clear ended require one explicit
  confirmation (`y`); a stale confirmation cannot commit a newer question.
- **Help** — one in-panel key list; no second screen.

Copy semantics that must not be softened: a successful `run` proves a durable
Session-inbox delivery (`Delivery queued`), never a completed model turn and
never "executed exactly once". `executionActive === true` disables Run now,
pause/resume and Delete; `false` or an absent value is not a Client readiness
verdict, so the Host still decides whether Run is admitted. A confirmed Run
re-checks the frozen task identity/revision and execution state. The delivery
floor is display-only; the Client never compares it to its clock. The official
`schedule_execution_pending` refusal means Run did not start and is shown as the
information notice `Run not started: another execution is pending.`; a CAS
mismatch keeps the draft and says the task changed on the Host; an unproven
mutation outcome says the outcome is unknown and requires a re-read before any
retry.

Renderer scope: the PiTui renderer owns this workspace. TSP does not admit
`/schedule` (it receives the generic unsupported-capability refusal and the
draft is restored, with zero Session/model/Host Schedule write); a native TSP
Schedule page requires its own UX design freeze and is out of this surface's
scope. The official Web `ui-schedule` row stays the official browser UI and is
independent of this workspace.

Proof: `test/tui/schedule-workspace-panel.test.ts`,
`test/tui/schedule-virtual-terminal.test.ts`,
`test/app/schedule-workspace-controller.test.ts`,
`test/app/schedule-session-navigation.test.ts`,
`test/app/schedule-command.test.ts`.

## Attachments and input completion

The current, sole owning contract for this behavior is
[Input, attachment and shell surface behavior](./surface-input.md). This heading retains existing entry links; do not
maintain a second copy of the behavior here.

## Question, Goal, cards and the todo dock

Question lifetime and seat ownership live in
[overlay-focus.md](./overlay-focus.md). Goal/ask tool cards and JSON-result
folded previews live in [transcript.md](./transcript.md). The one small surface
contract left here is the fullscreen todo-dock click loop:

- Summary click opens the compact panel; panel click goes compact → full; a
  full-list click closes to summary.
- Compute `dockHeight`/`dockTop` and check the dock region before the todo-panel
  branch. When the panel hides the summary, `dockHeight` is 0 and the dock
  branch is inert.
- The regular surface has no mouse; do not toggle a random message card when the
  dock row is clicked.

Authority: `TuiApp` todo-dock geometry/hit-testing
(`dock.render(width).length`, `handleTodoPanelClick`).
