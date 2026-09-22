# Surface decisions: plain-exit, semantic pending-input queue pane, credential targets

Small user-visible behaviors that each needed a decision; kept in one doc
so a contributor can find the rationale without reading every file.

## Tool-card rendering follows the Web's render intents end to end

The TUI's tool cards already used the Web's row model
(`toolCardHeader` — design titles, SUMMARY_KEYS summaries, workspace-
relative paths) and the tool-owned render intents for the cards it
handled (`read`, `search`, `terminal`, `diff`). This change closes the
remaining gaps where a card fell back to raw JSON or raw result text:

- **`card: 'web'` result views** (`web_search` / `web_fetch`) now render
  their structured shape — the provider answer and source list (title —
  url, snippet under each) for a search, the URL and HTTP status for a
  fetch — with the same truncation marker placement as Web WebBlock.
  Previously the switch had no `web` case and the card fell through to
  the raw result text.
- **Generic cards with object `rawInput`** render per-tool one-line
  shapes instead of pretty JSON: `todo_write` renders a checklist
  (`●`/`○`/`✓` rows), `terminal_read`/`terminal_send`/`terminal_signal`
  a session target line, `session_event_trace`/`session_event_read` a
  `session_id · seq` line. Unknown objects keep the pretty-JSON fallback
  (the Web's own generic body behavior).
- **Generic cards with `content` blocks** (the plan tools'
  `exit_plan_mode`, plan review) render the content text instead of the
  raw model-facing result. Both the pending call (`presentCall.content`)
  and the completed result (`presentResult.content`) paths honor this.
- **The no-view generic fallback** renders with the Web's `resultText`
  semantics when result blocks are available: text blocks verbatim,
  other block shapes as pretty JSON — instead of the joined raw text
  alone.
- **Folded-card previews** add what the header lacks: `web_search`
  shows the query, `web_fetch` the URL, `skill` the skill name. The
  `todo_write` header itself now reads `2/3 done · first active` instead
  of a raw args dump (Web TodoRow parity), so the folded row does not
  repeat it.

Pure helpers live in `src/present.ts` (`webCardLines`,
`genericRawInputLines`, `resultTextLines`, `foldedCallPreview`,
`summarizeToolArgs`); the render layer in `src/tui-app.ts` owns colors
and layout. Pinned by `test/rendering.test.ts`.

## Plain `exit` quits the TUI

Typing exactly `exit` (trimmed, lowercase) in the editor and pressing Enter
quits the TUI — shell muscle memory. The intercept sits at the very top of
the runner's `dispatchUserInput`, BEFORE session creation and before the
busy-Enter steer gate, so `exit` never births a session and always quits
regardless of the delivery preference. `/exit` remains the command form;
any other prompt (including `exit!` or `Exit`) still goes to the model.

## The queue pane follows semantic pending-input placement

The queue pane consumes the same `PendingInputReader` projection as the shared
runner. It renders every item with `placement === 'queued'`, in projection
order, using only the occurrence id and content. `steering` and `context`
placements remain outside queue gestures. The steer-all hint is shown only
while the active subject reports `running`; idle rows remain visible and say
that they are waiting for the current task to resume. On the main surface,
Alt+Up is a TUI-only recall-all extension: it removes queued occurrences through
`SessionWriter.updateQueue({ kind: 'remove' })` and stages their content in the
editor, rather than performing the official in-place `edit` operation. Direct
inbox collection names and message metadata are adapter-internal; the TUI has
no source-specific notice filter, settlement classifier, or failure-notify side
channel. If a future surface needs to hide a class of messages, that policy
must be represented by a semantic projection available to every backend.

## Pending user input never disappears between the editor and the transcript

The D2.1 follow-up completes the official Client's split between the queue pane
and the conversation tail, and bridges the window where a submission has been
accepted but has no authoritative representation yet:

- **Queue pane** — authoritative `placement === 'queued'` rows plus a
  client-local queued echo (marked `sending…`) until the authoritative
  occurrence with the same `rpcId` arrives. A local-only row is not addressable
  by `updateQueue` (it has no authoritative occurrence id). The `sending…`
  marker is part of the row width budget; an ultra-narrow pane that cannot hold
  the marker plus one text cell drops the marker rather than wrapping it onto a
  detached row.
- **Conversation tail** — an ephemeral steering lane rendered with the same
  user-bubble visual language: authoritative `placement === 'steering'` rows
  and client-local steering/transcript echoes. It is never inserted into
  `TranscriptFolder`, never durable, never searchable, and never in the queue
  pane. It appears while the turn/tool surface (Working, tool cards,
  `job_output`) stays active, and it REMAINS visible after that turn is
  interrupted. Its status line is derived from the subject's activity: an
  AUTHORITATIVE steering occurrence reads `steering…` while running and
  `waiting for next turn…` once its turn is interrupted (the Host keeps it
  parked until the next wake); a client-local steering echo has no Host
  occurrence yet and always keeps `steering…`. The parked row stays visible and
  only the label changes — the occurrence keeps its identity, and a later
  ordinary prompt is what wakes the Agent and consumes it.
- **Context** — `placement === 'context'` has no pending user surface; it
  presents through its normal conversation/context surface once materialized.
- **Identity, never text** — each human submission mints a request id before its
  first async preparation await and persists it as the Direct user-message
  source `rpcId`. Local echoes and authoritative occurrences correlate by that
  id; a local echo is suppressed only while an authoritative counterpart is
  visible, and is retired on the durable `user/message` (or a known terminal
  exit). Because the Host claims a pending occurrence before its asynchronous
  pre-step emits the durable message, the echo is re-presented in that window
  rather than deleted — the accepted content stays continuously visible. Two
  same-text submissions stay two distinct pending rows.
- **One atomic update** — the runner publishes queued rows, steering rows and
  activity in a single `setPendingInputPresentation` call, so a handoff never
  paints an intermediate blank/duplicate frame.
- **Gesture-captured delivery** — a Ctrl+S/steer draft resolves its delivery
  mode at the gesture boundary and uses that SAME mode for both the local echo
  placement and the written prompt, so an agent status flip while the gesture
  waits on the submit FIFO can never make the pending surface disagree with the
  actual delivery.
- **Own pending input is forced visible (runner-owned)** — only a client-LOCAL
  submission echo bound for the transcript lane (steering/transcript) is own
  input. When a NEW such identity appears, the runner returns the subject's
  VIRTUAL transcript window to latest (a reader may have paged into history)
  and scrolls to the tail, so the local echo — and later its durable
  replacement — are actually in the projection and on screen. An authoritative
  steering occurrence produced by another client/background producer is NOT
  own input and never steals the viewport; the authoritative rpc-correlated
  replacement of an existing local echo does not jump a second time (the
  ownership key set is derived from the local ledger, per subject). Keys are
  tracked per subject, so entering/leaving the child viewer neither re-fires
  nor forgets the parent's own input. `TuiApp.setPendingInputPresentation`
  itself is a pure presentation update and never moves the viewport.
- **Local-only queue rows carry no bulk hint** — the steer-all/recall-all
  gestures address only authoritative queued occurrences, so a queue pane
  holding only client-local `sending…` rows hides the hint rather than
  advertising a no-op action; a MIXED pane scopes the hint to the accepted rows
  (`… to steer accepted`) so `sending…` rows are never implied to participate.
  The `sending…` suffix already communicates the state.

Per-occurrence QueueDock controls: the TUI intentionally does NOT expose a
per-occurrence queue action UI. `Alt+Up` is recall-all over authoritative
occurrences and `Ctrl+S` is FIFO steer-all; there is no row selection,
single-row edit/remove/steer, row action button/keybinding, per-row busy state,
edit overlay, selection clamp, or edit-target-disappearance lifecycle. D2.2
still keeps the queue-action SEMANTIC (`SessionWriter.updateQueue` `edit` /
`remove` / `steer`) fully aligned for both Direct and Remote adapters with
adapter tests and same-Host proof. The migration preserves DSH capabilities and
expresses them with a TUI-native surface; it is not a React/Web affordance
clone, so adapter-level `edit` without an edit UI is expected, not a gap.

### Remote presentation keeps exactly one optimistic identity

D2.2 makes the client-local optimistic-echo source a seam
(`src/submission-presentation.ts`): production Direct reads the existing
`PendingSubmissions` ledger; the experimental Remote path reads the official
`SessionSnapshot.pendingSubmissions`. The single join
(`src/pending-presentation.ts`) correlates authoritative occurrences with local
echoes by request/rpc identity only and routes `queued` to the queue pane and
`steering`/`transcript` to the conversation-tail lane; `context` has no pending
user surface. The Remote path therefore never runs a second optimistic ledger
beside the official one, and a steer echo can never render as a queued row.

## D2.3 model / preset / new presentation decisions

These are TUI product decisions expressed through the official DSH Host/Client
semantics converged in D2.3; they are not a Web-affordance clone.

- **`/model` is projection-authoritative.** The current Session value is the
  durable Session model selection (`modelSelection` projection `next`, then
  `lastUsed`), falling back to the Host catalog default only while the Session
  has no selection. The picker renders one Host-generation directory read
  (`session.modelCatalog` semantics) with isolated provider-failure rows. A
  chosen model puts the picker itself into an in-place `Selecting…` state while
  the semantic write settles (a duplicate apply is never a second commit); a
  `rejected`/`cancelled` write walks back to the model list so the picker stays
  usable, while a `committed`/`indeterminate` settle dismisses it. The footer
  model label shows the in-flight selection as `(selecting…)` while the
  authoritative current value stays visible; an `indeterminate` settle never
  paints the requested model and is never retried (the display reconciles from
  the Session projection). `/model` and `/preset` capture their semantic SUBJECT
  once — the Session generation PLUS the exact session identity (including
  `undefined` for a sessionless surface) — and re-fence it after every await and
  before any UI mutation, so a same-generation Session-identity drift is
  `superseded`, not a stale repaint or notice.
- **`/preset` is honest about blankness.** With no Session it stages a
  run-local pending preset for the next fresh Session and never creates one.
  On a blank current Session it dispatches the official blank-Session select
  (`agentPresets.select`), then refreshes the same Session's command/skill
  catalog. Blankness is read from the official turn-boundary projection (the
  same authority the Host re-checks), never from the TUI transcript; an unknown
  blank state opens the picker and lets the Host be the final authority. A
  started Session keeps its recorded preset visible and refuses
  the switch with the Host's `agent-preset/locked` wording — never a false
  switched display. A deployment with `modeSelectionEnabled: false` hides the
  `/preset` affordance from the slash candidates and `/help` (a presentation
  filter only); the handler stays registered and still refuses the selection
  surface, so a typed invocation fails closed identically, and an
  unavailable/unknown roster keeps the affordance rather than infer a policy.
  Failure settlement: `rejected` keeps the prior
  preset and shows the reason; `indeterminate` claims neither the old nor the
  requested preset and is never retried.
- **`/new` rides guaranteed-fresh create.** The TUI owns this transition, so
  an explicit preset intent is carried by the create operation itself
  (creation-time atomicity); the TUI never emulates `create()` then
  `agentPresets.select()`. The old Session stays current and its draft/command
  context stays usable until the create commits; a pre-publication refusal
  leaves it untouched, and an ambiguous/post-publication failure is never
  reported as "the Session was never created" and is never blind-retried.
- **Sessionless `/model` is a global-default intent.** It is persisted as the
  Host global default (never smuggled into `session.create`); the pick AWAITS
  that write so it reports a truthful settlement (a `rejected`/`cancelled`/
  `unsupported` outcome keeps the picker usable, an `indeterminate` one
  dismisses with the reconcile notice), and an optimistic intent is explicitly
  not a committed save. The sessionless footer marker is DERIVED from the one
  default-intent tracker: `(selecting…)` while the write is in flight, an
  explicit `(unconfirmed)` once it settles `indeterminate`, and cleared only
  when an authoritative Host read reconciles it (the persisted default either
  carries the choice — committed — or proves it did not land; a restored older
  still-pending intent shows `(selecting…)` again). EVERY in-flight default
  write (and its fenced correction) is awaited before a fresh create, so the
  create consumes the settled Host default. A FAILED latest intent is walked
  back in the UI and is NOT seeded into the created Session (v2 §0.8.4): the
  fresh Session runs the actual persisted Host default, never a fabricated
  choice, and the failure cannot leak into a later create.

## /login and /logout resolve credential targets, not just DEEPSEEK_API_KEY

The official deepseek adapter authenticates through `DEEPSEEK_API_KEY`;
the llm-pi-ai adapter (a multi-provider seam) declares one route per
provider, each carrying its own `apiKeyEnv` credential ref in the
`llm-pi-ai` settings section (`providers.<route>.apiKeyEnv`). /login and
/logout resolve their argument against the MERGED credential catalog: the
llm configurable-provider directory (`ctx.llm.listConfigurableProviders()` —
every installed pi-ai catalog route, dormant or not, plus hand-declared
profiles) overlaid on the settings section. A route with a stored profile
carries its `apiKeyEnv`; a route without one falls back to the conventional
derived reference (`<ROUTE>_API_KEY`, the web Models page derivation). The
set is deduped by ref, deepseek official first. The settings-only read is
the fallback when the llm service is absent.

- no argument → a searchable picker grouped by configured / available ·
  catalog / custom (the fork's SelectList renders the group headers from
  the `group` field — never synthetic selectable header rows), with an
  `[ Add New Platform ]` action row last, then the key-entry question;
- an argument matching a route name (or its first word, so `/login
  deepseek` reaches the official entry) → that route's `apiKeyEnv`;
- an env-var-looking argument (`OPENAI_API_KEY`, `MY_CUSTOM_KEY`) → used
  verbatim, uppercased when typed lowercase (the original escape hatch —
  `/login my_custom_key` sets `MY_CUSTOM_KEY` exactly like the old
  `.toUpperCase()` did). The typed name is NEVER re-derived through
  `deriveKeyRef` — that would silently corrupt the target into
  `MY_CUSTOM_KEY_API_KEY` (a wrong-ref regression, guarded by a test);
- a valid route pattern that names NO catalog entry (e.g.
  `/login acme-gateway`) → the add-provider wizard with the route
  pre-filled: wire protocol, base URL, display name, API key, then
  `llm.discoverModels` probes the endpoint for its advertised models
  (failure falls back to hand entry; at least one model is required), and
  the profile persists through `settings.mutate` + the credential. The
  base URL and models are required ONLY for hand-declared routes — a
  catalog route has both from the installed catalog, so `/login
  anthropic` still just asks for the key. `apiKeyEnv` is written into the
  profile only when a key was stored (web parity: a keyless route keeps
  provider-native auth). The profile write and the key write are reported
  separately, so a persisted profile with a failed key write says
  "provider added, but storing the key failed" instead of claiming the
  whole add failed;
- anything else → an error listing the valid options.

Without the settings service (or the llm-pi-ai section) the option set
degrades to the official target only, preserving the old behavior.

The `/login`/`/logout` surface refreshes the footer model row and the
welcome card on `llm/adapters-updated`, `settings/document-updated`
(llm-pi-ai/llm-deepseek namespaces only) and the credential events
(`credentials/reference-updated` and `credentials/record-updated` — the
0.1.1-rc.1 split of the old `credentials/updated`), so a provider added
here — or edited externally in `settings.yaml` / `.credentials.yaml` —
shows up without a restart. `/login` supports both CredentialRef
(API-key) and CredentialKey authorization-flow targets.

Resolution helpers: `src/provider-catalog.ts` (`providerOptionsFor`,
`credentialOptionsFor`, `resolveCredentialArg`, `deriveKeyRef`,
`ROUTE_PATTERN`), pinned by `test/provider-catalog.test.ts` and
`test/login-credentials.test.ts`.

## The subagent viewer is mode-aware: continuable = interactive, one-shot = read-only

The child viewer's interactivity is keyed SOLELY to the catalog mode carried
through the whole chain (`SubagentListEntry.mode` → `TaskBrowserRow.mode` →
`SubagentViewerTarget.mode`), never guessed from running/inactive state, and
never re-derived inside the viewer. A `continuable` viewer's editor is LIVE:
Enter and the accelerated steer gesture resolve queue/steer delivery against
the child's running state and `busyEnter` policy, then call the OFFICIAL
`ctx.subagents.prompt({ requestId, parentSessionId, childSessionId,
mode: 'continuable', delivery, content }, signal)` control API
(DSH 0.1.2-alpha.4) —
user provenance, with queue or steer delivery; parent authority is validated by
the Host itself. An empty accelerated submit is the separate child-scoped
`queued`-occurrence steer-all and never calls this prompt API. Decisions a
future change must not silently reverse:

- **The viewer editor is a PLAIN text editor.** Everything typed — including
  lines that start with `/` — is delivered to the child as text; slash
  commands are NOT executed against the parent, and the child gets no
  command-execution wire. The accelerated Ctrl+S gesture is intercepted and
  submitted to the child; parent-only actions (Ctrl+Enter explicit queue,
  Alt+↑ recall-all, Shift+Tab permission, Ctrl+F/Ctrl+Shift+F main
  search, keyboard exit bindings (same-key confirmation; Ctrl+C clears the
  draft first, default Ctrl+D is editor-owned when content is present, custom
  keys preserve it), ↓ task browser, Ctrl+G external editor, Ctrl+V image
  intake) are consumed by the host BEFORE the ladder reaches the editor, so
  the viewer can never act on the parent session.
- **Non-empty viewer prompt writes have exactly one path**: the runner's `onSubagentSubmit` →
  `submitSubagentPrompt` (src/subagent-viewer-submit.ts) → the official
  `ctx.subagents.prompt`. Never `ctx.subagents.sendMessage(...)` (that is
  the Agent-authored Steer path — a human prompt must queue as its own
  turn), never `ctx.agents.get(childId).followup(...)` (bypasses the
  continuation manager / cold resume / direct-parent authority), never the
  parent's submit/steer/queue path. The caller-minted `requestId` (one
  UUID per human submit) is persisted on the accepted message; failures
  classify through the official RemoteError vocabulary
  (`subagent/parent-unavailable`, `subagent/not-resumable`,
  `subagent/unauthorized`, `subagent/delivery-unavailable`,
  `gateway/cancelled`, …).
