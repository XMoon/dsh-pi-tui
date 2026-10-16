# TSP Session Browser (PR4-B1)

This contract covers the complete experimental TSP Session Browser. B1-A added
the `SessionReader`-backed Browse/Search/Details Presenter; B1-B connects the
registered TUI commands and Resume actions to that Presenter and the existing
Session switch. PiTui remains the production default.

## Scope and authority

- `SessionReader.list(currentSessionId, signal)` is the sole membership and
  ordering authority. Only listed main Sessions are presented; `origin ===
  'subagent'` rows are excluded.
- `SessionReader.projectionBatch(rows, signal)` enriches those rows with title
  and preset facts. A missing projection remains unknown; it is not filled from
  a local transcript or a second persistence reader.
- `SessionReader.search(canonicalQuery, signal)` is the sole content-search
  authority. Its bounded page order, snippets, and `hasMore` fact are consumed
  as returned. Content hits are intersected with the listed main rows; an
  unlisted ID never becomes a Browser row.
- The Browser does not scan Client or Host files, read session logs, add a
  persistence format, or change the `SessionReader` contract. Direct and
  experimental Remote adapters retain their existing semantics.
- `currentSessionId` and `currentCwd` are captured from the opening subject.
  `current`, `selected`, and `live` are different facts: selection never
  changes the Current marker or supplies session-transition authority.

The internal read owner is `src/app/command/session-browser-read.ts`; its
snapshot and intent types are in `session-browser-presentation.ts`. The neutral
query, workspace, and lineage helpers are in
`src/domain/session/browser.ts`. The native Presenter is
`src/tui/tsp/session-browser.ts`, mounted through the existing TSP renderer in
`src/tui/tsp/session.ts`.

## Browse, search, and details

- Browse opens in the current workspace. Workspace membership uses lexical
  `sameWorkspace(row.cwd, currentCwd)`; unknown roots match neither workspace.
  All-workspaces mode keeps the listed main-session lineage, including
  cross-workspace parent/child edges. Orphans become roots and cycles are
  emitted without unbounded traversal.
- Browse Tree groups only adjacent rows whose workspaces match; repeated
  workspace headings are intentional. Grouping never reorders the
  `buildSessionTree()` parent-first sequence or resets row depth, and every
  contiguous run has its own PickerGroup ID. Search remains global Cards without
  workspace groups.
- A non-empty query is canonicalized once for metadata matching and Host
  search: remove NUL, trim, cap at 500 UTF-16 code units, and avoid a dangling
  high surrogate. Metadata matches only listed-row `id`, `title`, `cwd`, and
  `preset` fields. It does not locally search content or Host snippets.
- The native input keeps raw editor text and cursor separate from the canonical
  query. Ordinary Reader snapshots update results/status without rewriting the
  editor; `/sessions` and `/search` initial queries and a no-match typed
  `/resume` query are explicitly seeded once. Text edits made while the list
  loads, including whitespace-only changes that canonicalize to the existing
  query, take precedence over pending initial/direct-match intent. Such
  canonical no-op edits do not restart Host Search.
- Query mode uses the same native Picker identity in global Cards layout and
  does not inherit browse-scope membership. Metadata matches retain the
  official list order; Host-only results follow Host page order; overlap is
  deduplicated and carries the Host snippet. `hasMore` asks the user to refine
  the query; it does not start pagination.
- `search() === undefined` is an unavailable content-search capability, not an
  empty Host page. Metadata matches remain available; with no metadata match,
  the Presenter states that content search is unavailable. Thrown list,
  projection, and search errors remain distinct from empty/unavailable states.
  Search loading/unavailable/error/`hasMore` status remains visible when
  projection enrichment also fails; the projection warning stays secondary.
- Browse rows show compact recent activity from `updatedAt`; Details shows full
  ISO Created/Updated timestamps. An absent `createdAt` is `Unknown` and is
  never inferred from `updatedAt`.
- Details is one read-only native Overlay Reader. Back or Esc returns to the
  same Picker and retains query/scope/selection. Each reading owns a distinct
  Reader/body/scroll identity; no Resume action is offered from Details.

The Picker progressively enriches the first 20 listed rows, then batches the
remaining rows in groups of 50 after yielding. A query is sent to Host after a
250 ms debounce; an equivalent canonical query does not restart it. List,
projection, and search work use `runOwned`, per-panel abort/currentness fences,
and query generations. Closing, reopening, disposing, changing subject, or
replacing a panel retires its timers and in-flight reads before a late result
can publish.

## TSP presentation and lifecycle

- The native capability gate requires `picker`, `row`, `overlay`, and `text`
  kinds plus the `scroll` feature. A pane missing any requirement receives no
  Session Browser presentation and the Presenter emits no unsupported scroll
  operation.
- One native Picker key remains stable for a panel across query, scope,
  projection, and resize updates. A new open gets a new panel identity. Details
  body and Back identities are scoped to one reading. Event admission uses the
  current surface, rendered target, panel/page identity, and offered action or
  row; the SDK does not expose an authoritative frame revision, and this code
  does not claim one.
- The existing modal seat has priority. Browser, Preset, and Model share one
  layer and retire one another; a modal suspends Browser input and restores the
  same read-only state when it closes. Hydration retires the Browser; shared
  renderer disposal clears the exposed Model, Preset, and Browser presenters.
