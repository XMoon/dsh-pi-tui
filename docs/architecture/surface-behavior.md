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
creation, history write, viewer gate or busy-Enter steer gate.

**One exit-intent classification.** Every entry — `/exit`, `/quit`, the bare
`exit` word, an effective exit key and the TSP exit gesture — reaches the ONE
Client-local coordinator (`src/app/bootstrap/exit-intent.ts`) with the entry
name only as provenance. The pure classifier
(`classifyExitIntent` in `src/domain/command/policy.ts`) reads the LIVE
backend, the exact current Session presence and its authoritative activity on
every request AND every confirmation; it never treats an unobservable state as
idle and never keeps a second Host-running cache.

| Intent | Direct | Daemon Client |
|---|---|---|
| no Session (no open submission admission) | exit the process | detach this Client |
| proven `idle` | exit the process | detach this Client |
| proven `working` | Direct Busy Choice (`Stop current work and exit` / `Stay`, Stay default) | Daemon Busy Choice (`Keep working and disconnect` default / `Stop current work and disconnect` / `Stay`) |
| `unknown` | Direct Unknown Choice (`Exit and retire local Host` / `Stay`) | Daemon Unknown Choice (`Disconnect without stopping` / `Stay`) |

`working` is the exact current owner's official status (the Direct Agent's
`running`, the Remote `SessionSnapshot.running === true`) or a live application
admission that cannot be called idle (an in-flight submission holding the
composer, a running user shell). A pending submission without a Session is
`working`; a live owner without an observable status, a missing Remote
`running` bit or a rolled Connection/binding generation is `unknown`. The
`CommandSurface.sessionRunning ?? false` projection, the transcript `Working`
row and any cached busy flag are never the authority.

**Exit is not Host stop.** A daemon Client exit never stops the daemon Host: the
Keep path sends no Host write at all, and leaving releases only this Client. The
Direct path keeps its existing exit controller (owned-session retirement inside
the `appExit` disposal). There is no second exit controller, no new Host RPC,
and no `/detach`/`/shutdown` command.

**A running user shell is not an Agent Turn.** While a `!` / `!!` Host user
shell is in flight the choice keeps the normal exit options but adds the
reminder that leaving aborts the shell and that Agent idle does not prove the
shell finished (Owner decision: remind, do not remove the exit options).
`Current work: stopped.` is never derived from the Agent waiter alone while a
shell runs, and a confirmation made before the shell started refreshes the same
family with the reminder before it can act. The keyboard's busy Ctrl+C remains
the existing cancel path, which aborts the shell and the exact live Session
turn together.

**Daemon Stop terminal proof.** `Stop current work and disconnect` captures the
Session scope and the exact Remote transport identity once, re-validates both
before acting, and sends ONE official cancel through the session control
admission (`SessionRuntime.withControl` → the exact owner's retirement
`cancel`). The control section is released before the idle wait. Only
`whenIdleOrAbort === false` for that SAME owner — proven while its generation
and binding remain current — permits the Client exit, and only that proof may
print `Current work: stopped.`. The cancel ACK is never a stop proof; a proven
refusal, a pre-dispatch cancellation, an indeterminate reply, an aborted wait
and an `'unobservable'` generation all render the same-seat `Stop could not be
confirmed. The daemon may still be working.` state with Keep/Stay, are never
retried automatically and never auto-detach. If the captured owner becomes idle
before confirmation, no cancel is sent and the exit proceeds on the same
identity. While the wait is in flight the same seat shows the Stopping state and
accepts no second selection. A running-user-shell reminder can appear on this
Unconfirmed seat too, but it never rebuilds the seat into a Busy choice: the
refusal facts and the safe option set stay, and the one safe detach performs
exactly one final commit.

**Every action must be really actable.** The choice is size-aware: an option is
keyboard- and pointer-actable only while its complete label is painted AND the
box can show every actable option. When the terminal cannot host the three
actions (a very narrow or very low viewport), the seat degrades to the truthful
safe path — the `Stay` action, or a single `Esc Stay` line when even that row
cannot fit — rather than leaving a clipped or off-screen destructive action
reachable. The seat is remountable across a fullscreen screen swap, so an open
decision can never become an invisible one; a Host Question/Approval withdraws
it with no business action and it is never restored automatically.

