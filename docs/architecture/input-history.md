# Input history: storage, recall, and migration

## What this records

Where the TUI keeps the per-directory input history that ↑/↓ recall reads,
why the settings document was the wrong home for it, what the recall-order
contract is, and the migration path that moved existing users' history out
of `~/.dsh/settings.yaml`.

## Decision: a dedicated JSONL file, not the settings document

History used to live inside the `dsh-pi-tui` settings namespace
(`history: { [cwd]: string[] }` in `~/.dsh/settings.yaml`). That was the
wrong home:

- **Settings are preferences.** The settings document is user-editable
  configuration (`theme`, `footer`, `busyEnter`, …); a bulk, high-frequency
  log of every submitted prompt grows it without bound and buries the
  preferences in noise.
- **Whole-file replaces clobber concurrent writers.** The settings write
  path is read-modify-write of one document; two TUI windows in the same
  directory (the "new window" case) race each other — last write wins, so
  one window's submissions can silently erase the other's.
- **Settings reads are schema-shaped.** History is opaque runtime data; a
  preferences schema has no business validating it.

### What other agents do

| Agent | Location | Format | Keyed by |
|---|---|---|---|
| kimi-code | `<dataDir>/user-history/<md5(cwd)>.jsonl` | JSONL `{"content": …}` | per cwd |
| Claude Code | `~/.claude/history.jsonl` | JSONL | global |
| Codex CLI | `~/.codex/history.jsonl` | JSONL | per machine |
| aider | `<git_root>/.aider.input.history` | plain lines | per project |
| Gemini CLI | none — derives ↑ recall from session logs at runtime | — | per session |
| shells | `~/.bash_history` etc. | plain lines | per user |

Nobody stores input history in a settings/preferences file. The closest
match for dsh-pi-tui's per-directory requirement is **kimi-code**: a
dedicated data file keyed by the working directory. We adopt that shape.

## The chosen design

- File: `$DSH_HOME/user-history/<md5(cwd)>.jsonl` (`$DSH_HOME` defaults to
  `~/.dsh`, same root as the existing `$DSH_HOME/logs` diagnostics; the
  `dshHome` helper in `src/runtime/process/diagnostics.ts` is the single source of the path).
- Format: one JSON object per line, submission order (oldest first).
  Multi-line submissions are one JSON line (newlines escaped by
  `JSON.stringify`), so pastes cannot corrupt the layout.
  - **v1** (legacy, kimi layout): `{"content": "..."}` — still read forever.
  - **v2** (canonical since the Ctrl+R milestone): `{"v":2,"content":"...",
    "cwd":"...","ts":<epoch-ms>,"sessionId":"ses_..."}`. New rows carry the
    working directory and a submission timestamp so the all-directory
    history search can merge files and order globally by time. Unknown
    future fields are tolerated; a v2 row with invalid metadata degrades
    the field to null (content stays searchable) instead of dropping the
    row.
- Writes: append-only (`O_APPEND`), 0600 file, 0700 directory, created on
  demand. Consecutive repeats and empty lines are skipped (shell-history
  behavior); non-consecutive repeats are legal history and survive.
- Recall vs. persistence (decoupled):
  - **Recall**: `HISTORY_RECALL_LIMIT` (100) entries seed the editor's
    ↑/↓ history. The canonical JSONL is NEVER truncated or rewritten on
    read — a concurrent append from another window must never land in an
    orphaned inode. Auto-compaction is a planned maintenance milestone
    (`HISTORY_FILE_MAX_ENTRIES`, 5000), not part of the read/append
    contract.
- Corrupt lines are skipped on load, never fatal.
- `!` shell commands are stored verbatim (with the `!`), so ↑ recall
  restores them as text and Enter re-runs the shell branch (kimi does the
  same with its bash-mode flag).
- The runner loads the file per session (and once at boot for the launch
  cwd, so a fresh window recalls immediately — see below) and appends on
  every submitted line.

## Ctrl+R history search

`Ctrl+R` replaces the EDITOR SEAT with the input-history search surface
(host-reserved key; plugins can never claim it). It is "find and EDIT", never
"find and run": the Transcript keeps rendering above it and the ordinary footer
below it, and the panel is an editor-seat tenant — not an overlay and not a
second screen.

