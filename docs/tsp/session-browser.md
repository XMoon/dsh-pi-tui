# TSP Session Browser

This contract covers the experimental TSP Session Browser: browse/search/details
over the `SessionReader`, and the guarded Resume command path. PiTui remains the
production default; TSP keeps the experimental opt-in described in
[overview.md](./overview.md).

## Scope and authority

- `SessionReader.list(currentSessionId, signal)` is the sole membership and
  ordering authority. Only listed main Sessions are presented; `origin ===
  'subagent'` rows are excluded.
- `SessionReader.projectionBatch(rows, signal)` enriches those rows with title
  and preset facts. A missing projection remains unknown; it is never filled
  from a local transcript or a second persistence reader.
- `SessionReader.search(canonicalQuery, signal)` is the sole content-search
  authority. Its bounded page order, snippets and `hasMore` fact are consumed as
  returned. Content hits are intersected with the listed main rows; an unlisted
  ID never becomes a Browser row.
- The Browser does not scan Client/Host files, read session logs, add a
  persistence format or change the `SessionReader` contract. Direct and Remote
  adapters keep their existing semantics.
- `currentSessionId` and `currentCwd` are captured from the opening subject.
  `current`, `selected` and `live` are different facts: selection never changes
  the Current marker or supplies session-transition authority.
- The internal read owner is `src/app/command/session-browser-read.ts`; snapshot
  and intent types live in `session-browser-presentation.ts`. Neutral query/
  workspace/lineage helpers are in `src/domain/session/browser.ts`. The native
  Presenter is `src/tui/tsp/session-browser.ts`, mounted through
  `src/tui/tsp/session.ts`.

## Browse, search and details

- Browse opens in the current workspace. Workspace membership uses lexical
  `sameWorkspace(row.cwd, currentCwd)`; unknown roots match neither workspace.
  All-workspaces mode keeps the listed main-session lineage, including
  cross-workspace parent/child edges. Orphans become roots; cycles are emitted
  without unbounded traversal.
- Browse Tree groups only adjacent rows whose workspaces match; repeated
  workspace headings are intentional. Grouping never reorders the
  `buildSessionTree()` parent-first sequence or resets row depth; each contiguous
  run has its own PickerGroup ID. Search is global Cards without workspace
  groups.
- A non-empty query is canonicalized once for metadata matching and Host search:
  remove NUL, trim, cap at 500 UTF-16 code units, and avoid a dangling high
  surrogate. Metadata matches only listed-row `id`, `title`, `cwd` and `preset`
  fields; it does not locally search content or Host snippets.
- The native input keeps raw editor text and cursor separate from the canonical
  query. Ordinary Reader snapshots update results/status without rewriting the
  editor; `/sessions`/`/search` initial queries and a no-match typed `/resume`
  query are seeded once. Text edits made while the list loads — including
  whitespace-only changes that canonicalize to the existing query — take
  precedence over pending initial/direct-match intent, and canonical no-op edits
  do not restart Host search.
- Query mode uses the same native Picker identity in global Cards layout and does
  not inherit browse-scope membership. Metadata matches retain the official list
  order; Host-only results follow Host page order; overlap is deduplicated and
  carries the Host snippet. `hasMore` asks the user to refine; it does not start
  pagination.
- `search() === undefined` means content search is unavailable, not an empty Host
  page. Metadata matches remain available; with no metadata match the Presenter
  states that content search is unavailable. Thrown list/projection/search
  errors remain distinct from empty/unavailable states. Search loading/
  unavailable/error/`hasMore` status remains visible when projection enrichment
  also fails; the projection warning stays secondary.
- Browse rows show compact recent activity from `updatedAt`; Details shows full
  ISO Created/Updated timestamps. An absent `createdAt` is `Unknown`, never
  inferred from `updatedAt`.
- `SessionSummary.formatStatus` is the Host-authoritative on-disk format state
  and is presented read-only: `Migration required` appears as one item after
  `Updated` in the row detail (kept on the content-search card branch) and in the
  Details `State` value. `current` and an absent fact add nothing; no new badge,
  fact group, control or page exists. The label is a statement, never a veto: the
  normal Resume/open path stays, and the official Host `Session.open` owns any
  migration it performs.
- Details is one read-only native Overlay Reader. Back or Esc returns to the same
  Picker and retains query/scope/selection. Each reading owns a distinct Reader/
  body/scroll identity; no Resume action is offered from Details.
- The Picker progressively enriches the first 20 listed rows, then batches the
  remaining rows in groups of 50 after yielding. A query is sent to the Host
  after a 250 ms debounce; an equivalent canonical query does not restart it.
  List/projection/search work use `runOwned`, per-panel abort/currentness fences
  and query generations. Closing, reopening, disposing, changing subject or
  replacing a panel retires its timers and in-flight reads before a late result
  can publish.

## TSP presentation and lifecycle