**Choice currentness.** A choice captures the backend, the full Session scope
(the sessionless generation included) and the Remote transport identity at open. Any confirmation re-reads them first: a
Session/connection rollover retires the old choice with zero side effects (the
user re-triggers the intent), an Idle→Working transition re-opens the Busy
Choice through the normal entry, and a Busy→Idle transition lets Keep proceed
and lets Stop detach without a cancel. A user shell that starts AFTER the choice
opened (an already-accepted `!`/`!!` submission whose session creation was still
pending) refreshes the same family with the shell reminder before any Keep/Stop
can act. A real Host Question/Approval withdraws
the Client choice with zero business action. `Esc` and `Ctrl+C` inside the choice
mean `Stay`; no Host work is cancelled by either. The exit controller is called
only at the final commit.

**Whole-Host stop confirm (M6 UX PR2).** A Daemon Client that itself made a
verified `daemon → direct` Profile transition earns ONE transient exit
permission; only when the PR1 exit decision has already committed to leaving
AND the LIVE Profile facts still prove the transition does the SAME coordinator
open the `daemon-host-stop` confirm. It is strictly NOT a Turn stop: its three
options are `Leave daemon Host running and exit` (the safe default, the ordinary
detach), `Stop daemon Host and exit` (the ONE explicit Profile-management
authorization, handed to the final exit root which runs the authenticated
`daemon stop` after the terminal restore), and `Stay in the TUI` (the whole exit
is withdrawn; the permission stays for the next exit). The confirm names the
full blast radius (ALL connected Clients, Sessions, Jobs and pending
interactions) and never claims a stop before the control plane's own proof. A
Host Question/Approval preempts it with zero management writes, exactly like the
PR1 choice.

**Keyboard rule.** The default effective exit key keeps its same-key 1.5-second
confirmation and the Ctrl+C clear-draft / Ctrl+D forward-delete editor behavior.
While the exact current Session is `working`, the DEFAULT physical Ctrl+C is a
single Busy Cancel through the existing interrupt path (no exit confirmation, no
draft clear); while `unknown` it refuses to arm the exit and states that the
running state cannot be verified; while `idle` it keeps the existing
clear-then-double-press exit. A user remap of the exit action, a leader
completion, or a remap of the interrupt action onto Ctrl+C keeps its own
semantics — only the builtin physical Ctrl+C carries the busy exception. TSP
applies the same rule to its bound raw keys (idle Ctrl+C and empty-draft Ctrl+D
need the same-key second press), while its pre-bind Ctrl+C remains an emergency
exit.

**Compatible cross-build connection.** A Daemon/Split Client that authenticates
a Host under the same protocol and DSH runtime but a different PiTui build
prints ONE non-blocking `info` notice on its initial physical Surface mount
(`Connected to a compatible Host with a different PiTui build. To use the
installed Host build, run `daemon restart` when work is idle.`). Redraws,
Session switches, reconnects and same-process HMR never repeat it; a new OS
Client process may show it again. It never changes Host admission, restarts or
stops the Host, and it never claims the Host is older. The cross-build admission
facts are owned by [host-client.md](./host-client.md); this document owns only
the presentation contract.

