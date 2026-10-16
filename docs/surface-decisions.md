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

Pure helpers live in `src/tui/transcript/tool-presentation.ts` (`webCardLines`,
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
- **Context** — `placement === 'context'` is not pending USER input, but
  authoritative occurrences are exposed in a NON-USER ephemeral Context tail
  for background/injected-input observability (2026-09-30 TUI presentation
  closure, intentionally extending the official Web policy — see the
  migration doc's D2.1 addendum). The row renders generic
  `context-generic` chrome plus a bounded body preview (max 2 width-aware
  body rows, ellipsized) and a waiting status derived from the subject's
  activity (`waiting for next step…` while running, `waiting for next turn…`
  once parked). It is never in the queue pane, has no local optimistic echo,
  never exposes the raw DSH `source` (or infers a producer from text), is
  not searchable, not durable, never inside `TranscriptFolder`, Work spans or
  Context clusters, and does not steal the viewport (a reader browsing
  history stays put). The Host claim removes it — the pending-input snapshot
  is the ONLY lifecycle authority, there is no TUI-owned retained row — and
  the durable Context returns through the normal transcript path after
  materialization.
- **Identity, never text** — each human submission mints a request id before its
  first async preparation await and persists it as the Direct user-message
  source `rpcId`. Local echoes and authoritative occurrences correlate by that
  id; a local echo is suppressed only while an authoritative counterpart is
  visible, and is retired on the durable `user/message` (or a known terminal
  exit). Because the Host claims a pending occurrence before its asynchronous
  pre-step emits the durable message, the echo is re-presented in that window
  rather than deleted — the accepted content stays continuously visible. Two
  same-text submissions stay two distinct pending rows.
- **One atomic update** — the runner publishes queue rows, the ONE ordered
  tail (user steering rows interleaved with non-user context occurrences, in
  the join's projection order) and activity in a single
  `setPendingInputPresentation` call, so a handoff never paints an
  intermediate blank/duplicate frame.
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

Per-occurrence QueueDock controls: per-occurrence QueueDock Edit / Remove /
Steer is a CURRENT PRODUCT GAP. The semantic adapters already support exact
occurrence operations: D2.2 keeps the queue-action SEMANTIC
(`SessionWriter.updateQueue` `edit` / `remove` / `steer`) fully aligned for both
Direct and Remote adapters with adapter tests and same-Host proof. `Alt+Up` is
recall-all over authoritative occurrences and `Ctrl+S` is FIFO steer-all; both
are useful bulk terminal-native affordances but do NOT substitute for exact
occurrence actions. There is no row selection, single-row edit/remove/steer, row
action button/keybinding, per-row busy state, edit overlay, selection clamp, or
edit-target-disappearance lifecycle.

Owner: Post-M3 Q1.

### Remote presentation keeps exactly one optimistic identity

D2.2 makes the client-local optimistic-echo source a seam
(`src/app/submission/presentation.ts`): production Direct reads the existing
`PendingSubmissions` ledger; the experimental Remote path reads the official
`SessionSnapshot.pendingSubmissions`. The single join
(`src/app/surface/pending-presentation.ts`) correlates authoritative occurrences with local
echoes by request/rpc identity only and routes `queued` to the queue pane and
`steering`/`transcript` to the conversation-tail lane; a non-user `context`
occurrence renders in the same ordered tail with its generic non-user Context
identity and never correlates with a local echo. The Remote path therefore
never runs a second optimistic ledger beside the official one, and a steer
echo can never render as a queued row.

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
  switched display. rc.2 retired the rc.1 `modeSelectionEnabled` chooser policy,
  so `/preset` is a normal command advertised whenever the command catalog is
  healthy; the official registry is the only selectability authority.
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

Resolution helpers: `src/domain/catalog/provider.ts` (`providerOptionsFor`,
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
  `submitSubagentPrompt` (internal to src/runtime/direct/subagent-direct.ts) → the official
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
  mutation calls may use only the SEMANTIC writer subject of the child mounted
  by the current interactive continuable viewer — the backend-neutral authority
  the writes are addressed to, never a merely name-matched identity. Backend
  mapping: Direct supplies the exact live Agent (with the pinned direct parent
  and registry identity still matching); Remote supplies the writer subject of
  the exact retained child Session. This queue-only resolver never grants
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
  open** (M3-5 PR1: the child is a first-class DISPLAY SUBJECT). The parent
  session's status (permission/model/plan/task badges, extension footer
  segments) describes a session the user is not looking at. The split is:
  - **Viewer-owned identity + presentation folds.** `ViewerRuntime` supplies
    the child id/label/mode/activity/access and the child transcript fold
    (its own `StatsFolder`: turn/step counters, recent presentation
    performance, the stats line). These never become authority for the
    child's Session-scoped facts.
  - **Session-owned facts come from `SessionReader.sessionStatus(childId)`.**
    `StatusRuntime`'s ONE display-subject selector resolves the main Session
    or the viewed child, reads ONE `SessionStatus(childId)` cut, and derives
    the child's composition (model/preset), access (projection-authoritative
    permission), workspace (its own cwd — a Remote child's Host cwd never
    implies a local branch), cumulative tokens and context
    (numerator = `projectedTokens ?? pressureTokens`, window = the projection's)
    and the todo/title/goal presentation. An absent child fact stays ABSENT —
    the parent's value, the sessionless default and the bounded fold's total
    are never stand-ins.
  - **One atomic commit.** The view subject, the Session-owned sections, the
    activity section (its `todoCount` is the display-subject list length), the
    legacy display fields and a disposable display-subject PRESENTATION
    projection (todo list / session title / session identity, which otherwise
    live as durable MAIN state) travel in ONE `TuiApp.commitDisplaySubject`
    call; the StatusStore publishes them in a single synchronous `update()`
    before any notification, so no observer reads `view=child` beside the
    parent's facts (or the reverse). An ALREADY-OPEN todo panel is re-rendered
    from the same committed projection (enter, child A→B, a child todo change
    and exit alike — it never waits for an unrelated event). The main durable
    presentation state is never overwritten — clearing the projection restores
    its LATEST values.
  - **The main session's welcome card (head) is hidden while a child is the
    display subject.** That card names the main session's model/workspace/
    session id; leaving it up would show two different sessions at once. Its
    facts are never overwritten, so the LATEST main identity reappears on exit.
    Hiding re-measures the transcript rows (`transcriptWelcomeHeight`, the
    fullscreen row map and the scroll anchor ride the same measurement), so
    regular and fullscreen geometry stay consistent.
  - **The existing footer consumers render the display subject's own facts.**
    The `model`, `agent-preset`, `permission-preset`, `context`, `git-branch`
    and `todo` items read the section the commit just published, so a viewed
    child's model/provider, configured preset, available permission,
    context pressure/window, branch and todo count are displayed where the user
    configured them (the default preset shows model/permission/cwd/context/
    tokens/branch; `agent-preset` and the separate `todo` count appear in custom
    layouts). An absent child fact renders nothing — never the parent's value.
    Genuinely MAIN-only chrome keeps its subject gate and stays hidden while
    viewing: the Task Center badge, plan state, the `ext:*` extension bridge,
    queue, agents and run-state.
  - **Extension: v2 live-session semantics stay, the display subject is
    published ADDITIVELY.** The released Stable `SessionSnapshot` (API_VERSION
    2) means "the live session's identity and mode" and its semantics are
    UNCHANGED: `sessionId`/`workspaceRoot`/`title`/`model`/`cwd`/`branch`/
    `permission`/`turns`/`steps` and the activity `todoCount`/`todoSummary`
    keep describing the LIVE session owner — a viewer transition never
    re-points them (the M3-5 PR1 contract decision; see
    `docs/extension-api.md`). The session the user is LOOKING AT is published
    beside it as the optional `session.displaySubject` (`sessionId`, `title`,
    `workspaceRoot`, `cwd`, `branch`, `model`, `permission`, `turns`, `steps`,
    `todoCount`, `todoSummary`), present only while a child viewer is mounted
    (`viewerMode`). The first-party todo dock item prefers
    `displaySubject.todoSummary`, so the chrome still follows the subject while
    the live-session fields stay truthful. Direct/current viewer composition is
    qualified by PR1; the Remote child viewer stays PR2 (no Remote
    child-viewer L6 is claimed here).
  The display-subject status is re-derived on EVERY durable event of the viewed
  child (never on streaming deltas, which do not reach that path): the child's
  Session-owned facts come from the official projections, and any durable event
  of that Session may move one of them — `model/selection` / `request/header`
  (modelSelection), `agent-preset/selected` (agentPreset), `request/context`,
  usage-bearing `assistant/message`/`assistant/attempt`, the `surfaceOp`
  message/tool-result family (contextPressure/contextBreakdown), `todo/write` /
  `session/title` / `goal/change`, the permission knobs and the turn/step
  counters. Enumerating that family set proved fragile, so the primitive is the
  whole durable event stream (`app/surface/runtime.ts`, the viewer branch).
  While a child viewer is mounted, every durable event of the LIVE session also
  refreshes the status: the extension's v2 live-session snapshot is derived from
  the same refresh (one that does not re-project the live sections into the
  child store), so a cheap live event such as `step/end` can no longer leave the
  published live counters behind the live fold. **Extension footer segments do not render while viewing**:
  viewer mode is host-owned chrome, the extension surface already exposes
  `viewerMode` in its session state, and the first-party builtin's
  turn/step segment would otherwise duplicate the child counters with the
  parent's. Header extension badges keep rendering (they do not conflict
  with the child identity). No extension API changed (additive-only).

## Durable hierarchical task browser

The `/tasks` browser (and the ↓ empty-editor trigger, and the footer badge)
read the DURABLE descendant catalog, not the live-child list:

- **The semantic lineage source is the DURABLE descendant catalog** — one root
  Session plus its complete descendant tree in the official stable pre-order —
  never a re-implemented traversal over session headers. `parentId` + `depth`
  ride every row from the catalog facts, never guessed from labels or order.
  Backend mapping (M3-5 PR2): Direct composes the official
  `subagents.listDescendants`; Remote walks the recursive official
  `subagentCatalog` projection (the released Client carrier cannot expose
  `listDescendants`). Both feed the SAME semantic Task contract — a row's shape
  must not encode which backend produced it.
- **Subagent rows keep the DSH stable pre-order VERBATIM.** Activity never
  re-sorts a row above its parent (a running grandchild stays under its
  inactive parent). The "first running subagent" rule is a CURSOR policy
  (`TaskBrowserHandle.setItems(items, preferredValue)`), never a sort.
- **A finished one-shot child stays reachable.** `inactive` is never an
  outcome; Enter opens its persisted transcript read-only. No activity
  filter exists in `buildTaskRows`.
- **Runtime activity is a commit-time RUNTIME fact, never read from the
  catalog.** A catalog's own activity field is live-STORE presence, not driver
  activity: an idle continuable child stays live in the session store and would
  otherwise read as `running` forever. Every child row's `running` / `inactive`
  is therefore taken AT COMMIT TIME by the `TaskBrowserRuntime` coordinator
  (`projectSubagentActivity`) from the backend's live-run authority, so a slow
  catalog response can never overwrite a newer runtime state. Backend mapping:
  Direct reads the Agent registry (`ctx.agents.get(id)?.status === 'running'`);
  Remote reads the official Session-list `running` bit. The coordinator splits
  CATALOG refreshes (the only paths that re-list) from RUNTIME-only refreshes
  (the cached catalog is reused; membership/tree/mode never move). Backend
  mapping of the triggers: Direct takes subagent lifecycle + `agent/status`
  events and is membership-gated (only flips of children in the cached catalog
  refresh the surface, so the MAIN agent's own per-turn flips never repaint);
  Remote subscribes the official Session list and the Jobs state through the
  surface owner. A session switch closes the open browser, clears the badge
  SYNCHRONOUSLY and drops the cached catalog — the old session's running
  badge never hangs on the footer until the new session's first listing
  lands (the fence key = session generation + id; a failed listing never
  leaves a stale badge).
- **Catalog invalidation is coalesced by the SURFACE owner, never the
  coordinator.** Every production trigger (the mount seed, the backend's
  lifecycle/membership invalidations — Direct's `subagent/start` /
  `subagent/end` and the subagent tool-call fallback, Remote's official Session
  list and Jobs state — Job membership events, opening the browser, the Full
  Task Center `R`) funnels through one
  surface-owned single-flight gate: at most ONE `refreshCatalog()` traversal
  is in flight per session generation, an invalidation arriving mid-flight
  only marks the gate `dirty`, and the traversal's settle starts at most ONE
  trailing read that observes the latest membership. A session-generation
  bump invalidates the old gate immediately — the new session's refresh
  starts without waiting for the old session's slow traversal — and the old
  traversal's late settle is generation-fenced, so it neither clears the new
  gate nor schedules a trailing read. The coordinator's request/committed
  epoch fence stays the OVERLAP-correctness authority (`refreshCatalog()`
  remains re-entrant and correct for any direct or future caller); this gate
  is only the performance (single-flight) authority. The opt-in
  `DSH_TUI_TASK_REFRESH_PROFILE=1` logs one line per REAL traversal (elapsed,
  absorbed invalidations, trailing, outcome, superseded, and — for a
  current-generation read — the committed durable descendant count) so a live
  session can prove the refresh storm is flattened. A traversal superseded by a
  session switch is still recorded, with only its own start-time facts; it never
  reports the new session's catalog state.
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
  then calibrates in the background through the SAME coalesced catalog
  gate as every other invalidation — opening never races a second full
  descendant traversal next to one already in flight.
- **The interrupt verb is advertised AND fired only for a continuable
  row whose driver is running right now** — one predicate
  (`isSubagentRowInterruptible`) gates both the panel hint and the
  runner's execution path, so an idle continuable has no driver to stop
  and the UI never advertises (or fires) a dead stop.

## Communication policy and Focus surface

Communication policy is two independent user preferences, neither of them a
display preset: `ProgressUpdatesState` (`off` | `milestones` | `frequent`,
default `milestones`) owns the user-facing mid-turn update cadence, and
`ResponseStyleState` (`default` | `concise` | `explanatory`, default
`default`) owns the density/explanation depth of visible assistant text.
`DisplayState` owns what the surface can make visible. Missing or invalid
settings resolve to the defaults through the parsers (the single authority).
The `/settings` rows change the shared runtime states synchronously, then save
through the existing serialized whole-document ConfigPort write, preserving raw
extension fields. A failed save is reported without undoing the live choice.

Each composed root TUI agent registers `tui:progress-updates` at order 80 and
`tui:response-style` at 81, followed by `tui:focus-mode` at 90 and tool
guidance at 100+. The providers read live state on every assembly; changing
either axis does not recompose the agent, re-register sections, or change the
other axis. Plain `composeAgent` callers that omit both states retain their
existing composition. `default` returns an empty response-style section, not a
disabled base prompt, Focus policy, tool policy, or safety behavior.

Milestones reports only at closed phase boundaries, material direction
changes, or required user input — never because a partial finding was just
established while the same investigation continues. Frequent deliberately
allows active updates during longer work (semantic guidance, never a
tool-call counter or timer). Off actively suppresses progress narration.
Concise and Explanatory steer the visible answer only; they own no cadence,
tool-narration, or Focus-visibility semantics. Focus owns hidden intermediate
text, self-contained questions/approvals, independent background work,
truthful pending-work statements, and the user-needed final visible message.
While Focus is active the progress provider reads both live states and returns
an empty effective section — the saved cadence is never mutated and leaving
Focus restores it on the next assembly; the response style stays active. The
Focus prompt states the surface fact (progress-only intermediate messages
cannot reach the user) without owning cadence or style preferences.

Locality is split: preference state and selection are Client-local; persistence
uses `ConfigPort.tuiSettings`, while Direct composition installs the structural
`SystemPromptLike` sections in the Host's agent scope. A future wire backend
must round-trip the preferences as settings data and install the policy
Host-side; callbacks and the mutable state objects never cross the wire. This
adds no Remote RPC or production backend and does not change display defaults.

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
  llm/retry) never count as tools; a `subagent/descriptor` is not a
  transcript row at all (child identity metadata, post-PR166).
  (2026-09-22 presentation-convergence addendum v2: the COLLAPSED
  presentation vocabulary is `Think:` + `Action:` and both headers say
  `N actions`. Tool stays the STRICT underlying semantic — a `llm/retry` row
  never counts as a tool — but that lifecycle row DOES own the collapsed
  `Action:` slot and DOES count as its own action subtype (`retry`). A
  `subagent/descriptor` does NOT: it is the child session's identity metadata
  (a continuable child logs it before its first `turn/start`), so it is never
  an Action nor an action subtype. A workflow row remains neither. The
  Message/Tool aggregation facts above are the turn-level inputs, not the
  collapsed slot vocabulary — see the collapsed Action slot
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
  while the Agent works) is visible process feedback: it renders AFTER the
  Thought as a post-Thought row while collapsed (2026-09-30 closure; the
  decision reads the semantic `form` and raw position, never a source kind),
  never enters the Thought's hidden Action candidate set, and returns to its
  exact raw position when the Thought opens. A notice inside the
  opening foundation stays before the Thought, and a mid-turn relay stays
  visible.
  Expanded Focus preserves process chronology after the foundation: later
  steers and surfaced context return to their real positions and remain
  unmarked as owner-only process content. Searching a mid-turn notice needs
  no Focus-root reveal and no special forced-visible path (retired 2026-09-30)
  — the row is already visible, so ordinary search addresses it like any
  other surfaced Context card; a match inside the folded Notice payload opens
  through the row's own message disclosure.
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
  This full preview body belongs to the live/Preparing/true-latest Work; a
  settled historical Work collapses to its header only (the 2026-09-29
  compact historical compaction, below). Counts describe the span, not the
  turn; no fact renders a placeholder row; span-local duration is omitted
  when no per-span timing evidence exists, never faked from whole-turn
  timing. Expanding the span re-uses the ordinary message renderers for its
  members.
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
  duration with the identity to the end. The header duration is the Activity's
  structural LIFETIME (`src/tui/transcript/activity-clock.ts`), not the member
  settle: the fold still records a presentation-only `TranscriptTiming`
  sidecar (`SessionEvent.time` only) on thinking/tool/retry rows (a command row
  and a subagent descriptor are never span members, so they carry no Activity
  timing), and `summarizeWorkSpan` still aggregates
  earliest-start/latest-end/any-running in its existing single walk. On top of
  that member evidence the lifetime starts at the earliest member start and
  closes at the EARLIEST real boundary, which is either (a) the start of a
  human-interaction tool inside the run — a RUNNING `ask_user_question` /
  `exit_plan_mode` is still a Process member while its active panel owns the UI,
  and it is matched by NAME exactly like the fold's work accounting, so the
  waiting time is never counted and the value is identical once the tool settles
  and the card leaves the span — or (b) the first FOLLOWING canonical block that
  provably became visible after the Activity started (the fold records a point
  sidecar on the actually-visible Conversation/Context rows: assistant
  first-visible reply text, user/injected-context messages, workflow runs,
  compaction cards), and finally the owning turn's `turn/end` — which is a TIME
  CAP, never a mere fallback: an Activity can never end after its own turn, so a
  later turn's prompt/Context/Work can never lengthen an already-frozen
  Activity. The close boundary is POSITION- and TIME-qualified: only a block
  positioned AFTER the Activity whose own proven time is not EARLIER than the
  Activity's start can close it, so a preceding row (a Context the Activity
  started after) closes nothing, and neither does a reordered row that provably
  became visible STRICTLY BEFORE it (cold hydration can order a Conversation row
  after the Process rows it chronologically preceded — such a row also does not
  disqualify the span as the live tail). An EQUAL-time following row does close
  it, from that same instant: a coarse clock that stamps a whole step with one
  millisecond must freeze the Activity (a point span hides its duration) rather
  than leave it counting a Conversation that is already visible. The lookup is an exact offline dominance-min: two
  bounded structure passes, two sorts and one indexed query per Activity —
  O(n log n), never a per-Activity re-walk of the window (the structure reads are
  locked by a Proxy-count regression). A following block with no proven
  first-visible time keeps the span out of the live tail without closing it. **Display-order convergence (fold unit):** the
  canonical Work MEMBERSHIP — which Process rows share one Activity — follows the
  fold's ONE display order, and the fold now CONVERGES that order from durable
  evidence instead of the accidental append order:
  a step's Tool row is displaced around its Assistant anchor from the row's OWN
  materialization evidence (the earliest of its Preparing delta and its durable
  `tool/call`) compared with the Assistant row's proven first-visible reply time,
  from EITHER arrival direction (`assistant/message` converges the calls its own
  durable stream named; a durable `tool/call` carries its own step and converges
  itself against an Assistant row that already settled). Read grouping asks ONE
  adjacency question — the final display order, visible rows only — so a
  Conversation visible between two reads keeps them apart (each with its own
  `callCount`, timing, search corpus and window slot) while reads the display
  order genuinely brings together still merge; cold builds the groups once after
  `hydrate`, a live settlement re-groups only its own turn, and the cheap
  raw-tail fast path is kept whenever the raw tail IS the display tail.
  **The evidence rule (one rule, both arrival directions):** a Tool row is only
  reordered when its OWN materialization evidence (the earliest of its streamed
  Preparing delta and its durable `tool/call`) and the Conversation's PROVEN
  first-visible reply time are both known and strictly different, and when the
  call's durable `(turn, step, callId)` identity matches this step's own
  candidates (its embedded stream's deltas or its durable message's tool-call
  blocks). Every settlement re-derives the relations it already anchors, so an
  authoritative replacement can never inherit stale order.
  **Expressiveness limit of the anchor model (documented, not hidden):** a
  displacement emits a whole side of one anchor contiguously (`before…, anchor,
  after…`), so it cannot express "after the anchor, interleaved with a row that
  stays put". A Tool displacement is therefore REFUSED when the move would cross
  a visible row that is not itself one of the same step's proven same-side Tool
  rows (an invisible row is never a boundary, so it can be crossed). In that case
  every row keeps its physical order: the row order is the durable one, not the
  full chronological one, and live vs cold are not guaranteed to agree for such a
  log. This is the accepted conservative choice — it never lets a read jump across
  another step's (or another lane's) visible row, and the Work/read grouping stays
  internally consistent — rather than a claim of full convergence.
  **Still conservative — never a guess, and no universal parity:** the streamless
  settlement fallback (which exists only so an Activity can close) is NOT order
  evidence, so without an embedded stream the durable append order stands; an
  equal timestamp proves nothing; a call id the step never named, or one reused
  by another step or turn, is not this step's evidence. Those logs keep the
  durable append order, so an evidence-poor replay can still differ from the live
  run. Read grouping is bounded work by construction for the NORMAL serial tail: a
  `tool/result` that is the display tail settles through the local fast path with
  no regroup at all, and a real display-order change re-groups only its affected
  envelope (the changed row, its anchor and that anchor's other displaced rows,
  their display neighbours, every group containing them, and the DISPLAY runs of every groupable read the envelope covers). That envelope is bounded by the affected RELATION, not by
  a constant: a LATE or DISTANT settlement — a delayed replay whose displaced row
  sits far from its anchor — can legitimately span the intervening rows, including
  rows of other turns, so no universal "well below a turn" cap is claimed. Only an open, non-blocked
  trailing span of a live-tail window
  whose committed display subject is running is live; the live predicate is
  re-read per render (never a latched boolean) and re-reads `now()` on the
  shared repaint heartbeat (no per-card timers). An Activity with no proven end
  and no provable liveness renders NO duration at all — the last member's own
  end is never presented as the Activity's end, and no value can regress a
  duration the user was already watching (a Remote snapshot-only
  `running: false` flip, a history window, an inactive subject); a point-only
  span omits it too (never `0s`). Read grouping never crosses
  a turn boundary so no Activity span ever inherits another turn's count or
  timing (a group's action cardinality and wall span stay on the turn that
  renders the card). The shared Think/Action/Preparing slot geometry lives
  in `src/tui/components/transcript/compact-process-preview.ts` (TS6; one
  authority for Focus and Activity); the Think slot shows the LATEST logical line of the bounded
  reasoning tail in both states (running follows the right edge, settled
  head-truncates).