- **Scopes**: `Tab` cycles the scope; the query survives the switch.
  - `Current session` (the default when a live session exists) — only the
    CURRENT session's inputs: v2 rows whose `sessionId` matches the live
    session id. v1 rows and v2 rows without a sessionId are excluded —
    never guessed (legacy data has no reliable session proof).
  - `Current directory` — the live cwd's file, every trusted row.
  - `All directories` — every history file with the cwd-proof rules.
  - Without a session identity (a deferred start before the first prompt)
    the panel defaults to `Current directory` and the session tab is
    hidden — a session tab with no identity would always be empty.
- **Filtering**: case-insensitive substring over the content; an empty
  query browses the most recent history.
- **Layout (one vertical presentation at every width)**: a top boundary `─`
  (Owner decision D15), then the `Input History` header with the scope tabs and
  the `F2` hint, the query row, a `Results · N matches` counter, a single-line
  results window (at most eight painted rows, following the selection), the
  Results/Preview divider, then the `Preview`, the action bar and a bottom
  boundary `─` (below the action bar, against the footer). The two boundary
  rules are preferred and may compress the Results/Preview regions, but they
  never cost the mandatory Header/Query/Action Bar, at least one result row or at
  least one Preview content row: when the budget cannot satisfy all of those the
  bottom rule is removed first, then the top one; a loading/empty/failed state
  keeps at least its one status/message row. A rule never takes a
  transcript/footer row.
  `F2` toggles the seat between its normal (≈63% of the terminal) and expanded
  (≈80%) target height; the real grant also reserves the live non-seat chrome
  and one transcript row, so a small terminal drops the Preview before it drops
  the visible selected result.
- **Preview**: the selected row's FULL soft-wrapped multi-line content with its
  OWN scroll position (`Alt+↑`/`Alt+↓` one row, `Alt+PgUp`/`Alt+PgDn` one page,
  `Alt+Home`/`Alt+End` first/last) and ONE trailing metadata row
  (`Scope: … · Directory: … · Time: … · Session: …`; a legacy row honestly shows
  `Time unknown`, never a fabricated time). The Preview never truncates the
  source with a marker. `↑`/`↓`/`PgUp`/`PgDn` keep selecting in the results list;
  the list shows the prompt only, with the directory prefix in
  `All directories` only.
- **Copy**: `Alt+C` copies the EXACT stored prompt (both roots); in Transcript
  Fullscreen the Preview heading also carries clickable `Copy All [Alt+C]` and
  `Use Selected [Enter]` (the verb is never bracketed; the whole item is hidden
  when it cannot fit, while `Alt+C`/Enter stay available).