- **Child queue occurrence access is separately fenced.** Reader and queue
  mutation calls may use only the exact live Agent mounted by the current
  interactive direct-child continuable viewer, with the pinned direct parent
  and registry identity still matching. This queue-only resolver never grants
  ordinary child prompt authority; non-empty prompts remain parent-authorized
  through `SubagentPort`. The current TUI viewer exposes the child queue rows
  and Ctrl+S steer-all subset; selectable edit/remove controls remain a later
  UI slice, and Alt+Up recall-all stays disabled in viewers.
- **Viewer submissions never enter the shared editor history.** An ↑ recall
  in the MAIN editor must not resend a child-scoped follow-up to the
  parent. The fork editor's own per-editor recall is untouched.
- **Failed deliveries restore into the child's OWN draft slot**, merged
  below anything the user typed meanwhile (`mergeDraft` semantics), and a
  send that outlives a viewer switch/close restores into the OLD child's
  slot via `restoreSubagentDraft` — the current surface is never polluted
  (the TuiApp viewer generation is the stale-guard anchor).
- **Transcript rows come only from the child's real session events** — an
  accepted follow-up never inserts a fake user row; the child's own
  `user/message` event lands in the viewer folder through the normal
  folding.
- **Images are out of scope** for viewer follow-ups: the main-session image
  draft store is deliberately never shared with the child (a per-child
  image store is a later milestone).
