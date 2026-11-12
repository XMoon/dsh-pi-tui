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
  release. Only complete painted action spans are pointer targets; other Action
  Bar hints remain inert.
- This pointer path is Fullscreen-only. Regular/Main retains terminal-native
  selection and scrolling behavior and has no application Task pointer routing.
- Reading Job output belongs to the Job Workspace, not the Task Browser.

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

`/sessions`, `/search <query>` and bare `/resume` open ONE fullscreen Session
Workspace over the existing `SessionBrowserReadOwner`; the retired PiTUI Picker
is not a fallback. TSP keeps its own native Presenter over the same owner (see
[tsp/session-browser.md](../tsp/session-browser.md)).

- **A CLI Session launch opens the SAME Browser without waiting for the Host
  Workspace.** Bare or explicitly blank `--session` opens Browse All, and a
  non-blank value that is not a canonical full id, an exact listed row id or a
  unique CLI hex prefix opens the same Browser with that value as its one
  initial global search. This startup entry skips the sessionless mount
  Workspace-preflight wait so the first input frame is never blocked by a slow
  Host; `Esc` returns to the sessionless Welcome with no Session, draft or
  writer. A canonical full id (or an exact listed row) still resumes pre-mount
  through the ONE `SessionLifecycle.open`; a genuine open failure keeps its
  original Host error and opens the same Browser once as a MANUAL recovery
  entry, never a second automatic resume.
- **The Host Editor `←←` entry is contextual, never a global binding.** Two
  independent, unmodified `Left` presses within 600 ms from the empty PiTUI Host
  main Editor open the SAME fullscreen Workspace with the All browse intent,
  while bare `/sessions`, bare `/resume` and the Welcome entry carry the Current
  intent (only that intent still decides the one-time missing-Current notice;
  every entry browses the complete official Workspace tree). The gesture requires the Host editor to be the
  real physical keyboard owner on the main surface, prompt mode and a strictly
  empty draft: any text (whitespace included), a staged attachment, an
  in-flight bracketed paste, an open autocomplete and every higher-priority
  seat/modal/overlay leave it inert. The FIRST press is an ordinary editor
  Left; the second consumes that one key. Only a real press counts — Kitty
  repeat/release are protocol artifacts of the same physical press, a paste or
  an Unstable raw rewrite never synthesizes the gesture, and a terminal that
  carries no key-event types cannot strictly distinguish OS auto-repeat from a
  human second press (that limitation is a protocol fact, not a policy). `Esc`
  restores the same Session, draft, editor focus and screen; the gesture never
  switches, stops or writes by itself. TSP has no PiTUI TuiApp, installs no such
  entry and keeps its native Browser.
- **Workspace-first list, one row per Session.** The browse list paints official
  Workspace folders in Host follow order. Each folder contains one row per listed
  Session; within it, active priorities are Needs, Working, then ordinary
  history, each ordered by official `updatedAt` with the previous order as the
  tie-break. Only ordinary history is watermarked, and the watermark is
  RENDERER-LOCAL to one Browser open. The shared default watermark is eight
  ordinary rows for the current Workspace (and a Host-confirmed next-create
  destination) and zero for every other Workspace; a non-current Workspace with
  confirmed Needs/Working starts expanded with those active rows and zero
  ordinary history; every other Workspace starts as its Folder row only.
  Explicit manual collapse hides EVERY
  child row, active and current ones included, and leaves the Folder row with
  its trustworthy counts; `Enter`/`Right` restores the automatic view, `Left`
  collapses again. An expanded non-current Workspace starts at five ordinary
  rows (the current or a Host-confirmed next-create destination at eight), and
  `Show more` adds five more; the operation disappears when history is
  exhausted. Folder, Session and Show more are separate typed targets, not
  PickerGroup headers.
- **PiTUI spends spare list rows on ordinary history, up to a per-group cap.**
  In the ORDINARY Browse list the panel raises the watermark of ALREADY EXPANDED
  groups by ONE ordinary row per step while this frame's actual list budget (the
  pane height the layout gave the list, less the status rows the list itself
  paints) still has spare rows, up to twenty ordinary rows per group. The
  Sessionless `Choose workspace` chooser never grows: it selects an existing
  Workspace, so its spare height stays free instead of filling with unrelated
  Session rows.
  Current/Next groups fill first, then the other expanded groups rotate in
  official order, so one large Workspace cannot starve its siblings. A collapsed
  Folder is never expanded to use the space, and a frame whose base tree already
  overflows its budget never grows. Needs/Working rows, the current Session and
  the selected Session stay visible outside that ordinary cap, and a Session the
  shared projection already forces visible costs no extra row. The watermark
  never decreases inside one open: shrinking the terminal only changes the
  viewport/scroll, and re-rendering the same size and facts does not grow it
  again. `Show more` adds five rows from the CURRENT value and may cross twenty;
  the next open recomputes from the shared defaults. The growth is PiTUI-only and
  per open: the shared projection, TSP Native and every persisted source keep the
  eight/zero defaults.
- **The PiTUI tree has explicit inline action rows.** A real Host registration
  capability paints ONE root `Add directory` row above the official folders; an
  expanded REAL official Workspace paints `+ New session` as its first child
  row. Synthetic groups (`Unassigned`, `Membership ambiguous`) never paint New,
  and a Workspace baseline that is not proven never fabricates a Folder. The
  actions are ordinary rows reachable with `Up`/`Down`, not footer links and
  not a separate focus mode: there is no hidden Actions ring. `Add directory`
  opens the existing bare Host-path editor INLINE under the root row; `New
  session` calls the existing command-owned create handoff with the official
  `workspaceId` and never creates, closes or reports success by itself. ONE
  per-operation pending object locks repeated New activation until that SAME
  operation's own settlement arrives from the command owner: `committed` (the
  command owner alone retires the Browser), or `failed` / `not-committed` /
  `cancelled` (which unlock a deliberate retry). A transient notice, its expiry,
  a timer or a roster diff is never a Folder-New settlement. The Welcome chooser
  paints no `New session` and no `Use directory` child row.