**After the terminal restores.** A daemon Client exit prints the fixed
`Disconnected from dsh-pi-tui (daemon client).` block with the REAL effective
profile and Session (no Session line without a Session) plus `daemon status`,
`daemon logs` and `daemon stop` commands; it never claims a Host state, PID or
Turn outcome it cannot observe. The resume command preserves a temporary
`DSH_PI_TUI_BACKEND=daemon` override (the Profile may still be Direct) and
shell-quotes the profile/session arguments so the hint is copy-paste safe. A verified Stop may add the one
`Current work: stopped.` line. A Client that used a compatible different-build
Host adds one past-tense note in the same block, after the ordinary
stop/current-work summary and before the Resume/Manage blocks: `Note: This
Client used a compatible Host with a different PiTui build. To adopt the
installed Host build when work is idle: dsh --profile <profile> daemon
restart` (the real Profile is shell-quoted by the existing policy). A confirmed
or unconfirmed whole-Host Stop never carries that adoption suggestion, and the
note never commands an automatic restart. A Direct exit keeps only the existing
resume line. Fatal/sudden termination never prints the detach block.

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
- In the Full Task Center's Tracked Work view, the retained Subagent catalog
  starts fully expanded at every depth. Explicit Left/Right tree disclosure
  remains user-owned; a collapsed branch stays collapsed across row refreshes
  and scope switches until explicitly expanded or the browser is recreated.
  The Active view and the separate Quick accessory keep their existing
  active-work membership policy; Jobs remain a separate flat group.
- In that same Full Tracked Work view, only ACTIVE Jobs (`running` /
  `stopping`) are shown by default. Retained terminal Jobs are collapsed behind
  ONE chrome action row above the scrollable list: `Show N past jobs [J]` while
  active Jobs exist, `Show N jobs [J]` when none do, and `Hide N past jobs [J]`
  once opened, with ` · !N unreviewed` appended while the hidden candidates hold
  unacknowledged failure attention. The manual disclosure is a panel-local
  per-open choice (never settings/session state). A non-empty Work search still
  matches the authoritative terminal Job records and temporarily reveals the
  matching rows without changing the manual disclosure; Active scope, the
  separate Quick accessory and a Workflow-scoped browser keep their own
  membership. Job failure attention is acknowledged only when an attention Job
  row actually enters the painted viewport — the control, header and `!N`
  summary never acknowledge it.
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
  release. The complete painted Work history disclosure action label is the ONE
  new Fullscreen Task pointer target besides the contracted exits below; its
  informational `!N unreviewed` suffix, surrounding whitespace and the ordinary
  Job group header stay inert. Beyond that history disclosure label, only the
  complete painted spans of the contracted exits are pointer targets: `Close [Esc]` on Work/Team enters the browser's existing `onCancel`,
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
- Fullscreen `[Work] Team` Header labels remain last-painted pointer targets in
  the normal and short/degraded/slim layouts alike: a label is hit only while
  its complete painted span survives the sanitized header text and truncation
  (a clipped or omitted label is inert), and the existing pending-Stop,
  Team-eligibility and interaction-currentness gates stay authoritative. The
  same rule keeps the Work type-filter exit usable in short grants: with at
  least two rows the complete current candidate and clickable `Cancel [Esc]`
  remain, with one row only the candidate is painted and no exit target is
  invented. Regular/Main stays keyboard-only.
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

## Agent preset picker (`/preset`)

The PiTui bare `/preset` is ONE root-owned capturing overlay with TWO pages: a
Catalog and a Details reader. BOTH pages carry the same explicit business
actions. The shared Host/Config write semantics and the state vocabulary are
owned by [TSP preset selection](../tsp/preset-selection.md); this section owns
the PiTui interaction contract. The TSP-native picker keeps its own two-zone
UI and read-only Details; only the shared `Set default` business effect below is
common.

- **Authority.** `src/tui/commands/models.ts` owns the one roster read and the
  `Use`/`Set default` writers; the panel holds only local page/focus/scroll
  state. `Use next` (sessionless) stages `runner.pendingPreset` and creates no
  Session; `Use session` (a still-blank live Session) commits through the Host
  transition gate and its `agent-preset/selected` authority. The Catalog writes
  the filtered visible selected raw ID; Details writes the ID it is bound to.
  A started Session keeps the existing bare `/preset` refusal with no selectable
  UI. The typed `/preset status`, `/preset default [<id>]` and `/preset <id>`
  verbs keep their existing command results; typed `default` and every picker
  share the one default writer.