- **The footer switches to the VIEWED child while a subagent viewer is
  open.** The parent session's status (permission/model/plan/task badges,
  extension footer segments) describes a session the user is not looking
  at, so the runner pushes a `SubagentViewerFooter` (label, mode badge
  `[subagent · continuable]` / `[subagent · one-shot]`, activity, cwd,
  the child's OWN turns/steps and stats line from a per-viewer StatsFolder
  fed only the child's own events) and clears it on exit / session swap.
  The footer is refreshed at step/end and turn/end (never on streaming
  deltas). **Extension footer segments do not render while viewing**:
  viewer mode is host-owned chrome, the extension surface already exposes
  `viewerMode` in its session state, and the first-party builtin's
  turn/step segment would otherwise duplicate the child counters with the
  parent's. Header extension badges keep rendering (they do not conflict
  with the child identity). No extension API changed (additive-only).

## Durable hierarchical task browser

The `/tasks` browser (and the ↓ empty-editor trigger, and the footer badge)
read the DURABLE descendant catalog, not the live-child list:

- **The lineage source is `subagents.listDescendants`**, never a
  re-implemented traversal over session headers, and never `listChildren`
  for the browser (the badge may scope to running descendants of the same
  listing). `parentId` + `depth` ride every row from the catalog facts —
  never guessed from labels or order.
- **Subagent rows keep the DSH stable pre-order VERBATIM.** Activity never
  re-sorts a row above its parent (a running grandchild stays under its
  inactive parent). The "first running subagent" rule is a CURSOR policy
  (`TaskBrowserHandle.setItems(items, preferredValue)`), never a sort.
- **A finished one-shot child stays reachable.** `inactive` is never an
  outcome; Enter opens its persisted transcript read-only. No activity
  filter exists in `buildTaskRows`.
- **Runtime activity is projected, never read from the catalog.**
  `listDescendants().activity` is live-STORE presence, not driver
  activity: an idle continuable child stays live in the session store and
  would otherwise read as `running` forever. Every child row's
  `running` / `inactive` is re-projected from the Agent registry
  (`ctx.agents.get(id)?.status === 'running'`) AT COMMIT TIME by the
  `TaskBrowserRuntime` coordinator (`projectSubagentActivity`), so a slow
  catalog response can never overwrite a newer runtime state. The
  coordinator splits CATALOG refreshes (subagent lifecycle events, the
  subagent tool call, jobs changes — the only paths that re-list) from
  RUNTIME-only refreshes (`agent/status` — the cached catalog is reused,
  membership/tree/mode never move). The runner's `agent/status` handler
  is membership-gated: only flips of children in the cached catalog
  refresh the surface, so the MAIN agent's own per-turn flips never
  repaint. A session switch closes the open browser, clears the badge
  SYNCHRONOUSLY and drops the cached catalog — the old session's running
  badge never hangs on the footer until the new session's first listing
  lands (the fence key = session generation + id; a failed listing never
  leaves a stale badge).
- **Jobs are a separate flat group**, sorted by their own registry
  ordering; the background one-shot duplication (job row + child row with
  no cross-reference) is contract, locked in by test.
- **Viewer authority is a separate `access` dimension** (`ViewerAccess`):
  mode stays the durable semantic; only a depth-1 continuable child is
  interactive from the root. Nested (depth > 1) rows open read-only even
  when continuable, advertised as `<mode> · nested · read-only from this
  parent` (the real mode — continuable or one-shot — is always shown,
  never relabeled). The read-only gate sits in the INPUT ROUTING layer
  (Enter and the plugin submit path hard-reject), not only at send time;
  there is no fallback to the main session as a nested direct parent, and
  no `ctx.agents.get(childId).followup(...)` bypass.
- **The footer badge counts RUNNING descendants at every depth** (the user
  cares that a deep agent is still working), where RUNNING means the
  registry-projected driver state — durable idle children never keep the
  badge armed.
- **`has children` is not rendered.** The tree connector already
  expresses parenthood, so the extra detail line duplicated the
  structure; the `hasChildren` data fact stays on the row for future
  fold/disclosure work.
- **The open browser's FIRST FRAME seeds from the cached catalog.**
  Opening `/tasks` (or the ↓ trigger) paints the coordinator's CURRENT
  state — cached membership + fresh jobs + fresh registry statuses —
  synchronously (no persistence), so the panel never flashes a
  jobs-only list that contradicts the badge, and a failed fresh listing
  cannot leave a panel/badge mismatch. The async membership refresh
  then calibrates in the background.
- **The interrupt verb is advertised AND fired only for a continuable
  row whose driver is running right now** — one predicate
  (`isSubagentRowInterruptible`) gates both the panel hint and the
  runner's execution path, so an idle continuable has no driver to stop
  and the UI never advertises (or fires) a dead stop.

## Output style and Focus policy

`OutputStyleState` is independent of `DisplayState`: `checkpoint` (default),
`concise`, `explanatory`, and `none` control model communication, not transcript
projection. Missing or invalid `outputStyle` settings resolve to `checkpoint`.
The `/settings` row changes the shared runtime state synchronously, then saves
through the existing serialized whole-document ConfigPort write, preserving raw
extension fields. A failed save is reported without undoing the live choice.

Each composed root TUI agent registers `tui:output-style` at order 80, followed
by `tui:focus-mode` at 90 and tool guidance at 100+. The providers read live state
on every assembly; changing either axis does not recompose the agent or change
the other axis. Plain `composeAgent` callers that omit the style state retain
their existing composition. `none` returns an empty style section, not a disabled
base prompt, Focus policy, tool policy, or safety behavior.

Checkpoint updates follow semantic milestones, never mandatory tool-boundary
narration. Concise reduces narration, not correctness or requested detail.
Explanatory adds relevant rationale, not generic verbosity. Focus owns hidden
intermediate text, self-contained questions/approvals, independent background
work, truthful pending-work checkpoints, and the user-needed final visible
message. It does not duplicate those generic communication styles.

Locality is split: preference state and selection are Client-local; persistence
uses `ConfigPort.tuiSettings`, while Direct composition installs the structural
`SystemPromptLike` section in the Host's agent scope. A future wire backend must
round-trip the preference as settings data and install the policy Host-side;
callbacks and the mutable state object never cross the wire. This adds no Remote
RPC or production backend and does not change display defaults.

## Focus fullscreen disclosure

The 2026-08-24 UX plan's Focus click behavior is fullscreen-only:

- **Scroll-intent expand (2026-08-25)**: clicking a collapsed Thought in
  fullscreen expands it and the viewport policy is scroll-intent +
  running-ness — never "expand ⇒ follow the end". A SETTLED (completed) or
  unknown-activity Thought expansion PRESERVES the user's current
  historical position and disables follow-end — a historical Thought has
  no live output to chase. A RUNNING Thought expansion follows the end
  (and keeps following) ONLY when the user was already following live
  output; when the user has scrolled into history the running Thought
  expands in place too. **Collapse anchors the header**: closing the
  Thought scrolls the header back near the top with follow-end disabled,
  so the Thought stays in view.
- **Ctrl+O Expand Recent follows the same scroll-intent rule**: it
  follows the end only when the user was already following AND the
  expanded set contains a running Thought; every other case preserves the
  current viewport. Ctrl+O Collapse All keeps the bulk-collapse anchor
  policy.
- **Nearest-owner click routing**: attachment > secondary > outer Thought
  > ordinary message. A compact secondary card full-reveals on click; an
  expanded secondary's body click folds ONLY that card (the root stays
  open); a NON-secondary process row (intermediate assistant) collapses
  the owner Thought. **Attachment hit areas win first**.
- **Root Collapse All**: clicking the expanded Thought header collapses
  the turn and clears its per-card expansions — reopening shows the
  timeline compact again.
- **The regular surface never gets an ANSI scrollback anchor**: its
  viewport is owned by the terminal emulator / tmux / the SSH chain; the
  TUI does not fight it.
- **Transcript-search jumps keep their own scroll policy**: the search
  caller owns the jump target; the reveal never forces a Thought-header
  anchor.

## Focus V2 compact model (2026-08-24 plan)

- **The whale icon encodes ONLY the disclosure state**: 🐋 collapsed, 🐳
  expanded — every collapsed outcome (running / settled / failed /
  interrupted / blocked / max-tokens) reads the same 🐋, and the header
  label carries the outcome (`Thought`, `Failed after …`, `Interrupted …`,
  `Blocked …`, `Max tokens …`). The old mixed set (◐/▸/▾/⚠/⨯) is gone.
- **Three semantic process slots, decided by the event stream**: Think
  (reasoning-delta), Message (assistant text), Tool (tool/call — ANY
  name, known or custom). Injected context (skill-invocation,
  skill-catalog, system reminders) and lifecycle events (workflow,
  subagent/descriptor, llm/retry) never count as tools.
  (2026-09-22 presentation-convergence addendum v2: the COLLAPSED
  presentation vocabulary is `Think:` + `Action:` and both headers say
  `N actions`. Tool stays the STRICT underlying semantic — a
  subagent/descriptor or llm/retry row still never counts as a tool — but
  those lifecycle rows DO own the collapsed `Action:` slot and DO count as
  their own action subtype (`subagent`, `retry`); workflow rows remain
  neither. The Message/Tool aggregation facts above are the turn-level
  inputs, not the collapsed slot vocabulary — see the collapsed Action slot
  decision below.)