- **Collapsed Action slot + `actions` header stats (2026-09-22
  presentation-convergence addendum v2): the collapsed process presentation
  uses `Think:` + `Action:`; Focus additionally keeps `Message:` +
  `Error:`, and BOTH headers say `N actions · subtype ×count`.** `Action` is
  the latest meaningful non-Thinking TURN-OWNED Process evidence: genuine Tool,
  Preparing, Retry, and explicit
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
  underlying semantic (a `Retry` row is never a Tool, and neither is a
  command row — a turn-less `control` node — nor a subagent descriptor,
  which is not a transcript row at all; a genuine `tool/call name=subagent`
  IS a Tool literally named `subagent`, and is the delegation Action). The
  shared `CompactActionStats` cardinality: a genuine tool contributes its
  `callCount`, a retry occurrence contributes one action of
  its own subtype (`retry`); an
  orphan result contributes `0 actions` and renders the honest `Unpaired …
  result` diagnostic instead of pretending a missing call existed; a live
  Preparing run temporarily owns the slot but never increments stats (the
  formal call counts once when it materializes). Active surfaced
  interactions (`ask_user_question` / `exit_plan_mode`) remain externally
  owned, never duplicate themselves in Action and never count. Focus and
  Activity share ONE classifier, ONE latest-candidate rule, ONE Action
  formatter and ONE subtype-stat formatter (`src/tui/transcript/process-summary.ts`
  for the renderer-neutral classifier and stats; the physical Action slot line in
  `src/tui/components/transcript/compact-process-preview.ts` —
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
  `Action:`). Since the post-PR166 convergence this is structural: commands
  are a real `kind: 'command'` transcript node with NO `turn` field and the
  `control` semantic class, paired by `commandId` (`command/run` creates the
  running row, `command/done` settles the same row), with an explicit
  `sourceEventSeq`/`sourceCommandId` manual-compaction correlation joining a
  correlated `/compact` command into its compaction card (one visible owner,
  the card's search corpus keeps the command fields searchable). A
  `subagent/descriptor` materializes NO transcript row at all: it is the CHILD
  session's identity record (a continuable child logs it before its first
  `turn/start`; upstream asserts `descriptorIndex < turnStartIndex`), held by
  the viewer/catalog state, so it can neither form an Activity nor feed
  ActionStats. The parent's own genuine `tool/call name=subagent` is the
  delegation evidence and the Action.
- **One transcript left edge for container chrome (2026-09-22 v2 addendum
  §28; body-indent supplement).**
  The Focus root, Activity and the ambient Context
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
  icon or Compact gains progress-update narration guidance.
- **Compact historical process compaction (2026-09-29):** only the true
  latest/live Work keeps Think/Action previews. Settled historical Work
  collapses to its header. A historical Work with Thinking but zero Action
  evidence uses `Thought` as a presentation-only identity so header-only
  compaction does not erase its semantic meaning. Canonical Work
  ownership/projection is unchanged. The full behavior matrix, the
  window-authority (`hasNewer`) true-latest rule and the component-cache
  invalidation contract are owned by
  `docs/transcript-display-disclosure.md`.

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
  a following live call starts a new ownerless pending run — rendered fail-open
  as ordinary Preparing rows, never jumping back before the boundary
  (Compact collapsed/expanded and expanded Focus alike). A page/window change
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