- Pointer selection changes only the selected row. B1-A's historical read-only
  state is documented in its evidence: row activation emitted only an internal
  test intent and Footer Resume was disabled despite its `primary` marker. B1-B
  supersedes that interaction: a valid non-current row enables the primary Resume
  action, and row Enter/activate uses the same guarded switch as the Footer.

## Commands and Resume (B1-B)

- The TSP capability gate runs only after the authoritative command classifier
  selects a registered TUI command. Native availability additionally requires
  the live Session Browser Presenter. A Host-origin same-name command, extension
  command, skill wrapper, or ordinary unknown slash line remains governed by its
  existing classifier/owner; no second command registry is introduced.
- `/sessions [query]` and bare `/resume` open the same Browser. `/search <query>`
  opens its global Cards view with the initial query; empty `/search` is rejected
  before listing and none of these commands creates a Session.
- `/resume <id-or-prefix>` uses the single official `SessionReader.list()` read
  for that open and the existing `findSessionMatch()` order over `panel.rows`
  (listed main-session rows only). The first listed main-session match starts
  the switch without a second list; a miss, including a subagent-only target,
  becomes the initial global query. A manual Browser query entered while the
  list loads takes precedence and suppresses a matching typed `/resume` switch.
  This is the Owner-directed Native TSP rule resolving the frozen plan's
  `STOP_MATCH_CORPUS` choice as main-only without rewriting that plan; the PiTui
  fallback direct matcher remains unchanged. `/sessions [query]` and
  `/search <query>` retain the same loading-time user-query priority. See the
  [B1-B evidence](./evidence/pr4-b1-b.md) for candidate-order, matching-hit,
  and persisted-child controls.
- Footer order is Close, Details, Resume. Resume retains the `primary` action
  designation in every state; it is enabled only for a listed, non-current
  selection while no switch is pending. Loading, empty, unavailable, error, no
  selection, current-row, and pending states keep it disabled with an explicit
  action reason. The current Tern client represents disabled Resume as
  `primary off`, retaining the Owner-accepted B1-A style (see [B1-A evidence](./evidence/pr4-b1-a.md));
  a Tern 0.8.4 headless capture shows the label unreadable while the pointer
  hovers the disabled primary. The Owner accepts this as an external client
  limitation: no styling change is authorized, G8 visual acceptance remains
  PARTIAL, and reason-tooltip paint is unverified (see [B1-B evidence](./evidence/pr4-b1-b.md)).
  Selecting a row only changes selection; row Enter, row activate, and Footer
  Resume produce the same single operation intent. Details remains read-only.
- The Reader owner validates the active panel, captured subject, listed target,
  and pending latch. Browser events and Native TSP typed direct matches are
  admitted only for this read's listed main rows; typed direct matching is
  suppressed when the user changed the query during listing. Both routes carry
  the captured `SessionScope`; `SessionRuntime.switchSession(target,
  expectedScope)` checks that exact owner/generation again inside the existing
  transition gate before navigation side effects. It never opens a nested gate
  or trusts a Session ID, `Picker.current`, `selected`, or `live` badge as
  currentness authority.
- Flush, lifecycle open, publication, old-owner retirement, hydration, catalog
  refresh, and reporting remain owned by the existing Session runtime. An
  open/refusal failure leaves the old owner current, keeps the Browser retryable,
  displays the failure, and releases pending. Pre-publication failures preserve
  the outgoing draft; post-publication catalog/retirement failures are reported
  without rolling back the committed owner. Success is checked with the new
  owner's authoritative reread, not an optimistic notice or Picker snapshot.
- `test/tern-tsp-session-browser-commands.test.ts` proves the Direct L6 switch
  through the production command registration, Direct `SessionReader`, lifecycle,
  and runtime using the scripted TSP event fixture. The separate S4 flow
  `scripts/tern-pane-session-browser-direct.mjs` is the real-Tern, production-
  composition qualification; its run result and artifacts are recorded in the
  [B1-B evidence](./evidence/pr4-b1-b.md). Neither Direct path establishes
  Remote TSP Resume support.

## Qualification limits

The B1-A/B1-B real-client run is `REAL_TERN_HEADLESS`, not `REAL_TERN_GUI` and
not a physical G8 acceptance. The unreadable disabled-Resume hover paint is an
Owner-accepted external Tern 0.8.4 limitation; no styling change was made, and
G8 visual acceptance remains `PARTIAL`. Physical GUI, IME, wheel, theme, and
physical PageUp/PageDown remain `NOT_VERIFIED`. Remote TSP Resume remains
`UNKNOWN/NOT_VERIFIED`; no Remote L5/L6 success is claimed. See [PR4-B1-A evidence](./evidence/pr4-b1-a.md)
for the historical read-only qualification and [PR4-B1-B evidence](./evidence/pr4-b1-b.md)
for command/Resume coverage and current limits.

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
Direct lifecycle, and command-owner controls. The `read` flow qualifies painted
presentation with a controlled Reader; the `direct` flow uses the real Tern
client and production Direct composition to exercise the business switch and
authoritative reread. Both are headless, not physical GUI acceptance.
