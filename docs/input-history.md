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

### What other agents do (researched 2026-08)

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
  `dshHome` helper in `src/diag.ts` is the single source of the path).
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

`Ctrl+R` opens the input-history search panel (host-reserved key; plugins
can never claim it). It is "find and EDIT", never "find and run":

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
- **Details**: the selected row's FULL multi-line content, plus its
  directory, timestamp and session — legacy rows honestly show
  `Unknown (legacy history)` (never a fabricated time). The list shows
  the prompt only; the directory prefix appears in `All directories` only.
- **Enter** puts the selected text back into the editor (via
  `setEditorText`) and closes the panel — it never submits. **Esc** closes
  with the draft untouched (the panel never previews into the editor).
- **Storage**: v2 rows carry `cwd` + `ts` + `sessionId`; v1 rows inherit
  the cwd from a v2 row that validates the file hash (Rule 1) or a
  known-cwd identity map (Rule 2). Unresolved legacy files are excluded
  from `All directories` (Rule 3 — never a guessed directory).
- **Search source**: `src/history-search.ts` (replaceable; a SQLite/FTS
  backend can swap in without touching the panel) and
  `src/history-panel.ts` (the overlay).

### The session-scope persist gate (deferred start)

The `session` scope is only as good as the `sessionId` on each row. The
runner therefore writes an agent-facing submission's history row AFTER the
session exists, with the FINAL session id — the first prompt of a deferred
start (`dsh --profile …` without `--session`) creates the session, and a
row written before creation would carry no sessionId and vanish from
`Current session`. Sessionless submissions (`/help`, `/settings`,
`/sessions`, `!!` shells) persist with `sessionId: undefined` and stay
visible in `Current directory` / `All directories`. The ordering contract
lives in `src/history-persist.ts` (`persistAfterSession`), pinned by
`test/history-persist.test.ts` (the merge gate).

### Bounded recent-first scanning (the perf contract)

The search never parses a whole history file. Every call reads the JSONL
store from the tail backwards through `src/history-reverse-reader.ts`
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
the live session** (`recallHistoryForSession` in `src/history.ts`) —
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

- `src/history.ts` — the pure store: pathing (`historyFilePath`), parsing
  (`parseHistoryLines` / `parseHistoryRecords`), read-only load
  (`loadHistoryFile` / `loadHistoryRecords` / `loadRecallHistory`), append
  rules (`appendHistoryLine` v1 / `appendHistoryRecord` v2). Pinned by
  `test/history.test.ts`.
- `src/history-search.ts` — the Ctrl+R search source (`HistorySearchSource`
  seam + `FileHistorySearchSource`): scope, bounded recent-first reverse
  scanning, the global scan budget, the page/continuation contract, legacy
  cwd recovery, matching, ordering, dedupe, cancellation. Pinned by
  `test/history-search.test.ts`.
- `src/history-reverse-reader.ts` — the reverse JSONL batch reader
  (EOF-backwards chunks, cross-chunk/UTF-8-safe line assembly, revision-
  bound continuation cursors, abort). Pinned by
  `test/history-reverse-reader.test.ts`.
- `src/history-panel.ts` — the Ctrl+R modal panel (query input, scope
  tabs, list, details, responsive layout). Pinned by
  `test/history-panel.test.ts` and the `test/ctrl-r.test.ts` integration
  suite.
- `src/history-persist.ts` — the session-scope persist gate: the pure
  persist decision (`persistHistoryRecord`) and the deferred-start
  ordering contract (`persistAfterSession`). Pinned by
  `test/history-persist.test.ts`.
- Runner wiring in `src/index.ts`: boot seed, per-session seed in
  `initLiveSession`, append on submit in `dispatchUserInput` (v2 rows,
  after session creation for agent-facing submissions), migration, and the
  injected `FileHistorySearchSource`.
- `docs/README.md` — index.