- **`src/tui/transcript/structure.ts` (TS6; formerly `transcript-projection.ts`)
  is the canonical authority.**
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
- **`displayPolicyFor()` is the runtime materialization authority**
  (`src/tui/transcript/display-policy.ts`): `projectedBlocks()` selects the
  Compact / Focus / Full materializer from `turnLayer`, `processLayer` and
  `focusBehavior`, so the policy table and the runtime cannot drift.
  `isFocusDisplayPreset()` is the NEUTRAL behavioral answer
  (`src/domain/display/preset.ts`), exactly `preset === 'focus'` — it must not
  depend on the terminal disclosure policy (TS8-D).
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
- TUI/core local commands AND `!`/`!!` user-shell lines keep refusing
  attachments outright: their line is a UI control, never agent-facing input.
  The shell has no attachment delivery path (the user-shell owner in
  `src/app/submission/user-shell.ts` neither admits nor consumes drafts), so
  the refusal is what keeps a placeholder from becoming shell arguments. A
  client command contribution needs no refusal: its invocation is the BARE
  token only, so an attachment-bearing `/deploy [image #1]` line is never its
  invocation — it is an ordinary multimodal submission. A skill wrapper, a
  `/skill <name>` invocation and a plain prompt stay agent-facing and deliver
  their attachments to the model.
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

## Single-row presentation boundaries are explicit

Any renderer that budgets one returned `string` as one terminal row must
normalize caller-provided CR/LF before width measurement, marquee windowing,
hit-map construction, or truncation. Raw domain/runtime text remains unchanged;
the normalization belongs only to the presentation boundary.

A surface that intentionally supports multiline content must instead use a
multiline-aware renderer (for example `wrapTextWithAnsi` / `Text`) and budget
the resulting physical rows explicitly. `visibleWidth`, `truncateToWidth`,
`Frame`, and the overlay compositor are not newline sanitizers; fixing the
problem at those layers would hide already-wrong measurement and hit-map
assumptions.

The current containment applies this rule to `TaskBrowserPanel`,
`SearchablePicker`, and `SelectedMarquee`. During the planned interaction-panel
refactor, row cardinality must become an explicit presentation contract
(single-row vs multiline) rather than an accidental property of arbitrary
strings. The refactor must audit the remaining sibling surfaces, including
vendored `SettingsList` / `SelectList` consumers, extension header/dock/footer
single-row slots, history cwd rows, and attachment/file-name fallbacks.

Do not move this normalization into runtime/domain models: search, persistence,
replay, exports, and semantic projections must keep the original text.

## User shell display policy

- The capture layer (client/shell/output-capture byte/line/disk caps) is the memory
  safety boundary and is UNCHANGED; this policy only bounds what the card
  PRESENTS: a running card collapses to the newest 5 source lines, a
  settled card to at most 20 VISUAL rows, with an honest hidden-line
  marker. Ctrl+O (the existing master switch) expands to the retained
  buffer — everywhere EXCEPT fullscreen Focus, where Ctrl+O owns the
  Thought-root bulk and the shell cards keep their folded state (the
  `!`/`!!` card presentation is otherwise unchanged); a running card's
  result is re-chained to the bounded tail on a throttle.
- Quick dismiss (Alt+K) removes SETTLED cards only: a running card is
  never dismissed, the shell process is never cancelled (Esc owns that),
  no session event is deleted, and an already-submitted `!` context
  payload is untouched. `!!` stays Session/model-excluded: the Host
  executes it, while the completed result remains presentation-only.

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
fail-fast (re-vendor lifecycle follow-up P3, `src/tui/process-slot.ts`):

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
  teardown cannot fail open either. **Fail-closed slot ownership is not
  fail-fast cleanup** (M3-6 PR3): `TuiApp.dispose()` attempts EVERY final
  cleanup step (the non-truncating `runSyncDisposalSteps` batch), and only
  a completely successful batch releases the slot. Any collected
  final-dispose error therefore keeps the slot claimed while the remaining
  independent resources were still released. A sibling surface-cleanup
  error that leaves `TuiApp.dispose()` itself successful does NOT poison the
  slot: the surface records the failure and retirement/transport continue.
- The external-editor suspend/resume and ordinary stop/start cycles keep
  the claim (same generation, same ownership — no trip); fullscreen
  main/alt-screen swaps stop/start the SCREENS (not the app) and never
  touch the slot at all.

## Task Center uses one catalog with two presentation surfaces

Quick Tasks is the footer-triggered, Active-scope view; `/tasks` opens the full
Task Center in Tracked scope. Both surfaces consume the same durable preorder and
runtime projection.

**Attention dataset (M3-3B).** Task Center is current actionable state, not
execution history, and different sources own their own retention:

```text
Work dataset:       the shared Job/Subagent catalog + runtime projection
Attention dataset:  surface-composed current human interactions
                    (M3-3B starts with the continued Question)
Quick:              hidden actionable attention + active work
Full:               every current actionable attention row + tracked work
```

The Question controller owns the authority interpretation and exposes a
detached presentation model (`QuestionAttentionRow`); the pure
`app/surface/task-attention.ts` maps it onto panel rows (stable
`question:<sessionId>:<callId>` identity, `Needs attention` group, `?` glyph,
`awaiting answer` / `answering`), and the surface composes attention ABOVE the
work rows before the browser's first frame.

**Footer attention fact.** A parked actionable Question publishes its own `?N`
figure in the Task Center badge (`[? 1 awaiting · ↓ view]`, compact `[?1·↓]`),
together with the `↓ view` hint when the editor seat is available. It is a
fourth independent fact: it never joins the task/agent counts or the failure
count, and a visible Question is NOT counted because it already owns the
response seat (queued/settled/unavailable Questions are not counted either). A
Questions-only session therefore still advertises — and can open — its Task
Center reopen path.

Question rows are NOT work rows:
they carry no `startedAt`, never join the active-work count, never inherit stop
semantics, and the panel includes them by an explicit rule so a running Job can
never hide a pending Question. `Enter` on such a row reopens the controller
entry (closing the browser and returning the seat); a row that went stale
between rendering and selection fails closed and keeps the browser usable.