- **Message candidate/confirmed**: streaming text-delta feeds the
  candidate immediately; a later tool/call, step/start or output confirms
  it as an intermediate message; at turn/end the candidate that IS the
  exact final assistant is dropped from the slot (the final renders
  outside the Thought) — an interrupted candidate survives as process
  information.
- **Per-turn token segment** in the header (input + cache read + cache
  write + output, shared StepUsageAccumulator with the footer stats);
  hidden entirely when the provider reports no usage (never `0 tok`).
- **Tool display is presenter-first**: the live tool registry's
  presentCall wins; the static Web row-model header is the replay
  fallback (`skill` maps to the read variant with the `Load skill` title
  on both paths). The fold stores raw call facts only — presentation
  strings never enter the TranscriptFolder.
- **Thinking is disclosure, never visibility (2026-08-25 unified
  model)**: a Thinking block exists whenever the model produced
  reasoning and the current projection contains it — a collapsed Focus
  root hides it (the outer projection gate), every other context keeps
  it. There is exactly ONE Thinking preference, `thinkingExpanded`
  (compact default / full): `Alt+T` bulk-toggles it and clears every
  per-card override first, `/settings` → `Thinking detail` is the same
  state, and neither Focus ON/OFF nor fullscreen ON/OFF nor session
  switches reset it. The old `hideThinking` / `focusThinkingVisible`
  visibility pair is deleted.
- **Focus separates turn foundation from process chronology
  (projection-only)**: a LEADING injected-context prefix that wakes a
  turn is the expanded Thought foundation and renders before the Thought.
  Human user/steer rows and CAUSAL surfaced context are persistent
  boundaries in collapsed Focus, where they remain visible in raw relative
  order. A MID-TURN `form:'notice'` (a background job or subagent settling
  while the Agent already works) is process feedback, not causal input: it is
  hidden inside the collapsed Thought and restored at its exact raw position
  when the Thought opens (2026-09-21 addendum; the decision reads the
  semantic `form` and raw position, never a source kind). A notice inside the
  opening foundation and a mid-turn relay stay visible.
  Expanded Focus preserves process chronology after the foundation: later
  steers and surfaced context return to their real positions and remain
  unmarked as owner-only process content. Searching a hidden mid-turn notice
  surfaces it through a presentation-only temporary reveal (`projectFocus`
  `forcedVisible`) without opening the Thought or writing a manual owner.
  The durable `steer`/source facts are never rewritten, and injected
  context still does not occupy Think/Action/Message slots and never counts
  as a tool.
- **The foundation is identified by a source-derived `context` marker,
  never by bare `kind: 'system'`**: the fold writes `context: true` only
  on injected-context rows (the non-user `user/message` path); llm/retry
  and max-tokens rows are also `kind: 'system'` but are orchestration and
  stay inside the expanded process (owner-marked) and hidden under the
  collapsed Thought. The original leading-`kind` heuristic was falsified
  by the retry-before-any-visible-output case, so the presentation-only
  marker was added to the system row (a plan deviation from
  "projection-only": the marker is not a durable field and no new session
  event, and the icon stays a display field, never a semantic signal).

## Compact Work spans and form-aware Context (2026-09-20 PR3/F4)

- **Compact is a real preset now.** `/display compact`, the `display-preset`
  settings row value, and a persisted `displayPreset: 'compact'` all resolve to
  Compact without a Full fallback. Focus stays the only preset with the
  model-facing behavioral policy; Compact keeps `focusBehavior: false`.
- **Work folds contiguous Process runs, never whole turns.** A maximal run of
  Process-classified rows becomes one presentation-only span whose owner is its
  first member `TranscriptMessage` (the stable disclosure identity). Every
  Conversation/Attention/surfaced-Context/turn boundary ends the run, so
  Assistant intermediate narration stays visible in chronology and the final
  answer keeps its existing ownership.
- **Collapsed Work = Header + Think + Action, never Message.** The Think row is
  the latest reasoning tail (one visual row, following the tail while
  streaming); the Action row is the latest meaningful non-Thinking Process
  evidence (one visual row — see the collapsed Action slot decision below).
  Counts describe the span, not the turn; no fact renders a placeholder
  row; span-local duration is omitted rather than faked from whole-turn timing.
  Expanding the span re-uses the ordinary message renderers for its members.
- **The Work header keeps the plain triangle** (`▸`/`▾`, the
  `section-collapsed`/`section-expanded` semantics in every icon style) — the
  Focus root keeps its whale identity. The Context CLUSTER header composes the
  same disclosure marker with the Context identity icon (`context-generic`:
  `📎` emoji / `⋅` symbols / hidden minimal), so it reads
  `▸ 📎 Context · N injections` under emoji and `▸ Context · N injections` under
  minimal with no dangling separator (`iconLead` supplies each separator only
  when its glyph exists). Activity is plain `▸`/`▾` + its name — the 2026-09-22
  v2 addendum retired the Activity identity icon entirely (see the Activity
  decision below). Both disclosures are click-owned in fullscreen.
- **Post-F6 (2026-09-21 PR B; 2026-09-22 v2 addendum): the visible container
  is `Activity`, with NO identity icon and span-local wall timing.** The
  user-visible name is `Activity`; the internal owner kind stays `work`
  (`TranscriptWorkSpan`), no internal rename. Activity is a frequent
  structural/disclosure container, not a high-priority semantic event, so the
  2026-09-22 presentation-convergence addendum removed the entire
  style-resolved identity mark (`🧰` emoji / `✦` symbols / empty minimal, and
  the `IconSemantic 'work'` registry entry with it): the disclosure marker +
  the name identify it in every style (`▸ Activity` / `▾ Activity`), and the
  Context cluster keeps its own identity icon. The collapsed header follows
  the Focus information hierarchy `<identity> <duration> · <stats>` (duration
  directly beside the identity, never `· 18s`), the `· thinking` marker is
  gone (thinking presence is not a lifecycle state; the Think slot owns the
  content), and the degradation ladder drops the LAST stat first and keeps
  duration with the identity to the end. The header duration is the span's
  OWN wall clock: the fold records a presentation-only `TranscriptTiming`
  sidecar (`SessionEvent.time` only) on thinking/tool/command/retry/
  delegation rows, `summarizeWorkSpan` aggregates earliest-start/latest-end/
  any-running in its existing single walk, running spans re-read `now()` per
  render (the shared repaint heartbeat — no per-card timers), missing
  evidence omits the duration (never `0s`), and read grouping never crosses
  a turn boundary so no Activity span ever inherits another turn's count or
  timing (a group's action cardinality and wall span stay on the turn that
  renders the card). The shared Think/Action/Preparing slot geometry lives
  in `src/compact-process-preview.ts` (one authority for Focus and
  Activity); the Think slot shows the LATEST logical line of the bounded
  reasoning tail in both states (running follows the right edge, settled
  head-truncates).
- **Collapsed Action slot + `actions` header stats (2026-09-22
  presentation-convergence addendum v2): the collapsed process presentation
  uses `Think:` + `Action:`; Focus additionally keeps `Message:` +
  `Error:`, and BOTH headers say `N actions · subtype ×count`.** `Action` is
  the latest meaningful non-Thinking TURN-OWNED Process evidence: genuine Tool,
  Preparing, Subagent delegation, Retry, and explicit
  incomplete-result diagnostics, selected purely by canonical chronology
  (never a per-type priority) among the rows the collapsed surface actually
  hides — Focus derives it from the same transcript rows `projectFocus`
  hides under the collapsed Thought root (never a second `TurnActivity`
  chronology store), Activity derives it in `summarizeWorkSpan`'s single
  member walk. Post-turn replay evidence — a row that materialized after the
  `turn/end` of the turn that OWNS it (only turn-carrying producers can be
  late for a turn) — stays transcript/search evidence but is excluded from the
  Action aggregate/winner, Work membership and read grouping; an idle
  slash command is outside-turn feedback and is never misread as replay. The
  fence and its provenance rule are owned by
  `docs/transcript-display-disclosure.md`.
  The slot is presentation-only: Tool remains a strict
  underlying semantic (`Command`, `Retry`, `Subagent` are never Tools). The
  shared `CompactActionStats` cardinality: a genuine tool contributes its
  `callCount`, a subagent/retry occurrence contributes one action of
  its own subtype (`subagent`, `retry`); an
  orphan result contributes `0 actions` and renders the honest `Unpaired …
  result` diagnostic instead of pretending a missing call existed; a live
  Preparing run temporarily owns the slot but never increments stats (the
  formal call counts once when it materializes). Active surfaced
  interactions (`ask_user_question` / `exit_plan_mode`) remain externally
  owned, never duplicate themselves in Action and never count. Focus and
  Activity share ONE classifier, ONE latest-candidate rule, ONE Action
  formatter and ONE subtype-stat formatter (`compact-process-preview.ts` —
  count-desc/name-asc, max 3 named subtypes, `+N` counts remaining SUBTYPES),
  and their component caches key on bounded Action + ActionStats signatures
  so a synthetic Action repaints even when the turn's tool state is
  unchanged. Focus stats are TURN-level (projected once from the turn group,
  unaffected by search reveals); Activity stats are SPAN-level (its own
  members). Focus keeps its turn-level `tok` segment; Activity
  intentionally NEVER shows tokens — a span has no trustworthy per-span
  usage authority, and unknown is omitted, never allocated or estimated.
  Singleton stats stay visible (`1 action · read ×1`) — no count-sensitive
  presentation branches. Expanded views keep their canonical full-detail
  rows; `Action` exists only in collapsed summary presentation and is never
  a disclosure owner or a search source. A COMMAND row is deliberately never
  an Action and never an Activity member: a command lifecycle is session-level
  standalone evidence — DSH appends `command/run`/`command/done` as direct
  log-only events with **no turn wrapping them**, and the settled result renders
  outside model history — so its card stays a standalone transcript row
  (visible, never folded into a turn's Activity, never claimed by the collapsed
  `Action:`). Its `turn` field is a legacy display-placement artifact, not
  semantic ownership; an authoritative `command` transcript kind is deferred
  follow-up work.