- **Flat focus ring.** ONE page-local `focusTarget` (`list`/`reader`,
  `use`, `set-default`, or Error `retry`) replaces any parallel zone/action
  state. Catalog Ready is `list → Use → Set default → list`; Details Ready is
  `reader → Use → Set default → reader`. `Tab`/`Shift+Tab` move directly to the
  concrete action; arrows never switch business actions. `Close`/`Back` stay on
  their real `Esc` device and never enter the ring. A disabled/dropped/unpainted
  action is excluded; a changed row, resize or unavailable action returns the
  focus to the page base rather than silently retargeting a later Enter.
- **Catalog.** Built-in then Custom groups, name/id/description search, complete
  `name (id)` labels and atomic `[current]` / `[next session]` / `[default]` /
  `[draft]` / `[unavailable]` chips. The pinned Action Bar carries
  `Use next` or `Use session`, `Set default`, an inert `Tab actions` keyboard
  hint (while the list has focus and an enabled action is painted), and
  `Close [Esc]` last. A focused action replaces the hint with `Verb [Enter]`.
  Browsing, searching and opening Details never write; the first pointer click
  on a different row only selects, and activation requires the row already
  selected (keyboard `Enter` or a second click).
- **Details** is ONE read-only Markdown reader (complete Name/ID/Type/Scope,
  committed relationships, a broken row's failure reason, the complete
  description and — for a shipped preset only — the official Mode guide) with
  the SAME pinned Action Bar: `Use next/Use session`, `Set default`, an inert
  `Enter actions` hint while the reader has focus, and `Back [Esc]` last.
  Reader `Enter` only moves focus to the first enabled painted action (zero
  write); a subsequent Action `Enter` is the explicit write. `Tab` never moves
  the reader scroll. `Esc` or the painted Back span returns to the Catalog with
  the query, selection and list window intact.
- **Pending / refusal.** Entering Pending preserves the page and the bound row,
  redraws the bar as `Close [Esc]` only, and states `Applying preset…` /
  `Saving default…`; `Esc` closes and never cancels the admitted writer. A
  rejected/locked Use returns the SAME page Ready with focus on its base: the
  Catalog keeps its complete error viewport, Details puts the complete sanitized
  reason at the top of the same reader (`detailsScroll=0`). No implicit retry
  and no second write.
- **Set default (shared with dsh-web).** The writer validates through the
  roster, writes the Config default, and only after that write is CONFIRMED
  re-reads the Host-authoritative effective default. It attempts ONE switch of
  the exact Session captured at operation start only when that effective id
  still equals the requested id, the Session is still the current,
  still-proven blank one, and no newer Use/default operation won; a newer
  effective default from another Client or Host policy wins and this operation
  does not switch the Session. It never creates a Session, never switches a
  started Session, never rewrites the run-local pending preset, and never
  retries or rolls back after a confirmed Config save. The result separates
  `applied` / `applied-unrefreshed` / `uncertain` / `overridden` /
  `not-applicable` / `skipped-stale` / `failed` from a Config `unconfirmed`;
  only a proven pre-dispatch refusal may be reported as not switched. An
  ownership-only supersession after the Host selection was already dispatched
  is uncertain/no-retry, not a proven non-switch. A committed switch whose
  post-commit catalog refresh failed, and an ambiguous Host settlement, stay
  explicit and are never reworded as a non-switch; a raising Config write
  remains UNCONFIRMED.
- **Loading / Error / Retry.** The overlay mounts immediately in Loading and the
  command's single read owner hydrates it in place. A failed read paints the real
  reason with `Retry` + `Close`, and Retry re-enters Loading through that same
  owner (one read in flight). An empty roster is the readable
  `No agent presets configured.` state — never a silent first-row fallback.
- **Lifecycle.** Every `/preset` invocation retires the previous panel; the one
  logical overlay is remounted across a fullscreen switch/resize without losing
  local state. A late read or settlement that no longer owns the surface commits
  no frame and never reopens a closed panel. `Close`/`Esc` dismiss the panel but
  never cancel an admitted Host/Config write; rejected/locked writes keep the
  ready page with the real reason, an indeterminate write dismisses without an
  implicit retry, and a raising default write is reported UNCONFIRMED — never
  as a proven rollback.