**Retired pre-B4-B Quick/Full interaction contract.** The former modal promotion
and Esc-restore flow, Quick `←`/`→`/`Tab` controls, and promotion pseudo-row
route are superseded; do not use them as current behavior. Current on-demand
Quick navigation and its optional Full action are specified in [The on-demand
Task Quick](#the-on-demand-task-quick-hidden-by-default-keyboard-focusable-b4-b).
The Full Task Center continues to own search, scope, stop, refresh, paging and
reverse (`Shift+Tab`) type cycling.

Active scope retains every ancestor
needed to explain an active descendant but does not promote that descendant to a
root. Terminal job failures are acknowledged only when a visible Task Center
row is opened; until then the footer keeps a failure marker and the ↓ affordance.
The stop action is a confirmed, capability-gated dispatch: continuable running
children use their durable direct parent authority, while running jobs use the
public job kill API. The browser never reads job output.

The Task Center is a live tracked/control projection, not an
execution-history list. Invariants (DSH `0.1.7` JobRegistry contract):

1. **Authority** — job rows are the current `jobs.list(sessionId)`
   projection and subagent rows the current descendant catalog; the TUI keeps
   no job tombstones or history cache.
2. **Presentation scopes** — internal `active` renders as `ACTIVE`,
   internal `all` renders as `TRACKED`. The internal `TaskScope` union and
   persisted view state keep `active | all`; only the label changed.
3. **Foreground shell** — rc.1 may temporarily register foreground
   `bash`/`pwsh` work while it runs; after a direct foreground completion
   upstream may `remove()` the record, and the row leaves the Task Center
   with the registry. The Transcript is the foreground execution history.
4. **Background handed-out jobs** — a terminal record stays visible in
   TRACKED as long as the registry retains it.
5. **No inference** — `JobView` carries no handed-out/provisional bit, and
   the TUI never guesses provenance from kind, tool args, Transcript cards,
   or timing.
6. **Transitions** — Quick defaults to Active; direct `/tasks` defaults to
   Tracked. Quick's Full action calls the same `openTasksBrowser('full')` route
   as `/tasks` and does not inherit Quick's Active scope. `A` toggles the Full browser between Active and Tracked
   (presentation only).
7. **Footer denominator** — the job denominator is the current tracked
   roster (preferred density says `tracked jobs`), not a session lifetime
   total; it may shrink when upstream removes a record. Compact density
   keeps the bare `1/3j` form.

## The selected-Job detail is a fullscreen workspace, not an overlay

Opening a Job row (`bash`/`pwsh`/`other`, or a `subagent` Job without a stable
child id) leaves the Task Center for a dedicated fullscreen Job workspace: a
typed header (the status title, the real metadata, the page's summary and the
Output/Command reading tabs), a retained-output body with its own Find row, an
optional reading-facts row, and a pinned bottom Action Bar. Between the body and
that bar a TRANSIENT notice row renders the app's own live notice while the
workspace owns the terminal, so a Stop settlement (a refused or unproven stop in
particular) is visible without leaving the Job view; it reuses the single app
notice and its lifetime rather than a second Stop state. The visual layout itself
is owned by the B1-D section below.

One chrome plan (`planChrome()`) budgets every fixed row from the live terminal
grant, in a fixed priority: the Action Bar first (it is NEVER budgeted away),
then the status title (from two rows), then one readable body row (from three),
then the Search row, the summary, the tabs, the transient notice, the metadata
row and finally the reading-facts row. Every optional row is granted only while
the reserved body row survives, and the metadata / reading-facts rows need enough
body left to stay worth reading, so a transient notice never squeezes the last
output row away and no optional row can push the Action Bar off the screen. A
Search row is only granted from four rows up, so a shorter frame cannot enter
Find at all, and a resize that takes the row away leaves the search (keeping the
paused viewport and its anchor) instead of pointing the physical focus at a hidden
editor. The workspace is its own screen, so the main transcript, the original
editor and the footer never take part in its layout, and the previous screen
(regular or transcript fullscreen) is paused with the Task Browser kept alive
underneath — `Esc` returns to the SAME browser instance, its selected row and the
original draft/scroll state.

Facts stay separated by construction: the workspace presents ONE captured
`JobInspectorState` (the opening row plus the latest detached observation), and
the body is exactly the port's retained tail — never a concatenation of status,
label and output. The three placeholders are distinct and honest: `Waiting for
retained output…` (no snapshot yet), `No retained output` (observed, nothing
retained) and `Retained output unavailable` (the observation port refused). A
`subagent` Job shows `Label` instead of pretending to be a shell command, and
every frame discloses `Retained preview · not full history` (on the reading-facts
row where the grant allows one, otherwise on the pinned Action Bar) — the tail is
bounded and is not the Job's archive. `Esc` and the `tasks.stop`
component action remain the only write intents; the Stop write stays the
existing capability-gated `jobObservation.stop`, and ordinary typing never
reaches the background editor or transcript.

## Job Output follow is End-only, and Find is Job-local

The Job Output is the ONE scrollable region of the workspace: `PgUp`/`PgDn`,
`↑`/`↓`, `Home` and the real terminal wheel (and an equivalent scrollbar jump)
move only that viewport, never the background transcript or Task Browser, and
never submit editor input. Follow is an explicit client-local intent owned by the
Job's own viewport, deliberately NOT the fork's automatic end-follow: opening a
Job follows the retained tail, ANY manual browse — paging, one line, `Home`, a
wheel notch, a scrollbar drag, or landing a search hit — pauses it, and `End` is
the ONLY key that resumes it. Reaching the last row by hand, a content shrink, a
viewport growth (terminal resize or a chrome row appearing/disappearing), a newer
snapshot and leaving the search all leave the intent paused, so the Action Bar's
`Follow on` / `Follow paused · End resume` text is the user's truth rather than a
`scrollTop` coincidence. `Ctrl+Home`/`Ctrl+End` stay pure browsing aliases (they
pause), and `End` is honoured even after the Job settled: it means "show the
newest retained tail", never a claim that new Job output appeared. The physical
`Home`/`End` viewport keys are RESERVED to the workspace: they are matched before
any Find binding, so a user who remaps the effective Find onto one of them still
gets End as the only follow re-arm (and Home as the preview top), while `/` —
never reserved — remains the Job-local Find entry; the Action Bar's Find hint
drops such a reserved binding rather than promising a key the workspace
consumes.

`Tab` is reserved the same way, for the workspace's own page toggle: the owner
matches it BEFORE the Find check — **unconditionally, in every search state** — so
a Find remapped onto `Tab` can never shadow the page switch the bar advertises
nor reach `openFind()` (in NAVIGATE that would flip the search back to EDIT). The
Find hint filters it out exactly like Home/End, only the inactive state performs
the switch, and while a Find owns the ordinary keys `Tab` is a consumed no-op. `/`
remains the always-available Job-local Find entry, so no remap can strand the
search.

`Ctrl+F` (or whatever the live keymap really resolves `app.transcript.search`
to, leader sequences included) and the non-configurable `/` alias open a Find
over the CURRENT retained Output only: the header, the `Command`/`Label`
summary row, the tabs, the notice and the background transcript are never
searchable, and an
empty/unavailable body reports `0/0 · No matches` instead of inventing a hit. The
binding is scoped to the Job — the Transcript search handler and the fork's
built-in search overlay are never entered from inside the workspace — while a
Find that is disabled or rebound stops advertising the old key. `Enter` moves
from editing to result navigation, where `n`/`N` cycle the matches; in the editor
those letters are query text, and in navigation every other printable key is
inert. The Search row shows its own `i/N` fact, the current match is strongly
highlighted while the other visible matches stay weak-underlined, and the
rendered row count and every visible width are unchanged. The first `Esc` leaves
only the search (keeping the paused viewport next to the still-open Job, with its
query remembered for the next `Ctrl+F`); the next `Esc` is the existing Back to
the Task Browser. `End` while a result view is up leaves the search and returns to
the tail as well — and the physical focus returns from the hidden Search row to
the workspace root. The Action Bar only promises keys the current search state
really accepts: while a Find owns the ordinary keys it does not advertise Stop
(the Search row consumes ordinary letters while editing and the read-only result
view keeps them inert), and while the query is being EDITED it also drops the
`End resume` suffix and the Find entry hint, because `End`, `Home` and the Find
chord belong to the query Input there; the result view keeps `End resume` and the
Find re-entry, and leaving the search restores the normal bar.

The retained window is the ONLY source any of this may read. The anchor and the
search hit are both carried against ONE baseline: the retained window that was
actually DRAWN last (its source, width and rendered rows) plus the proven row
eviction applied to it since. When the port's bounded tail evicts old bytes, the
newest window is compared with that baseline — by ANSI-stripped visible content —
and the total eviction moves the visible top row and the current hit together, so
several snapshots landing before the next frame keep the exact same row instead of
re-applying or discarding an eviction, and a different occurrence that happens to
reuse the old row/column coordinates can never inherit the current hit. A window
with no provable overlap (a width re-wrap, a fully replaced preview) keeps the
offset and lets the viewport clamp it, never guessing and never fabricating a
`GAP`; `[GAP]`
still comes only from the official `gapBefore` fact, `[ERROR]` from the
observation error and `[SETTLED]` from the official settlement, and they remain
independently co-visible. The Action Bar's `rows a-b/N` is the position inside
THIS retained preview, never a Job-history line number, and it yields to the
disclosure when the row is narrow. Search indexes are rebuilt for the current
window/width/query only; a match that left the window cannot leave a stale
highlight or `i/N` behind. A surviving current hit stays current across a newer
window while its row is still provable (a pure append never resets `n`/`N`),
because the hit is carried through the SAME proven row mapping as the anchor —
never as a bare coordinate key, which an eviction could hand to a different
occurrence. A width change has no such mapping at all (the rows are re-wrapped),
so the carried identity is dropped there rather than compared across widths. Only
when the current match itself cannot be proven in the new window does the
selection fall back to the nearest PROVABLE match at or after the visible anchor
rather than to an old ordinal, and that visible anchor is the viewport the frame
ACTUALLY painted — synchronised at every frame commit, so a plain scroll moves it
even when no Job output arrived.

Not yet claimed here: the Command reader, the exact original-text selection and
the two Copy verbs live in their own sections below. Search, follow and the
retention anchor above are B1-B.

## The Command page is a mutually exclusive second body of the SAME workspace

A shell Job (`bash`/`pwsh`) whose OBSERVED `label` is non-empty gains a Command
page inside the same workspace, the same `TuiAltScreen`, the same Job and the
same observation: `Tab` on either page toggles between Output and Command, or a
click on the visible Command summary / its `↗ Command` entry / the `Command` tab
switches to it; `Esc` returns to Output (it never closes the workspace
and never releases the observer). `Tab` replaced the former Job-local `v` open
verb: one symmetric key now owns the page toggle in both directions, and `v` is
inert. `Label:` Jobs (`subagent` and every non-shell
kind) never grow one — the entry is gated on the OBSERVED kind plus a non-empty
label, so an opening Task row that merely looks like a shell command can show a
read-only summary but cannot open or copy a Command, and a Job whose eligibility
disappears returns to Output synchronously, dropping the Command hit map, the
selection and the editing focus with it.

Both bodies and both Search rows are mounted ONCE for the whole panel lifetime
and made mutually invisible by the layout's own `visible` entries, so exactly one
body is ever laid out and exactly one is the primary ScrollView. The Output page
therefore keeps its follow intent, its viewport, its anchor and its query across
any number of round trips; entering or leaving the Command page never calls
`pauseFollow`/`resumeFollow`, and the Command page never shows an Output Follow
state, never shows the Output retained-preview disclosure (it shows `Full
command` instead) and never advertises Stop. `End` on the Command page is that
document's end (it has no follow to re-arm), while `Home`/`End`/`PgUp`/`PgDn`/
arrow/wheel/scrollbar all move only the page the user is reading.

`Ctrl+F` (or the live effective binding) and `/` open the CURRENT page's own
Find: two independent `JobOutputSearch` instances with their own query, mode,
epoch, `i/N` fact and reveal, so a Command query never inherits the Output query
or its match ordinal. Switching pages ends the current Find's INPUT ownership
(the query is kept for the next open) and returns the physical focus to the
workspace root, and `C` while a Find owns the ordinary keys is query text —
never a copy.

## Command copy is original-text only, through the existing Client clipboard

Three verbs share the ONE existing Client-local capability
(`ClientActions.copySelection`, injected into `TuiApp`); no Host port, no new
clipboard service, no remote OS clipboard and no `process.stdout` write is
introduced.

- **Output Copy** (`C` while no Find owns the ordinary keys) sends the
  `JobObservedSnapshot.text` captured at the keypress, verbatim: no trim, no ANSI
  strip, no header/marker/decoration, no Command source, and no claim about
  evicted history.
- **Command Copy All** (`c` on the Command page, or a click on the painted
  `Copy All [C]` button) sends the ORIGINAL `JobObservedSnapshot.label`: leading and
  trailing whitespace, TABs, CRLF and a trailing newline all survive, and the
  display prefix, ellipsis, escapes and alignment spaces are never part of the
  payload. On a frame too narrow to paint the whole button no click target is
  created at all, and `C` remains the reachable path.
- **Command drag selection** sends `label.slice(start, end)` for the half-open
  UTF-16 range the gesture covered.

Every DYNAMIC field the workspace CHROME paints crosses ONE display boundary that
strips complete CSI/OSC/APC/DCS sequences and drops any remaining C0/C1/DEL byte:
the header rows (Job identity, kind, status, progress, detail, the Command/Label
summary and the follow-stream error) AND the transient notice row, which embeds
the Job label in a Stop settlement. Both rows carry Host-supplied metadata on a
screen the fork also uses for its own terminal control, and the theme's own
styling is applied AFTER that projection, so it is never stripped with it. The OFFICIAL bytes are
never rewritten: the `View`, the Command document and every copy payload keep the
raw `label`/`detail`/`progress`, and the Command body shows control bytes as
visible escapes rather than executing them. A `label` carrying its own OSC 52 is
therefore painted as plain text and can never reach the terminal stream from
either row. (The Task Browser's own stop notices interpolated the roster label the
same way; that pre-existing sibling was outside B1-C and was reported there. It is
closed by the Task Browser Host-text terminal-safety boundary recorded below.)

The Command page renders a dedicated document model rather than the vendored
`Text` renderer, because `Text` expands TAB to three spaces, word-wraps and
`trimEnd()`s every wrapped row — round-tripping those rows could never reproduce
the original bytes. The model scans the label once per (source, width) and keeps,
for every painted cell run, the exact original UTF-16 range it came from:
`\n`/`\r\n` are real hard-break tokens whose offsets stay in the source, soft
wrapping inserts nothing, TAB paints three cells but maps one `\t`, a lone `\r`
and every other C0/C1/DEL byte are painted as safe text escapes (`\x1b`, `\x00`,
`\r`, …) that still map back to their single original character, and a grapheme
wider than the whole grant paints one placeholder cell while still mapping in
full. Padding to the terminal's right edge forms no run, so it can never be
dragged into the payload. A changed label, a width change, a page switch, a blur
or a dispose cancels the gesture instead of re-mapping stale offsets.

The selection itself is consumer-layer: the published `MouseRegion` wraps the
Command body as the ScrollView's only child, returns `capture: true` on a left
press, and resolves every press/drag/release against the LAST PAINTED viewport
geometry (read at the frame-painted boundary) plus the live scroll position —
never the press-time captured origin, which goes stale as soon as an edge scroll
moves the viewport. The range is SYMMETRIC and inclusive at both ends: the
document-order earlier endpoint aligns to its grapheme's start and the later one
to its grapheme's end, whichever end the user pressed first, so `a → c` and
`c → a` over the same line copy identical bytes and the pressed grapheme is never
dropped. A same-cell click selects nothing and copies nothing. The wheel is
deliberately left UNHANDLED so the fork's own routing scrolls the active
viewport, and the scrollbar keeps the fork's existing interaction.

Auto-scroll follows the fork's own gesture feel: a PRESS only anchors (it never
starts a timer), and once the gesture has really dragged, reaching the body's
visible FIRST or LAST row — or leaving the body entirely, which keeps the clamp —
starts a temporary 50 ms timer that scrolls one row and grows the selection over
the rows that scroll in. A one-row viewport has no distinct edges, so the same
cell never implies both directions: it scrolls only when the pointer clearly
leaves the body. The timer stops as soon as the real document boundary cannot
move the viewport any further, and it belongs to the gesture alone — it is
released on release, page switch, resize, blur, label change, workspace exit and
dispose. Only the Command viewport moves; the Output page's follow intent and
scroll position are untouched by any of it.

Both Copy verbs capture the payload SYNCHRONOUSLY and only then hand it to the
app, so a snapshot arriving while the promise is in flight can never rewrite what
was requested. The settlement re-proves the exact Job workspace record before it
may notify: a copy that lands after the user left that Job — or after a
replacement viewer opened — is dropped silently. `true` from the clipboard
strategy only proves the bytes were EMITTED (OSC52 has no clipboard ACK), so the
notice reads `Copy sent` and never claims the system clipboard received them; a
`false` result and a rejection both read `Copy failed`, and a composition that
does not wire the owned-task entry reports the same failure instead of looking
inert.

An intent with NO payload is answered by the reason the panel captured, never by
a generic silence and never by a clipboard write: an observed-but-empty retained
Output reads `Nothing to copy`, a not-yet-observed (or refused-observation)
Output reads `Output unavailable`, and a Command copy that lost its eligibility
reads `Command unavailable`. The workspace does not guess and does not reshuffle
the sources: a Command page that cannot be entered makes no request at all, and
an empty gesture (a click, or a drag that covers no cell) is not a copy intent, so
neither produces a request or a notice.

The header's Command summary, its `↗ Command` entry, its `Copy All [C]` button
and the other page's tab are plain painted cells, so they route through the alt
screen's existing press/click callbacks against a hit map produced by the LAST
PAINTED header frame (the header's own painted top row included). A region is
exactly the painted TEXT it names: the summary and the `↗ Command` entry are two
separate regions, the `Copy All [C]` button is its own, and the padding in between
stays inert. The release must re-prove the SAME action, the SAME page, the SAME
Command source identity AND the same relative row/cell range the press named, so a
repaint between press and release — another Job, a re-flowed header row, a
narrowed button — can never fire a ghost open or a copy of different bytes. Both verbs also
have their fixed Job-local keyboard fallbacks (`Tab` for the page, `c` on either
page), so nothing is mouse-only. The keyboard and the pointer are separate
intents: while a Command Find owns the ordinary keys a plain `c` types into the
query (or stays inert in result navigation) and neither state advertises a
keyboard Copy, yet the still-painted `Copy All [C]` remains clickable — one click
copies only the official original label, and it never touches the query, the
current hit, the search mode or the search input's focus.

The Action Bar keeps B1-A/B's retention order and simply appends the two
read-only verbs at the LOWEST priority, so a narrow row drops `C copy output`
before `Tab switch` and both before any pre-existing truth (`Esc back`, Stop,
Follow, `[GAP]`, the retained/full disclosure, the position fact and the Find
hint). At 80 columns that means the verbs are usually not advertised at all while
their KEYS stay fully functional: no half-painted affordance is ever shown, no
action that cannot execute is advertised, and a `Copy All [C]` whose row the
frame could not grant leaves no click target behind. The B1-D reading tabs are the
long-term entry point for these verbs; the KEYBOARD fallbacks and the drop order
above are unchanged there.

The Command page therefore suspends the fork's OWN copy-on-select while it is
shown (and restores whatever the screen started with on Output), because that
native path classifies a SECOND click inside the fork's 500 ms double-click window
as a word selection and would copy the word under the pointer through its own
trimmed screen-text path — overwriting the exact command copy the button just
made. The Command body's precise drag selection does not depend on it: it is the
`MouseRegion` path above. The Output page keeps B1-A's native selection copy on
purpose (dragging the retained body still copies screen text), which also means a
rapid double click on the Output page's `Command` summary (or its `↗ Command`
entry) copies a screen word instead of opening the Command page — the pre-existing screen-wide behaviour, not
a B1-C regression; a single click always opens the page as documented.

## Job Workspace visual layout after B1-C (B1-D)

B1-D is a PRESENTATION change on top of the merged B1-A/B/C behaviour: the same
panel, the same ONE observer, the same two reading pages, the same copy sources
and the same press-time hit-map owner, with a readable hierarchy. The frozen
visual order of one frame is: the status title, the optional metadata row, the
page's summary row, the reading tabs, the current page's optional Search row, the
body, the optional reading-facts row, the transient notice row, and the pinned
bottom Action Bar. `planChrome()` above remains the ONE budget; no component
computes its own `terminal.rows` share.