- **One transcript left edge for container chrome (2026-09-22 v2 addendum
  §28; body-indent supplement).**
  The Focus root, Activity, the pending Activity card and the ambient Context
  cluster render their header/body chrome at the transcript content column
  with NO decorative two-cell outer indent, so a collapsed container header
  and its expanded canonical member rows align on one boundary (no
  collapsed/expanded left-edge inversion). `containerPath` stays semantic
  ancestry for disclosure/mouse/search/viewport resolution and NEVER controls
  visual indentation. Genuine internal structure keeps its indentation:
  Thinking bodies, Tool payload/result insets, PTC child/grandchild trees,
  assistant/user wrapped continuations and `Message:` continuation rows. The
  standalone Context cards (notice / relay / recall) apply the same principle
  one level down, at the card: the header stays at the left edge while the
  card's own body is indented 2 cells — the structural contract, its width
  rule and the overflow-safe drop below 3 columns are owned by
  `docs/transcript-display-disclosure.md` (`Card-internal header→body
  layout`).
- **`Ctrl+O` is the ONE regular transcript-detail owner; a disclosure
  CAPABILITY decides what may be collapsed.** On the regular surface the shared
  master (and, when it exists, the effective `app.transcript.toggleExpand` key)
  owns regular Compact Work, Context clusters, ordinary folds and long/pending
  user folds; fullscreen Compact keeps the Work-span bulk and the mouse-owned
  per-card click. When the key is unavailable every one of those folds fails
  open and advertises no hint (the capability is applied where the renderer
  builds the disclosure, so no hidden count/marker is produced). A hidden
  Work/cluster member revealed by search is opened through the ONE container
  reveal path (`searchRevealOwnerFor`) and promoted on an ordinary dismiss.
  The master's DERIVED bulk expansion follows the same `EXPAND_RECENT_TURNS`
  boundary as every ordinary fold (it never computes a separate recent-Work
  window); a non-recent container therefore stays collapsed until the user
  reaches it through search reveal, exactly like a non-recent ordinary fold.
- **Ambient clustering is semantic on every preset and surface; only its
  presentation default is capability-dependent.** With an operable disclosure
  action the regular surface collapses the cluster behind the same
  `▸ 📎 Context · N injections` header as fullscreen (a keyboard master on
  regular, a click on fullscreen); with no operable action it presents the
  members flat. The cluster owner, search path, viewport identity and
  raw-adjacency rule stay cluster-based either way.
- **Nested Focus Work is a real container.** Expanded Focus emits each canonical
  Work span as `[focus-root, work]`: fullscreen defaults it collapsed with a
  mouse-owned header, regular Focus opens it whenever the owning Thought is
  expanded, and search may reveal it temporarily. The generic blank-row rule
  collapses the NEAREST shared container (nested Work beats the outer Thought);
  an explicit root collapse returns that turn's Work owners to the Compact
  default, while a temporary hiding never clears manual Work state.
- **Surfaced Context is form-aware.** The fold retains the producer-declared
  `MessageSource.form` as presentation-only provenance; `notice`, `relay` and
  `recall` become standalone rows (producer summary at normal brightness /
  Agent message with sender and body / Session recall with labels), while
  unknown or absent forms stay a standalone generic Context injection. A relay
  is presented like a message but never reclassified to `user` or `Conversation`.
- **Only raw-adjacent same-turn ambient rows cluster.** Ambient =
  `instructions`/`catalog`/`snapshot`; grouping runs on raw chronology BEFORE
  any Process hiding, so a hidden Tool can never merge two Context rows. The
  cluster summary uses structured labels/forms only and its duplicate
  compression is display-only.
- **Clustering applies to every preset**, and the opening ambient burst (the
  initial user plus immediately following surfaced Context) stays above the
  Focus Thought in both Focus states while a mid-turn burst keeps its
  chronological position.
- **Performance contract**: a stable Work span's live reasoning/tool updates use
  the existing content-refresh path; a boundary change or member add/remove is a
  legitimate structural reprojection; notice/relay rows are render-time
  width-aware (no baked one-line truncation); there is no second renderer,
  search index, or viewport owner.
- **Scope**: PR5/F5 converged Focus-expanded and Full onto the canonical
  structure; PR6/F6 converged disclosure ownership (regular-surface owners,
  nested Work disclosure, search reveal path). Compact is not the default (F7);
  the post-F6 Compact UX/identity review decides whether Work gains an identity
  icon or Compact gains checkpoint narration guidance.

## F4 hardening (2026-09-21 PR4)

PR4 adds no preset, semantic class or disclosure owner; it hardens the shipped
F4 behavior and documents the guarantees in
`docs/transcript-display-disclosure.md`:

- **Malformed / legacy Context never crashes or invents identity.** The fold
  reads the source kind through the single Context parser, so a restored log with
  a `null`/missing/non-object `source` folds as standalone generic Context
  instead of throwing; unknown/future `form` stays generic (never ambient);
  invalid `summary`/`sender`/label values are never fabricated; malformed
  `changes`/`references` arrays degrade to the kind fallback; a legacy
  `session-reference` stays recall.
- **Large-history grouping stays linear.** The active search reveal owner is
  memoized per projection (keyed on target, preset, surface and window
  identities) instead of being re-resolved per row/span, and the parser's
  distinct-label dedup uses a Set. A projection resolves the reveal owner a
  small constant number of times regardless of history size.
- **Streaming/Preparing ownership and search/surface transitions hold** under the
  deterministic race matrices. The live Preparing ownership consumes the SAME
  Work-member boundary authority as the projection, so a settled
  surfaced-interaction card (question / Plan review) closes the trailing run and
  a following live call starts a new pending Work instead of jumping back before
  it (Compact collapsed/expanded and expanded Focus alike). A page/window change
  prunes the Compact Work/cluster owners the new window no longer projects (so an
  A→B→A round-trip cannot resurrect a dropped expansion), and a window never
  invents an off-window member.
- **Width/grapheme robustness** holds for every F4 row family across ASCII, CJK,
  emoji, combining marks, ZWJ emoji and ANSI text.
- **Settled surfaced-interaction cards (question / Plan review) are surfaced
  evidence, not Process.** The authoritative set is exactly
  `ask_user_question` + `exit_plan_mode`; source/tool identity only
  (`kind:'tool'`, a name in the set, not running) — never the title, the result
  wording, a rich card, or a past approval; no fifth semantic class. Compact
  makes them Work boundaries (standalone, never counted/previewed); collapsed
  Focus hoists them out of the Thought (raw relative order, never across the
  committed-answer fence and never reordered against user/steer rows); expanded
  Focus restores their raw position; Full is unchanged. Their own disclosure is
  independent of the Focus root: fullscreen Focus keeps the mouse-owned
  per-card disclosure (collapsed by default; a click toggles only the card) and
  the card is EXEMPT from the root-collapse secondary reset, while regular Focus
  has no per-card owner independent of the root (Ctrl+O drives both the root and
  the tool-detail master) and therefore fails open/full with no fold hint. A
  RUNNING interaction remains owned by its panel (QuestionFlow / plan-mode
  approval) with no duplicate surfaced card. The turn's tool count / tool-type
  stats / collapsed Action slot exclude them, running or settled (the
  presentation-convergence addendum v2 §43 active-interaction exception).
  Every other tool (todo/goal/subagent/workflow/schedule/cordis/bash/edit/…)
  stays ordinary Process.

## F5 projection convergence (2026-09-21 PR5)

PR5 extracts the ONE preset-neutral semantic segmentation and makes Compact,
Full and expanded Focus materialize it instead of each re-deriving boundaries:

- **`transcript-projection.ts` is the canonical authority.**
  `projectTranscriptStructure(raw window)` returns `Message | Work span |
  Context cluster` and reads no preset, surface, Ctrl+O, mouse, search,
  disclosure, viewport or width state. `isTranscriptWorkMember()` is the single
  Work member predicate (the live Preparing ownership consumes it too), and
  `clusterAdjacentAmbientContext()` remains the single raw-adjacency cluster
  authority. The projector is O(n) and references the original
  `TranscriptMessage` objects for owner/member identity.
- **Compact is a materialization adapter.** `projectCompact()` no longer owns any
  segmentation; it only decides collapsed/expanded Work and cluster
  header/flat output. PR4 Compact behavior, owner/member identity and the
  settled-interaction boundary are unchanged.
- **Full materializes the structure flat.** Work expands to its members with no
  Work chrome, the shared cluster presentation obeys the surface capability, and
  the message chronology equals the raw window. Full no longer runs an
  independent `applyContextClusters(raw messages)` semantic path.
- **Expanded Focus consumes the structure for its process tail.** It computes
  the canonical segmentation over the UNFILTERED tail (the held-back final never
  changes raw adjacency), materializes each Work span as a nested
  `[focus-root, work]` container (F6), and keeps the Focus-specific lead
  foundation, committed-answer fence, projected ancestry and final holdback. Its
  cluster presentation obeys the surface capability exactly like Full. Collapsed
  Focus keeps its hoist policy and substitutes the canonical cluster identity in
  Focus-projected order.
- **`displayPolicyFor()` is the runtime authority** for materialization:
  `isFocusDisplayPreset()` delegates to `focusBehavior`, and `projectedBlocks()`
  selects the Compact / Focus / Full materializer from `turnLayer`,
  `processLayer` and `focusBehavior`, so the policy table and the runtime cannot
  drift.