## Web frontend control (`/web`)

`/web` is ONE local, sessionless Client command that controls the Split Host's
official Web frontend. It never creates a Session, submits a prompt, starts a
second Host, changes the default backend or disconnects the TUI. It owns every
read and write of the frontend and holds no Web state of its own: it reads the
status through the semantic WebAccessPort, performs each explicit action on the
Host's own service, and re-reads the authoritative state. There is no polling.

The command has TWO renderers and ONE business authority:

- **PiTui**: a TYPED DEEP LINK into the ONE Settings workspace's
  `Host · Web UI` page — the SAME screen lease, no overlay, no second Settings
  surface. The page mounts on its first really-painted frame and the command
  resolves only after that mount settled; a real failure closes the lease and
  is the command's error, never a silent Rows fallback. The page's own
  presentation contract (runtime vs next-launch authority, actions, confirm,
  generation binding, `Esc` ladder) is owned by
  [surface-settings.md](./surface-settings.md#web-ui-page-host); this section
  owns only the command semantics. Direct shows the page with
  `Unavailable · Split Host only` and no runtime action; it no longer refuses
  the entry.
- **TSP**: the existing native picker plus ONE read-only Details Reading over
  the same application-level presentation request, so the action vocabulary
  cannot fork between renderers. On a Direct backend that renderer keeps its
  `Web frontend controls are available only in a Split Client.` receipt.

Every operation is committed by the command, never by a presenter: one Host
call, then ONE authoritative status re-read whose result is what the surface
re-projects. Pointer activation is delivered by the fullscreen/alt-screen
surface (the host enables terminal mouse reporting only there); the regular
screen deliberately keeps the terminal's native selection behavior. A
dismissal retires the surface only and never undoes a Host-accepted change.

The explicit actions are the same on both renderers. `Open in browser` asks for
the official authenticated URL exactly once per action and hands it to the
Client-local opener; it only ever claims `Browser open requested`, never that a
browser page opened. `Copy access link` asks for it exactly once and reports
only the clipboard's boolean acknowledgement (`Link copied` or `Clipboard
unavailable`). The URL carries the Host's official launch token and never
enters a notice, the transcript, a painted cell, a diagnostic or a trace; it is
never cached or written to a file. `Enable Web` / `Disable Web` are the Host's
own `setEnabled` switch: a confirmation is required before disabling, and
disabling is the same frontend serving switch described below — it never
revokes a Browser cookie, an existing Browser page, a Bearer token or a live
Browser WebSocket. The listener stays `127.0.0.1`-only, and the first release
formally supports only the trusted same-machine user (no LAN, public proxy or
SSH tunnel guarantee).

A user decision is bound to the Host it was DISPLAYED under. Every action is
qualified by a CURRENT Host observation; a Connection generation change
revokes the visible actions, the URL request and the pointer targets and
re-reads before a new action is offered. A dispatched write is never cancelled
by leaving the surface, never replayed, and never attributed from a later read:
a lost receipt, a Host change during the request or an unperformable read-back
is `Outcome unconfirmed` — never `Not changed`.

The next-Split-Host-start preference (`pi-tui-web-preferences.autoStart`,
default Off) is a DIFFERENT fact with a different lifetime: it is edited inside
the same `Host · Web UI` page's `Next Host Start` section, is read only by the
Host cold boot before Ready, and saving it never changes the current Host's
final Web state. There is no standalone Settings row for it. Saving any Settings
value recomposes the Host profile, so the Web rows are briefly unloaded and
re-mounted by the Host's own repair through the official
`app-boot/config-reload`; the final state is preserved, a browser connection may
drop and reconnect during that window, and the preference still applies only to
the next launch. A non-current configuration backend offers no confirmable
candidate, and the authoritative re-read confirms only the persisted
preference.

The local ACP v1 listener and its next-start preference are edited in ONE
place: `/settings → Host → ACP access`. That page owns the runtime state (the
LIVE listener read through the Host's private `piTuiAcpAccess` service, one
explicit `setEnabled`, one authoritative read-back) and the persisted
`pi-tui-acp-preferences.autoStart` preference (default `Off (default)`, a
revision-checked user patch that applies only to the NEXT Split Host start).
The two authorities are never merged, saving the preference never changes the
current listener, and a runtime toggle never writes it. On Direct the page
states `Unavailable · Split Host only` and still offers the editable preference
for the Split Host the user may start later. The page contract (phases, first
focus, risk confirmation, Esc ladder, short/narrow behavior) is owned by
[surface-settings.md](./surface-settings.md#acp-access-page-host); this document
owns only the command entry and its TSP-native sibling.

## ACP quick control (`/acp`)

`/acp` is ONE local, sessionless Client command that opens the Client's ACP
listener control. It never creates a Session or Agent, submits a prompt, opens
a browser or a Host, changes the default backend or disconnects the TUI. On the
PiTui renderer it is a TYPED SETTINGS DEEPLINK: the command takes the SAME
Settings workspace lease and mounts `Settings · Host · ACP access` on its first
really-painted frame (Direct included). There is no PiTui overlay, no second
settings screen and no silent Rows-level fallback: a mount failure closes the
lease and is the command's real error. The TSP renderer keeps its ONE native
`ui.picker` plus ONE read-only Details Reading over the ORIGINAL
`AcpAccessRequest` presentation request. The two renderers do NOT share a
presenter or an action vocabulary: the PiTui page adds Copy, the next-start
preference and the risk confirmation, while the TSP picker keeps its own frozen
status/enable/disable/Details actions. Their common authority is the ONE
`AcpAccessPort` Host controller, and neither entry reaches a Host service
directly.

On the page the Host state admits exactly:

| Host state | Page actions | What an action really does |
|---|---|---|
| `disabled` | Enable ACP, Copy client command, Refresh | the Host's own `setEnabled(true)` after ONE live preflight |
| `enabled` | Copy client command, Disable ACP…, Refresh | the confirmation's own `setEnabled(false)` after ONE live preflight |
| `changing` | Copy client command, Refresh (no write) | nothing concurrent is submitted |
| `unavailable` | Copy client command, Refresh (the reason is shown) | no implicit recovery or retry |
| connection unreadable / Direct | Copy (when the Profile is proven), Refresh | no guessed Off, no runtime write |

Every runtime operation is committed by the page's command owner, never by a
presenter or a cached projection: a current observation, one live preflight,
at most ONE `setEnabled` and one authoritative re-read. The mutation is bound to
the Connection generation that produced the visible state, so an old observation
cannot write to a newly connected Host; a state that already reached the target
(or is changing/unavailable) dispatches zero writes and states `Not changed`; a
dispatched request whose receipt is lost is `Outcome unconfirmed` and is never
retried automatically. Leaving the page or closing the workspace never undoes a
Host-accepted change and never re-enables the listener.

`Copy client command` is the ONE Client-local action: it copies the official
`dsh --profile <proven-profile> acp stdio` command with POSIX-safe quoting from
the Profile identity this composition proved, and it requests no Host socket,
token or process. It also works while the listener is disabled, where the page
states the listener must be enabled before a client can connect.

The page's `Client Setup` section carries the durable connection statement the
retired PiTui Details overlay used to own (local Split Host, same OS user, no
TCP/HTTP, closing an ACP View only detaches it). No socket path, credential,
cookie or private bind name is painted or copied; headless endpoint discovery
stays `daemon status`, and the TSP Details Reading keeps its own native text.

`/acp` and `/settings → Host → ACP access` are the SAME surface on PiTui. The
persisted `pi-tui-acp-preferences.autoStart` preference is a DIFFERENT
authority edited inside that same page and is never written by the runtime
toggle. The TUI command never calls the daemon status HTTP route, and the daemon
status command never opens a TUI. The public headless `dsh --profile …
acp status|enable|disable` CLI remains a separate entry over the same Host
controller, not a TUI path.

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