- **Enter** puts the selected text back into the CURRENT editor (via
  `setEditorText`) and closes the seat — it never submits and never writes a
  hidden host editor behind a plugin winner. **Esc**/**Ctrl+C** close it with
  the draft, cursor, input mode and pending paste content untouched, and those
  two keys are consumed by the seat while it is active (closing History never
  interrupts the agent or quits the TUI).
- **Session currentness**: `Ctrl+R` captures the runtime's SINGLE
  `SessionScopeAuthority` scope once (exact owner + generation) and the seat's
  search/accept/copy/async guards re-read that same capture. A session switch, a
  same-id reopen (A→B→A), a same-owner generation bump or the sessionless→first
  session publication therefore makes the old seat logically dead the instant the
  new owner is published: the runner physically closes it in the same synchronous
  commit (before the new Session's first editable frame), a UI cleanup failure can
  never roll the published Session back, and Enter/Copy/async results from the old
  scope are refused rather than written into the new Session. A live blocking
  owner (Question / Approval / Save Location) PARKS the seat instead — the SAME
  instance with its query/selection/Preview anchor returns after the LAST blocker
  settles.
- **Pointer (Transcript Fullscreen only)**: clicking a result row SELECTS it
  (it does not accept); the explicit `Use Selected [Enter]` / `Copy All [Alt+C]`
  cells act,
  the wheel scrolls the list or the Preview under the pointer only, and a
  Preview drag copies the exact original source substring. The regular main
  screen has NO application mouse: it is fully keyboard-driven and the
  terminal's native selection/scrollback is untouched.
- **Storage**: v2 rows carry `cwd` + `ts` + `sessionId`; v1 rows inherit
  the cwd from a v2 row that validates the file hash (Rule 1) or a
  known-cwd identity map (Rule 2). Unresolved legacy files are excluded
  from `All directories` (Rule 3 — never a guessed directory).
- **Search source**: `src/client/history/search.ts` (replaceable; a SQLite/FTS
  backend can swap in without touching the panel) and
  `src/tui/panels/history-panel.ts` (the editor-seat surface). The exact
  original-text cell mapping the Preview drag shares with the Job Command page
  lives in `src/tui/components/source-text-layout.ts`.

### The session-scope persist gate (deferred start)

The `session` scope is only as good as the `sessionId` on each row. The
runner therefore writes an agent-facing submission's history row AFTER the
session exists, with the FINAL session id — the first prompt of a deferred
start (`dsh --profile …` without `--session`) creates the session, and a
row written before creation would carry no sessionId and vanish from
`Current session`. Sessionless submissions (`/help`, `/settings`,
`/sessions`, `!!` shells) persist with `sessionId: undefined` and stay
visible in `Current directory` / `All directories`. The ordering contract
lives in `src/app/submission/history-persist.ts` (`persistAfterSession`), pinned by
`test/history-persist.test.ts` (the merge gate).

### Bounded recent-first scanning (the perf contract)

The search never parses a whole history file. Every call reads the JSONL
store from the tail backwards through `src/client/history/reverse-reader.ts`
(fixed-size chunks, lines reassembled across chunk boundaries, UTF-8 safe)
and consumes a GLOBAL scan budget — `HISTORY_SEARCH_SCAN_LIMIT` (5000)
physical lines across ALL files per call, never per file. The `All
directories` scope stats the candidates with bounded concurrency and scans
them serially in mtime-DESC order (most recently active workspace first);
mtime only schedules files, the final order is always row.ts.

The result is a `HistorySearchPage`: the matches NEW to the call's window,
plus a `HistorySearchContinuation` when older history remains. A
continuation resumes exactly where the call stopped (no re-scan of the
covered suffix, no duplicate rows across pages) and is bound to the request
context (a mismatched continuation is a typed error). Reaching the scan
budget is NOT exhausted. The panel currently renders only `page.results`;
"Search older" is a later UI phase on this contract.

The history store is append-only, so a concurrent append between pages does
not invalidate a continuation: the scan continues by its old snapshot
boundary and the appended rows belong to the next fresh search. Only a
file that SHRANK or was rewritten under a continuation cursor invalidates
it — the source then throws `HistorySearchContinuationStaleError` (a typed
error) instead of silently skipping the file and reporting exhausted.

Two intentional trade-offs of the bounded window:

- **Coverage**: histories outside the first scan window may not appear
  initially — the default search is recent-first, not exhaustive.
- **Legacy cwd coverage**: the file proof comes from `knownCwds` (upfront)
  or a validating v2 row observed INSIDE the scanned window. Rows whose
  proof lies outside the window are omitted from `All directories` — v2
  cwd hash validation itself stays strict and unchanged.

### Recall-order contract (trap: get this backwards and ↑ shows the OLDEST entry)

The file is oldest-first; `TuiApp.resetInputHistory` takes **newest-first**
(`seedInputHistory` iterates it reversed into the editor, whose recall list
is newest-first). The runner therefore reverses the loaded entries before
seeding. The first `↑` must recall the MOST RECENT submission — this is
pinned by `test/input-experience.test.ts` ("seeded input history recalls
entries with the up arrow") and `test/tui-app.test.ts`.

### Seeding at boot (trap: deferred start has no session)

With a deferred start (`dsh --profile …` without `--session`) no session
exists at boot, so the per-session seed in `initLiveSession` has not run.
The runner seeds the recall history from the LAUNCH cwd at boot too, so ↑
works immediately in a new window; `initLiveSession` replaces it when the
first session is born (and on every session switch).

### Editor recall scope: session-first (↑/↓), cwd-first (Ctrl+R)

The EDITOR's ↑/↓ recall is session-scoped once a live session exists:
`initLiveSession` seeds it with **only the rows whose `sessionId` matches
the live session** (`recallHistoryForSession` in `src/client/history/store.ts`) —
resuming session A in a shared cwd never recalls session B's inputs. With
no live session (fresh/deferred start) the recall pool is the whole cwd
file, v1 legacy rows included. Explicitly **no automatic fallback**: when
the session's rows run out, ↑ stops (it never silently switches to cwd
history — the scope would become invisible to the user).

Two invariants that must never be conflated:

- The **recall projection** is the session filter — the EDITOR's ↑/↓ pool.
- The **persistence dedupe anchor** (`lastHistoryContent`) stays the cwd
  file's ACTUAL last row. Resuming session A after session B wrote `bar`
  keeps the dedupe anchor at `bar` even though ↑ only shows session A's
  rows — dedupe stays per-file, never per-session.

v1 legacy rows (no `sessionId`) never participate in a live session's
recall — they are not guessed into any session. Ctrl+R remains the
broader search (its `Current directory` / `All directories` scopes cover
legacy rows; `Current session` filters to the live session exactly like
the editor recall).

### Publication→hydration window (trap: the reseed races the submission's OWN write)

A Session publication (ordinary `/new` / switch, `/fork` adoption, the
first-session creation) makes the new owner current BEFORE its hydration
reseeds ↑/↓ from the session-scoped JSONL rows. A submission accepted inside
that window is already owned by the NEW Session, but its own persistence is
ordered behind the transition — the submit FIFO turn and `ensureSession()`
(`persistAfterSession`) — so the write can run AFTER the snapshot read: the row
lands on disk under the new `sessionId` (and Ctrl+R `Current session` /
`Current directory` find it) while the reseed does not see it and would
otherwise drop it from ↑. The append itself is synchronous inside the detached
task (`runDetached` invokes its factory synchronously and `appendFileSync` runs
there); the ORDERING between the submission body and the reseed is what races,
never the append.

`TuiApp` therefore keeps the open scope's SCOPE-BOUND TEMPORARY SUBMISSIONS as
the scope's TRUE submission sequence (newest first), and the hydration reseed
reconciles them:

- the scope is OPEN FROM CONSTRUCTION: the SESSIONLESS POOL is a real scope (a
  deferred start, and the Remote startup resume whose `remote.read` await leaves
  the terminal accepting input). The first published owner ADOPTS the pool's
  entries — a pool submission's row is written under the new Session, so the
  snapshot cannot carry it yet — and the resume publication needs no call at all
  (the pool is already open; that owner's reseed commits it);
- `beginInputHistoryScope(owner)` runs at the synchronous publication seam of the
  ordinary transition, the fork adoption and the first-session creation. A
  REPLACED owner's entries are dropped with the scope, so Session A's input can
  never cross into Session B's recall;
- `rememberInput()` records every accepted input in the scope while it is open —
  it never compresses a repeat away, because only the FINAL seed can see where
  another writer's row lands between two identical submissions. The scope's own
  cap counts RUNS of consecutive identical text, exactly like the editor/mirror
  recall it feeds, and keeps a run's oldest occurrence plus its newest (which
  carries the run's rank), so a long run of pending duplicates costs constant state
  and can never evict an older, distinct occurrence. (A steer, a shell line or any
  other writer's row can land between two identical submissions and move the
  CWD-level consecutive dedupe anchor, so a later run member can legitimately
  append: its row is simply re-emitted from the snapshot.) The mirror keeps its unchanged duplicate rule, so an input identical
  to the outgoing Session's last row is still recalled after the reseed;
- EVERY accepted Enter — each editor seat, a sessionless or local command, a
  `!`/`!!` shell line — becomes an occurrence with its own internal OCCURRENCE
  TOKEN that rides its submission into the persistence record. The token — never
  the text — is what attributes a settlement to exactly one occurrence, so
  repeated identical submissions stay distinguishable (`a → b → a` keeps both
  `a`s), and no occurrence is discarded before the final seed compresses
  adjacent duplicates;
- the write owner reports EVERY settled submission, in APPEND ORDER, through
  `settleScopeInput({ token?, owner, outcome, text })` — a successful append and a
  policy SKIP alike, from the SAME synchronous stack that performed it. The
  append order is the file's row order, and a skipped submission still occupies
  its position there. The only session-history writers that report NO token are
  the steers that never pass `rememberInput` (a raw Ctrl+S steer, the editor steer
  action, an application extension steer): their row is kept where the disk put
  it and is never claimed by a scope occurrence;
- the settled FACT of an occurrence is kept per token, independently of the
  session id its row carries and of the capped settlement queue. It exists only
  for occurrences the scope still holds — a fact is dropped together with the
  occurrence the cap removed, and a late settlement of a dropped occurrence adds
  nothing — so the metadata stays bounded by the scope, never by how many
  submissions the window saw. The number of appends each row owner produced is
  kept separately and is NEVER evicted, which is what tells the reseed how many of
  the snapshot's newest rows the window owns: the appends whose settlements the cap
  evicted are still emitted, in disk order. A pool occurrence written sessionless is
  settled but is not part of the new Session's projection (it adds nothing). A
  skipped occurrence whose settlement the cap evicted keeps its rank as well: the
  owner's append count at settlement time is durable, so the skip still lands at the
  append boundary it recorded — after the rows that preceded it and before those
  that followed, whether or not their own settlements survived the cap (only a skip
  whose whole boundary lies outside the covered window falls at its end);
- `resetInputHistory(entries, owner)` commits that owner's reseed from that
  evidence alone, in ONE linear pass (the frozen plan bounds it at O(100)):
  occurrence token → rank is built once, the snapshot's newest written-count rows
  ARE the owner's appends in reverse (a count watermark, never text matching), and
  a single ordered cursor interleaves the occurrences the window does not carry —
  a never-settled one is NEWER than every settled submission of the writers that
  share the submit turn, so it stays in front of their rows. An occurrence written under another identity (a
  sessionless pool row) is not part of this Session's projection and adds
  nothing, and a written row older than the recall window (the 100-row cap) is not
  in the projection at all. The seed then performs the adjacent-duplicate
  compression and the 100-entry truncation LAST, exactly as the baseline did.

While a reseed is still pending, the outgoing Session's rows remain recallable
(`resetForGeneration` is an invalidation signal, not a confirmed switch); they
are replaced by the new owner's projection at the commit above.

No second history authority is created: the per-cwd JSONL stays the snapshot
authority, and the write policy (trim, empty / consecutive-repeat / attachment
skips, cwd `lastHistoryContent`, the `sessionId` field) is unchanged.

## Migration

One-time, at boot: the legacy `history` map inside the `dsh-pi-tui`
settings namespace is read from the settings descriptor's RAW user layer
(`settings.describe()`), written to the per-cwd JSONL files (the stored
arrays are newest-first; the file wants oldest-first, so they are reversed),
and the `history` key is then explicitly deleted from the stored section.

### Trap: schemastery does NOT strip unknown keys

`schemastery`'s `z.object` keeps unknown keys in the resolved value, so
`{ ...settings.get() }` still carries `history` after the schema dropped
the field — a "cleanup" replace that spreads the resolved doc writes the
key right back (the file's mtime changed; the content did not). The cleanup
must `delete doc.history` explicitly before replacing.

### Crash-safe migration

Migration is idempotent per cwd: an existing JSONL file means that cwd was
already migrated, and the settings key is only deleted once EVERY legacy cwd
has its file (`allMigrated`). A crash mid-migration (some files written, the
key still present) therefore resumes on the next boot instead of losing the
unwritten entries.

## Where the code lives

- `src/client/history/store.ts` — the pure store: pathing (`historyFilePath`), parsing
  (`parseHistoryLines` / `parseHistoryRecords`), read-only load
  (`loadHistoryFile` / `loadHistoryRecords` / `loadRecallHistory`), append
  rules (`appendHistoryLine` v1 / `appendHistoryRecord` v2). Pinned by
  `test/history.test.ts`.
- `src/client/history/search.ts` — the Ctrl+R search source (`HistorySearchSource`
  seam + `FileHistorySearchSource`): scope, bounded recent-first reverse
  scanning, the global scan budget, the page/continuation contract, legacy
  cwd recovery, matching, ordering, dedupe, cancellation. Pinned by
  `test/history-search.test.ts`.
- `src/client/history/reverse-reader.ts` — the reverse JSONL batch reader
  (EOF-backwards chunks, cross-chunk/UTF-8-safe line assembly, revision-
  bound continuation cursors, abort). Pinned by
  `test/history-reverse-reader.test.ts`.
- `src/tui/panels/history-panel.ts` — the Ctrl+R modal panel (query input, scope
  tabs, list, details, responsive layout). Pinned by
  `test/history-panel.test.ts` and the `test/ctrl-r.test.ts` integration
  suite.
- `src/app/submission/history-persist.ts` — the session-scope persist gate: the pure
  persist decision (`persistHistoryRecord`) and the deferred-start
  ordering contract (`persistAfterSession`). Pinned by
  `test/history-persist.test.ts`.
- Runner wiring in `src/index.ts`: boot seed, per-session seed in
  `initLiveSession`, append on submit in `dispatchUserInput` (v2 rows,
  after session creation for agent-facing submissions), migration, and the
  injected `FileHistorySearchSource`.
- `docs/README.md` — index.