- **Search reveals a canonical container PATH.** Every preset resolves the
  hiding containers through the same neutral ancestry (Focus root via
  `searchTargetTurn()`, nested Work, Context cluster); a flat/fail-open
  container mints no node, a temporary navigation never writes manual state, and
  an ordinary dismiss promotes the necessary nodes atomically. The stable
  ancestry is memoized; the mutable open/hidden state is evaluated per call. No
  new viewport map or wire field is added.

## The composer submission policy is the WEB policy

The busy-Enter preference (`busyEnter`, default `queue`) is owned by the
gesture, not by the command: the boundary applies the WEB
`ComposerSubmissionPolicy.resolve()` contract (baseline
`dsh-v0.1.3-alpha.2`) verbatim and resolves ONCE per submission.

```text
!running              -> queue
gesture === 'enter'   -> the preferred mode (busyEnter)
accelerated           -> the OPPOSITE of the preferred mode
```

The Cmd/Ctrl-accelerated chord (Ctrl+Enter) is therefore "the other
behavior", never a fixed queue: with the DEFAULT `busyEnter=queue` it
STEERS, and under `busyEnter=steer` it queues. The public `queue-draft` /
`submit-draft` extension actions and the replacement editor's
`queue-submit` are EXPLICIT delivery commands, not gestures — they deliver
exactly what they say (the app raises `explicit-queue`). Those two
semantics must never be merged again: a fixed-queue chord gets the default
configuration backwards.

## Skill invocation delivery follows the resolved mode

A human skill invocation (`/skill <name>` or a per-skill wrapper) is an
agent-facing prompt, not a Host command: it follows the resolved mode.
`loadSkill` owns the delivery in BOTH modes — it builds the NORMALIZED
`/<name> <args>` line, steers or queues it, and injects the body whenever
the HOST's `dsh-tool-skill` pre-step listener does not (a composition
without that loader, where the TUI fallback rides next-step). Without the
loader the invocation keeps the order-preserving steer even under a queue
mode: a followup would let the body arrive before the user's words (the
driver claims next-step first) — the documented exception, confined to
compositions without the loader.

The mode is resolved once, at the submitting gesture's own boundary, and
then only executed:

- The dispatch boundary resolves `queue | steer` (the policy above) and
  binds it for the command execution that launches the delivery
  (`withDelivery`). The skill delivery accepts that value; it never
  re-reads `busyEnter` or `agent.status` — a gesture is a property of the
  dispatch that settings cannot reconstruct, and an async draft
  preparation must not let a concurrent settings edit or status change
  re-decide the mode.
- The `/skill` picker (a modal selection with no dispatcher above it) is
  its own boundary, and its SELECTION is the boundary moment: the mode is
  resolved when a row is chosen, never when the modal opened (the agent
  may have gone idle, or busy, while it was up).
- A TUI-owned skill command executed with no submission behind it (the
  command plane driven from outside the submit boundary) has no gesture to
  honor and delivers queued.

## Host commands outrank client contributions

The command surface follows the DSH client contribution contract
(`ui-commands` `CommandUiRuntime.candidates`): the host catalog is merged
with the live CLIENT command contributions by name, and a host/contribution
name collision **fails loud — it never shadows**.

- A LINE the current effective host catalog CLAIMS is a host command: it
  executes through the command plane, and neither a TUI nor an extension
  contribution can remove that claim. The claim belongs to the LINE, not to
  the name — the DSH decision table (`ui-commands` `matchEnter`) claims the
  BARE token of every host command and, for a `leadingInput` descriptor
  (`CommandDescriptor.input !== undefined`: `/goal <objective>`, `/plan`),
  its argued line as well. An argued line of an execute-kind command
  (`/compact now`) is not a command invocation: it is an ordinary submission
  (busy policy included) and the command plane is never asked to run it. A
  claimed command the real session then lacks is consumed by the
  advertised-miss gate — never a plain model message.
- **A contribution is a slash-MENU entry: it claims the BARE token only.**
  Upstream checks a contribution with `if (!bare) return undefined`, so
  `/deploy` runs the client handler while `/deploy explain` is an ordinary
  submission that reaches the model (busy policy and attachments included),
  and the handler never runs for it. A contribution can therefore never be
  invoked with a composer attachment — an attachment makes the line argued —
  and its `handler` only ever sees `rawInput` without non-whitespace input
  (trailing whitespace stays verbatim, like every other command surface).
- **A name the host catalog RESOLVES is host territory in BOTH states.** The
  catalog's view of a line has three outcomes: it CLAIMS the line, it resolves
  the name but does not claim THIS line (an argued line of an execute-kind
  command), or it does not resolve the name at all. The LAST outcome leaves the
  name to the client layers — an unknown slash line, or a live client
  contribution, which may then run locally. The other two are host territory:
  such a line is never classified as a local client command for the attachment
  gate, a same-named contribution never runs for it, and the middle state is an
  ordinary submission (`/compact <args>`). A contribution can only coexist with
  a resolved host name in the failed-source collision state, so the middle
  state's contribution rule is the shape that state takes.
- **The claim is resolved against the FINAL catalog, and submit-time
  NON-invocations are sticky.** On a deferred start the standing view cannot
  see the session-scoped catalog, so the plane's ownership of the line is asked
  AGAIN after `ensureSession()` and the advertised-miss gate follows that same
  answer: a name the committed catalog resolves without claiming the line is
  delivered as an ordinary submission (never consumed as an "advertised miss"),
  and a name the committed catalog DOES claim on this line is executed by the
  plane even when the standing view had classified the line as unclaimed.
  A line the catalog already resolved WITHOUT claiming it when it was submitted
  can never become an invocation afterwards: if that name disappears from the
  final catalog, the line stays an ordinary submission (the plane is not asked,
  and the submit-time name claim does not consume it as a miss), and the
  attachment gate keeps treating it as host territory — it never falls back to
  a same-named client contribution that the submit-time routing had already
  excluded.
  The CLIENT-LOCAL eligibility is sticky in the same way: only a line whose
  initial route was a LIVE client contribution keeps the client-local
  classification under the final authority (that is the deferral case above),
  so a contribution that appears DURING the deferred window never reclassifies
  a generic line as a UI control — the routing already decided, its handler
  never runs for that submission, and an attachment on the line is delivered
  as an ordinary multimodal prompt.
- A contribution is a client-owned command (menu row + client handler); it
  executes locally and never steers. `sessionless: true` runs it before a
  session exists, otherwise the session resolves first.
- A **deferred start** settles a session-backed contribution's authority only
  AFTER the session exists (the session commits the catalog the standing view
  could not see): a host claim or skill wrapper that appears with it takes the
  line, otherwise the client handler runs. A name the committed catalog
  resolves — claimed or not — ends the contribution's ownership of the line.
  Two rules follow, both regression-pinned (the deferred line is always the
  BARE token, so there is no attachment to carry across the window and no
  deferred refusal to fire):
  - **The captured registration is fenced.** The deferred resolution runs the
    EXACT contribution the user submitted. A dispose + reload during the
    window (even under the same owner and id) is a NEW generation that must
    never run in place of the submitted one, and a vanished name must never
    fall through to the command plane or the MODEL. The submission is aborted
    with a `/<name> is no longer available` notice and the draft is restored.
  - **The line's final owner is re-asked.** A late host descriptor that
    resolves the name owns the bare line (the plane executes it, or — for a
    name resolved without claiming the line, which can only be an argued
    line — the submission becomes an ordinary delivery). The plane's ownership
    and the advertised-miss gate are resolved from that same final answer.
- A colliding contribution fails the candidate synthesis as a whole: the
  command SOURCE is marked failed (upstream `source-failed` parity — the
  source's whole group is removed), so no command row, client or host, is
  offered until a synthesis succeeds again. Nothing stale survives: a
  displayed row can never execute a different command than it shows. The
  HOST CLAIMS are refreshed before the merge, so a failed synthesis never
  costs a host command its input authority; the collision is recorded on the
  contribution's health (cleared when it merges cleanly again, and only while
  the record still shows that very collision message — so a handler failure
  that OPENED the record is preserved; see the limitation note below for the
  failure order that is not protected) and surfaced once per
  contribution identity and failure generation — one failed pass states EVERY
  collision it found in the single notice slot.
- Everything unclaimed is an ordinary prompt; TUI-local commands
  (`LOCAL_COMMANDS`) and TUI-owned skill wrappers keep their own routes
  (local execution, `loadSkill`) — they are the one thing the line-level host
  claim must not steal, because the dispatch excludes them from the host
  route in the same way.
- **Known diagnostic limitation — the health record is lossy.** One
  contribution identity has THREE writers of its single extension-health
  record: the candidate synthesis above, the client handler's settlement,
  and the session command path that reports the HOST command executing under
  a colliding name. The ledger keeps ONE failure generation per record and
  deduplicates a repeat (the first message wins), so the record is not an
  authoritative summary of every unrecovered failure. The recovery rule above
  is message-based, which protects one failure order only:
  - a client handler that fails while its name is colliding keeps its
    failure out of the record (the collision message wins), and the
    collision recovery then clears the record although the handler never
    recovered;
  - a client handler that succeeds while its name is colliding clears the
    still-active collision record;
  - a HOST command's own settlement under a colliding name is attributed to
    the contribution's health record.

  The user-visible behavior is unaffected and is asserted alongside: the
  handler failure is notified and logged when it happens, the collision is
  notified and withdraws the menu rows, and dispatch, claims and the menu
  never consult health. The three flows are pinned by the `known limitation`
  regressions in `test/submit-hot-path.test.ts`. Making the record
  authoritative requires separating the failure SOURCES (and no longer
  attributing a host execution to the contribution), which is deliberately
  out of scope here.