- **Status title** (from two rows): the fixed `Job` label, the Job id and kind,
  then the ONE shared `‣` marker plus the Title Case status word in
  `taskStatusColor` and the independent `[GAP]`/`[ERROR]`/`[SETTLED]` markers
  (warning/error/muted). The
  status and its markers are laid out FIRST, so a long identity truncates itself
  and can never push the status out of its row, and the markers stay readable
  without colour.
- **Metadata** (standard frames only): the real `progress`/`detail` plus the
  descriptive `Earlier output evicted` / `error: …` facts. Progress outranks
  detail, and the descriptive facts claim at most half the row, so an unbounded
  progress value can never make the independent gap/error reason unreachable. No
  row is drawn when the view has no such fact — never a blank placeholder.
- **Summary**: on Output, `<Command|Label>  <label>` with the right-aligned
  `↗ Command` entry ONLY while a shell Command is really observed (the opening row
  may show the read-only summary but never grows the entry); on Command,
  `Full command` with the right-aligned `Copy All [C]` button. Every non-shell
  kind reads `Label`, and no arrow, button or Command tab exists for it.
- **Reading tabs** (one row): the CURRENT page is bracketed and emphasised
  (`[Output]`/`[Command]`, compact `[Out]`/`[Cmd]`), the other page is plain, and
  a themed `─` run fills the rest of the row (CJK/wide labels included: the run is
  sized in terminal cells). The tabs derive from the existing `readState.view` —
  there is no second `selectedTab`/`activeReadView` state — and only the OTHER
  page's label is a hit target: the current page's bracketed label is a status
  marker, so clicking it changes nothing.
- **Body**: the same B1-B/B1-C renderers on the terminal's own background — never
  a second card, frame, `$` prefix or injected colour that could reach a payload.
- **Reading facts** (wide and tall frames only): ONE unflanked status row carrying
  the page's own disclosure (`Retained preview · not full history` / `Full command`)
  on the left and the real `rows a-b/N` position of THIS retained preview on the
  right. Where the frame
  grants no such row, the pinned Action Bar keeps the bounded disclosure instead:
  one fact is never advertised twice in the same frame, and neither form ever
  claims a complete history.
- **Action Bar**: pinned last and painted with the theme's muted token —
  `Esc back`/`Esc output` (last), the legal `tasks.stop` primary hint, the strict
  `Follow on`/`Follow paused` truth, `[GAP]`, the effective Find key, the Job-local
  `Tab` page toggle and `c` copy verbs and a pure `PgUp/PgDn` browsing hint, each
  yielding in the B1-B priority
  order. Every entry is gated on the LIVE frame: the Find hint appears only while
  the frame can host a SearchRow and the query is not being edited, the page hint
  only while a body row is really painted and the query does not own the ordinary
  keys, and the preview position only while a body is painted — a frame that
  cannot act on a hint never advertises it.

Responsive grants use the same 80×10 boundary B1-B already owned: `rows>=4`
grants the SearchRow, `rows>=5` the summary and the tabs, `rows>=6` the transient
notice, `cols>=80 && rows>=10` the metadata row (and only with at least four body
rows left), and `cols>=100 && rows>=12` the reading-facts row (with at least six
body rows left). Below those floors the optional rows disappear in that order and
the body keeps at least one row from three rows up: `rows=2` is status + Action
Bar, `rows=1` is the Action Bar alone with `Esc` still reachable. A live notice
therefore yields at five rows and takes its own row at six only because one body
row survives.

Copy payloads are UNCHANGED: Output Copy is still `observed.text`, Command Copy
All is still the original `observed.label`, and a Command drag is still
`label.slice(start,end)`. The new chrome adds no copy source, and a rendered,
highlighted or truncated string is never fed into a payload. The Command page
still suspends the fork's native copy-on-select (the Output page restores the
setting the screen started with), and the Output page keeps B1-A's native
selection copy on purpose.

The hit map remains "the LAST PAINTED frame, and only its painted text": the
header produces the regions its own render really painted — the summary and the
`↗ Command` entry as two separate regions, the `Copy All [C]` button, and the
other page's tab — and a release re-proves the same action, page, Command source
identity and the same relative row/cell range. Hidden and zero-grant affordances
keep no target, and a row the frame had to truncate keeps only the label cells it
really painted: the ellipsis `truncateToWidth` substitutes is inert, so a frame
too narrow for the label can never be triggered through its own overflow marker. The `open-output` action added for the Output tab
routes to the existing `showOutput()`, so a tab click is the SAME page switch as
`Esc`/`Tab` (Search exit, selection cancel, native copy-on-select restore and the
repaint included) and never a display-only body swap.

No Job fact is invented: the chrome renders only the fields
`deriveJobInspectorView` already projects, and every Host-supplied string
(`label`, `detail`, `progress`, the follow-stream error, the notice text) crosses
the SAME `chromeText()` control-sequence boundary BEFORE the theme styling is
applied, exactly as the B1-C section above records.

## The Settings workspace: a three-level projection whose Theme and Display rows are editable (B2-A → B2-B)

`/settings` opens a dedicated fullscreen Settings workspace instead of a
72×28 `SettingsList` overlay. The workspace is a read projection of category /
row / detail navigation over a detached snapshot; since B2-B, exactly TWO of its
rows (`Configured theme`, `Transcript display`) also own a real write channel,
and nothing else does.

- **Post-B2-A navigation decision: three levels, not focus owners.** The
  workspace always has exactly three levels — L0 `categories`, L1 `rows`, L2
  `detail` — and the panel's `focus` is the only navigation state. `Right`
  advances exactly one level; `Left` returns one level and is inert at L0.
  `Enter` follows the same level transition, while `Esc`/`Backspace` step back
  (and close at L0), at EVERY width. `Up`/`Down` act on the current level.
  `Tab`/`Shift+Tab` remain inert; the retired medium-only Tab focus cycle and
  header category switch are not restored. A writable row enters L2 choosing
  in one step from L1; a read-only row enters L2 browse. A new open always
  starts on L0.
- **Responsive three / two / one projection.** Width only decides how many panes
  of the current level are painted: `>=108` columns render the three-column
  `Categories | Settings | Details` layout; `76..107` derive their two columns
  purely from the current level (`focus === 'categories'` → `Categories |
  Settings`, otherwise `Settings | Details`); `<76` renders the current level
  alone. Hidden panes are neither painted nor addressable — they publish no hit
  target and own no wheel — and row text is laid out against the pane width it
  is actually painted in, so the medium rows column may differ between L0 and
  L1. The single width breakpoint table is the panel's own freeze, not a
  project-wide rule.
- **The pilot rows are real read facts.** Appearance shows `Configured theme`
  and `Icon style`; Display shows `Transcript display` (the LIVE
  `runner.displayPreset()`, with the persisted `.displayPreset` named as a
  separate last-read fact) and `Thinking detail` (the live
  `app.isThinkingExpanded()`). Every row states its Scope and freshness; a
  missing document is `unavailable` and a `get()` throw is a `read-error`, never
  a fabricated default. The theme row's `value` is the source-qualified
  configured identity (`plugin:…`/`file:…`) and its summary is the friendly
  display name — the raw identity is what `C` copies. The header is a pure level
  breadcrumb (`Categories` / `<Category> · Rows` / `<Category> · <Row>`) plus an
  `N editable rows` badge at 76+ columns; it paints no interactive cell.
- **Browse and copy never write.** Navigation and `R` (re-read the same
  authorities, no subscription and no shadow store) never touch the configuration
  document. `C` copies the captured row's exact `value`; during L2 choosing it is
  active only while the painted Action Bar advertises `c copy`, using the existing
  `copySelected()` path and never the draft candidate. A row without a write
  channel says so (`read-only here · Other settings edits this row`) and paints no
  edit verb.
- **The L2 edit phase is transient, not a fourth level.** On the two writable
  rows, `Right`/`Enter` (or the painted `[Change…]`) opens an in-pane choice
  directly from L1; the same Detail pane keeps current-value and Runtime/Persisted
  facts above the candidates. `Up`/`Down`/`Home`/`End` move candidates without
  writing, `PgUp`/`PgDn` and the wheel over facts scroll only the fact region, and
  the candidate list scrolls independently under its own wheel region. The active
  multi-column pane title (for example `[Details]`) remains while one content row
  remains; it yields only when it would replace the sole content/candidate row.
  `Enter` or `[Confirm]` is the only commit; `Left`/`Esc`/`Backspace` or `[Cancel]`
  cancels directly to L1 with ZERO writes. Only an explicit confirm dispatches,
  and a candidate whose source is gone (an unloaded `plugin:` theme) is listed as
  `unavailable` and refused at confirm and at retry. The heading `Choose value`
  names the shared in-pane selector; a long or CJK candidate WRAPS rather than
  being truncated, every painted candidate row is a real hit target, and the
  exact candidate value (source-qualified for themes, never its label) must be
  visible before keyboard confirmation. If it has scrolled out of view, the first
  Enter reveals it and the next Enter confirms. The frozen 44×8 allocation remains
  the default; under the owner-approved bounded exception, an identity that needs
  more candidate rows first reclaims the optional `Choose value` heading and, only
  if still needed, reduces facts to one original `Value` row. Confirm and `Enter confirm` are
  painted only when the complete identity fits; identities beyond that capacity
  remain unconfirmable at 44×8 and require more height. A layout WIDTH change
  re-flows wrapped candidates and participates in the reveal rebase exactly like a
  candidate or viewport change (while a plain repaint never fights the user's own
  scrolling), and a source that unloads under an open choice re-anchors it on the
  candidate VALUE. One commit at a time: while a write is pending the edit verbs
  are not painted, and the panel holds exactly one request identity, so a
  superseded or post-close settlement can never repaint.
- **Runtime and persisted are two facts, always drawn apart.** A writable row's
  Detail names the live runtime fact (`Runtime` for the theme palette —
  `app.currentTheme()`/`app.activePluginTheme()`, never the configured value) and
  the stored preference (`Persisted`, or `Value` where the row's primary value IS
  the persisted one). The stored fact is the one the READ proved: the value, `not
  set` for a readable document that carries no value, or an explicit
  `unknown — …` when there was no document to read — the panel never guesses which
  of those it is. The commit status is field-scoped and shown only on the row
  that owns the phase: `Saving…`, `Verified · the authoritative read agrees`,
  `Not saved · <real reason>`, `Commit accepted · verification unavailable ·
  <reason>` or `Outcome unknown · <reason>`. `Verified` requires a completed
  mutation, a `configReadiness() === 'ready'` re-read and a matching authoritative
  value (theme after canonical normalization, display preset exact). A write that
  returned success but could not be re-read is `Commit accepted · verification
  unavailable`; one that returned success while the authority READABLY disagrees is a
  failure (`Not saved · the write reported success, but the authoritative document
  reads …`), never "verification unavailable" — the readback was performed and
  disagreed. A REJECTED write is classified on a fresh authoritative read against the
  value the request STARTED from (its base): only an authority still carrying that
  base REFUTES it (`Not saved · <the real error>`), while a third value (someone else
  wrote in between), the requested value already in place — an external writer may
  have reached it first — or an unreadable authority proves nothing about THIS request
  and is reported as `Outcome unknown`, never as a claimed acceptance and never as a
  refusal the authority contradicts.
- **The write path is the existing one.** The commit runs through
  `serializeTuiSettingsMutation` over `ConfigPort.tuiSettings`, re-reads the
  document inside the queued task, preserves the raw USER `footerCustomItems`
  (fail-closed when unavailable) and changes exactly one field. The Display preset
  applies through the SAME `TuiApp` DisplayState owner `/display` and `/focus`
  use and then persists ONCE: the runner's own `setDisplayPreset` (apply-first
  plus a detached best-effort write) is deliberately NOT used, because it would
  dispatch a second write. `/display`, `/focus`, `/footer` and the legacy editor
  keep their existing semantics.
- **A non-ready backend never fakes a save.** A theme commit is refused before
  anything is applied when `configReadiness() !== 'ready'`; a display commit may
  still apply the Client-local runtime fact and then reports exactly that
  (`applied locally, but the configuration is stale so it could not be stored`).
  A refused write leaves the runtime ahead of the document and says so instead of
  silently rolling the applied palette back.
- **The theme `auto` apply is the terminal query, fenced on ONE runtime-owned
  intent.** Choosing `auto` drops the plugin-theme record FIRST (the unload fallback of
  a theme the user has left must never force `dark` and stop the terminal tracking over
  a stored `auto`), starts the one OSC 11 detection and enables tracking — starting the
  detection IS the apply, exactly like `/display`'s runtime-first policy. Every
  DELIBERATE selection records the runtime owner's intent
  (`TuiApp.noteThemeSelection()`: the boot restore, the legacy `/settings` theme row,
  the Settings workspace, the reload re-apply, the advanced host-state `setTheme`),
  and both the settled detection (`runAutoDetect`) and the live scheme listener are
  fenced on it instead of on the asynchronous document — an explicit theme applies
  runtime-first, so the persisted value can still read `auto` while its write is in
  flight, and neither a late answer nor an already-queued scheme report may colour
  over the newer choice. Derived applies (a detection's own answer, a report, the
  plugin-unload fallback) never record the intent. The detection is issued for the screen
  that owned the terminal, and a screen hand-off RELEASES that observation with it — the
  answer is dropped rather than trusted about a screen the user has left. Every hand-off
  completion (both directions of a fullscreen swap, the Job/Settings workspace opens and
  the return to the surface they paused) re-samples ONCE when the latest intent still
  follows the terminal, awaiting the abandoned observation so it starts a fresh one on the
  screen that now owns the terminal. A stale answer therefore cannot colour a new screen
  AND an in-flight query is never simply lost. Mode 2031 is per screen: the leased workspace screen joins the same tracking
  sync, so `auto` chosen INSIDE the workspace subscribes the screen that really owns the
  terminal (and a manual choice releases it) instead of waiting for the lease to end.
