# Surface decisions: plain-exit, queue notices, credential targets

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

## Background-subagent settlement notices never appear in the queue pane

The queue pane is the mirror of the agent's inbox and therefore a
USER-INPUT surface (kimi's queue pane lists only queued prompts). dsh
pushes two kinds of background-subagent notices into the parent's inbox:

- continuable children: `source.kind === 'subagent-settled'` (the
  continuation manager's settlement notice);
- one-shot background subagent jobs: `tool-jobs` completion notices whose
  summary starts with `subagent `.

Both are the runtime's account of a child ending, not steerable input, so
the queue mirror drops them (`isSubagentSettlementNotice`). The task
browser is their surface: terminal job rows (one-shot), inactive child rows
(continuable), `/subagents` for transcripts. A FAILED settlement
additionally surfaces once as a transient error notify
(`subagentNoticeIsFailure`, classified on the producers' deterministic
wording — "finished and" is the only success phrasing for
`subagent-settled`; `[status: failed|killed]` for tool-jobs). The dsh-side
delivery is unchanged: the parent model still receives the notice; only the
TUI's queue mirror filters it. Bash-job notices stay in the queue.

Classification helpers: `src/index.ts` (`isSubagentSettlementNotice`,
`subagentNoticeIsFailure`), pinned by `test/queue-notices.test.ts`.

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
Enter delivers the text as the child's NEXT distinct FIFO turn through the
OFFICIAL `ctx.subagents.prompt({ requestId, parentSessionId, childSessionId,
mode: 'continuable', content }, signal)` control API (DSH 0.1.2-alpha.4) —
user provenance, no interrupt, no steer; parent authority is validated by
the Host itself. Decisions a future change must not silently reverse:

- **The viewer editor is a PLAIN text editor.** Everything typed — including
  lines that start with `/` — is delivered to the child as text; slash
  commands are NOT executed against the parent, and the child gets no
  command-execution wire. Parent-only actions (Ctrl+S steer, Ctrl+Enter
  queue, Alt+↑ dequeue, Shift+Tab permission, Ctrl+F/Ctrl+Shift+F main
  search, Ctrl+C/D exit chords, ↓ task browser, Ctrl+G external editor,
  Ctrl+V image intake) are consumed by the host BEFORE the ladder reaches
  the editor, so the viewer can never act on the parent session.
- **The write path is exactly one**: the runner's `onSubagentSubmit` →
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
  subagent/descriptor, llm/retry) never occupy a slot or count as tools.
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

## Focus is surface-adaptive

Two surfaces, two consistent detail paths — no mouse hit-map in regular
mode (only `TuiAltScreen` wires `onCellClick`):

- **Regular (fullscreen OFF) — keyboard-driven**:
  - Ctrl+O is the Focus detail master: it toggles a DERIVED reveal of the
    recent `EXPAND_RECENT_TURNS` Focus Thoughts. The derived state is
    NEVER written into `focusExpandedTurns`, so switching to fullscreen
    drops it (deterministic: `toolOutputExpanded` and `focusExpandedTurns`
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
injection). A TuiApp mutates the shared `tui.editor.submit`, Home/End and
alt-screen mappings while it runs, so two concurrently LIVE surfaces in one
Node process would silently fight over one keybinding state — App A's
submit remap would hijack App B's Enter. The product/CLI architecture is
one process = one live TUI; the host enforces that invariant fail-fast
(re-vendor lifecycle follow-up P3, `src/process-tui-slot.ts`):

- `TuiApp.start()` CLAIMS the process slot; `TuiApp.stop()` releases it
  (idempotent); `TuiApp.dispose()` releases through the same stop path;
  a failed `start()` never leaks the claim.
- A second surface that starts while another is LIVE rejects with a
  deterministic error — never a silent keybinding collision.
- The slot is a LIVE slot, deliberately not held across `stop()`: the
  invariant the guard needs is "never two CONCURRENTLY live surfaces",
  which is exactly what the process-global keybindings require. The
  external-editor suspend/resume and ordinary stop/start cycles release
  and re-claim without tripping; fullscreen main/alt-screen swaps stop/
  start the SCREENS (not the app) and never touch the slot at all.
- A stopped surface may be replaced by another surface (sequential, not
  concurrent — still one live TUI at a time).