## Command attachments follow the descriptor declaration

The composer's attachment policy is the DSH client contract
(`ui-commands` `CommandInputDescriptor.attachments` +
`CommandUiRuntime`/leading-claim submit), not a TUI-local guess:

- A command may be invoked with attachments ONLY when the descriptor that
  CLAIMS the line declares `input.attachments: true`. An attachment-bearing
  line for any other CLAIMED command is refused before dispatch
  (`/<name> does not accept attachments; remove them first`) and the draft —
  attachment placeholder included — comes back. The host executor re-enforces
  the same declaration at admission.
- The claim is asked for the LINE, never for the name
  (`CommandDescriptor.input`, upstream `matchEnter`): a `leadingInput`
  command (`/goal <objective>`) claims its argued line, while an execute-kind
  command (`/compact`) claims the BARE token only. `/compact <anything>` is
  therefore no command invocation at all — it is an ordinary submission that
  keeps its attachments and follows the busy policy — and the command plane
  is never asked to run it (the host registry resolves by NAME, so handing it
  over would run the command anyway).
- A DECLARING **HOST** command receives the submitted IMAGES as encoded
  `CommandSubmitAttachment`s on `commands.execute`; the host admits them
  through its own attachment store (the client never saves them locally for a
  command invocation). A TUI-owned command never carries a payload on that
  wire: `/skill <name> ...` is itself a registered TUI command and a live
  skill wrapper is TUI-owned, and neither declares `input.attachments` — the
  host executor would reject the invocation before `loadSkill` ran. Their
  placeholder line is delivered as-is and the images are admitted by the
  delivery path (`loadSkill` → `prepareUserMessage`), which is what makes an
  explicit `/skill <name> [image #1]` multimodal.
- A FILE attachment is refused even for a declaring command: the host
  contract carries files as upload receipts, and this client has no seam to
  produce one — fail closed rather than hand the host a placeholder with no
  payload (`/<name> cannot receive file attachments in this client; remove
  them first`).
- A command submission CONSUMES its attachments only after handler success
  (web parity): an error outcome restores the draft and KEEPS the staged
  attachments, so a failed command never swallows the user's image.
- TUI/core local commands AND `!`/`!!` local shell lines keep refusing
  attachments outright: their line is a UI control, never agent-facing input.
  The shell has no attachment delivery path (`runLocalShell` neither admits nor
  consumes drafts), so the refusal is what keeps a placeholder from becoming
  shell arguments. A client command contribution needs no refusal: its
  invocation is the BARE token only, so an attachment-bearing `/deploy [image
  #1]` line is never its invocation — it is an ordinary multimodal submission.
  A skill wrapper, a `/skill <name>` invocation and a plain prompt stay
  agent-facing and deliver their attachments to the model.
- The policy is applied against the FINAL authority, not only at submit time.
  A deferred start may commit a session-scoped host command the standing view
  could not see, so the dispatch RE-APPLIES the policy after
  `ensureSession()` and before `commands.execute` (the host executor only
  validates the payload it is handed — an empty one would run the handler with
  the placeholder as a plain argument and then consume the draft). An unknown
  `/name [image #1]` line that becomes an undeclared host command is refused,
  a late declaring command receives its images, and a late declaring command
  still refuses a file.

## Focus is surface-adaptive

Two surfaces, two consistent detail paths — no mouse hit-map in regular
mode (only `TuiAltScreen` wires `onCellClick`):

- **Regular (fullscreen OFF) — keyboard-driven**:
  - Ctrl+O is the Focus detail master: it toggles a DERIVED reveal of the
    recent `EXPAND_RECENT_TURNS` Focus Thoughts. The derived state is
    NEVER written into `focusExpandedTurns`, so switching to fullscreen
    drops it (deterministic: `transcriptDetailExpanded` and `focusExpandedTurns`
    stay orthogonal).
  - ANY expanded Focus root — Ctrl+O-derived OR manually revealed
    (search / viewer restore) — full-reveals its non-Thinking process:
    regular has no mouse, so there are never compact secondary cards that
    cannot be opened (`root open == process full`).
  - Thinking is a SECONDARY detail owner: it renders COMPACT (with the
    `(alt+t to expand)` hint) unless the shared `thinkingExpanded` bulk
    preference says full. `Alt+T` never removes a block — it only picks
    the detail level.
  - There are no `▸ Bash` affordances in regular mode — nothing to click.
- **Fullscreen — mouse-driven fine inspection**:
  - The Thought is click-disclosed; an expanded Thought shows COMPACT
    secondary cards (Thinking included), and a click full-reveals one
    card (attachment > secondary > outer Thought). A Thinking click
    flips that card's EFFECTIVE state: under bulk-compact it expands
    only that card, under bulk-full it collapses only that card (the
    override always expresses the opposite of the effective state).
  - Ctrl+O is the Thought-ROOT bulk owner in fullscreen Focus ONLY (the
    2026-08-25 supplement): no expanded root → expand the most recent
    `EXPAND_RECENT_TURNS` eligible roots (real TurnActivity turns that
    are currently projected — never a fake Thought); any expanded root →
    Collapse All in ONE mutation + ONE rebuild + ONE viewport pass.
    It NEVER touches Thinking on any surface (Alt+T owns Thinking
    detail; every disclosure has one bulk owner), never full-reveals
    secondaries (mouse-owned), and Collapse All additionally clears
    every Focus-secondary local override and normalizes the regular
    Ctrl+O tool master OFF — only there — so a later surface/Focus
    switch cannot resurrect the old bulk detail.
  - A click on a blank visual row INSIDE an expanded Thought (the
    inter-block spacer rows) collapses that Thought — the escape hatch
    that works even when its header scrolled out of view, reusing the
    exact header-click collapse anchor. Row-based ownership only: a row
    claimed by any concrete target (attachment / secondary / header /
    ordinary message) keeps its own behavior — the same row's right-side
    blank is never a Thought background (no X-axis hit geometry). The
    Thought's trailing boundary spacer (the next Thought / a user
    message / the final assistant follows) is unclaimed — a global blank
    click is a no-op, never a guessed "nearest Thought", and editor /
    footer / chrome / overlay areas are never pierced.
  - The fold hint reads `(click to expand)` for fullscreen secondary
    cards, `(alt+t to expand)` for regular Thinking, `(ctrl+o to
    expand)` for the ordinary keyboard-owned folds.
  - Alt+T bulk-toggles ALL Thinking and clears every Thinking per-card
    override first (a predictable ALL-compact / ALL-full result).
  - Root Collapse All clears the turn's per-card expansions but never
    the Thinking bulk preference.
- **Switching surfaces** re-derives the projection: entering fullscreen
  drops the Ctrl+O-derived reveal (manual disclosures only); returning
  to regular restores it while the master is ON — and CLEARS every
  Thinking per-card override (regular's only Thinking state is the bulk
  preference; a stale fullscreen click must never leak back).
- **Search** full-reveals ONLY the matched Thinking block (a per-card
  override) and never writes the bulk preference; the reveal rides the
  same override channel as a fullscreen click, so the next Alt+T resets
  it. In regular the override is honored for search reveals — the only
  override that can exist there, because the fullscreen → regular
  transition clears the click ones.

## Selected-row marquee

- Only the SELECTED row's main label scrolls (pause → one cell per 250ms →
  tail pause → loop). Tree connectors, the current-session marker, mode
  suffixes, status and elapsed are fixed layout regions.
- The window slices by VISIBLE CELLS (CJK/emoji/ZWJ never split); one
  timer per panel, unref'd, disposed on close; only an overflowing
  selected row arms it.
- The session picker uses the vendored SelectList's `truncatePrimary` seam
  (no fork divergence): the label is split into a fixed presentation
  prefix (lineage + marker) and the marqueeable title.

## Local shell display policy

- The capture layer (bounded-output byte/line/disk caps) is the memory
  safety boundary and is UNCHANGED; this policy only bounds what the card
  PRESENTS: a running card collapses to the newest 5 source lines, a
  settled card to at most 20 VISUAL rows, with an honest hidden-line
  marker. Ctrl+O (the existing master switch) expands to the retained
  buffer — everywhere EXCEPT fullscreen Focus, where Ctrl+O owns the
  Thought-root bulk and the shell cards keep their folded state (their
  local `!`/`!!` presentation is otherwise unchanged); a running card's
  result is re-chained to the bounded tail on a throttle.
- Quick dismiss (Alt+K) removes SETTLED cards only: a running card is
  never dismissed, the shell process is never cancelled (Esc owns that),
  no session event is deleted, and an already-submitted `!` context
  payload is untouched. `!!` stays local-only.

## One live TUI per process (the vendored keybindings are process-global)

The vendored fork's `getKeybindings()` is a PROCESS-GLOBAL singleton
(upstream shape — deliberately NOT re-vendored into per-TUI dependency
injection). A TuiApp's HostKeybindingManager syncs `app.input.submit` →
`tui.editor.submit` (plus Home/End and alt-screen mappings) into that
singleton on EVERY rebuild — and the manager SURVIVES `stop()` (only the
final `dispose()` ends the surface generation, keeping extension
registrations/handles valid across stop/start round-trips). Two surfaces
sharing one process would therefore fight over one keybinding state —
App A's submit remap would hijack App B's Enter — even when one of them
is merely stopped, not disposed. The host enforces the invariant
fail-fast (re-vendor lifecycle follow-up P3, `src/process-tui-slot.ts`):

- `TuiApp.start()` CLAIMS the process slot at the first successful start
  (a failed `start()` never leaks the claim); `TuiApp.stop()` NEVER
  releases it — a stopped-but-not-final-disposed surface still owns the
  process-global keybinding namespace; `TuiApp.dispose()` releases LAST,
  only after the completed final teardown (keybinding manager, extension
  host and editor holder all disposed).
