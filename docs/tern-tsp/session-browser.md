# TSP Session Browser (PR4-B1-A)

This contract covers the internal, read-only Session Browser read path for the
experimental TSP renderer. B1-A implements the Presenter and its real
`SessionReader` owner; it does not admit a production command or perform a
Session transition. The production default remains PiTui.

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
- Pointer selection changes only the selected row. In B1-A, Enter/activate may
  produce a test-observable Resume intent, but the footer Resume is disabled
  and no production writer, `switchSession`, transition gate, or session
  operation is connected. With no test callback, the intent is reported as
  deferred to B1-B.

Physical GUI, IME, wheel, theme, and Remote-TSP behavior are not certified by a
scripted TSP session or a real-client headless run. Real Tern headless evidence
is recorded in [PR4-B1-A evidence](./evidence/pr4-b1-a.md).

## B1-B handoff

B1-B owns command admission and the real Resume transition. It may consume the
internal `SessionBrowserResumeIntent` (`sessionId`, captured
`currentSessionId`, and source) only after rechecking the authoritative current
Session and listed target at the existing transition boundary. It must route a
successful transition through the existing `switchSession`/Session lifecycle
owner and preserve its cancellation, hydration, writer, and failure semantics.
It must not treat a disabled footer, selection state, `live` badge, or B1-A
intent as proof that a transition occurred. B1-A adds neither a public API nor a
new `SessionReader` method.

## Regression lanes

```sh
node --test --import tsx/esm test/tern-tsp-session-browser-read.test.ts
node --test --import tsx/esm test/tern-tsp-session-browser.test.ts
node --test --import tsx/esm test/tern-tsp-session-browser-direct.test.ts
node --test --import tsx/esm test/sessions.test.ts
node scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-read.mjs
```

The first three lanes cover the read owner, native TSP wire/presentation, and
Direct `SessionReader` integration respectively. The real-client flow is
`REAL_TERN_HEADLESS`, not `REAL_TERN_GUI` and not a real Session switch.