- **The cursor is ONE typed row identity.** `> ` marks the selection; `●` marks
  the current opened Session, and `· Current` marks the one official Workspace
  that uniquely contains it. Selection never changes Current, the Host working
  directory or Workspace order. `Right` expands a collapsed Folder and then
  enters its first visible child, `Left` moves from a child to its parent Folder
  and collapses an expanded Folder, and `Enter` runs the selected row's own verb
  (Expand/Collapse, New, Add, More, Open, or the chooser's Choose workspace).
  Every activation is admitted only against the rows the LAST frame really
  painted: a row scrolled or budgeted out of the frame cannot be opened by a
  blind key. The cursor is preserved by row id across official reorders and
  expansion changes; a hidden Session re-anchors on its parent Folder and a
  removed Folder on its nearest surviving neighbor.
- **A Session row is a tree CHILD of its Folder.** The `> ` selection gutter
  keeps the tree's leftmost two cells, while a Session's `●` current bullet,
  its identity and its metadata start two cells further right; the bullet
  therefore follows the same indent instead of staying in the root column. The
  Folder row, its disclosure, `+ New session`, `Add directory` and `Show more`
  keep their own relative indent, and the flat search-result list keeps its old,
  unindented geometry.
- **A sessionless destination is not a Current Session.** A Host-verified
  next-create Workspace is ordered first and painted `Next` with the same
  eight-row base history watermark; it never renders as `Current`, because Current
  means the opened Session's unique official membership.
- **Choose/add a directory returns through the same Browser lifecycle.** The
  sessionless Welcome's Choose directory opens the same `/sessions` Browser at
  its full Workspace folder tree, titled `Choose workspace`; there a Folder's
  `Enter` or label click commits that existing official Workspace as the
  next-create intent and returns, while `Right`/`Left` and the disclosure only
  browse. That chooser paints no `Use directory` row and no `New session` child.
  A first submit refused by the Host Workspace preflight opens the same Browser
  only AFTER the submission owner has restored the draft, directly in the inline
  Host absolute-path editor with the refused path prefilled for correction. The
  ONE physical Action Bar paints its local Host-registration verbs
  `Verify [Enter]` and `Cancel [Esc]` — while a painted suggestion block is up
  the same slot names `Hide suggestions [Esc]` — never a Workspace selection;
  the editor body paints no second verb row. It rejects an empty value and a
  shape that is definitely non-absolute for the known Host dialect while the
  Host resolve remains the final judge, and dispatches at most one Host
  resolution until it settles; a rejection keeps the text and the previously confirmed intent, while
  a success commits the next-create intent. That chooser returns to the Welcome
  only after success; ordinary Browser Add returns to Browse and never creates a
  Session. `New session` on a Folder reuses the existing `/new` transaction with
  that `workspaceId`, keeps the old Session until the commit, reports a refusal,
  and retires the Browser only after a committed switch.
- **Only a proven PRE-CREATE Workspace refusal opens recovery navigation.** A
  `/new` whose Host `resolveWorkspace` refuses (the semantic port's typed
  `refused`) opens the same Browser's full Workspace tree after the failed
  transaction settles and its single-flight releases; the old Session, its
  Turn, draft and next-create intent are untouched while the user browses, and
  a Session is created only by the user's explicit `New session` on the chosen
  Folder (the existing Folder-New transaction owns that create). The sessionless
  first ordinary submit follows the same admission only after the submission
  owner restored the exact draft and its attachment references: it enters the
  existing inline Host editor prefilled with the refused proposal, Verify only
  commits the next-create Workspace, and the user must submit again for the
  first Session to be created. `unavailable` (a disconnected or unreadable Host)
  and `superseded` (a newer generation or selection) never navigate, an unknown
  refusal code is never guessed into one, and no post-selection create failure,
  cancellation, teardown or dropped draft opens a chooser or replays the earlier
  prompt. A refusal whose captured subject or next intention is no longer
  current is silent: it never repaints, selects or overwrites the newer surface.
- **The inline Host-directory editor completes official Host levels, never a
  Client path.** Opening `Add directory`, or the refused-first-submit path
  editor, starts ONE per-open editor controller with its own private Input.
  Ordinary Add first reads `list(undefined)` and, unless a retained/recovered
  path or a real user edit exists, prefills the official Host home plus the Host
  separator and reuses that SAME listing as the first level. The Host home is
  the only dialect fact; the Client's own homedir, cwd, platform and local
  completion never answer here. A late home answer never rewrites real input or
  its cursor, a cleared value stays blank without a request, and a retained
  initial/recovered path always outranks the home prefill.
  Prefix typing issues ONE debounced `list(parent)`. Candidates are only the
  official child `name`s matching that prefix (case-insensitive for the Host's
  Windows dialect), keep the Host's own order, show at most eight rows, keep
  `hidden` children visible, and are identified ONLY by the official
  `entry.path`. `Tab` or a candidate click writes that path plus the Host
  separator and queries the next level; `Up`/`Down` cycle only rows the frame
  really painted; `Enter` verifies the RAW Input through the existing
  `onAddDirectory`/`resolveWorkspace` transaction and never accepts a
  candidate; the first `Esc` hides a painted suggestion block and the next
  leaves the editor. The ONE bar's `Hide suggestions [Esc]`/`Cancel [Esc]`
  replay that SAME two-layer ladder. A candidate action, browse read or transport rollover
  never registers a Workspace: only the explicit `Enter` reaches the ONE
  existing resolution, which may then commit the next-create intent. A failed,
  refused or unavailable read is stated as such (`Directory unreadable: …`,
  `Directory suggestions unavailable: …`, or an observable unexpected read
  failure); an empty official level is `No child directories`; a prefix with no
  match is distinct; and `truncated` is never presented as a complete no-match.
  A request whose Host connection generation is replaced settles the CURRENT
  editor's browse state as stopped rather than leaving a permanent loading
  claim or presenting the stale result; the raw value and manual Host
  verification remain usable, a new edit starts the next prefix generation,
  and the Home-read case states the reopen path for browsing again.
  While verification pends the editor advertises only the verifying state and
  no completion, mouse or Tab action may start another read or write; a
  settlement returns to editing with the same raw value. A frame too short to
  paint the Input never submits, and 80×2 has no editor body and only the real
  `Esc` action. The Input, home read, latest query generation and painted
  candidate admission are disposed with the editor or the per-open lease, so a
  late result can never repaint a newer open.
- **A sessionless Host surface starts UNSELECTED unless the launch directory is
  provably the Host's.** `@`, the first Session and the standing Skill read
  dispatch nothing while no Host Workspace is chosen: the Welcome says so and
  points at the existing `Choose workspace` Browser. The Client's own launch
  directory becomes an AUTOMATIC Host-path candidate only when the authenticated
  local Host identity proves the same directory object — Linux
  `/proc/<hostPid>/root/<launchCwd>` and the Client launch directory are
  directories with identical `(dev, ino)`, with the Host PID starttime still
  equal to the authenticated one. The candidate is re-proved before the Host
  `workspace.create` and again before its `workspaceId` is adopted, and the
  automatic proposal is one-shot: a committed create consumes it rather than
  assuming it later. An explicit Browser/Add choice always outranks it and
  persists across the Client's next sessionless create.
- **An unprovable launch directory never degrades into a guess.** A different
  inode/device (another mount namespace, a symlinked or replaced directory), an
  unreadable `/proc`, a stale/absent Host identity or a non-Linux Client leaves
  the surface unselected; the user chooses through the SAME Browser/Add flow.
  A Direct/sessionless surface keeps its historical launch-directory proposal —
  there the process IS the Host.
- **The first submit without a selection refuses before any Host write.** An
  unselected sessionless submit creates no Workspace and no Session, keeps the
  draft with the submission owner, states the missing Host workspace, and opens
  the existing Workspace Browser at most ONCE per mounted surface (a cancelled
  picker stays unselected; no render, reload or repeat submit reopens it).
- **The next-create intent is Client-local and runner-scoped.** One
  `WorkspaceNextIntentOwner` carries the optional `host-path` proposal, its
  provenance (launch default, proved automatic candidate, explicit user choice),
  the Client-local selection revision and the last confirmed Workspace id.
  `capture()` returns `undefined` while unselected, so no caller can fabricate a
  Host request. Directory selection or verification changes only that intent; a
  committed create consumes the captured intent, a stale intent fails before any
  Host `create`, and a failed preflight marks the Welcome status rejected
  without replacing the confirmed target.
- **Activity is sampled, never inferred.** One accepted roster revision produces
  one sample from `SessionWorkspaceFactsPort.readActivity` over the read owner's
  roster. Activity generation and eligibility updates are separate from
  Workspace membership revision, and stale roster results are inert. `running`,
  `pending` and `attentionSourceState` retain provenance. Unknown/unavailable/
  denied facts remain complete in Peek/Details; compact rows hide them rather
  than printing them once per Session. A Working row paints `Working`, while
  only confirmed answerability paints `Needs attention`.
- **Answerability is a gate, not a classification.** Only a pending candidate
  this Client can really answer may enter `Needs attention`: a live forwarded
  Question/Approval invocation held by the Client-root delivery owner
  ([host-client.md](./host-client.md)), or a `continued` Question whose official
  projection proves no queued reply while this composition holds the answer
  capability. A pending candidate without that proof stays in its base group
  with `Pending unverified`; it is never a Needs row, never answerable from the
  list, and never retried. `readActivity.attention` is a candidate, not
  permission, and the answer itself always happens after the Session is
  committed, through the surface's existing Question/Approval owner. Every
  Activity sample and every eligibility change applies in the SAME frame: a
  revoked answerability immediately leaves `Needs attention` and its count,
  because a classification is a fact and not a deferred animation.
- **Workspace baseline is the membership authority.** Browse folders use official
  `workspaceId`/`sessionIds` in follow order. A missing, denied, failed or ended
  follow invalidates membership and keeps the roster usable as a flat fallback;
  cwd never proves membership. Ambiguous and unassigned rows are explicit only
  after a valid baseline. There is no `w` key that changes a scope selector.
- **Attention stays inside its Workspace.** Needs/Working are row priorities inside each official Workspace folder, never a cross-folder section or a reason to filter out sibling folders. Browse scope is not narrowed, so the header paints no outside-attention count.
- **Search stays global.** The panel never re-filters the Host's bounded search
  page by the browse scope; only a real editor text change reaches the read
  owner's one debounced Host search generation. `Enter` in the editor only moves
  focus to the first real result; a second `Enter` from the results list is the
  ONE activation: it returns when that result is the Current Session and is the
  guarded Resume otherwise. Results are never re-grouped by Activity.
- **Current row Enter returns.** A listed, painted Current Session row's `Enter`
  (Browse, the Search-results second `Enter`, or Peek `Enter`) closes the Browser
  and returns to the Session that opened it: no Resume intent and no Session
  switch, with the Session id, draft, turn and writer untouched. Every other
  Session row keeps the guarded Resume. The action bar names the real verb —
  `Return [Enter]` in secondary navigation ink for Current, `Open [Enter]` primary
  otherwise — and the Current branch is decided only after the same listed and
  painted admission a Resume needs. A Session row click still only selects;
  returning requires the physical bar segment or `Enter`.
- **`Space` is a read-only Peek.** It opens a plain-text detail of the selected
  painted Session row (full Session id, identity, official Workspace
  membership, cwd, preset, updated, running, pending, source) and nothing else:
  no Agent, no Question/Approval form, no Session `open`/`retain`, no writer and
  no Host call. Folder, New, Add and Show more rows have no Peek and never
  inherit the last Session. `Esc` returns to the previous focus with the same
  selection, query and scroll; `Enter` activates the PINNED Session — returning
  when it is Current, otherwise an open that still has to pass the read owner's
  eligibility/currentness before any switch. The Peek is
  pinned to ITS Session id: if a roster/search refresh no longer lists that
  Session, the Peek exits to its previous focus and the list re-anchors on a
  listed row — it never silently
  shows, or switches to, a different Session.
- **Header, Preview and navigation.** The header is ONE row: `Sessions · <listed
  count>` (or `Choose workspace` in the chooser) with the real `/ Search` target
  on the right. It never repeats the Current Session id or an `All workspaces`
  scope; `Current`/`Next` live on the official Folder row. `Tab`/`Shift+Tab`
  jump by ONE Folder TITLE in the projected tree (wrapping, skipping Sessions,
  New and Show more; from Add they start at the first/last Folder; zero Folders
  is a no-op), and never enter a second focus ring. `Up`/`Down`, `Home`/`End`
  and `PageUp`/`PageDown` move within the actually visible rows. The wide
  read-only Preview follows the typed node (Folder facts, New, Add, Show more or
  the Session detail) and the action bar advertises only the selected row's real
  `Enter` verb. From `112x12` the frame is two columns: the list keeps at least
  44 cells, a two-cell gap, and the rest is the read-only preview/Peek; below
  that it is one column. Frame-level facts (search editor, status and Host error
  lines) span the full width; the Esc action bar is always the last physical
  row, and a short frame withholds activation instead of opening a row it did
  not paint. The inline Add editor consumes the keyboard while it is open; Tab
  never changes the Workspace cursor and `Esc` cancels back to the tree.
- **Mouse is the last painted hit-map.** One render commits a frame revision and
  the REAL painted cell ranges of every tree row plus the Folder disclosure,
  search results and the physical Action Bar's action segments. A click acts
  only on the SAME frame revision and SAME target range as its press; any
  scroll, resize, search, Activity or content change between press and release
  drops the gesture. In the ordinary Browse tree a Folder's title/blank area
  AND its disclosure both toggle that Folder exactly once, so the whole row is
  the disclosure target while the `> ` gutter and Session rows keep their own
  verbs. In the Sessionless `Choose workspace` Browser the same title click
  commits that existing official Workspace and returns, while its disclosure
  only toggles. A Session row click only selects; `+ New session`,
  `Add directory` and `Show more` clicks run their named explicit action;
  Resume is the guarded `Enter` verb and the Current row's `Enter` is its Return.
  The ONE physical Action Bar is
  pointer-capable for its complete painted `Verb [Key]` segments only
  (`Return [Enter]`, `Open [Enter]`, `Peek [Space]`, `Close [Esc]`, `Back [Esc]`,
  `Results [Enter]`, `Verify [Enter]`, `Cancel [Esc]`, and the selected row's
  real Enter verb); each runs the existing method (`resumeSelected`,
  `openPeek`, `handleEscape`, `handleSearchInput`, `handleDirectorySubmit`,
  `handleDirectoryCancel`, `activateSelectedBrowseRow`) and never starts a
  second navigation state machine. The Peek pane paints NO local action line:
  the global bar is the only navigation row, and its `Open [Enter]`/`Return
  [Enter]` is the one explicit activation. A press records the LIVE terminal grant beside the frame
  revision, so a resize that has not repainted yet also drops the gesture. A
  same-row double click on the same word stays the terminal's word-selection
  gesture, so one fast double click toggles a Folder at most once.
- **One lifecycle.** Each open keeps exactly one Workspace follow, one roster
  read owner, one Activity sample generation and one fullscreen lease. The close
  path aborts list/search/Activity, disposes the follow once, stops the screen
  once and restores the return surface once; a late result from any of the three
  sources can never paint into a newer open. An Activity update never moves the
  cursor to another Session: the selection is preserved by Session id and the
  scroll anchor by the visible row id, so the user keeps browsing the same row
  while the groups and statuses repaint truthfully.

Authority: `TuiApp.openSessionWorkspace` + `SessionWorkspacePanel`,
`projectPiTuiWorkspaceTree` (the ONE PiTUI action-row adapter over the shared
visible tree), `buildSessionWorkspaceView` (the ONE pure classifier),
`SessionBrowserReadOwner`, `SessionWorkspaceFactsPort` and the Client-root
forwarded-answer eligibility view; sink: the leased fullscreen screen.

Must-not: add a second Session roster, a second Activity reader, a Host pending
store, a Workspace registry or a persisted Workspace table, re-filter Host
search results, infer membership from a cwd, treat `attention` as answer
authority, expose an answer form in Peek, give a row a hit region the frame did
not paint, or treat an accepted Resume intent as a committed switch.

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

The `Auto-enable Web on Host startup` row in `/settings → Tools` is a different
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

## Settings Workspace

`/settings` and its real alias `/status` open ONE fullscreen lease with ONE
navigation focus state. The category rail is the selection owner; the right
column is the content. Width only projects panes (≥108 three, 76–107 two, <76
one). The category order is the fixed `About, Models, Account, Agent, Appearance,
Conversation, Input & Terminal, Tools, Plugins`, and ONE conditional
`Extensions` is appended while the extension settings registry reports live
rows (nine vs ten painted categories; no hardcoded count anywhere). Both
`/settings` and `/status` run the same handler and land on `About` with
identical initial focus and entry-refresh behavior. `/footer` and its
`/statusline` alias take this SAME lease and mount the Footer layout page;
bare `/keybindings` takes it for the Keyboard shortcuts page (see the
specialist-page contract below).
- The extension-settings DIRECTORY is a live projection of the in-process
  `SettingsRegistry`: the panel reads its `{revision,count}` synchronously before
  every input, pointer and render decision (no second registry, no subscription
  split). A changed revision revokes the previous frame's pressed gesture and
  whole hit map before dispatch, re-reads the one snapshot, re-anchors the
  selected row on a live row of its category, and withholds every key except the
  real `Esc` until a frame composed against the current directory has painted.
  The count alone is never the fence: a same-id owner replacement keeps the
  count and moves only the revision. The event that discovers the change never
  navigates with it; a frame whose directory moved inside its own render
  publishes no grant and schedules the next frame. A registry change invalidates
  the PAINTED FRAME, never a business state it did not touch: an unrelated
  registration, unload or `setValue()` keeps an open candidate choice (re-anchored
  on its candidate identity), the selected category/row and both scroll offsets;
  only a selection that really stopped being valid (a vanished row, or the
  emptied `Extensions` category) repairs the choice and resets its offsets. A
  VANISHED selection also retires its pending/settled PRESENTATION and UI lock:
  the app-owned write keeps settling through the command/Registry owner (its
  health/diagnostic record is unchanged), but it has no row left to paint on,
  the current selection may already belong to another owner, and the request
  identity is advanced so a late settlement can never claim the new selection.
  When the registry empties while `Extensions` is selected, the selection lands
  on `Plugins` with the rail focused and nothing is installed, enabled or
  removed; a stale internal `initialCategory: 'extensions'` request lands on
  `Plugins` too.
- `Extensions` is a real configuration category, not a transition launcher: its
  Rows level projects the LIVE registrations of ONE owning extension at a time.
  The groups are the distinct `owner` identities of the current registry rows,
  ordered by each owner's FIRST appearance in the registry's global
  `order ASC, id ASC` stream; within a group that registry order is preserved.
  The selected row's owner IS the current group — there is no group cursor,
  cached page list or second selection state.
  `Tab`/`Shift+Tab` cycle the groups (wrapping) only at this Rows level with two
  or more groups and no open choice or pending write (both own their keys),
  landing on the target group's FIRST row; `↑`/`↓`/Home/End/page/wheel and both
  scroll offsets stay inside the group. Every other category, focus, choice and
  pending state keeps the root region-key semantics, and a single group paints
  its name and `[1/1]` but keeps the root Tab. The header states
  `Extensions [i/N]` BEFORE the display label, so a narrow frame truncates the
  name and never the position; the Rows pane header degrades
  `Rows (m) · <label>` → `Rows (m) · i/N` → `Rows (m)` inside its own width.
  When the selected row disappears the SAME owner group keeps the page and
  selects its first surviving row; when the whole group unloads the first live
  group becomes current (its first row, Rows focus); the emptied category falls
  back to `Plugins` as above. In every one of those repairs the vanished
  registration's transient phase is retired as described above, so the repaired
  page is immediately operable and never keeps a stale `Saving…` or a stale
  settled word.
- Each extension setting is a native Rows/Detail/Choice entry. The Detail states
  the RAW owner identity and the RAW registry id; a registration that
  contributed no selectable values is READ-ONLY (the Stable contribution has no
  freeform text field, and no editor is invented), and a current value outside
  the registered choices is reported instead of being auto-selected. Only an
  explicit Confirm calls `SettingsRegistry.applyDetailed`; the confirmation
  carries the registration's immutable internal token, so a same-id HMR
  replacement (even with the same owner string) can never receive an old
  confirmation, retry or settlement. `accepted`/`rejected`/`stale`/`gone` keep
  their registry semantics: a rejection records health only for the INVOKING
  owner and paints `Not saved`, while a superseded or unloaded registration is
  reported without a fabricated plugin refusal or rollback. Extension settings
  are runtime-only: nothing here is written to the TUI settings document or a
  Host profile.

- Every category shares ONE root row plan: header, optional metadata, at most
  one top rule, optional app notice, optional pane header, body, and the single
  physical last-row Action Bar. The app notice is the ONE root-level notice;
  a page's own business notices stay inside that page's body. At ≥76 columns a
  direct About/Models/Account page keeps the category rail and shares
  ONE display-only pane header whose focused `[Label]` names the live keyboard
  owner; the page's own semantic hint line is moved unchanged to the frame's
  last row instead of being regenerated at a wider width. The Plugins page keeps
  the rail at ≥120 columns regardless of which side owns the keyboard; at 76..119
  the pair moves with the keyboard instead, so the rail is painted only while the
  Categories rail owns the keys and steps aside for `List | Details` once the
  plugin content does — subject to the same six-real-body-row floor as the wide
  frame, below which either projection falls back to ONE business column (see the
  Plugin Manager section). The full-width
  `install`/`confirm`/`diagnostics` views hide the rail at every width. The legacy medium
  projection keeps its adjacent Categories+Rows at L0 and Rows+Details at
  L1/L2 — the rail is never pinned as a fixed left column. The bar starts at
  the frame's first column, and every child page keeps its own body and action
  rows above it. A terminal resize or any other unrepainted chrome change (the
  root App notice is the same boundary: it moves/shrinks the direct page's
  content box and grant without changing the terminal size) revokes the
  previous frame's action/copy grants before the next paint, even when the
  effective child body grant value is unchanged; until that frame paints, and
  whenever the frame shows only the Esc fallback, only Esc is admitted
  (Backspace is not a portable back key: a page may bind it to an editable
  query). A FOCUS TRANSFER that changes the Plugins content projection is the same
  boundary: at 76..119 columns the adjacent pair follows the keyboard, and on a
  narrow terminal one region is painted at a time, so moving the keyboard between
  the Categories rail and the plugin content (in EITHER direction) leaves the
  previous frame on screen; until the destination frame paints, the root refuses
  every key except the real Esc — including the
  Shift+Tab it intercepts itself and the rail keys it would otherwise act on —
  and a Backspace is refused as well. Mouse presses, releases and wheel gestures
  from the previous frame
  are rejected: the root re-derives the live content box and child grant from
  the live chrome before each pointer gesture, and a release must still match
  the box its press was admitted against. Any pending pointer state is revoked
  when the two disagree. With no granted body row (the
  shortest frames) the Esc action the frame names for that state runs: a real
  back, a state-named cancel such as clearing an editable filter, or an
  explicit wait while a Host mutation is still pending. No unreachable page
  refresh, copy or action runs from an invisible body.
- **The ONE physical last-row Action Bar is pointer-capable across the root and
  its hosted pages.** The root registers the target from the FULLY painted Esc
  span the row really painted: its own bars publish it directly, while a hosted
  page (About/Models/Account/Plugin/Footer/Keybindings/specialist) exposes only
  a read-only span of its own last painted Esc affordance in page columns — the
  root paints that row from column 0, so no column translation is applied. A
  hosted page also exposes its own SEMANTIC identity (the current sub-view plus
  every transient phase its Esc really acts on); the root stores it at press and
  re-proves it at the release, so a child repaint that keeps the same bar cells
  can never hand the gesture to a different Esc outcome. A pure wait/status fact
  (for example a Host write still in flight) publishes no span and is never
  clickable. A release replays the CURRENT state's Esc through the root's
  EXISTING keyboard ladder (`handleInput('\x1b')`: the specialist page's own
  handler, the direct page's return handling, or root `goBack`/close), so a
  pending mutation, dirty draft, awaiting-paint grant or install phase is never
  bypassed. No page registers a second last-row owner, and a page that painted
  no complete Esc affordance leaves the row inert.

- `About` is the default home: the Welcome-card brand/whale plus the runtime
  facts (the bundle's own version, the installed DSH version — `Unknown` when
  unreadable — and the selected backend) and, when a live main Session is
  captured, that Session's identity, whole-Session statistics, measured
  performance and Context occupancy. Every absent authority is worded
  `Unavailable`; no zero is fabricated, and no session is created or written.
- One captured revision supplies both the painted strings and the raw copy
  values. `↑`/`↓`/`PgUp`/`PgDn`/`Home`/`End` select the semantic fact; `c`
  copies the selected fact's exact raw value (numeric rows keep the source
  number, never the rounded display), `Shift+C`/`C` copies the full stable
  report, and `r` refreshes the Session statistics and Context once. `Enter`
  activates only the explicitly selected `Refresh context` action; an ordinary
  fact is inert. `Esc`/`Backspace`/`Left` returns the keyboard to the rail.
  A fact row paints NO per-fact affordance: single-fact copy is advertised only
  as the weak `c copy fact` Action Bar hint, and it is granted only while the
  selected fact's physical row span intersects the painted viewport. `C` and
  the ONE body `Copy All [C]` affordance are not gated on a visible fact row, so
  a narrow frame that drops that segment keeps the keyboard shortcut.
- About reads are non-creating and re-prove the captured SessionScope (owner +
  generation) after every await; a session switch revokes the old view
  immediately, and one semantic entry admits at most one refresh. While
  sessionless, no read starts and the Session-only Refresh is not painted.
- Mouse `Copy All`/`Refresh` targets exist only for the WHOLE painted
  affordance at its last-painted geometry; a clipped or hidden button has no
  target. Ordinary fact cells publish no hit target at all, so clicking a value
  never copies it. The whale is decoration: the report carries facts, never
  artwork.
- `Models` and `Account` are DIRECT content pages in the SAME lease (not
  fabricated Settings rows and not a second alt-screen owner). Selecting either
  on the rail paints the real page in the right column at once, while the
  keyboard stays on the rail; `Enter`/`Right` then hands the keyboard to that
  page and runs no page action by itself. `Esc`/`Backspace`/`Left` returns the
  keyboard to the rail and keeps the page instance, its view, its draft and its
  watch; only a real category change or a real close disposes it. Narrow paints
  one page with an explicit `Esc`/Back path.
- `Tab` (forward) and `Shift+Tab` (reverse) re-focus ONE logical region and
  never activate, write or read the Host. At `≥76` columns a direct category
  hands the keyboard from the rail to its content page, and About/Account
  content hands it back to the rail (Account only while the page may safely
  yield: its confirmation and pending operation keep the keyboard). At `≥76`
  columns a legacy category cycles `categories → rows → detail` forward and in
  reverse, only re-focusing that pane: focusing the Detail never opens its
  choice, editor or writer. Below 76 columns the root Tab is inert, and the
  existing `Enter`/`Right` (in) and `Esc`/`Left` (back) navigation is unchanged.
  A transient choice, a pending write and the in-place Plugin Manager keep their
  own keys; every region jump lands on the destination's first candidate and
  bumps the pointer-press revision, so a straddling click cannot activate it.
- The configuration categories (`Agent`, `Appearance`, `Conversation`, `Input &
  Terminal`, `Tools`, and the conditional `Extensions`) keep their three-level
  browse (L0 categories, L1 rows, L2 detail). `About`, `Models`, `Account` and
  `Plugins` remain direct content pages.
- Twenty configuration rows are writable, in writer kinds that are never
  conflated: the configured theme, the transcript display preset, the icon style,
  the mid-turn progress-updates cadence, the response style, Git attribution,
  Home/End keys, Mouse wheel lines, Notifications, Notification method,
  Terminal progress and the `Agent` user-shell sandbox policy are persisted
  through the ONE serialized TUI settings document; the profile-wide
  `Visual tools` switch is the Host profile's revision-checked form section;
  the `Agent` `Approval policy` is the official per-session runtime override
  (no document field), `Default permission` is the Host permission default, and
  `Subagent model selection` is the official subagent model-selection section;
  transcript detail (`Ctrl+O`) and thinking detail (`Alt+T`) are Client-local
  RUNTIME-ONLY disclosure states with no document field at all, so their Detail
  states `not applicable — runtime-only` and their `Verified` claims only the
  live runtime fact. `Submit while busy`, `Fullscreen` and the `Agent` user-shell
  sandbox policy are the PERSIST-FIRST document rows (see below); the subagent
  allowlist is a specialist PAGE action, not an L2 scalar writer. Browsing never
  writes, and the configuration rows expose no copy verb at all.
- The document-backed rows do NOT share one apply/persist order, and the
  contract keeps their differences instead of normalizing them:
  - `Submit while busy`, `Fullscreen` and the `Agent` user-shell sandbox policy
    are PERSIST-FIRST: the stored document is the authority the row reports as
    its primary `Value` and as its `[current]` chip. A missing/illegal raw value is stated exactly (`not set`,
    `invalid stored value: <raw>`) and never replaced by the consumer's
    fallback; the `Runtime` half names the effect the next read of that document
    will have (`Next busy Enter: …`; the paused transcript mode plus the
    post-close apply). A non-ready/unreadable document refuses the write and
    changes nothing, and only a completed write whose fresh same-field read
    agrees is `Verified`.
  - `Fullscreen` never swaps the screen during the commit. The verified target
    is a transient per-open intent: after the workspace closes through the
    user's own exit, and only while the re-read document still carries exactly
    that value and the app is still idle (no Job/workspace lease, no
    Question/Approval/Save owner, same return screen), the restored transcript
    surface receives ONE physical switch with the preference persistence
    skipped. A forced teardown, a newer blocking owner or any unverified outcome
    switches nothing; the stored preference then applies at the next TUI mount.
  - `Git attribution`, `Home/End keys`, `Mouse wheel lines`, `Notifications`,
    `Notification method` and `Terminal progress` are APPLY-FIRST like
    `icon-style`/`progress-updates`/`response-style`, each driving its ONE
    existing owner: the shared `gitAttributionState` the registered
    `tui:git-attribution` SystemPrompt section reads, the keymap bindings the
    fullscreen viewport really resolves, the NEXT alt-screen mount option, the
    one completion controller's mode/method, and the terminal-native progress
    protocol selection. `Mouse wheel lines` applies to the NEXT fullscreen entry
    only — its live fact says so (`<n> (next fullscreen entry)`) and the mounted
    viewport keeps its constructor-time step — while notification
    writes never emit a notification, and the terminal-progress preference is
    never confused with the Agent's `Progress updates` narration cadence. A
    legacy `on` terminal-progress value is a READ compatibility only and is
    never written back without an explicit confirmation.
  - `icon-style`, `progress-updates` and `response-style` are APPLY-FIRST: the
    live owner changes immediately, the document write follows, and a failed
    persistence never rolls the runtime back. Their Detail keeps two separately
    named facts — the value that already took effect as the primary `Value`, and
    the `Persisted` stored value. While such a commit is pending, that primary
    `Value` already shows the applied value (the projection is re-read when the
    owner changes, not at settlement), and the `Persisted` fact keeps reporting
    the stored value until an authoritative re-read agrees.
  - The explicit `Runtime` label is a property of the row's PRIMARY fact, not of
    its writer kind: the panel paints it only when `edit.primary` is the
    PERSISTED fact, because then `Value` is the stored fact and the live one
    needs its own name. Exactly two rows are built that way — `theme` and the
    Host-authority `visual-tools` switch; every other document row
    (`display-preset` included) is runtime-primary and therefore paints
    `Value` + `Persisted` with no `Runtime` row.
  - `[current]` is a SEPARATE decision from `Value`/`Runtime`: it marks the
    candidate the row considers current, and the two must not be conflated.
    `theme` and `display-preset` keep their pre-existing semantics unchanged —
    the theme is a Host-persisted preference whose non-`ready` backend refuses
    the commit BEFORE any runtime apply, and BOTH mark `[current]` from the
    persisted preference rather than from the live value. The display preset
    still applies through the shared `DisplayState` owner before it persists,
    so its `Value` is the live preset while its `[current]` chip follows the
    stored one. Both keep their existing writer code.
  - The Host-authority `visual-tools` switch marks `[current]` from the Host
    profile's CONFIGURED value (`enabled`), never from the live registry
    registration: whether the registration took effect is the separate `Runtime`
    fact, so a configured On the Host did not apply is a stated mismatch rather
    than a moved `[current]` chip.
  - In every case the `Persisted` fact reports the raw stored value (`not set`
    when the readable document carries none, an explicit unknown when it cannot
    be read), and a normalizer's fallback is never presented as the stored
    value.
- `Agent` owns FIVE rows in this frozen order: `Approval policy (this session)`
  (only for a live, still-current captured Session on a backend that really
  reads and writes the official per-session approval override) → `Default
  permission` (only while the Host advertises a preset roster) →
  `Subagent allowed models` + `Subagent model selection` (BOTH only while the
  official subagent model-selection section and the model catalog are
  available) → `User shell sandbox policy` (always painted). The category stays
  in the fixed rail even when every row is unavailable, and `Agent` has NO
  transition launcher any more: it has no unmigrated field left.
  - `Approval policy` is RUNTIME-ONLY and scope-pinned: the workspace captures
    ONE live Session scope on open and never re-targets it. A session switch
    makes the captured scope stale — the Confirm is refused synchronously
    (zero dispatch, the refusal reaches the ONE app notice) and reopening the
    workspace is what speaks about the new Session. `Value` is the override the
    official service reads (or `not overridden`), a separate `Runtime` fact
    states what the next approval consumes (the consumer's own `ask` fallback
    when there is no override), and `Persisted` says
    `not applicable — current session only`. `Verified` means the SAME scope
    reads the value back; it is never a persistence claim, never a permission
    preset and never `/yolo`.
  - `Default permission` is HOST-PERSIST-FIRST: candidates are the Host's raw
    preset ids in Host order, the write is the official
    `permission.defaultPreset` mutation, and `Verified` needs a fresh
    `defaultPreset()` read to agree. It applies to NEW Sessions only — the
    running Session's preset, sandbox and approval knobs are untouched — and a
    Host port without a settings service REFUSES explicitly instead of
    succeeding as a no-op.
  - `Subagent allowed models` opens the EXISTING subagent allowlist picker in
    this same workspace body (same screen lease, same chrome, the picker's own
    semantic hint as the physical last row) through the ONE explicit
    `Manage allowed models…` action. Its `Esc` returns to the Agent rows — never
    a category, never the conversation — and the row summary is re-read from the
    official section on the way back. `Subagent model selection` is the same
    official section's `enabled`: enabling with an EMPTY allowlist performs
    ZERO official writes, states the setup guidance and moves the selection to
    the allowlist row through a typed follow-up outcome (never by parsing the
    message); disabling keeps every saved route; `Verified` requires BOTH the
    toggle and the route list to read back.
  - Both subagent surfaces write through ONE command-owner section queue (the
    workspace toggle and its embedded picker). Every user action is an intent,
    and the queue applies it to the official section as it stands when that
    intent's turn comes:
    - the toggle owns ONLY `enabled`;
    - a picker toggle owns exactly ONE `(provider, model)` pair, applied as an
      add or a remove — never a replacement of the whole list, so two surfaces
      (or two picker instances, one still writing) compose instead of erasing
      each other's routes. An add never creates a DUPLICATE grant (an existing
      pair is re-appended, so the stored order may differ from the click order)
      and a remove of an absent pair changes nothing.

    The half an action does not own is re-read from the official section INSIDE
    the queue, immediately before the write. A slow earlier write therefore can
    never land after a newer intent, and a payload captured before an earlier
    write settled can never erase it. An intent is REFUSED before any write when
    its turn finds the backend non-current, the section unavailable/unreadable,
    or the FRESH section in a state the intent cannot legally produce (the
    last-route-while-enabled rule is decided there, in FIFO order, never from a
    picker's earlier view): those refusals perform ZERO writes and report a typed
    cause. A write that was dispatched and then rejected by the section is a
    DIFFERENT failure — it surfaces as a failed write with its own reason, never
    as a refusal. The queue is a serialization + rebase barrier, not a second
    settings authority: the official section stays the only stored value, and a
    surface may only report facts it actually read back. An optimistic marker is
    therefore never summarised as saved: a close reports the last confirmed list,
    a successful fresh readback updates it, a rejected write that cannot read
    back rolls the surface back to that last confirmed list, and a write whose
    readback is unreadable keeps the last confirmed value rather than inventing
    one.
  - Every `Agent` row that owns a Host write refuses to offer a confirmable
    candidate while its authority cannot vouch for the value: a non-`ready`
    backend (or an unreadable document) keeps the row and its truthful
    last-known/raw facts but offers no candidate, so the UI never invites a
    Confirm that the writer must refuse. The delegation rows keep their
    last-known values labelled as such instead of claiming `Ready`/`[current]`.
  - `User shell sandbox policy` is a PERSIST-FIRST TUI-document row: `Value` is
    the RAW stored `localShellSandbox` (`not set` when absent, the invalid raw
    value when illegal, `unknown` when the document cannot be read), `Runtime`
    names the effect the NEXT `!`/`!!` really takes (including
    `bypass (default; no valid saved value)`), and only an agreed fresh
    document read is `Verified`. It is the Host user-shell execution policy —
    never the model's tool sandbox policy, never a permission preset, and it is
    deliberately not part of `Input & Terminal`. When the Host provides no
    user-shell the preference still stores, and the existing executor fails
    closed instead of degrading to a local spawn.
- The Settings workspace is the ONE settings surface: every field it reaches
  is edited by its own native row, row choice, embedded page or typed deeplink,
  so no category carries a transition launcher and no Settings gesture hands
  the user off to a second editor. The retired complete settings editor (and
  its Web rows, phase map and credential hand-off) no longer exists. The
  `SettingsList` component itself remains: independent commands (`/help`,
  `/skill`, `/preset`, `/keybindings conflicts`) open it with their own row
  lists through `TuiApp.openSettings`, which is not a Settings workspace path.
- `Tools` holds the built-in `Visual tools` row (backed by the Host profile's
  `pi-tui-visual-tools.enabled` volatile Config, schema default On) plus the
  `Web Search / Fetch` page entry, in that frozen order.
  Its stated value is the effective Host form value; `[default]` marks a value
  the USER layer does not declare. Confirm writes that ONE field through the
  official revision-checked settings mutation and re-reads the Host. Off
  releases both built-in registrations from the global Host tool registry and
  On restores the original definitions; already-recorded results and their
  rendering, copy, search and export are unaffected. A missing, unreadable or
  non-current authority keeps the category and row visible but offers no
  candidate and refuses the write (never a fabricated default). On a Direct
  backend `Verified` also requires the Host row's live registration fact to
  agree; Remote has no registry read and states the runtime half as
  unobservable instead of claiming success.
- `Web Search / Fetch` is an EMBEDDED SPECIALIST PAGE inside this same
  workspace lease: `Enter`/`Right` on the row (or its ONE painted
  `Configure Web…` action) mounts the page in the same body under the same
  header/metadata/notice/Action Bar. It is never the legacy `SettingsList`, never
  a second alt-screen overlay and never a second settings manager, and its `Esc`
  ladder is `Detail → Web list → the Tools row → the category rail`.

  The page paints exactly SIX rows in this frozen order: `Web Search Provider`,
  `Web Fetch Provider`, `Search API Result Count`, `Share Original Question`,
  `Search / Fetch API Endpoint`, `DeepSeek API Key`. At ≥100 columns the row list
  (max 34 columns) sits beside the selected row's Detail; at 65–99 columns the
  list is stacked above it; below 65 columns exactly ONE region is painted at a
  time and `Enter`/`Esc` move between the list and its Detail. The frame keeps
  ONE active cursor (the focused region's), ONE pane header and the ONE shared
  last-row Action Bar; a cropped grant scrolls instead of hiding an activation,
  and an Enter whose candidate is not inside the painted viewport does nothing.
  A candidate, state word or `[current]` chip is never painted partially, and
  terminal-untrusted Host text (custom provider ids, URLs, credential source)
  is painted through the existing sanitizers and width helpers.

  Authority is the Host `web` / `web-deepseek-api` sections through the
  `WebProviderConfig` read and its FIVE setters. The provider choices are the
  official identities `Messages`↔`deepseek-official` and
  `HTTP`↔`http`, plus the opt-in, separately billed `DeepSeek Search API` /
  `DeepSeek Fetch API`. A configured provider id outside those candidates is a
  CUSTOM route: it is displayed verbatim, it is never replaced by a default and
  the page offers NO confirmable candidate for it. The count row offers the
  `5/10/20/50` presets while the official domain stays 1–50: a stored integer
  outside the presets (for example `7`) is reported exactly and is never
  rewritten by navigation or refresh. `Share Original Question` is `on` by
  default and states the payload boundary (up to 128 characters of the
  triggering human question as `ori_question`, never the full history or system
  prompt). The endpoint row reuses the existing endpoint editor
  (`WebEndpointPanel`): a full URL draft, an explicit Enter Confirm and the
  trust warning that the credential and query are sent to that HTTPS target
  (the URL shape is validated, not the host's trust); `http`, userinfo, query,
  fragment and a trailing `/search`/`/fetch` are refused with no Host write.

  Every write is ONE explicit Enter confirmation that enters the command
  owner's single Web FIFO. At its turn the intent re-proves readiness and
  section availability, takes the NEWEST committed read as its base, refuses a
  custom-route/candidate violation with ZERO writes and dispatches the ONE
  official setter. A fresh read-back then decides the settled word: `Verified`
  only when the authority holds the requested identity, `Not saved` (with the
  value the Host really keeps) when a readable authority differs, and `Outcome
  unknown` when the result cannot be read back. A superseded read never decides
  a verdict; a newer read is awaited first, and a page closed mid-write only
  loses its own repaint — the dispatched Host operation still settles in the
  command owner. Confirming a value the authority already holds performs NO
  setter (the official auto-selection already applies the default candidate).
  `Loading…` on page entry or `r` is a real pending state, never a last-known
  value presented as current; every read that settles refreshes the Tools row
  summary and the mounted page from the same facts.

  `DeepSeek API Key` shows ONLY the official credential reference
  (`DEEPSEEK_API_KEY`), its presence and its source layer — never the value.
  Its two actions are `Configure in Models…` and `Clear in Models…` (the latter
  only while the fresh official fact is configured), and both hand a typed
  `ModelsInitialView` (the same reference, or its exact clear target) to the
  workspace root: the root retires the Web page FIRST, then switches to the
  existing Models page with that initial view in the SAME lease. The page never
  runs `/login` text and never touches a secret; Models owns the masked input,
  the clear confirmation and the credential-store mutation, and re-entering the
  Web page performs a fresh presence read. A backend whose Web section is
  unavailable (Remote or a half-mounted/malformed authority) still opens the
  page as a read-only statement with its reason, paints `Unavailable` and offers
  no Confirm or credential action at all.
- `Footer layout` and `Keyboard shortcuts` are EMBEDDED SPECIALIST PAGES in this
  SAME lease. `Appearance` carries the persist-first `Status line mode` row
  (`default`/`compact`/`custom`; a stored `command` is reported as
  `command (manual)` and is never a candidate) plus `Configure footer layout…`;
  `Input & Terminal` carries `Keyboard shortcuts…`. `/footer`, `/statusline` and
  bare `/keybindings` are TYPED DEEPLINKS: the command validates the exact
  row/page pair, takes the Settings lease and mounts the page on the first real
  body grant (never before the lease, never a fallback overlay). The page keeps
  its ONE existing authority — the Footer model/catalog/composer and its
  persist-first save transaction (queue-head USER raw merge, runtime apply only
  after the write), or the ONE `KeybindingEditorController` and its serialized
  writes/conflict checks. The root owns header, metadata, notice, pane header and
  the ONLY physical last-row Action Bar; the page contributes its business body
  and preview above that bar. `Esc` follows the page's own state machine (Footer
  dirty Save/Discard/Keep guard; Keybinding recorder → action detail → query
  clear → list root) back to its source row, then the existing Settings levels
  close; only leaving the whole Settings workspace releases the lease. On the
  page's ROOT state (Footer Row Selector, Keybinding list with an EMPTY query)
  `←` is the same back verb and the page bar advertises it as `← Back` — also
  when the grant is the single Action Bar row — while a sub-page or a
  non-empty query never advertises it. A dirty Footer turns it into the
  Save/Discard/Keep guard. Closing either professional page returns to that
  row's ROWS level — never to an intermediary Detail panel — so the very next
  back key (Esc or `←`) reaches the category rail; the subagent allowlist and
  Web Search / Fetch pages keep their own `Detail → row` ladder. Every
  sub-page keeps its own meaning (`←` still moves a Footer item between zones,
  and a non-empty Keybinding query still moves the search cursor). A page that
  blocks USER navigation (dirty Footer draft, in-flight save, non-empty query,
  action detail, recorder/leader, pending mutation) refuses category changes,
  and a page whose current grant or sub-view has not painted admits only the
  page's ROOT back verbs — the real Esc, plus `←` while the page is on that
  same root state — never a hidden save/open/search/list/leader/record control;
  the root's painted content box, revision and child grant fence every pointer
  gesture. A pending Keybinding mutation owns the page until its result is
  painted, so leaving can never strand an invisible write. No second
  alt-screen, overlay, editor or settings manager exists for these entries, and
  a deeplink that cannot take the lease or build its page returns a real command
  error instead of opening an overlay.
- An L2 choice is transient; only an explicit Confirm commits one field through
  its own authority path (the serialized TUI settings document, the Host
  `pi-tui-visual-tools` form section, or — for the two runtime-only disclosure
  fields — the `TuiApp` state owner `Ctrl+O`/`Alt+T` share, with no persistence
  step) and re-reads the authority. A writer refuses a value outside its frozen
  candidate set BEFORE it mutates anything: the parsers' fail-safe defaults are
  normalization, never validation. The progress-updates and response-style
  writers mutate the ONE shared prompt-state object the registered
  SystemPrompt providers read (`ProgressUpdatesState` / `ResponseStyleState`):
  no section is re-registered, no Agent is recomposed and nothing reaches the
  Focus/Compact presentation state.
- `Verified` requires a ready read-back with a matching value. Rejected/unknown
  outcomes are attributed from a fresh read, never guessed. A refused write is
  reported as `Not saved`/unknown, never as success. For the apply-first fields
  a failed persistence never rolls the live runtime back, so the screen must
  keep stating BOTH facts (the applied runtime value and the unchanged stored
  one); the runtime-only fields carry no document read at all, so they never
  paint a persistence phase.
- Theme auto is fenced on the runtime selection intent.
- `Plugins` is a DIRECT page inside the same lease (see Plugin Manager): the
  embedded `PluginManagerWorkspacePanel` paints only its own business body,
  while the root keeps the single Header/Metadata/rule/pane-header/last-row
  bar. At ≥120 columns the frame is `Categories | List | Details` — provided the
  frame can still grant six real business body rows (a shorter frame degrades to
  one business column); at 76–119 the rail focus paints `Categories | List` and the
  plugin content focus paints `List | Details` under the SAME six-row floor, so a
  shorter frame keeps one business column; below 76 columns it is one column, and
  the page is not
  mounted while the rail is focused there. `install`/`confirm`/`diagnostics`
  always take the full width (no rail) so risk text is never squeezed. `Tab`
  and `Enter`/`Right` only hand the keyboard to the plugin List (no action);
  `Tab` inside the List keeps its filter cycle, `Shift+Tab` from the untouched
  List root returns to the rail, and `Esc` from the List root returns to the
  rail with the page instance, its view/query/selection/scroll and the
  controller's install request id intact. Only a real category change or the
  Settings teardown disposes the page and releases its Host claim. No Settings
  level hands the user off to a second editor. `Extensions` is a real
  configuration category whose Rows
  project one owning extension's live settings at a time (see the Settings
  Workspace contract above).
- The screen lease/currentness mechanics are owned by
  [overlay-focus.md](./overlay-focus.md).

### Models page

The provider list and detail are detached ConfigPort projections
(`readCatalog`, `describeReference`, `recordPresence`, `listRecords`).
The page never infers a stored key from a route/profile.

- ONE catalog read per generation: the provider rows and their profile facts
  come from ONE provider snapshot (the adapter reads the configurable-provider
  directory and the settings once per snapshot, and never repeats a settings
  read or a deep copy per provider route). The credential presence is a
  SEPARATE, later read: one `describe` per UNIQUE reference, issued after
  the catalog succeeds. The catalog read runs AFTER the first painted frame of
  the page: the constructor performs no Host read, so selecting `Models` on the
  rail paints the Loading state instead of blocking the input path.
- The page's reads are armed BEHIND the frame that paints their
  Loading/Reading state, not behind a timer. The renderer writes a frame
  synchronously after the component tree renders, and the page starts a read
  only after that write. A `setTimeout(0)` is not this boundary: frames are
  throttled (up to the render interval), so a timer can run the synchronous
  Host scan before the state frame reaches the terminal. The rule covers the
  first catalog read, the catalog R refresh, the stored-credential list
  (opening it and R) and the record-clear confirmation.
- The read state is explicit: `Loading` (no authoritative rows yet), `Ready`,
  `Refreshing` (a read in flight over a live snapshot), `Stale` (the last
  snapshot is not the current authority — a failed refresh over the last good
  snapshot, or a backend mirror that is not current) and `Error` (no
  authoritative read at all, with a retry). A failed read is never painted as
  "no providers configured".
- The HOME lists the CONFIGURED provider profiles — the Host's own
  profile-present fact — plus the independent DeepSeek Account row. The
  presence of an API key never decides the membership, and an unconfigured
  directory route is not a HOME row.
- The credential/record state of a row is an INDEPENDENT fact, read after the
  catalog, and it has its OWN freshness: a new generation's presence is
  `Checking…` until it answers, so the previous answer is never painted as a
  fresh confirmation (a write's authoritative read-back keeps its priority
  through the per-reference generation fence). `Configured` /
  `Key missing` for an API-key reference, `Signed in` / `Not signed in` for a
  provider-native sign-in, `Checking…` while the read is pending, `Outcome
  unknown` for a failed read and `Unavailable` for a backend that cannot
  answer the question. A credential reference may be shared by several
  providers: the reference is read ONCE per generation and every row shows
  that answer.
- The stored-record presence is ONE enumeration for the page. The full
  Stored Credentials list (with its per-reference audit) is read only when the
  user opens that view, and a backend that cannot enumerate records is
  `Unavailable`, never an empty list. Opening that view, opening a clear target
  and the R refresh all start their read AFTER the painted frame — never in
  the input path — and a deferred read is CONSUMED by the view's own refresh: a
  user who already left the view pays no stored-credential scan, and no read
  happens twice.
- An authority-dependent write waits for the FRESH read of its OWN authority.
  The provider-profile actions (the native sign-in, the Add create and a
  provider-detail Configure API Key) wait for the provider catalog: while a
  refresh is in flight, or the last snapshot is not the current authority (a
  stale snapshot), they are disabled and the page states that the configuration
  is not current. The page addressed by an EXPLICIT credential reference
  (`/login REF`) and the stored-credential clear instead wait for the credential
  store's authoritative read of that exact identity: the reference page's write
  is disabled until `describeReference` answers (a failed read is retried with
  r), and a clear re-read drops the previous confirmation before the new answer
  arrives. Those actions stay usable when the provider catalog is stale — the
  fail-soft resolver guarantees an explicitly typed reference is addressable,
  and the write is verified by its own read-back.
- `Add Provider` is a catalog: `Available providers` lists the unconfigured
  providers this installation offers, each with the operation this page can
  really perform for it (a native sign-in, the prefilled setup draft, or an
  explicit manual-only reason), and `Other sign-ins` lists the sign-in flows
  that no provider profile addresses. One `Custom provider…` action opens the
  existing draft. The list is narrowed by typed text (a visible filter line
  with the match count); `Esc` clears the filter before it leaves the
  catalog. Browsing writes nothing; a catalog entry is activated only by an
  explicit Enter, and a route with no supported operation states why instead
  of claiming success.
- `Tab` and `Shift+Tab` move the page's ONE cursor between its body rows and its
  bottom action group (both directions toggle; the destination is the region's
  first candidate, and the first ENABLED action). The jump only repaints the
  selection and may reveal the destination row through the existing list
  scroll: it never opens a form, starts a flow or writes, and `Enter` remains
  the only activation key. A view with no body row (for example a zero-match
  Add catalog filter), no enabled action, or no paintable body/action space
  ignores the key instead of creating an invisible selection. An active
  QuestionFlow, native picker or model picker keeps its own Tab meaning; the
  page advertises `Tab sections` only while both regions are really paintable.
- Provider detail shows route, profile presence, protocol, endpoint, models,
  auth kind and credential presence (presence only, not a connection test).
- `Configure API Key` opens a page-local masked editor (the existing
  QuestionFlow component); an empty/cancelled answer writes nothing. A resolved
  `setReference` is not a success: `describeReference` must report the reference
  configured before the page paints `Verified`; otherwise it states the
  failure/unknown outcome. Below the QuestionFlow's 8-row supported budget the
  page paints a resize state and refuses submit; eligibility is re-evaluated
  against the live body height and the current auth-notice rows on every input,
  not only when a frame is painted.
- `Clear stored credential` is a single explicit confirmation for the exact
  identity (reference vs stored record). The confirmation is enabled only by
  the AUTHORITATIVE read of that identity: a target that is still `reading`
  cannot be confirmed (the delete is never dispatched before the store was
  checked), and a deeplink that opens the target reads it after the first
  frame. A clear that is IN FLIGHT owns its own state: a refresh never re-arms
  or resets it, the confirmation stays locked until the Host answers, and the
  same delete can never be dispatched twice. After the clear the page re-reads
  the store; it never claims success without the authoritative absence.
- The custom provider draft is one page-local form over route → protocol →
  base URL → display name → optional key → discovered/manual model ids →
  review → create. Nothing persists before Create. Profile and credential
  writes are separate Host operations; a persisted profile with a failed key
  write is reported as a partial outcome with the exact failed stage.
  The Create is CONDITIONAL: it writes the profile of a NEW route, it is
  refused when the route already has a profile, and it is checked against the
  revision its decision was read at — a provider configured in the meantime
  is refused (the user re-reads and retries), never overwritten. A directory
  route whose profile lives OUTSIDE the conventional provider slot (the
  catalog's `Manual setup only` rows) is refused too: the wizard can only
  write the conventional slot, so it never reports a created provider the Host
  would not read. The same rule governs the keyless profile write after a
  native sign-in: it never overwrites an existing profile, and a failed OR
  stale provider read authorizes no write at all.
- Provider-native sign-in uses the existing authorization attempt owner: early
  events are buffered before attempt binding, notices/URLs stay visible above
  in-page prompts, select/text/secret prompts answer through `respond`, a Host
  withdrawal closes only that prompt without answering, and settlement returns
  to the provider detail. A successful sign-in may write a minimal keyless
  profile for an unconfigured catalog route. An ordinary cancel/back is a
  REQUEST: it keeps any open prompt answerable and waits for the Host's
  authoritative settlement; the page refuses user navigation while a key
  write, Add Provider create, clear or native attempt still owns it. Browser
  Account attempts are never cancelled this way. A forced page teardown
  (blocking owner or workspace teardown) cannot keep a prompt answerable: the
  adapter releases the destroyed prompt bridge as cleanup, and the Host may
  report failed/cancelled even when a commit had started; the next Host read
  remains authoritative. That forced-teardown boundary has no safe
  adapter-only outcome.
- Stored credential records exclude the DeepSeek Account grant.
- The `/login` and `/logout` resolver stays fail-soft when a read fails: the
  always-present builtin target (whose reference is a constant) remains
  addressable, and an explicitly typed reference still resolves. A route whose
  credential reference is UNKNOWN (a failed settings read, a failed or stale
  Remote directory read) is not offered as a route→reference authority — a
  derived reference would be a guess that can point at another provider's
  key, and the last-known routes may belong to another Host.

### Account page

- Host `AccountView` phases drive the display (`succeeded` is presented as
  Authorized). A detached view is current only while paired with its adapter-
  issued local observation lease; without a valid lease it is last-known, not
  signed-out. Invalidation never implies a credential change. `credential-stored`
  is a storage fact, not a server-validated identity; profile and balance are
  independent queries with independent pending/failed/ready states, and an
  unavailable balance is never shown as 0. The page binds profile/balance reads,
  every Account mutation and the running-task risk read to the same current
  observation. A stale lease keeps profile/balance/links and authorization URLs
  last-known; already-started profile/balance results cannot commit across the
  account state serial. The official Watch is the only writer of the page's
  AccountView; Refresh releases the current subscription and waits for its complete
  initial snapshot. Stale Profile/Balance facts are marked last-known, and a stale
  authorization URL is not presented as current.
- Wallet decimal strings are forwarded verbatim. `Usage` and `Top up` use the
  client-local HTTP(S) opener with the official `AccountView.links`; the page
  never receives a token or grant payload.
- Sign in starts the official browser attempt with the Host's own loopback
  callback origin and login source `web`, and paints the authorization URL plus
  the SSH tunnel template for the current callback port. Cancel addresses the
  exact attempt id; a stale id cancels nothing.
- Sign out is an explicit confirmation with the account identity and the
  running-account-task risk. The page starts an asynchronous Host check; while it
  is pending or unavailable, Sign out is disabled and the distinct status is
  visible. An unavailable result offers `Retry task check`; only a current known
  result enables the destructive action. The check's Host authority and
  Direct/Remote semantics belong to [host-client.md](./host-client.md#provider-credentials-and-deepseek-account).
- The Watch subscription is the only writer of the page's AccountView. A successful
  SignIn/Cancel/SignOut call ends local `busy`; until the next complete Watch
  snapshot arrives, the prior view and its details are last-known and cannot
  authorize another mutation. A failed or unconfirmed mutation shows an explicit
  result notice, is never replayed automatically, and closes any SignOut
  confirmation. Explicit Refresh releases the old subscription and reopens the
  official Watch. Older task checks cannot authorize a newer Account view,
  confirmation, page or connection.
- The official `signOut` removes the local grant and leaves remote revocation in
  the background. A failed revocation never restores a local grant, and
  independent API keys stay stored. While sign-out is pending, user navigation
  and page exit are refused.
- Closing the page ends only the watch subscription; an in-flight browser
  attempt keeps running on the Host, and reopening reads the Host state again.

Authority: `src/tui/commands/settings.ts`
(`readSettingsWorkspaceSnapshot`, `commitSettingsWorkspaceField`, the Models/
Account page sources), `src/app/command/credential-workflow.ts`,
`src/app/command/account-workflow.ts`, `SettingsWorkspacePanel`,
`ModelsWorkspacePage`, `AccountWorkspacePage`, `TuiApp.openSettingsWorkspace`.

Must-not: add a second store/subscription/write path, fabricate defaults, commit
after close/replacement, paint a non-ready save as verified, show a secret or
token, infer credential presence from a route, offer an invisible confirm
target, clear the Account grant as a generic record, let an older page
settlement repaint the current page, drive the visual-tools switch from a TUI
preference, or claim its Host registry registration took effect when the
backend has no registry evidence.

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

### One controller, one workspace lease

`/plugins` and `Settings → Plugins` are the SAME composition: ONE
`PluginManagerController` per surface and ONE embedded
`PluginManagerWorkspacePanel` inside the existing Settings workspace Alt-Screen
lease. `/plugins` is only a deep link: it takes that lease with the Plugins
category selected and the keyboard on the Plugin List (sessionless, no Session
create/switch, no second screen). The controller outlives the page; a second
page while one still owns the controller returns nothing instead of nesting an
owner; a refused Settings lease leaves no phantom claim.

The page never paints root chrome: it receives a local
`{ width, rows, allowDual }` viewport from the root every frame and paints only
its Search/Filters row (list/details, when admitted), its OWN Host
notice/read-error/exemption row, its business body and ONE semantic bar as its
local last row; the root installs that line as the physical last row only while
the plugin content owns the keyboard. At ≥120 columns the frame is
`Categories | List | Details` when the frame can still grant six real business body
rows; at 76..119 it is `Categories | List` while the
rail owns the keys and `List | Details` once the plugin content does, so the rail
is not painted in that second case. That pair needs `allowDual`, a local width ≥76
and SIX real business body rows, so a shorter
frame degrades to ONE business column rather than squeezing the body; the split is
`min(42, max(30, floor((width−2)×0.42))` for the list and the remainder for
Details. A narrower or risk-starved frame degrades to ONE business column and
never to a permanent Categories rail. A wheel is routed by the column the local
pointer is really over: the List column scrolls the List and the Details column
scrolls the Details, in the List view and the Details view alike; the 2-cell
pair gutter belongs to neither pane and is inert.

Esc is a two-level gradient: the untouched List root yields to the Categories
rail (keeping the page and its state), a second Esc closes the Settings lease;
Details returns to the List, confirmation returns to Details, Diagnostics
returns to the List, and a running install's Esc hides the view without
cancelling the Host operation. The upgrade view follows the same rule: Esc from
`checking`/`selecting`/`confirm`/`done` returns to that Bundle's Detail, while a
`running` or `unknown` update hides the page (to the List) without cancelling or
re-dispatching the Host operation. The rail's `Tab`/`Enter`/`Right` only
transfer the keyboard into the List. `Esc` in the install/update gradient and
the details sub-state never cross levels. A page factory failure releases the
claim and disposes anything half-built instead of faking success; a page that
starts after an earlier attempt ALWAYS starts on the List, `i` reopens the same
in-flight/failed/unknown install request id without dispatching a second
install, and `u update result` reopens the ONE update lifecycle after it was
hidden.

### Host authority is owned elsewhere

The Host package/profile authority, semantic port, Direct/Remote mapping and
Connection generation fencing are owned by [host-client.md](./host-client.md).
This surface owns the controller/read-epoch/state-machine/workspace behavior; it
never invents catalog facts, and a `@deepseek-ai/` scope or `experimental`
substring is not identity proof.

### Default listing, explicit search and refused bundles

The Host's `BundleInfo.listedByDefault` is a DISPLAY decision, never enablement
or load success. The workspace applies it ONCE, as a local projection over the
same model cards: with an empty query, a `listedByDefault:false` bundle is
listed only while the profile selects it, the profile installs it, or a live row
proves it runs; any non-empty explicit search lifts that gate over the SAME
`model.cards`. A status filter never resurrects a default-hidden card, and no
entry is dropped from the controller, the model or the Host snapshot, because
the Host catalog stays the only authority and explicit search is the documented
route to the complete inventory. The list carries ONE hint line naming that
route; there is no second catalog page, store or navigation level.

A `Host error` outranks every selected/available summary. The SAME Host
`enabled` boolean means different things per target and is labelled accordingly:
a bundle's flag is the profile SELECTION (`Selected in profile`), while a
standalone Loader entry's flag is its effective enablement (`Effective enabled`,
including disabled ancestor groups). `Fiber` stays the separate runtime fact in
both cases, so a bundle the Host refuses with `unsupported-platform` is never
presented as running and an entry is never mislabelled as a profile selection. That refusal blocks only the official catalog Install; it
never locks the recoveries the Host still permits. A selected bundle can always
be disabled through the real `setBundleEnabled(name,false)` plus the
authoritative reread — including while its files are missing or its platform is
refused — and a profile-owned bundle's Remove is answered independently by the
Host `removable`/`availability` facts, through its own destructive confirmation.
The TUI never fabricates a platform decision, retries an indeterminate write, or
reports a refusal as success.

`BundleInfo.updatable` is a declared Host capability, never a TUI guess: only a
Host-updatable, non-self bundle Detail offers `Check updates…` (before Remove),
and the entry is answered by the official `listVersions` read. The Host's
`installed`/`official`/`source`/`readOnlyReason` facts — not a local check —
decide that capability; a non-updatable profile bundle keeps the
Remove-then-explicit-install guidance.

### Inventory read epoch

`readEpoch` makes the latest-started read win. A failed refresh keeps the last
good snapshot and marks `state='error'`; no mutation is admitted while
loading/error/busy, and the controller keeps one mutation in flight. Every
mutation is followed by an authoritative reread while `busyValue` stays set; a
failed reread blocks further writes until a successful refresh. A stopped
surface refuses pre-dispatch writes and does not restore into a destroyed
editor; a dispatched write keeps its accepted receipt and is never
reinterpreted.

### Install state machine

Phases:

```text
editing → inspecting → confirm → starting → installing → applying
                                      │            │
                                      └────────────┴──→ cancelling
                                                         ├─ cancelled       → done
                                                         ├─ too-late        → applying
                                                         ├─ already settled → unknown
                                                         └─ cancel failed   → installing

starting | installing | applying → done | failed | unknown
```

`cancelling` is reachable ONLY from `starting`/`installing`; it is never a
normal successor of `applying`.

- Exactly one `requestId` per attempt; inspect before any install; explicit
  confirmation. The same id is used by `waitForInstall`/`cancelInstall`; a new
  explicit approval gets a NEW id. An unknown result is reconciled through the
  official wait/reread, never claimed as success and never retried
  automatically.
- Explicit cancel is available only while starting/installing. `too-late` means
  the profile is applying and is never reported as cancelled.
- Unknown/failed reconciles through `waitForInstall` plus an inventory reread
  and is NEVER automatically resubmitted.
- A failed install may be retried only by explicit approval of the exact
  Host-reported `pendingBuilds` under a NEW request id.
- `installEpoch` fences stale inspect results; `mutationToken` enforces one
  mutation in flight.
- Leaving/hiding the page never cancels a Host operation. Every new page starts
  on the Plugin List; `i` reopens the SAME controller state (in-flight request,
  failed/unknown requestId, or a recent result) under the SAME request id and
  never dispatches a second install. `hasResumableInstall` is the reopen
  predicate for the list's hint only, never the initial view.
- A Remote reply superseded by a Connection generation change is an
  indeterminate `PluginManagerStaleResultError`, never a new-Host success or
  refusal.

### Update state machine

Phases (ONE Controller-owned lifecycle, never a second store):

```text
checking → selecting → confirm → running → done
   │           │          │         │
   └───────────┴──────────┘         └──→ unknown
```

- `Check updates…` requires the current Host model card to be a non-self
  `target:'bundle'` with `updatable:true`, and fixes the installed version and
  read epoch before `listVersions(name,{})`. An UNFINISHED preview
  (`checking`/`selecting`/`confirm`) is reused when the page is re-entered; only
  an explicit `r` repeats its registry read, and a new inventory read
  invalidates an unconfirmed list (`Bundle changed; check versions again`). A
  `done` result is historical evidence, not a frozen preview: `Check updates…`
  on the same bundle starts a NEW check (never a re-dispatch and never a reuse
  of the old registry/version selection), while `u update result` reopens the
  settled result until that new check replaces it.
- `selecting` renders every Host-listed version verbatim: tags, publication
  time, prerelease, deprecation, bundle declaration and compatibility. A
  non-bundle, incompatible or deprecated row is not selectable; a legal
  prerelease is selectable only by an explicit choice (the initial suggestion is
  the first eligible stable version and does NOT silently pick a prerelease).
- `confirm` shows `From → To`, the Host-answered registry, and the consequence
  warning; Cancel is the default choice, and a dangerous primary is painted only
  when its whole warning fits the painted body (a tiny frame withholds it and
  says why). Enter/pointer activation re-checks the last-painted action and the
  current installed-version/read epoch; a changed inventory withdraws the
  confirmation without writing.
- `execute` sets the request id, `running`, `busyValue` and `mutationToken`
  synchronously, then calls the official `updateBundle(name, exactVersion,
  {registry, requestId})` exactly once. While the update owns the path, Remove,
  Toggle, a new Install, build approval and a second Update are refused. Hiding
  the page never cancels or re-dispatches it.
- `running` renders the official `plugin-manager/update-state` steps and the
  matched `install-state`/install-log by exact request id; unrelated ids never
  enter the update log. `s stop target install` exists only while the update step
  is `installing` AND the matched install phase is `installing`; it calls
  `cancelInstall(requestId)` and keeps waiting for the update result. A
  `cancelled` / `too-late` / `not-running` answer is only a notice, never the
  update's outcome.
- The returned `PluginUpdateResultFact` is reported as TWO independent fields:
  the target `result` (`application`, `stage`, `version`, error, restart) and
  the optional Host `restore` (its own application/error/version). A target
  failure with a successful restore and a target failure with a failed restore
  are distinct states; a missing restore is never presented as a restored
  version. `restart-required` is shown as such.
- The update is `done` only after a fresh authoritative `snapshot()` read. The
  observed installed version is a separate fact from the operation result; a
  failed reread is `Inventory stale`, never a fabricated current version.
- A transport/Remote-generation failure after dispatch is `unknown`: it is
  neither success nor failure nor cancellation, is never retried, and keeps the
  local write lock. A successful authoritative reread plus an explicit
  `Acknowledge uncertainty` is the only release; the acknowledgement states that
  the Host may still be finishing the update.
- A settled update while the page is hidden is notified once and stays
  reopenable through the List's `u update result`; `Check updates…` after
  `done` starts a new check instead. No second update history/task center
  exists.

### Detail copy policy

The support sentence pair is module-private
`EXPERIMENTAL_BUNDLE_SUPPORT` in `src/app/plugin-manager/model.ts`. It applies
only to a bundle card with `official === true`, `section === 'experimental'` and
an exact key in the implementation's explicitly enumerated, Host-source-verified
official-bundle set. The exact names and copy are owned by the model and its
tests, not by this document: do not copy the table here. It is bounded app
presentation for explicitly enumerated official-bundle identities, not a
public capability API,
not a Host PASS, and is never derived from enabled/fiber/availability. The
model/tests also own the single Owner-frozen danger confirmation, which is the
only hazard statement.

### Diagnostics page

The Plugin Manager list opens a read-only Diagnostics page with `d`; it is a
FULL-WIDTH business view of the SAME embedded page/controller/Settings lease
(never a Settings category, a second controller or a second screen owner). The
root keeps its single Header/Metadata/rule/pane-header row; the shared app
notice is painted by the root, and the page's own Host inventory notice is not
painted on this view. One immutable read produces its
facts: the extension ledger's contribution health records, each live registry's
contribution count, and `api().capabilities`. Contributions with a PROVEN
`ownerEntryIds` association are grouped by owner; all others stay visible under
`Unassociated extension contributions`. Each record shows the exact
`extensionPoint:id`, its state and the whole `lastError` (wrapped, scrollable,
never silently truncated), and `c` copies its exact block while `C` copies the
whole stable report. Both payloads pass the SAME shared terminal-control guard
as About: ESC/CSI/OSC/DCS/C1 sequences and non-whitespace controls are removed,
TAB/LF/CR become visible escapes, and only the report's generated line breaks
remain structural. `r` rereads this projection only; it never refreshes the
official package inventory, and a ledger failure/recovery is reflected on the
next painted read. With no extension service attached the page says
`Unavailable`. Host package state, install logs and the Host inventory's
`Stale`/error notice are NOT extension diagnostics and never label this page.
Mouse `Copy [C]`, `Copy All [C]` and `Back` targets exist only for the whole
affordance at its last-painted geometry; copy uses the snapshot that was
painted.

Authority: `src/app/plugin-manager/extension-inventory.ts`
(`describeTuiExtensionDiagnostics`), `src/app/surface/plugin-manager-runtime.ts`
(the `diagnostics()` read on the ONE controller), `src/tui/plugin-manager/workspace.ts`
(the page/renderer and last-painted targets); sink: the Plugin Manager body,
action row and App clipboard.

Must-not: add a second controller/store/scanner, poll the ledger, fold package
inventory or install logs into extension health, infer an owner association from
a name/prefix, or let a Host `Stale`/error notice label the extension projection.

### Detail upgrade guidance

Derive only from `availability`, `canRemove`, `isSelf`, `version`,
`installTarget` and the Host `updatable`/error facts:

- self → managed outside this screen;
- installation → upgrade DSH; no in-place update or Remove;
- profile-owned with `updatable:true` → name `Check updates…` and state that the
  Host re-checks the exact target before changing the profile;
- profile-owned without it → Remove first, then an explicit later install; state
  when removal is not permitted;
- missing with an official target the Host itself refuses (for example
  `unsupported-platform`) → install unavailable with the Host reason;
- missing with an official target → the Host-offered target (masked spec +
  version); Install remains the only path;
- missing without a target → install unavailable;
- show `Version difference` only when both versions are known and differ; never
  claim "latest"; an unreadable current version is `unavailable`.

The guidance never dispatches a mutation and never echoes full userinfo/tokens.

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

Attachment completion and intake are Client-local:

- `/attach` and `/image` carry path-argument completion backed by
  `suggestPathArgument(argument, clientCwd)`. An unscoped term uses
  finder-first discovery with a bounded recursive fallback; a scoped empty term
  lists that directory's children; a scoped non-empty term constrains the
  search; Windows drive/UNC tokens keep their own dialect.
- Tab on an empty argument is a file-completion site only for commands that
  declare path-argument completion; accepting a directory reopens its children.
  The Client cwd is read at call time and stays independent of the Session/Host
  cwd. `@` whole-tree search remains Host-scoped. An UNCLOSED quoted argument
  completes inside the quotes (a quoted name may contain spaces); a CLOSED
  quote is treated as a complete token and does not complete. An accepted
  DIRECTORY keeps its quote open so the next completion continues in the same
  token, while an accepted FILE closes it.
- The attachment path token's boundary is ONE shared grammar, the same in every
  renderer: an unquoted word ends at an ASCII space or tab, a CR or an LF ends it
  in either form (an open quoted token never reaches across a line for its
  partner), and a Unicode whitespace such as U+3000 stays ordinary filename
  content. A line break may really sit inside a line — one renderer inserts a
  bracketed paste verbatim, another normalizes CR to LF before this grammar ever
  sees it — and an accept replaces a fragment of ONE logical line, leaving that
  break and every later line byte-for-byte untouched.
- `/attach` and `/image` are ALSO inline attachment sites: the
  FIRST logical line's leading command token stays the leading command seat
  above, while a declared attachment command token at any other cursor position
  (mid-body prose, or a later line's leading token) opens the same inline
  `/name` dropdown with two fixed actions (`Insert local image`, `Attach local
  file or image`) and then the SAME Client-local path candidates. Accepting a
  DIRECTORY only continues that path seat. Accepting a FILE replaces exactly
  the accepted inline fragment with the canonical placeholder through one real
  undoable edit of the live draft and never submits, queues or steers it;
  `weird/image`, URLs, `/usr/bin` and ordinary paths are never such a site. The
  intake is the same one `/attach <path>` uses (one read, the existing draft
  stores, no second draft copy); the inline route differs only in its commit
  target. Every confirm gesture (Tab, Enter, mouse click and the single-candidate
  Tab shortcut) is accept-only there because those rows bind no leading-command
  prefix, and the acceptance is honored only while the accepted request's strict
  snapshot, the accepting row's own identity, the live editor document/cursor,
  the seat and the surface generation all still match.
  Ownership is proven BEFORE the write; the notice reports the write. A
  successful placeholder replacement is exactly what makes the accepted draft
  snapshot no longer describe the draft, so the `attached … — Enter to send`
  success notice is gated on the intake's Session OWNER and on the commit
  actually returning `true` — never on the pre-commit snapshot (that would
  swallow every real success) and never after a refused commit (a rolled-back
  item announces nothing).
- `/attach <path>` is the canonical Client intake. Images go through the image
  pipeline; other regular files stage as metadata-only drafts. On the Direct
  backend a submission streams the draft through the in-process
  `ctx.attachments.saveFileStream()`; on the Remote backend the same Client-local
  stream is uploaded through the official authenticated raw file route, whose
  Host `FileUploads` authority stores the bytes and returns a Session-scoped
  receipt. The Remote prompt carries that receipt, and the pending-submission
  echo uses the Host-issued file metadata — never a local name/size guess. The
  Client-local path never becomes a Host file reference in either backend.
  `/image` stays image-only compatibility. Neither reads the file eagerly or
  routes through the Host filesystem.
- A generic-file submission is bound to the attach-time local source identity:
  the file is streamed at submit time, and a source that was deleted, replaced
  (including a FIFO), or changed (size/mtime/inode) is refused before any Host
  prompt. A Remote upload that completed does not by itself mean the Host
  accepted the prompt; only Host prompt acceptance, its durable history or an
  Inbox row carrying the same request carries that fact. A failure before the
  prompt is dispatched restores the same draft and never retries or reuses a
  staged receipt. A durable generic file recalled from the Host queue
  (`Alt+Up`) has no official Client carrier to re-bind a receipt on EITHER
  backend: the gesture refuses the whole recall before staging any draft or
  removing any queue occurrence and keeps the queue and editor unchanged; the
  user removes the file-bearing occurrence through `/queue` and recalls again.
  This is a shared semantic boundary, not a transport capability difference and
  not a claim of full file parity.
- The attachment intake and the Ctrl+V paste intent share ONE active composer
  and the existing draft stores; there is no second draft copy. `/attach` and
  `/image` read the current draft and insert the canonical placeholder through
  the mounted composer of the active renderer, and announce success only AFTER
  that intake succeeded and the placeholder inserted — for an image that means
  its bytes were read, for a generic regular file that means the metadata draft
  exists (only a bounded signature prefix was inspected; the content streams at
  submit time, see above); with no mounted composer — or with the renderer's own
  builtin admission refusing the command — they fail instead of staging. A
  pending intake never writes a replaced composer seat or a newer ownership
  generation/session; its late outcomes are published only
  while both its own seat and its session are still current, and the explicit
  session-changed/transition refusal is published only while its own seat is
  still current (it exists precisely because the session moved). On a renderer
  without a command card the synchronous `CommandResult.error` of these commands
  keeps its one result-notice owner; that scope never publishes a success, so
  the async intake's single message stays with the composer. Clipboard intents
  are queued as ONE per-surface FIFO of accepted triggers: each accepted trigger
  probes the OS clipboard at most once, a later trigger's probe starts only
  after the previous one settled (read + commit or failure), and a failed intent
  never blocks the following one. Paste text inserts at the live caret and never
  submits; an empty or unsupported clipboard is not an error, and an
  unreferenced-draft prune runs against the live draft before a new image is
  staged. The platform probe, deployment image policy, Host attachment
  admission and Direct/Remote submission paths stay their own authorities.
- A REAL terminal bracketed paste whose complete body is one absolute image file
  path plus the terminal's single trailing ASCII space is a THIRD intake source,
  distinct from `/attach`/`/image` and from the Ctrl+V OS-clipboard probe: the
  pasted path first appears as ordinary editable text, the asynchronous read
  stages the image in the SAME draft store, and the ONE proven paste span (never
  an `indexOf` match) is replaced with the canonical placeholder through one
  real undoable edit. The candidate grammar is strict — absolute POSIX, no
  control characters, one trailing space, a case-insensitive
  png/jpg/jpeg/webp/gif extension — while the file content remains the MIME,
  size and dimension authority. Until the read settles, every submit/queue/steer
  path refuses BEFORE clearing the draft or its Undo history and asks for a
  retry; a failed read keeps the path text and reports the basename. Only the
  default host composer and the TSP composer claim it: plugin replacement
  editors and shell-mode pastes keep their raw paste semantics, and a non-image
  paste is inert.
- The attachment marker is always `🖼️ ` (U+1F5BC + U+FE0F + space), so its
  visible width is three cells; a font without an emoji face may show a gap
  (accepted).
- Mixed user messages keep an inline `🖼️ name` / `📄 name` placeholder in the
  flat text and bubble, with thumbnails in block order. The placeholder text is
  a DISPLAY projection only; source content blocks are untouched
  ([terminal-output.md](./terminal-output.md)).
- Fullscreen-only attachment collapse: the info bar
  `🖼️ name · W×H · bytes` is constant in every state; only image rows come and
  go. Hit-testing covers only collapsible user/assistant thumbnails, re-measures
  the row map before resolving, and attachment rows win over the message-card
  toggle. A session switch clears the collapse set. Re-expanding re-uploads the
  base64 (accepted cost).
- Composer draft images have a live, bounded preview band between the plugin
  widget zone and the editor seat on both roots. It is a READ-ONLY projection
  of the **expanded composer draft** (`getDraft()`/`getExpandedText()`, the
  same text submission uses) and the live `DraftImageStore`, so its occurrence
  count and identities agree with the images that would be sent. The source
  capability exposes only `values()`; the preview never stages a second
  attachment, removes by id or reorders the draft. The store owns every staged
  byte and every budget; the existing unreferenced-draft cleanup is a separate
  runtime-owned path.
- The band shows exactly ONE card for the **LAST referenced occurrence** in
  the draft, so a newly pasted image is immediately visible. The identity row
  is painted first: `🖼️ #<draftId>/<totalOccurrences> · W×H · bytes`, then the
  remaining-occurrence count and, fullscreen only, an ASCII `x` removal
  control at the far right. The image is fit to at most **44×3** at >=70
  columns and **22×3** at 50–69; the identity row plus image rows never exceed
  four rows. Under 50 columns or with a 1–3 row grant the band degrades to a
  one-line count/latest-identity summary with no pixel card and no removal
  control; with no safe space it paints zero rows. The line/total identity
  uses the canonical `🖼️ ` marker (VS16). Pixel rendering uses raw PNG on
  Kitty, the original format on iTerm2, and — on Kitty — a bounded
  ASYNCHRONOUS PNG derivative of a local JPEG/WebP draft, all within the
  existing 4 MiB staged-source cap. That derivative is the SAME Client-local
  decoder the transcript uses (first frame only, EXIF orientation applied,
  fitted inside 768×768 without enlargement). The identity row, the `x` hit
  and the submitted bytes keep the ORIGINAL draft dimensions, media type and
  encoded bytes; while the derivative is pending the card paints the original
  identity plus `…`, and only an admission or decoder failure shows
  `Preview unavailable`. The derived state belongs to the ONE last-visible
  card of the mounted component (at most one running conversion) and is
  retired on a card switch, session switch, invalidation or dispose: a late
  result never repaints another card or a destroyed surface, and an
  Undo-restored draft is re-derived on the next visible paint. Unsupported/
  oversized/empty/recalled drafts and GIFs paint the real MIME, name,
  dimensions and `Preview unavailable` in the **card identity row**. The
  one-line summary fallback paints only the occurrence count plus the latest
  `#id W×H`, never a pixel claim. The band reads no new file, never reads a
  recalled durable ref and registers no global decoder or pixel cache. Its row
  grant participates in the unified fullscreen pinned-chrome/footer/widget
  budget; the widget/footer reservation is bounded to avoid a feedback cycle
  and may under-grant, never overflow.
- The fullscreen `x` control edits exactly ONE canonical placeholder occurrence
  in the **visible editor text** (removing at most one adjacent separator
  space), preserves the cursor's relative position, paste markers and mode.
  It deliberately does NOT prune the removed draft: the editor undo history
  can restore the canonical placeholder from an older snapshot. The removal is
  itself a REAL undoable editor edit (the pre-removal document is recorded), so
  Undo restores exactly the removed occurrence; it is never a silent
  programmatic text replacement. Staged bytes
  are protected by the `DraftImageStore`'s idempotent `(editor owner, image id)`
  undo leases: the host fork Editor exposes the canonical placeholders its real
  Undo snapshots still reference, and the surface reconciles the leases after
  every host-editor mutation (typing, paste, Undo, programmatic restore) and
  after a preview removal. Repeated `x → Undo → x` therefore cannot multiply a
  lease. When the editor's undo history is really retired (a submitted-draft
  clear), the store releases that owner's leases immediately — backend
  acceptance, working state and turn identity are not part of the undo
  lifetime. A session switch does not retire the host undo history, so
  undo-referenced bytes survive it, and the retained PiTui editor draft keeps
  every image it still references; dispose drops every lease.
- The undo-retention budget (8 images / 32 MiB, separate from the active
  16 / 64 MiB draft caps) applies only to images that are undo-leased and no
  longer referenced by the live **expanded** draft; an image Undo restored into
  the draft is an ACTIVE attachment again. Active admission never evicts
  retention-only bytes to make room. When the budget is exceeded, the oldest
  evictable retention-only image is retired: the REGISTERED OWNER's editor
  trims the placeholder from the undo snapshots that could restore it (the
  rest of those snapshots, including newer still-retained images, stays
  undoable) and only then do its bytes leave the store. Live occurrences and
  in-flight submission pins are never evicted; when every candidate is
  protected the budget may temporarily exceed its cap and re-converges later.
- A Composer submit takes a SCOPED bridge reservation of the submitted images
  BEFORE the clear (the fork's `onBeforeSubmitClear`, which returns a one-shot
  release) and releases it in a `finally` after the synchronous submit
  dispatch — for Enter, Ctrl+Enter, plugin submits and Ctrl+S steer alike. The
  existing business owner (`pinDraftAttachments`/`runReservedSubmit`, the
  HostCommand fallback) takes its own attachment reservation synchronously
  inside that dispatch, so the clear can never strand images that are part of
  the outgoing message and no bridge outlives the call stack. These clears
  retire the editor's undo history, so a delivered message — and the image
  bytes its successful write consumed — cannot be resurrected by Undo; a
  failed submission restores the draft before its reservation releases. Local
  commands, early refusals and empty submits acquire no long-lived reservation.
- The `x` control is offered only when the current seat editor exposes the
  narrow Undo-retirement seam; a Replacement Editor without it still renders
  the preview but has no safe removal control. A Replacement Editor without a
  real undo-retiring clear falls back to a plain text clear (which pushes
  undo), so the host editor's leases stay and a handoff back to the host seat
  can still undo the placeholder with real bytes. A rejected submission
  restores the draft before its business reservation releases, so a restored
  placeholder never becomes dead text. A successful removal also resets the
  fork's multi-click selection history, so an immediate second x after undo is
  a fresh click rather than a swallowed double-click. Undo (the editor's
  `tui.editor.undo`) therefore restores a live image, never a token that
  renders as text. An occurrence
  that exists only inside a large-paste marker is shown by the expanded
  projection but has NO removal control: the editor text cannot address it
  safely, and its draft (and any in-flight pin) must survive. When the
  previewed last occurrence shares an image id with an earlier hidden
  occurrence, it still gets a control only when the raw text after the raw
  last occurrence is a marker-free literal identical to the expanded suffix
  after the previewed occurrence; that proves no hidden content follows it and
  it maps to the raw last occurrence. Otherwise the control is suppressed.
  Regular mode has no fake mouse control: the user deletes the canonical
  placeholder text. The preview is display-only and never changes submission
  semantics. Its Image/base64 caches are short-lived: pruned to the
  currently displayed card on render and released on session switch/dispose.

Authority: `src/commands.ts` (`PATH_ARGUMENT_COMMANDS`),
`src/tui/file-completion/path-argument.ts`,
`src/tui/interaction/autocomplete/provider.ts`,
`src/tui/interaction/autocomplete/installed-provider.ts`,
`src/domain/transcript/content-blocks.ts`,
`src/tui/components/media/image-thumbnail.ts`,
`src/tui/components/media/draft-image-preview.ts`,
`src/client/media/image/placeholder.ts`,
`src/client/media/image/draft-store.ts`,
`src/client/media/image/types.ts`,
`src/app/submission/composer-port.ts`,
`src/app/surface/application-events.ts`,
`src/tui/commands/artifacts.ts`,
`src/app/command/tsp-capability.ts`,
`src/app/submission/submit-flow.ts`.

### Input completion seat

The candidate list has ONE source and ONE composition. The single catalog commit
point in `src/commands.ts` publishes the effective display catalog (Host rows,
Client registrations and merged extension contributions) together with the
collision and Host-claims bookkeeping, and that same install reaches the mounted
renderer by renderer kind: PiTui through the editor's installed autocomplete
provider, a renderer without a PiTui editor through the mount's command-completion
install port, which only forwards. Both compose their provider from
`createInstalledAutocompleteProvider`, so there is never a second catalog,
resolver, claims map or ranking implementation.

- A candidate row is a display fact only. Screening happens once, at that commit
  point, by real source provenance: a genuine Host-origin winner keeps its row and
  is never screened by renderer capability; a live dynamic Skill wrapper keeps its
  row; a row proven to be this surface's own TUI registration is offered only
  while the mounted renderer can run that command family, read from the mounted
  presenters at each commit (never a version or a name guess), and it never falls
  through to a same-name extension contribution; every other admitted row stays
  visible. A failed synthesis (a name collision) withdraws ALL displayed
  candidates while the Host input claims stay live.
- A bare `/name` candidate carries no argument, so a builtin whose bare form needs
  UI the renderer lacks is not offered. Offering a row is never an execution claim:
  submitting the original text still runs the unchanged gate and refusal.
- The renderer's own seat (`src/tui/tsp/input-completion.ts`) opens a list at
  exactly the positions the SHARED classifier already recognizes, and classifies
  nothing itself: the FIRST logical line's leading command token with no space
  before the caret is the command seat; an `@` token at a real boundary is the Host
  mention seat; a declared file-argument command (`/attach`, `/image`) is the
  Client-local path seat, and its own `leading` fact separates the legacy first-line
  argument seat from the inline body seat; a `/name` token at any other position is
  the inline seat the two fixed attachment actions share with the skill lexicon. A
  literal `!`/`!!` shell line, an email, `pkg@1.0.0`, a URL, a bare `./path` or
  ordinary prose open nothing, and the seat never asks a plugin about a position it
  did not admit. Which of those positions exists at all is the classifier's
  contract (`## Attachments and input completion` above and
  `## Session \`@\` completion routing` below), not a second rule invented per
  renderer.
- Sources never substitute for each other. A Host mention answers ONLY from
  `HostFilePort` under the current completion scope; an authoritative empty or
  `unavailable` answer opens no Client-local listing, is never re-scanned locally
  and is never presented as "the file does not exist" (see
  `docs/architecture/host-client.md`). A Client-local path argument answers ONLY
  from the local cwd and never queries the Host port; `/image @foo` is a local
  argument, not a mention. A text `/name` row — including one a plugin forged with
  attachment-shaped fields — never grants a read, because the shared provider's own
  strict request snapshot and row identity are the permission. A failed COMMAND
  catalog blocks only the command seat: a withdrawn catalog says nothing about the
  Host or local file sources.
- Accepting a candidate is a Composer edit, not a submission: the shared provider
  computes the replacement and the renderer's composer applies it as one
  conditional atomic write that keeps the text before and after the admitted token
  and parks the caret where the provider landed it — never at the end of the
  draft, which is what a whole-document draft write does. The span an accept may
  rewrite is the token the ORIGINAL classifier named for that seat (the `@` token,
  the argument range, the inline `/name` token plus whatever its own grammar
  consumes right of the caret, the command token), so no answer can move the `@`,
  eat the prose, rewrite the `/image` command token or reach another line; an
  out-of-span answer writes nothing. Only a later, separate submit gesture reaches
  the submission controller. The write is refused as a whole when the live document
  or caret no longer matches the document the replacement was computed against,
  when the caret is not a grapheme boundary, or when the change is not confined to
  one logical line; a refused completion changes no text, caret, paste lease or
  frame.
- An accepted inline attachment FILE is a two-phase gesture, and the two halves
  have different owners. The provider hands the immutable acceptance to the seat,
  which only STAGES it for that one gesture; the mount settles it through the
  installed command-plane stager — the same `runAttachmentIntake` authority the
  leading `/attach`/`/image` commands use (one Client-local read, the existing
  budget, the existing draft stores, the existing notices) — AFTER the composer's
  own atomic write committed the accepted document and caret. A refused write, a
  stale seat, an uninstalled stager, a moved document or caret, or an edit that
  walked away and back to the same bytes (the composer's edit-revision fence)
  produce no read, no store mutation, no placeholder and no success notice, and the
  user's own path text stays editable. An accepted ACTION writes `/image `/
  `/attach ` and reopens the same seat's path candidates; an accepted DIRECTORY
  continues the path seat; neither reads anything. The canonical placeholder
  replaces exactly the accepted fragment through one atomic composer edit that
  preserves every other paste lease, and the intake's session-scope and transition
  fences stay the command plane's. The leading argument seat never stages on an
  accept: the command handler still runs on the NEXT explicit submit.
- Any currentness loss ends the browse without touching the draft: a new catalog
  commit, a formal completion-scope change, a cleared draft, a Session
  publication, a hydration window, a disposed renderer, or a higher input seat
  taking the keys. A late answer and a click on an older frame's row are dropped on
  the same fence.
- While the list is open it owns ↑/↓, Tab/Shift+Tab, plain Enter and Escape:
  Escape closes only the list, and a modified or otherwise unconsumed key retires
  the list first and then reaches its existing owner exactly once — so a visible
  list can never turn Cancel into a no-op, and a no-op key can never leave a
  dismissed list painted. Plain Enter ACCEPTS and is never a submit, with ONE
  exception: when the first logical line's WHOLE command token already names the
  highlighted candidate and the caret sits at that token's end, there is nothing
  left to complete and Enter stays the submission gesture it has always been. For
  every other seat an Enter that cannot complete is still consumed, so a mention, a
  path, an action or a skill never executes or sends on the accept gesture. With
  the list closed the Composer's own arrows keep their existing meaning, including
  the input-history recall browse.

Authority: `src/commands.ts`,
`src/tui/interaction/autocomplete/installed-provider.ts`,
`src/tui/tsp/input-completion.ts`, `src/tui/tsp/editor.ts`,
`src/tui/tsp/session.ts`, `src/tui/commands/artifacts.ts`,
`src/app/command/tsp-capability.ts`, `src/app/surface/runtime.ts`,
`src/runtime/host-file-port.ts`.


## Session `@` completion routing

The Session `@` scope has ONE frozen Host-side router, used by BOTH backends:

```text
bare workspace fuzzy search   -> official ctx.fileReferences
  @foo @readme @src @.env         (workspace index, cache, exclusions, scoring,
                                   maxResults stay authoritative)

explicit path navigation      -> dsh-pi-tui Host scoped discovery
  @src/ @./ @../x @/abs @~/x      (the exact scope the user typed)
  Windows drive/UNC paths
```

The route is decided by the TOKEN's own shape (any separator, a root form, or a
Windows drive/UNC path), never by resolved workspace containment, official
result count or filesystem existence. The official provider is called ONLY on
the bare route; an authoritative official empty result stays empty and never
falls back to the scanner. The scoped route never calls the official provider,
so explicitly named excluded directories, symlink scopes, parent and absolute
paths all work; the accepted candidate is materialized as an absolute Host path,
and ranking scores the SCOPE-RELATIVE candidate (the home prefix never
fabricates matches).

- POSIX boundary: on a POSIX Host a backslash is an ordinary filename character,
  but the reused path resolver selects its Windows dialect from the token alone
  and normalizes separators. An ambiguous POSIX token containing a backslash
  (`foo\bar`, `dir\name/foo`) therefore stays with the official provider
  instead of being searched in a normalized (different) directory. This is a
  deliberate fail-closed narrowing until the shared resolver distinguishes host
  dialect, token dialect and literal backslashes.
- Parent-traversal spelling: on a POSIX Host the filesystem backend anchors a
  path containing a `..` segment with its PHYSICAL spelling (raw
  `<anchor>/<path>` concatenation, so an intermediate symlink is resolved by
  the kernel before the parent step) and resolves other paths lexically. The
  scoped search tests the whole anchored spelling and keeps the raw
  concatenation when required; the Direct discovery driver joins its base
  without re-normalizing, so completion and the model's read cannot land in two
  different physical directories. A home shorthand emits an absolute normalized
  value; the bare `~`/`~/` root form uses the raw `homedir()` spelling.
- Direct and Remote share this authority: the Direct adapter reaches it
  in-process; the Remote Client reaches the SAME router through the private
  `piTuiFileReferences` endpoint (the official `fileReferences` namespace stays
  mounted and authoritative for bare queries). The custom endpoint AUGMENTS the
  official provider; it does not replace it. Bare-query ranking, result bound,
  exclusion policy, implicit hidden matching and cache/invalidation remain
  official behavior.

Authority: `src/runtime/direct/file-completion/host-discovery.ts`,
`src/app/host/features/file-reference.ts` and the private
`piTuiFileReferences` contract. Proof: `test/client/host-file-port.test.ts`,
`test/runtime/remote/remote-host-file-port.test.ts`.

## `!` / `!!` shell input

`!` and `!!` are EDITOR STATE, not document text. Three modes (`prompt`,
`shell-context`, `shell-local`) hold a bare command body and serialize back to
`!`/`!!` only at Host boundaries.

- Empty-body transitions: `!` → shell-context; `!` again → shell-local;
  Backspace steps back; Esc cancels (autocomplete Esc first).
- A `!` after body text is literal; in shell-local an empty-body `!` is literal
  body text (there is no fourth mode).
- Bracketed paste normalizes only into an EMPTY prompt.
- Submission (Enter, the accelerated chord, Ctrl+S, a plugin sink, the subagent
  path) serializes and resets to prompt BEFORE dispatch. History stays
  serialized and decodes on recall. Handoffs carry the wire form.
- The prompt glyph is `❯ `, `! ` or `!!` in prompt/shell-mode inks.
- `!` is context-bearing: its completed result is written exactly once to the
  Session that submitted it, by the application's Session-write owner. `!!` is
  session-excluded: it writes no Session event and is never visible to the
  model. Both execute in the Host environment; the execution adapter itself
  never writes Session state.
- `bypass`/`sandbox` are Host execution policies, not machine locality.
  `localShellSandbox` defaults to `bypass`. Direct persists it in the `tui-app`
  settings document; in split-process mode the Host-only profile disables
  `tui-app`, so the `pi-tui-host-runtime` Loader row uses the same Config
  schema as the settings owner and the Remote ConfigPort reads and writes that
  Host descriptor. The Host validates the Client's requested policy against its
  live setting before preparation and again before spawn; a stale or mismatched
  request fails closed. Sandbox mode requires Host enforcement `full` and never
  falls back to bypass.
- One run is a Host-owned ONE-SHOT execution on Direct and Remote alike: both
  policies spawn the raw `['bash', '-c', command]` through the official
  `ctx.subprocess.spawn` seam in the Host workspace/environment and settle once
  with the process's real exit code or terminating signal. `sandbox` first
  resolves the exact live Session's policy, calls the official
  `ctx.sandbox.confine` exactly ONCE before the spawn, requires
  `enforcement: 'full'`, and spawns the EXACT argv that one call returned; a
  composition without the required official capabilities refuses before any
  spawn instead of degrading to bypass. The Client never spawns the command or
  supplies Host environment facts; on the Remote path, the Owner-only Host
  admission requires the exact live Session named by the request, and an unknown
  or mismatched Session fails closed before execution. Direct remains the
  production default and serves this contract in-process; Remote is the
  split-process transport of the same contract.
- Output is collected through the subprocess provider's per-stream collect/spill
  dispositions: each stream keeps a bounded in-memory tail and reports its own
  truncation instead of claiming lossless bytes, and the Host-local spill file —
  when one exists — holds the complete stream (a stream larger than the spill cap
  has no spill file). The managed range is joined before the collected readers
  are read once; there is no incremental stream, acknowledgement window or
  second output owner.
- Sandbox diagnostics follow the official bash-sandbox order: classify an
  OBSERVED runner-fatal from the collected stderr FIRST, even when that stream
  is truncated — a retained tail that positively matches a runner-fatal rule is
  a runner failure, never a denial and never a settled shell result, so it is
  not written to the Session. Only when no runner-fatal is observed does
  truncation decide the remainder: a nonzero exit with truncated stderr is a
  reason-UNKNOWN settlement (a higher-priority runner-fatal line may have been
  dropped), the card preserves the real exit and truncation, asserts no definite
  `sandbox denied`, and states that the failure reason cannot be determined, the
  command may have executed and it must not be retried automatically. A denial
  signature is never asserted while stderr is truncated; only a complete stderr
  may confirm a denial. This reason-unknown is distinct from the transport-level
  UNKNOWN of a lost terminal result. A pre-spawn runner failure remains its own
  failed outcome. A zero exit, a signal kill and a bypass run are outside this
  rule.
- Cancellation aborts the run; the subprocess provider terminates the managed
  process range and the Host joins that range before returning the settled
  result. A run whose terminal result is lost is a transport-level UNKNOWN
  outcome, distinct from the sandbox reason-unknown above: the card states that
  the command may have executed, the run is never replayed, and an unknown
  result is never written to the Session.
- Completion uses one shell grammar over the selected semantic port. Direct keeps its existing `bash -lc` compgen and fork path provider. Remote queries command names, variables, git subcommands and paths on the Host using the live Session's effective cwd and Host environment. A Host refusal never falls back to Client PATH or filesystem. A completion RESULT may not cross a Connection generation: a candidate reply that arrives (or is applied as an asynchronous result) after the Connection generation changed is refused, matching the official Client lifecycle (request abort, menu generation, editor document currentness, plus Host re-validation at execution). Accepting an already-displayed candidate that only edits the user's draft is NOT itself a Connection-generation check; execution admission remains the authority for whether a command runs.
- The user-shell card is one-shot. Every `!`/`!!` gesture freezes a
  Client-local display placement captured synchronously at acceptance; the card
  is a standalone transcript block and is never appended to the live tail by
  later Agent/Tool events. In the folded default it paints at most three
  physical rows: the header/status, the single `$ command` row, and — settled
  only — one authoritative outcome row (an exit/signal/timeout/truncation or
  error fact). A running card paints no output preview. The retained bounded
  streams, their own truncation lines (each naming the Host-local spill file
  when one exists), a definite `sandbox denied` fact only when no
  reason-unknown applies, the reason-unknown notice (`stderr truncated; failure
  reason cannot be determined, command may have executed; do not retry
  automatically`) for a nonzero sandbox run with truncated stderr when no
  runner-fatal was observed, and the real `[exit N]` / `[signal NAME]` /
  `[timed out]` markers stay reachable through the existing card expansion
  (never by reading the spill file). The retained body is bounded; at most 32
  settled cards are kept per mount, evicting the oldest settled card first
  while every running card stays owned by its run. A settled `!!` is a
  Client-local display record: it survives later Enter / Ctrl+S submissions
  and a later `!`; only a real Session switch/hydrate, a TUI remount or Alt+K
  retires it. Alt+K drops settled cards only, never cancels the process (Esc
  owns that) and never deletes Session events. A committed `!` removes exactly
  ITS OWN local card after `SessionWriter` reports committed, leaving every
  other shell card in place; rejected, indeterminate, cancelled or unknown
  outcomes keep their diagnostic card. A retained `!` card additionally carries
  a Client-local Session-submission marker: `not submitted` for a rejected,
  cancelled or pre-dispatch failure, and `submission uncertain` for an
  indeterminate write that must not be retried automatically. The marker is
  visible in the folded outcome row, and the expanded card keeps the concrete
  writer reason without changing the Host execution status (`[ok]`/`[error]`). The Child Viewer never renders the
  main Session's shell cards; they stay owned by the hidden main view and
  return with it, while a real Session replacement clears them.
- The card's placement belongs to the Client-local display policy, not to the
  Session event order: if its source row leaves the current window the card is
  not materialized there, and a card accepted while browsing history is
  anchored once when the latest window first returns — never to the global
  tail and never as a fake Session turn.

Authority: `src/tui/interaction/editor-input-mode.ts`
(`shellPrefixForMode`, `serializeEditorInput`, `editorModeFromHistoryEntry`),
`src/tui/interaction/tui-editor.ts`, `src/client/shell/compgen.ts`,
`src/app/submission/user-shell.ts`, `src/app/config/schema.ts`,
`src/app/host/pi-tui-host-runtime.ts`, `src/runtime/remote/config-remote.ts`,
`src/runtime/host-user-shell-port.ts`,
`src/runtime/host-user-shell-execution.ts`,
`src/runtime/host-shell-completion-port.ts`,
`src/runtime/direct/host-user-shell-direct.ts`,
`src/runtime/direct/host-shell-completion-direct.ts`,
`src/runtime/remote/host-user-shell-remote.ts`,
`src/runtime/remote/host-shell-completion-remote.ts`,
`src/runtime/remote/pi-tui-host-user-shell-host-bridge.ts` and
`src/app/host/features/host-user-shell.ts`.

Must-not: put the prefix in the buffer/cursor math, route a shell line through
slash commands, downgrade sandbox to bypass, call `ctx.sandbox.confine` more than
once, spawn an argv other than the one it returned, skip the official
`ctx.subprocess.spawn` seam, replace the one-shot bounded collect with an
arbitrary-length byte-perfect stream or a custom ACK/backpressure/mux/relay, add
a second file channel, a second process owner, polling/jobs or a public API for
this path, cache a failed compgen run, or let a mode-less plugin seat inject
`prompt` into a Host `!` submit.

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