- A second surface whose `start()` runs before the first one's final
  dispose rejects with a deterministic error — never a silent keybinding
  collision.
- Exclusivity is FAIL-CLOSED: if the final teardown throws, the slot
  stays claimed (a half-torn-down surface must never be publicly
  replaceable by a new one). `stop()` never releases, so a throwing stop
  teardown cannot fail open either.
- The external-editor suspend/resume and ordinary stop/start cycles keep
  the claim (same generation, same ownership — no trip); fullscreen
  main/alt-screen swaps stop/start the SCREENS (not the app) and never
  touch the slot at all.

## Task Center uses one catalog with two presentation surfaces

Quick Tasks is the footer-triggered, Active-scope view; `/tasks` opens the full
Task Center in All scope. Both surfaces consume the same durable preorder and
runtime projection. Scope, type, search, selection, and disclosure are
presentation state, so promoting Quick to Full never reorders or deduplicates
rows and Esc can restore the prior context. Their keyboard ownership is
deliberately asymmetric: Quick is navigation-only (arrows, `←`/`→` tree,
`Tab` type, `Enter` open, `Esc` close) and consumes every other key as a no-op,
so no printable can arm a hidden search/stop/action state and `Esc` is always
exactly one layer; the full Task Center owns search, scope, stop, refresh,
paging and reverse (`Shift+Tab`) type cycling. The only keyboard path from
Quick to Full is the `Open Task Center` pseudo-row plus `Enter`. Active scope
retains every ancestor
needed to explain an active descendant but does not promote that descendant to a
root. Terminal job failures are acknowledged only when a visible Task Center
row is opened; until then the footer keeps a failure marker and the ↓ affordance.
The stop action is a confirmed, capability-gated dispatch: continuable running
children use their durable direct parent authority, while running jobs use the
public job kill API. The browser never reads job output.

## Long user messages collapse at the presentation layer only

A text-only durable user message whose render-time visual row count exceeds
10 collapses to head (4 rows) + one marker + tail (3 rows). The decision and
the slice both run on the wrapped rows the CURRENT width produces, so a
resize re-decides and CJK/emoji/single-overlong-line wrapping is counted by
real screen space rather than string length. The canonical
`TranscriptMessage.text` is never rewritten: the fold lives entirely in
`UserBubbleComponent` and every non-presentation consumer (search corpus,
export, persistence, replay) keeps the full text.

Disclosure reuses the existing per-message `expandedOverride`, never a second
user-specific state map, and user messages are NOT added to
`isFocusSecondaryDisclosure` (a user message is a turn foundation, not process
detail). A regular surface with NO effective `app.transcript.toggleExpand` key
does not fold at all — compacting without an affordance would strand the prompt
collapsed — while fullscreen keeps folding because the marker click always
works. The owner of the expand affordance is surface-adaptive and is part of
the component cache identity:

- regular: the Ctrl+O recent-USER-turn boundary (its own threshold, computed
  from user turns only — never the Thinking/System/Tool process boundary,
  which can be sparse and would otherwise expand every prompt in a pure chat;
  or a per-message search reveal);
- fullscreen without Focus: the compact-marker click and the Ctrl+O master
  (`click / <key> to expand`);
- fullscreen inside a Focus: the compact-marker click and a search reveal —
  the recent-turn boundary is deliberately NOT consulted there, because a
  persisted `transcriptDetailExpanded` from an earlier surface must not leak an
  expansion into a surface whose marker says `click to expand`. Ctrl+O there
  belongs to the Thought-root bulk, so the marker never advertises a dead key.

A persisted Ctrl+O master keeps recent prompts expanded when the user moves
into fullscreen without Focus, exactly like the ephemeral pending lane: the
master is a cross-surface preference that also drives tool/system detail, so it
is deliberately NOT reset on the transition. Disabling the toggleExpand key
removes only the KEYBOARD affordance — in fullscreen the surface is never
stranded: every expanded prompt still shows the tail `▴ Collapse · click`
control and every folded one still shows the `click to expand` marker, so the
mouse round-trip works with no key. In regular the expanded prompt simply
renders full (no label), and Ctrl+O is the collapse owner.

The collapsed state exposes the compact marker; in FULLSCREEN the EXPANDED
state exposes a tail collapse control at the message tail — reusing the
trailing separator row when one follows, or one dedicated presentation row for
the final block. The direction is explicit in the shared disclosure metadata
(`expand` vs `collapse`) and in the fullscreen hit identity, so a stale press
can never transfer an expand target to a collapse target (or to a replacement
pending row). The tail label is `▴ Collapse · click / <key>` without Focus and
`▴ Collapse · click` inside a Focus (Ctrl+O owns the Thought-root bulk there, so
the card never advertises a dead key). The tail control is deliberately
FULLSCREEN-ONLY: regular draws into the terminal main screen, where no
app-owned copy pipeline exists, so a visible label there would be picked up by
the terminal's native selection — and regular has no mouse disclosure anyway, so
its only job would be a keyboard hint not worth polluting scrollback copy. In
fullscreen the tail row is presentation chrome: the fork's copy-source seam
(X057) copies it as the blank separator it replaced, while paint, search,
word/line selection and the mouse hit map keep reading the rendered line. The
excluded rows are derived at the PAINT boundary (`copyBlankRows` on the
last-painted snapshot), so the copy filter shares the same frame epoch as the
scroll content the user actually saw — a rebuild that has not repainted yet can
never leak the chrome or blank the wrong row.

Ctrl+O keeps its existing ownership: in regular/fullscreen-non-Focus it turns
the recent-turn master off and clears the true long-user overrides when either
the master is on or a VISIBLE user bubble/pending row is explicitly expanded;
in fullscreen Focus it also clears the long-user overrides (with the
root-collapse pass, or alone when no Thought root is expanded). Every
disclosure mutation runs through one viewport transaction: a reader who was
following the live tail keeps following it, and a historical reader is restored
to the SAME semantic row (durable message identity, or the pending row's stable
key) at the same viewport offset — never a raw absolute scrollTop that would
land on different content after a 150→8 row shrink. The Focus root Collapse All
keeps its own `anchor-turn` contract and never routes through the generic user
anchor.

The ephemeral pending steering/transcript lane joins the SAME visual-row
disclosure when its row is text-only (`foldableText`); an unknown or
mixed-content row fails open to the full presentation, so a pending row never
folds only to materialize as a full mixed-content durable bubble. Pending
disclosure state is presentation-only, keyed by the stable `rpc:<id>` /
`id:<id>` identity (a local echo and its authoritative replacement share it)
and pruned to the live pending keys on every presentation update; it never
enters the transcript, persistence, or the session. The status line
(`steering…` / `sending…` / `waiting for next turn…`) always stays visible and
is never folded into the compact middle.

The override cleanup filters `kind === 'user'` only, so
thinking/tool/system/compaction overrides and the Thought-root storage rule
are untouched. Both the search reveal and the Ctrl+O collapse predicate only
treat a message as folded when the HOST bubble owns its current presentation
(an extension message renderer that takes over `kind: 'user'` receives no
`expanded` state and renders no compact marker, so the Host never writes or
counts disclosure state for it) AND it ACTUALLY compacts at the current width
— so neither a plugin-owned nor a short prompt accumulates an invisible no-op
override that would eat a Ctrl+O press. A plugin-owned user entry is likewise
exempt from the Host long-user cache fields (boundary / expanded / hint): a
user-boundary shift or a surface swap never re-runs its extension renderer
(the renderer-registry revision still handles Host↔plugin ownership changes).
A regular surface with no expand key
never folds at all, so
entering fullscreen from it drops every long-user override — a stale reveal
from that surface must not hide the Focus marker. That clear is deliberately
GLOBAL for the transition (overrides carry no source tag and no parallel
state may be added), so an earlier fullscreen expansion does not survive a
trip through such a non-folding regular surface: re-entry re-derives folded.
A regular surface WITH the key keeps its reveal across the swap. A search
reveal is not a permanent pin: the next explicit Ctrl+O collapse hides it
again, and a later search jump reveals it afresh.

Only the marker row and the tail control row are click targets; every other
row of the bubble has an inert hit identity so ordinary user text keeps
selection/copy semantics. A search hit inside the collapsed middle expands the
message on jump, including outside Focus mode, because the search corpus is the
full text.

**Known limitation (deferred):** the search match carries no intra-message
offset, so the jump expands the message but does not reposition the viewport
onto the exact matched row. For a bulk paste large enough that the hit sits
far from the message's tail after expansion, the user may still need to scroll
within the revealed message. Landing the viewport on the matched row needs a
match-position contract across the search index and the runner jump path, and
is tracked as a follow-up rather than part of this change.

## Fullscreen jump-to-latest is a Host semantic action behind a viewport affordance

`TuiAltScreen` owns only the viewport affordance: it draws a bottom-centered
`↓ Latest` label whenever the primary follow-end view has left its end, plus
`shouldShowScrollToEndIndicator` (the Host's virtual-history window is not at
the live tail, so a history window keeps the label even when its local view
follows its end) and `onScrollToEndIndicator` (the Host consumes the click;
the fork's local `scrollToBottom` remains the fallback when no Host claims
it). The Host wires the label text from the effective `app.transcript.jumpLatest`
keybinding, the show predicate from `transcriptWindow.mode`, and the click to
the existing `onTranscriptJumpLatest` semantic action — so a history click
returns to the GLOBAL latest window instead of stopping at the current history
window's bottom. The history location gutter now says only where the window
is; the floating label says how to get back. This vendor seam extends X028.