- **Navigation never loses identity.** Selection is the stable row/category id,
  and width changes only re-project the layout: the level, the category and the
  row survive a resize in both directions, and the list rebases to keep the
  selected row (or the highlighted candidate) visible instead of scrolling the
  whole screen.
- **Mouse follows the last painted frame.** A category/row click selects the
  clicked item and takes its level's focus without advancing; clicking ordinary
  visible Detail content from L1 enters L2 (the same one-step choice for a
  writable row, browse for a read-only row). Any click that leaves L2 cancels an
  uncommitted choice atomically, including a click on the same row/category.
  Painted `Copy value`/`[Change…]`/`[Retry save]`/`[Confirm]`/candidate/legacy
  cells act on the item they are painted for regardless of the keyboard level,
  and a click is refused unless release re-proves the press-time kind, id, painted
  row, cell range, state version, level and category. A button that does not fit
  the pane WHOLE is not painted and publishes no hit target; wheel events scroll
  only the painted region under the pointer (facts and candidates are independent
  while choosing).
- **The legacy complete editor stays reachable.** The permanently visible
  `Other settings` category holds one row, `Open existing settings…`. Activating
  it retires the workspace (restoring the surface it paused) and only then opens
  the pre-B2-A `SettingsList`, so Icon style, Thinking detail, the Plugin Manager
  submenu, permission/session rows, extension settings and every existing write
  path are unchanged; `TuiApp.openSettings()` and its other callers keep their
  exact semantics.
- **The workspace is a physical screen lease** (§10.3 of
  `overlay-focus-contract.md`), mutually exclusive with the Job workspace and
  pre-empted by Question/Approval/Save. A dispatched commit survives the close
  under its runner owner, but its settlement is fenced by the screen record and
  the panel's request identity: it never repaints, notifies or addresses a
  replacement workspace.
- **Still read-only / still later.** `Icon style` and `Thinking detail` remain
  readable rows in this slice (their full editors stay behind `Other settings`);
  the remaining Settings migration and B4 Task Quick are later slices, and
  closing B2-B on these two rows is not Gate-3B closure.

## History is an Editor-seat tenant with an independent Preview (B3-A)

`Ctrl+R` no longer opens a managed overlay. Phase 3B / B3-A projects the
`HistoryPanel` into the editor seat through the Phase-3A optional tenant, so the
live Transcript keeps rendering above it and the ordinary footer below it while
the seat shows the History surface.

- **One vertical presentation at every width.** Header (`Input History` + the
  responsive scope tabs + the `F2` hint), query row, a `Results · N matches`
  counter, a single-line results window capped at eight painted rows, a divider,
  the `Preview` + `rows X-Y/N` heading with the copy actions, the soft-wrapped ORIGINAL
  prompt and one trailing metadata row. The retired 100-column split/stacked
  overlay layout, its width cap, its 7-row detail clamp and its `… more` marker
  are gone: the Preview never truncates the source, only its viewport.
- **The grant is live.** `planHistorySeatLayout()` derives the row budget from
  the real terminal rows (63% normal / 80% expanded by `F2`) and the measured
  non-History pinned chrome minus one reserved transcript row; the header, query
  and footer hint have first claim, and the shrinkable body splits between the
  results window and the Preview. A small grant drops the Preview (and then the
  footer with the hint folded into the header) LONG before it drops the visible
  selected result; a grant too small for any body row disables acceptance of an
  unpainted row.
- **The Preview keeps its place across a re-wrap.** The scroll anchor is the
  SOURCE UTF-16 offset of the first painted source row (`previewAnchorOffset`),
  and the visual row is derived from it at every width, so narrowing or widening
  the terminal keeps the reader on the same TEXT instead of the same row number.
- **The Preview is the copy authority.** List labels are single sanitized lines;
  the Preview is built from the shared neutral source-text layout
  (`src/tui/components/source-text-layout.ts`, extracted from the Job Command
  document, whose named exports and tests are unchanged), so every painted cell
  maps back to an exact original UTF-16 range. `Alt+C` / `Copy All [Alt+C]` copy
  the stored `content` byte for byte and the Fullscreen Preview drag copies an
  exact original substring — never a rendered or truncated row.
- **Pointer support is Transcript Fullscreen only.** The alt screen's existing
  component dispatch delivers press/drag/wheel to the panel, which resolves
  against its last painted frame (width/height, painted result identity, search
  generation). A result click selects; the explicit `Use Selected [Enter]` and
  `Copy All [Alt+C]` cells act, and each action is bound to the result ID it was
  pressed for. Only the LEFT button may start, extend or finish a gesture: a
  right or middle press falls through to the terminal's own handling (e.g. the
  Windows right-click paste path) and can never select, drag or activate a
  button. A Preview drag copies only when its RELEASE lands inside the painted
  Preview of the same last-painted frame, and the release position IS the final
  endpoint (a terminal may fold the last motion into the release event) — a
  release outside it, on another painted region, or after a width/height change
  safely cancels (no copy, no surviving selection), and an ended gesture can
  never be extended or resurrected by a later motion event. The regular main screen writes no mouse mode and installs no
  bridge: the panel refuses every pointer event there, and the terminal's native
  selection/scrollback is untouched.
- **Draft and cancellation.** Accept writes the accepted `content` into the
  CURRENT editor winner through `setEditorText` (never a submit, never the hidden
  host editor), after the tenant lease is retired and the captured session
  identity re-validated. `Esc` / `Ctrl+C` close the seat and leave the draft,
  cursor, input mode and pending paste content exactly as they were; those two
  keys are consumed by History while it is the active seat tenant, so closing it
  can never interrupt the agent or quit the TUI.
- **Currentness at every ACTING entry.** The host's `isCurrent()` (B3-B: the
  captured `SessionScopeAuthority` pair — the exact owner + generation — see the
  B3-B section below; B3-A used the live session-id string plus the surface
  generation) is injected into the panel as `tenantIsCurrent` and evaluated at
  the pointer entry (the fork dispatches mouse
  events outside the Host key ladder, so nothing else would notice a session
  change first), at the acceptance/copy eligibility checks and at the async search
  commit — a page that was in flight for a previous session is never published
  (the seat keeps its current rows and stays inert: no acceptance, no copy, no
  pointer action) and the CALLER keeps the lifecycle: the panel never retires
  itself from that async path, so the fire-and-forget search cannot reject. The
  host's next revalidation entry retires the stale tenant through its ONE close
  path; treating the session-switch publication itself as a revalidation entry is
  deliberately NOT done in B3-A (it would extend the Phase-3A revalidation seam
  and let UI teardown failure propagate into the session commit). B3-B later
  supersedes this with the SEPARATE, non-throwing `retireStaleHistorySeat()`
  publication port (see its section below), so the seam extension B3-A avoided
  never happens.
- **B3-B closes the lifecycle and currentness.** The full Question/Approval
  FIFO PARK/restore, the publication-time retirement, the authoritative Session
  owner generation with ABA protection across async queries/acceptance, and the
  L6 closure are B3-B (see its section below). B3-A's basic park/restore and
  refusal path are the foundation; closing B3-B is not Gate-3B closure.

## History Session lifecycle and design-language closure (B3-B)

B3-B closes the two B3-A deferrals without a second authority and restyles the
seat to the frozen design language.

- **One Session authority, captured once.** At `Ctrl+R` the application
  composition calls the runtime's single `SessionScopeAuthority.capture()` and
  injects `{ sessionId, isCurrent }` (`HistoryOpenScope`) into `TuiApp`; the
  seat's search/accept/copy/async/pointer guards all re-read that ONE capture.
  The old History-only `historySearchSessionId` getter and the mixed
  `TuiApp.generation` check are deleted. A session switch, a same-id reopen
  (A→B→A), a same-owner generation bump and the sessionless→first-session
  publication all fail the exact-owner/generation fence — no History epoch, no
  shadow counter, no Session class reaches the TUI.
- **Publication-time physical retirement.** `SurfaceRuntime` gains a PRIVATE
  `retireStaleHistorySeat()` instance port (never on `SurfaceDisplaySeam` or any
  TSP/Host API) that delegates to `TuiApp.retireStaleHistorySeat()`, which
  reuses the ONE existing `revalidateOptionalSeat()`. The runner calls it from
  the three `publishOwner` seams immediately after `beginInputHistoryScope`
  (ordinary switch, fork adoption, first-session), before any post-commit await,
  and the ownership core's single `resetForGeneration` hook calls it for a
  same-owner generation bump. The call is synchronous, state-only and strictly
  non-throwing: a tenant cleanup failure routes to the owned-failure reporting
  channel and can never roll back or mask the already-published Session. The
  owner commit is the logical fence; this port performs the physical close.
- **Accept reentrancy.** `onAccept` closes its OWN lease, then re-reads the
  captured scope (not the now-closed panel instance) plus the live
  blocker/newer-tenant/focused-overlay facts before `setEditorText`, so a newer
  owner that took the seat during the close keeps the keyboard and the current
  editor.
- **Design-language alignment (History only).** Identity/Header, active scope
  `[Label]` (bold `primary`), `> ` + bold `textStrong` selection, per-span
  secondary facts, `Results`/count tokens, bracket-less
  `Copy All [Alt+C]` / `Use Selected [Enter]`, labeled metadata facts, and a
  History-local whole-segment action bar with `Esc` last. Geometry, the
  0.63/0.80 grant, the eight-row list cap and the Preview's independent source
  anchoring are unchanged from B3-A; the shared `ACTION_BAR_SEPARATOR` is not
  touched.

## Task Browser Host-text terminal-safety boundary

A Task Center row is a projection of arbitrary Host/external text: the official
Job/Subagent label, a parent label, a Job detail, a caller header and a transport
error message. None of those bytes are trusted to be terminal-safe, and the Task
Browser owns no second text model — the whole surface is closed at its two real
display boundaries, both reusing the existing `sanitizedPhysicalLine()` projection
(recognized CSI/OSC/APC sequences stripped whole, then every remaining C0/C1/DEL
byte — ESC included — dropped, and line breaks/tabs collapsed to spaces, so no
control byte can survive even when a sequence is not recognized and its tail
stays as inert visible text) rather than a new sanitizer or a second
single-line helper:

- **The panel chrome** (`TaskBrowserPanel`): every dynamic field entering the
  list row, the inline/wide detail pane (`Selected`, label, parentLabel, parent
  id, detail, mode/status/access, and the `Stop …?  Y confirm` line that embeds
  the label), the header (the caller's run/phase text), the stale-refresh banner
  and the caller's no-match text is projected to one SAFE physical row BEFORE
  `truncateToWidth`/`visibleWidth`/the theme's `color.*` are applied. Cleaning
  after coloring would strip legitimate theme SGR, so the order is deliberate.
- **The ONE transient notice line** (`TuiApp.notify()`'s transcript-gutter row):
  a Task Browser Stop or a Subagent interrupt settlement embeds the same official
  label, and a dispatch failure embeds an `Error.message`. That row is the actual
  draw boundary and projects the notice text there, before the theme styling.
  `TuiApp.notify()`'s public semantics are unchanged: the STORED notice
  (`notifyText` / `currentNotice()`) stays the caller's raw string, and the Job
  Workspace notice row keeps its own `chromeText()` projection of it.

The business layer is untouched: the raw `TaskBrowserRow`/`TaskPanelItem` label,
the `JobStopOutcome`/`SubagentInterruptOutcome` and their message text are never
rewritten, so Stop/interrupt identity, currentness fences, once-only dispatch and
the success/error notice levels are unchanged. Projection happens only on the way
to the terminal; the official bytes still reach every copy verb. The production
route is exercised end to end — `/tasks` → the row's interrupt → the composition's
`SessionRuntime.withWriter` writer admission → the Direct subagent port →
`ctx.subagents.interrupt` → the notice line — by the L6 regression, which drives a
hostile official label and asserts on the raw `Terminal.write` stream.

Scope honesty: this record covers the Task Browser panel and the app transient
notice line (which is also the dock/pinned notice sink). It does not claim that
any other surface's dynamic text is safe; each surface keeps its own documented
boundary. In particular the Task Browser SEARCH row is the `Input` component's own
styled render of USER/query text (the vendored editor legitimately emits its own
cursor SGR there), not a Host Job/Subagent label, so it is outside this boundary
and is tracked separately.

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
stranded: every expanded prompt still collapses by a plain click on its BODY
and every folded one still shows the `click to expand` marker, so the mouse
round-trip works with no key. In regular the expanded prompt simply renders
full (no label), and Ctrl+O is the collapse owner.

The collapsed state exposes the compact marker; in FULLSCREEN the EXPANDED
state is collapsed by a plain click anywhere on the message BODY. The direction
is explicit in the shared disclosure metadata (`expand` vs `collapse`) and in
the fullscreen hit identity, so a stale press can never transfer an expand
target to a collapse target (or to a replacement pending row). A dedicated
trailing `▴ Collapse` control row is deliberately NOT painted on any surface:
the whole-bubble click is the single affordance, no presentation label can be
picked up by the terminal's native selection on the regular main screen, and no
keyboard hint needs to pollute scrollback copy. The fullscreen copy source is
therefore the real transcript content: the retired fork copy-source seam (X057)
and its blank-row bookkeeping are gone, so nothing has to be filtered out of a
selection.

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

The long-user bubble is ONE local disclosure surface in fullscreen: collapsed,
a plain single click anywhere on the bubble (head text, compact marker, or the
folded tail text) expands that message; expanded, a plain single click anywhere
on the bubble BODY collapses it. The compact marker stays as the visual
affordance naming the behavior — it is not the only hit target, and no
separate collapse row exists on any surface. Every non-bubble row (the pending
status line included) has an inert hit identity. Drag selection retains
selection ownership, and the bubble intentionally gives plain single-click to
disclosure in BOTH states, so double-click word selection is not available on
the long-user bubble in either state. Regular remains keyboard-only and
terminal-native: its marker advertises the effective key as the bidirectional
`expand/collapse` verb instead of an expand-only promise. A search hit inside
the collapsed middle expands the
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

## TOOL_NOT_STARTED is standalone Attention evidence and never an Action

DSH `0.1.7-rc.2` crash-recovery and fork-seed closers settle an assistant
tool request that never reached a durable `tool/call` with a synthetic
`tool/result` carrying `error.code === TOOL_NOT_STARTED` (detected through
the official exported constant, never recovery prose). The TUI presents
that row as an explicit **tool-request-not-started diagnostic**:

- the fold recovers the requested tool name from the durable
  `assistant/message` `tool-call` block, fenced by call id + turn + step,
  and degrades to a generic diagnostic when the identity is unproven;
- no synthetic `tool/call` is invented (`callCount = 0`), so the row is
  neither an executed Tool nor an orphan Action: `origin:
  'tool-not-started'` classifies it as standalone **attention** evidence,
  it joins no Activity/Work span, never owns the collapsed `Action:` slot,
  and contributes zero action statistics;
- the row is Host-owned: extension tool renderers and the normal
  ToolPresenter call/result presentation are bypassed (no `$ command`,
  diff, or read preview implies an execution), and the visible wording
  literally says `Tool request not started` — with the authoritative DSH
  recovery guidance as the expanded body;
- Markdown export states the fact (`### Tool request not started: bash`)
  instead of inventing a `### Tool <name>` durable-call heading.

`TOOL_OUTCOME_UNKNOWN` keeps the opposite semantics: a genuine started
tool whose outcome was not durably recorded stays a normal Tool card with
error outcome. Pinned by `test/session-v4-tool-result.test.ts`,
`test/transcript-semantics.test.ts`, `test/compact-process-preview.test.ts`,
`test/compact-display.test.ts`, and `test/focus-ui.test.ts`.

## Timed / continued Question (M3-3B terminal-native contract)

The rc.2 `ask_user_question` tool may declare a FOREGROUND WAIT (`timeout`
seconds). The Host keeps the durable deadline and the durable answerability;
the Client owns only presentation while it holds a claim. The TUI therefore
splits the lifecycle into three explicit layers:

```text
userQuestions projection  -> whether a question is open / continued / settled
inbox projection          -> whether a late reply is durably queued
QuestionSurfaceController -> the mounted card, the local countdown, the
                             wire-preserved rejection, reachability
QuestionFlow              -> the current form state / navigation only
```

Decisions (all terminal-native; none of them copies a Web button):

1. **Claim before countdown.** A timed request claims the Host wait
   (`userQuestions.attachWait`) and only then starts its local clock, seeded
   from the first frame's Host-computed `remainingMs`. Until that frame
   arrives the flow shows a non-destructive "claiming" line and NEVER guesses
   a duration. A refused/absent claim keeps the blocking flow without a
   countdown.
2. **The countdown is presentation only.** A local countdown reaching zero
   ends the FOREGROUND answer attempt. It never cancels the Turn and never
   cancels the question: the provider rejects the forwarded waterfall with
   the wire-preserved `ASK_TIMED_OUT` (matching the released Client), the Host
   returns pending, and the question stays durably answerable as `continued`.
   `Esc` rejects `ASK_CANCELLED`; a Host/delivery abort rejects `ASK_ABORTED`.
3. **First real answer mutation freezes the clock.** A selection toggle, a
   real free-text change, or a skip freezes the local deadline into indefinite
   local editing while the claim remains held; cursor moves, focus changes and
   other read-only operations never freeze it. No synthetic Host timer write is
   made. Focus/blur never releases the claim; teardown/disconnect does.
4. **Reachability is projection-driven and REACTIVE.** The port exposes
   `snapshot(sessionId)` plus `subscribe(sessionId, listener)`: Direct observes
   the Host projection registry's change feed, Remote observes BOTH Client
   projection faces (`userQuestions` + `inbox`) AND the Connection generation
   (a disconnect notifies even though the Client only clears its stores when a
   NEW generation connects; a generation change re-arms the faces against the
   current binding). The controller keeps exactly one registration for the
   session it presents and re-derives answerability from authority — never from
   a local timer, an old transcript card or a local store.
5. **A queued late reply removes the interaction.** While the Inbox holds a
   `user-question-reply` for the call, the controller keeps no entry and no
   editable submission; `REPLY_QUEUED` keeps the intent as a read-only notice.
   Discarding the queued reply (Host-side) makes the call answerable again.
6. **Final answers come from the projection.** A settled card renders the
   authoritative `userQuestions.settled` batch — a timed-out call's own tool
   result records the timeout, not the answer — as a presentation enrichment
   over the unchanged durable transcript event. An EMPTY settled batch is a
   real authoritative outcome (a late reply settled the call with no readable
   batch): only an ABSENT settled entry falls back to the call's own result.
7. **The Question outlives its editor seat (park / reopen).** Answerability and
   seat ownership are separate facts, exactly as in the released Web client:
   the controller keeps one `ContinuedQuestionEntry` per `(sessionId, callId)`
   with local presentation state `visible | parked`, and an entry outlives the
   mounted `QuestionFlow`.
   - `Esc` on a continued form PARKS it: the Host question is untouched, no
     `ASK_CANCELLED` is sent, the editor seat returns, and the user's answers /
     free text / current question are preserved.
   - **A parked Question never auto-reopens.** Projection invalidation, session
     events, assistant chunks, job updates, agent status, Task Center refreshes
     and repaints may update the row or remove the interaction, but only an
     explicit human reopen turns it back into a panel. Cold recovery (a
     reconnect, a session switch, or the initial attach discovering a
     still-continued call) creates the entry PARKED; only a live foreground
     interaction that locally transitions into `continued` keeps its form
     visible, because the user was already handling it.
   - The keyboard reopen path is the Task Center (`↓` Quick / `/tasks` Full):
     a parked actionable Question appears as a `Needs attention` row and
     `Enter` reopens the SAME entry (with its preserved draft). No `/answer`
     command and no dedicated global Question shortcut exist.
   - A queued reply, a settlement, a vanished call, or an unreadable authority
     removes the entry and its rows immediately; the transcript remains the
     durable historical/context anchor.
   - The mounted form owns an abort controller: authority withdrawal and user
     parking are different outcomes, and neither is reported as the other.
8. **The claim outlives nothing it shouldn't.** The claim attempt receives the
   caller's lifetime from the first moment, so a surface teardown (or a
   countdown end) during the opening frame releases the Host wait instead of
   leaving it held; a torn-down surface never mounts a countdown after the
   fact. A Host-driven claim end is reported as `ASK_ABORTED` — never as
   `ASK_CANCELLED`, which would record a cancellation the human never made —
   and the call is then re-derived from the projection.
9. **A superseded completion is silent.** A late answer whose Connection
   generation was replaced reports nothing: no "answer queued" line and no
   repaint, because the answer no longer describes the live surface (the new
   generation re-derives its own truth). A disconnected Connection likewise
   presents no answerable card from a last-known binding.
10. **A PUBLISHED Session owns the presentation: the replaced subject's live form
    leaves the seat.** The runner calls
    `SurfaceRuntime.reconcileInteractionPresentation()` from its published-session
    seam (`initLiveSession`), BEFORE the new owner's first frame, and the
    interaction owner withdraws every live presentation whose Session is no longer
    the surface's current one — a Question flow through the ONE controller, and an
    APPROVAL prompt through the same registry (its Session identity comes from the
    official request's OWN Agent, never a fabricated one). A flow whose timed
    claim is still OPENING is retired too: its form is never mounted once the
    claim lands. The identity used for that withdrawal is PER REQUEST (a borrowed
    Host cancellation scope may be shared by several requests, so it is never
    itself the address), and a replaced subject's request that only ARRIVES after
    the replacement was published is refused at ADMISSION against the surface's
    own currentness authority — the Session it shows or is currently OPENING (a
    tentative opening is not an owner replacement). A refused admission presents
    nothing. With a Host-owned cancellation lifetime only the Host ends it — and
    because the seat never received it, THIS owner registers that wait and drains it
    on teardown, detaching the borrowed listener. With NO Host lifetime nothing else
    could ever end it, so the refusal settles it AT ADMISSION instead of waiting for
    the TUI to exit: the approval answers `cancelled` (fail-closed) and the Question
    `ASK_ABORTED` (a Host-side end, never a user cancel). Admission, retirement and
    the ordinary activity reconcile all consult the SAME authority, so a Session
    being OPENED keeps its flow while a replaced subject (or a rolled-back opening)
    loses it; that authority is enabled ONLY for a renderer-owned presentation (the
    TSP mount) — the default PiTui branch, including the SDK-declined fallback,
    answers `true` unconditionally and keeps its original delegation semantics.
    The authority has a PRODUCER at every place it changes: the runner's own
    opening `clear`/`reset` seams run the full pass after mutating the journal (a
    rollback need not publish anything and there is no periodic reconcile), and an
    ended owner refuses admission outright — a request that only arrives during or
    after exit teardown takes the fail-closed cancellation instead of registering a
    presentation nothing can drain. Two further rules complete the contract: EVERY
    async presentation producer re-checks that same authority before it mounts (the
    bounded late-answer offer included, so a `continued` projection that only
    becomes visible after a replacement can never remount the replaced subject's
    form); and a request with NO Host-owned cancellation lifetime (the official
    signal is optional) is settled by this owner at a real replacement — the
    Question as `ASK_ABORTED`, the approval `cancelled` — because nothing else could
    ever end it, while a request carrying a Host signal keeps the Host's own
    settlement right. A request that is ALREADY inadmissible when it reaches the
    answerer (a legal upstream delay) has no later retirement to wait for, so the
    same rule applies AT ADMISSION (Question `ASK_ABORTED`, approval `cancelled`).
    The transient Alt+Q list is closed at a real replacement too (it belongs to the
    subject that opened it), and the whole withdrawal ALSO rides the SYNCHRONOUS
    owner-publication commit — in the same commit section as the outgoing-draft
    drop, before any post-commit await — so a replaced subject's modal can never
    keep the seat (or accept its keys through modal-first routing) while the new
    owner's initialization is still pending. That commit-section half is
    state-only and non-throwing, it performs NO Host read at all, and it withdraws
    every replaced presentation as ONE ATOMIC BATCH (the controller collects the
    lifetimes, the interaction owner adds the approvals and the renderer removes
    them all before it picks the successor), so a member of the batch is never
    promoted — and never painted — in between; the local settlement of a
    signal-less request (and of a mounted continued form) runs only AFTER that
    batch, so a synchronous abort can never settle — and thereby promote — a slot
    the batch is about to withdraw; it clears the
    stale displayed count locally and the full pass republishes the authoritative
    count (a projection read inside the commit section could throw after the owner
    was published and strand the commit bookkeeping that follows it).

    The withdrawal is PRESENTATION ONLY: the official
    request keeps its own Host-owned lifetime, so the Host's own cancellation
    still ends it (classified `ASK_ABORTED`, never a user cancel), a surface
    teardown still settles it exactly once, and the replacement subject inherits
    neither the form, nor the input seat, nor the previous subject's parked count
    or callbacks. The renderer-facing member is
    `withdrawPresentation(lifetime)` — the TSP seat implements it (its
    `layer` modal must not outlive the owner that opened it) while the PiTui
    adapter is deliberately inert, exactly like `withdrawPending`. The pre-commit
    quiesce deliberately leaves the outgoing owner's form mounted and answerable:
    the withdrawal is driven by the PUBLISHED-session seam or by the ordinary
    activity reconcile against the SAME currentness authority, never by a
    tentative opening.
    Evidence: `docs/tern-tsp/evidence/pr3-b.md` (rounds 5–9).

## A credential backend that cannot enumerate records still has a usable /logout

Remote rc.2 publishes no record-read Remote, so the Remote credential adapter
REJECTS `listRecords()` rather than reporting an empty list (an empty list
would assert "you have no stored records").

The terminal-native consequence: the no-argument `/logout` picker opens with
the references it CAN clear (`describeReference`), offers no fabricated record
row, and the outcome text states that stored credential records cannot be
enumerated or removed on this backend. Clearing a reference never implies that
stored records were cleaned up. `/logout <ref>` remains the direct path.

Credential operations also re-check the Connection generation before reporting
their outcome: a `setReference` that completed against a replaced Host is
reported as unconfirmed (never as a new-Host success), and a superseded
`describeReference` degrades to "not configured" in the picker.

## The passive Task Quick accessory below the editor (B4-A)

B4-A installs the passive half of the locked Task Quick UX: a bounded,
non-focusable task window directly below the editor seat (B4-B moved the band
under the whole footer — see the on-demand section below). It is a first-party
PRIVATE sibling on BOTH physical roots (the regular document, between the seat
and the public `input.widget.below` Text, and the fullscreen pinned stack in the
same position) — never an overlay, never an editor-seat tenant, never a public
extension widget, and never a second focus owner. B4-B owns the keyboard
crossing, the row selection and the typed row clicks; the legacy modal Quick
(the existing `↓` / `app.tasks.open`) and `/tasks` Full stay the reachable
entries, and their routing/wordings are unchanged.

- **One data authority.** The rows are the SAME `Task Runtime` projection the
  Task Center uses. `TaskBrowserRuntime.commitRows` now publishes the passive
  window on EVERY commit (not only while a modal browser is open),
  `TaskRuntime.refreshAttentionRows` republishes it from the controller's
  detached attention model, and the Jobs-only fallback (`source.jobs` without a
  `taskRead`) keeps `taskBrowserRows` and the window in step with the registry
  even while no browser is open. The projection helper
  (`quickTaskProjection`) applies exactly the modal Quick's Active/ancestor/
  attention policy and drops the modal-only `view-full` promotion row, so the
  window's `N` is the number of rows that can actually be scrolled to. There is
  no second catalog, no second summary and no second acknowledgement ledger; a
  transient roster read failure keeps the retained same-session snapshot rather
  than publishing an authoritative empty.
- **Failure attention is never silently acknowledged.** Passive painting,
  refresh, resize and wheel never call `TaskBrowserRuntime.acknowledge()`: while
  live work exists the Active scope keeps the failure out of the window (the
  footer `!N` attention stays pending), and once it surfaces the window only
  paints the `‣ Failed` word. Opening the modal Task Browser still performs the
  original "the user actually saw the row" acknowledgement.
- **Row budget.** The grant is derived from the LIVE frame: the terminal rows,
  the measured pinned chrome (header, subject bar, dock, todo, goal, queue, busy
  indicator, BOTH widget zones, the footer AND the editor seat) plus exactly one
  visible transcript row, further capped by the accessory's own proportional
  share of the terminal height and by its own four-row ceiling (identity + three
  task rows). A one-row grant is spent on task content, never on a header, and an
  empty projection or a frame with no room paints NO row and installs no hit
  geometry. The public widget zones keep their placement, their own budget and
  their lifecycle: the accessory never borrows a row from them, from the editor,
  from the footer or from the transcript floor.
- **One projection, never a dataset view.** A Workflow phase/run opens the modal
  Task Browser with a child-id dataset scope; the resident window is not that
  view, so it projects from the SAME commit's GLOBAL rows (the coordinator hands
  both to the surface), and opening a scoped browser never narrows or hides the
  session's other active Jobs and Subagents.
- **Nesting without a new glyph.** A nested Subagent row is painted with
  indentation derived from its durable depth; the modal panel's `├─ ` connector
  (U+2500 is East-Asian-Width ambiguous) is deliberately NOT carried into this new
  surface.
- **Window anchoring.** The durable anchor is the first visible row's stable
  `value`; a status update never moves the window, an inserted/removed row
  rebases onto the surviving anchored row, and a vanished anchor falls back to
  the bounded previous index — never to a label, a position or a time guess.
  `showing x-y/N` reports the painted window, the mode suffix is dropped whole
  when it cannot be painted whole, and the label is the only part that truncates.
- **Pointer contract (Transcript Fullscreen only).** The regular main screen
  stays a keyboard-only surface (the accepted H3A-16 contract: no mouse mode is
  written, no pointer is dispatched, native terminal selection/scrollback is
  untouched), so the wheel over the window is deliberately NOT reachable there —
  it is recorded as such rather than emulated. Inside Transcript Fullscreen the
  alt screen's EXISTING component dispatch delivers the wheel to the accessory,
  which resolves it only against its LAST PAINTED frame — the painted box AND the
  live terminal geometry recorded at paint time, so a resize that has not been
  repainted yet is refused even though the event itself still carries the stale
  layout's box dimensions — moves its own window by one row, requests no focus and
  acknowledges nothing. The whole painted band owns the wheel: while the pointer
  is on the window the transcript underneath never scrolls, and a wheel at a
  window boundary — or one dispatched against a frame that is stale because a
  resize has not been repainted, or because the projection just emptied and the
  blank frame is not painted yet — is consumed with `render: false` instead of
  falling through. The last painted hit geometry therefore lives until
  `render()` really paints zero rows, which is when the band leaves the screen.
  Press/release/click are refused: the accessory cannot open, stop or acknowledge
  anything in B4-A.
- **Session currentness.** A session-generation reset clears the window together
  with the badge/summary/roster mirrors, and every publish inherits the
  coordinator's session key + request-epoch fence: a late catalog commit of a
  superseded session can never paint into the new session's window.

Evidence: `test/task-quick-b4a-composition.test.ts` (real `TuiApp` +
`VirtualTerminal` + `createTaskRuntime`: roster → commit → projection → painted
below-editor rows on both roots, the Jobs-only fallback, a transient read
failure, the frozen size matrix, the fullscreen transcript floor, the parked vs
visible Question case, the SGR wheel with its negative controls, the
acknowledgement negative with a modal positive control, resize anchoring and the
no-Task-Center-capability skip) and `test/task-quick-accessory.test.ts` (the pure
grant ladder, the single-physical-row projection and the window anchor).

## The on-demand Task Quick: hidden by default, keyboard-focusable (B4-B)

Owner product revision (2026-10-14): even with live tasks the accessory paints
ZERO rows by default; the ONLY automatic crossing is an effective
`app.tasks.open` Down from the focused HOST editor whose cursor sits on its
last VISUAL line. `focused` is the one visibility authority — the component
keeps no second `open` flag, and losing focus hides it again.

- **The visual boundary is the fork editor's own (divergence X063).**
  `TuiEditor.canEnterTaskQuickFromDown` delegates to the new protected
  read-only seam `canYieldDownAtLastVisualLine(expectedLayoutWidth)` — the
  editor's private word-wrap map plus its transient-mode flags
  (history/autocomplete/jump/paste) are the only authority for "a real Down
  would leave this editor at the last visual line". The host predicate
  (`quickDownEligible`) adds the ownership facts: live surface, `tasksActive`,
  a real projection (>=1 row), the host editor as the PHYSICALLY focused seat
  in prompt mode, and no Question/Approval/Save/tenant/overlay/workspace/
  leader owner. A plugin editor takes no claim. Any miss is a DECLINE: the key
  is consumed without a replay.
- **Admission and hint share ONE predicate.** `taskBrowserAvailable()` feeds
  the footer `↓ view` / compact `↓` from the SAME `quickDownEligible()` the
  routing resolves — the hint may never advertise a route the ladder refuses,
  and `editorEmpty` no longer gates this composition (a non-empty draft
  qualifies on its last visual line). The footer hint is a compose-time
  projection of the latest Editor-rendered layout. A stale width fails closed; the next Editor render
   at the new width
   republishes the boundary and coalesces the Footer correction.
- **Owner-approved hidden-entry geometry (2026-10-15).** HIDDEN→ACTIVE admission
  is measured against a read-only candidate of the complete Footer composed
  with `taskBrowserAvailable=true`, including the `↓ view` hint. The candidate's
  actual physical height feeds the existing Quick row planner; it is never
  committed, mutated or iterated to a fixed point. If that candidate leaves no
  Quick row, both the hint and Down route fail closed—even if the hint-free
  painted Footer would leave room. Once Quick is ACTIVE, its geometry uses the
  actual painted Footer; a disappearing hint may free rows but does not revoke
  focus by re-running hidden-entry eligibility.
- **Keyboard surface.** The component keymap's task actions drive it. With `N`
  real tasks and the Full callback, navigation is exactly
  `task[0] … task[N-1], open-full`; without that callback it remains task-only.
  Every entry selects `task[0]`, never the action. ↑↓ move through that one
  windowed sequence without wrapping; Down on the final target clamps, PgUp/PgDn
  page by the PAINTED navigation-row count, and Up on `task[0]` exits. `Esc`
  exits (Host physical-Escape seam: never arms the double-Esc cancel, never
  reaches the background editor), Enter dispatches the selected typed target,
  every other key is a consumed no-op. Real-task selection remains an ephemeral
  stable `value`, reconciled by stable ID with a bounded successor/predecessor
  fallback; `open-full` is a distinct target and is never encoded as a value.
- **Typed commit.** Enter (and a Fullscreen same-row press→release click —
  the value-identity latch forbids press A → release B) first leave Quick,
  then route the CURRENT projected row through `openQuickTaskItem`: the value
  is verified against the CURRENT Quick projection and the session subject,
  then resolved by the ONE `resolveTaskSelection` router the Full browser uses
  (Question `attention.reopen`, subagent `enterView`, Job view). A stale value,
  a switched session or cleanup refuse with `false` — the hidden Quick never
  re-opens and nothing reports "opened".
- **Open Full action.** When real tasks exist and the first-party callback is
  available, `➜ Open Task Center…` is one appended navigation target in the same
  bounded window, with no task status or fabricated `TaskPanelItem.value`. Enter
  and the Fullscreen same-row press→release click first commit Quick HIDDEN and
  restore the current Editor seat, then call `TaskRuntime.openTasksBrowser('full')`
  — the existing `/tasks` owner. A focus loss, changed painted frame, empty
  projection, stale geometry or mismatched press/release is inert. `/tasks`
  remains available when Quick is hidden or has no tasks.
- **Owner displacement.** Every blocking owner (Question/Approval/Save,
  optional tenant, managed capturing overlay, Job Workspace, Settings, plugin
  editor winner, session reset, screen swap) terminates Quick at its own
  composition commit; a commit that empties the ACTIVE projection exits
  through `onEmpty` (guarded to the real focused component). The exit restores
  the CURRENT seat occupant, never a hard-coded editor.
- **The modal Quick is retired.** `openTasksBrowser` narrows to `'full'`
  (`/tasks` and the Workflow-scoped views); the Quick→Full promotion pseudo-row,
  the Esc restore-into-Quick tail, the modal-only state carrier and the panel's
  `quick` mode are removed with their consumers — no shim, no dead branch. The
  Full browser's Scope/Search/Type/Stop/Job-child semantics are untouched.
- **Row budget while ACTIVE.** The B4-B addendum's live-frame grant keeps one
  transcript row, the proportional share and the five-row ceiling (at most one
  divider + identity + three task/action navigation rows). Hidden-to-ACTIVE
  admission guarantees an initial real task row; identity and decorative
  divider yield as needed. After entry, a one-row grant may scroll to show only
  the selected Full action, which uses one of the same three navigation slots.
  Footer badges and `showing x-y/N` count real tasks only. A frame with no room
  for an initial task row DECLINES entry. `>` in `primary` remains D6's sole
  active device; the action's `➜` is muted type information, not another
  selection/focus marker.

Evidence: `test/task-quick-b4b-interaction.test.ts` (S1–S14 minus the pointer
matrix: hidden-by-default both with and without tasks, the boundary drives the
entry with the draft preserved, navigation with the global-first Up exit, the
typed route's refusal + open sides, the parked-Question reopen through the
production sink, shell-mode/non-last-line fail-closed, the disabled action's
hint + route drop, the 44-column CJK wrapped entry and the 0-grant decline,
the session-reset exit, `/tasks` Full filtering with Quick hidden; X063
same-turn facts, zero normal-input map scans/composes, stale-width resize hint
restoration and width-4 clamp; focused Quick blocks Host submit/steer actions;
jump transitions; hint-enabled Footer candidate denial/positive admission and
ACTIVE geometry independence), `test/task-quick-b4a-composition.test.ts` (the
ACTIVE-frame witnesses of the same production composition) and
`packages/pi-tui/test/editor-task-quick-boundary.test.ts` (wrap segments,
transient modes, stale-width rejection, rendered-snapshot/map edge equivalence,
and non-consuming negative). Post-B4-B action coverage lives in
`test/task-quick-accessory.test.ts` (typed target, task-only counts, glyph/ink,
keyboard and stale/cross-row mouse fences) and
`test/task-quick-b4b-interaction.test.ts` (real TaskRuntime Full route, Quick
hidden/Editor restored first, `/tasks` dataset parity and Fullscreen SGR click).

**Owner revision 2026-10-15 (footer-below layout addendum):** the accessory
band moved UNDER THE WHOLE FOOTER — the LAST visible region of both roots
(editor seat → public below widgets → footer → separator → accessory). The
band owns exactly ONE top separator rule (role 15 `border`, the
Owner-authorized Footer↔Quick boundary — never `primary`/`borderFocus`, no
bottom rule, no frame); it paints only when every desired task/action navigation
row already fits (`grant ≥ desired + 2`) and yields to navigation rows on a low
budget. The active ceiling is 5 rows: 1 separator + 1 identity + 3 task/action
rows. The Footer's
own budget is untouched (the chrome measurement includes the footer; the band
takes the remainder), the painted hit geometry includes the separator row as
inert chrome, and the mouse/wheel contract is unchanged. The owner-revision
authority is the addendum document (`temp/panel/…footer-below-quick-layout
-addendum-v1-20261015.md`) except for Footer admission geometry: the Owner-approved
2026-10-15 hint-present candidate preflight above supersedes conflicting B4-B
main-plan Step 2 and addendum §2.3 wording. Default-hidden behavior and the
`app.tasks.open`/Editor-boundary authorities remain unchanged.

**Owner clarification — Main Root Transcript Floor Exception:** Fullscreen is a
fixed-height root and continues to reserve at least one visible Transcript row;
its widgets/Quick yield when the budget is short. The ordinary Main Root remains
a flowing document with its historical public-widget grants. At extreme heights
such as 80×8, existing chrome may move Transcript above the current viewport
while preserving it in terminal scrollback. B4-B must not worsen Main visibility
relative to the Quick-hidden frame: Quick remains zero-row while hidden, and
entry admission still uses the measured Footer candidate, Editor, below-widget
rows and a one-row Transcript reserve; if no Quick task row fits, entry is
refused. This exception does not authorize changing Main widget grants, Footer
capacity or root layout, and it does not apply to Fullscreen or to clipping
introduced by an ACTIVE Quick.