- The native capability gate requires `picker`, `row`, `overlay` and `text` kinds
  plus the `scroll` feature. A pane missing any requirement receives no Session
  Browser presentation, and the Presenter emits no unsupported scroll operation.
- One native Picker key remains stable for a panel across query, scope,
  projection and resize updates. A new open gets a new panel identity. Details
  body and Back identities are scoped to one reading. Event admission uses the
  current surface, rendered target, panel/page identity and offered action or
  row; the SDK exposes no authoritative frame revision, and this code does not
  claim one.
- The existing modal seat has priority. Browser, Preset and Model share one layer
  and retire one another; a modal suspends Browser input and restores the same
  read-only state when it closes. Hydration retires the Browser; shared renderer
  disposal clears the exposed Model/Preset/Browser presenters.
- Pointer selection changes only the selected row. A valid non-current row
  enables the primary Resume action; row Enter/activate uses the same guarded
  switch as the Footer. Details stays read-only.

## Commands and Resume

- The TSP capability gate runs only after the authoritative command classifier
  selects a registered TUI command. Native availability additionally requires the
  live Session Browser Presenter. A Host-origin same-name command, extension
  command, skill wrapper or ordinary unknown slash line stays with its existing
  classifier/owner; there is no second command registry.
- `/sessions [query]` and bare `/resume` open the same Browser. `/search <query>`
  opens its global Cards view with the initial query; empty `/search` is rejected
  before listing. None of these commands creates a Session.
- `/resume <id-or-prefix>` uses the single official `SessionReader.list()` read
  for that open and the existing `findSessionMatch()` order over `panel.rows`
  (listed main-session rows only). The first listed main-session match starts the
  switch without a second list; a miss, including a subagent-only target, becomes
  the initial global query. A manual Browser query entered while the list loads
  takes precedence and suppresses a matching typed `/resume` switch. This
  main-only corpus is the Native TSP rule; the PiTui fallback direct matcher is
  unchanged.
- Footer order is Close, Details, Resume. Resume keeps the `primary` action
  designation in every state; it is enabled only for a listed, non-current
  selection while no switch is pending. Loading, empty, unavailable, error, no
  selection, current-row and pending states keep it disabled with an explicit
  action reason. The client represents disabled Resume as `primary off`; the
  label can be unreadable while hovered. This is an Owner-accepted external
  client limitation: no styling change is authorized and reason-tooltip paint is
  unverified.
- The Reader owner validates the active panel, captured subject, listed target
  and pending latch. Browser events and native typed direct matches are admitted
  only for this read's listed main rows; typed direct matching is suppressed
  when the user changed the query during listing. Both routes carry the captured
  `SessionScope`; `SessionRuntime.switchSession(target, expectedScope)` checks
  that exact owner/generation again inside the existing transition gate before
  navigation side effects. It never opens a nested gate or trusts a Session ID,
  `Picker.current`, `selected` or a `live` badge as currentness authority.
- Flush, lifecycle open, publication, old-owner retirement, hydration, catalog
  refresh and reporting remain owned by the existing Session runtime. An
  open/refusal failure leaves the old owner current, keeps the Browser retryable,
  displays the failure and releases pending. Pre-publication failures preserve
  the outgoing draft; post-publication catalog/retirement failures are reported
  without rolling back the committed owner. Success is checked with the new
  owner's authoritative reread, not an optimistic notice or Picker snapshot.

## Limits

The real-client runs are `REAL_TERN_HEADLESS`, not `REAL_TERN_GUI` and not a
physical G8 acceptance. The unreadable disabled-Resume hover is an
Owner-accepted client limitation; G8 visual acceptance is not claimed as complete.
Physical GUI, IME, wheel, theme and physical PageUp/PageDown are outside this
contract and are not claimed. Remote TSP Resume is not claimed; no Remote L5/L6
success is established.

## Regression lanes

```sh
node --import tsx/esm --test --test-concurrency=1 \
  test/tern-tsp-command-admission.test.ts \
  test/tern-tsp-direct-admission.test.ts \
  test/tern-tsp-session-browser-commands.test.ts \
  test/tern-tsp-session-browser-read.test.ts \
  test/tern-tsp-session-browser.test.ts \
  test/tern-tsp-session-browser-direct.test.ts \
  test/session-runtime-remote-owner-handoff.test.ts \
  test/runner-remote-command-plane.test.ts \
  test/session-picker-content-search.test.ts \
  test/tern-tsp-runner-interactive.test.ts \
  test/sessions.test.ts
node --import tsx/esm --test --test-name-pattern='^A-07' test/tern-tsp-live-mount.test.ts
node scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-read.mjs
node scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-direct.mjs
```

The unit/integration lanes cover command admission, the read owner, native wire,
Direct lifecycle and command-owner controls. The `read` flow qualifies painted
presentation with a controlled Reader (including the read-only
`Migration required` row detail and Details `State` at wide and narrow panes);
the `direct` flow uses the real Tern client and production Direct composition to
exercise the business switch and authoritative reread. Both are headless, not
physical GUI acceptance.
