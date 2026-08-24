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

- **Scope**: `Tab` toggles `Current directory` (the default) ⇄
  `All directories`; the query survives the switch.
- **Filtering**: case-insensitive substring over the content; an empty
  query browses the most recent history.
- **Details**: the selected row's FULL multi-line content, plus its
  directory, timestamp and session — legacy rows honestly show
  `Unknown (legacy history)` (never a fabricated time).
- **Enter** puts the selected text back into the editor (via
  `setEditorText`) and closes the panel — it never submits. **Esc** closes
  with the draft untouched (the panel never previews into the editor).
- **Storage**: v2 rows carry `cwd` + `ts`; v1 rows inherit the cwd from a
  v2 row that validates the file hash (Rule 1) or a known-cwd identity map
  (Rule 2). Unresolved legacy files are excluded from `All directories`
  (Rule 3 — never a guessed directory).
- **Search source**: `src/history-search.ts` (replaceable; a SQLite/FTS
  backend can swap in without touching the panel) and
  `src/history-panel.ts` (the overlay).

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
  seam + `FileHistorySearchSource`): scope, legacy cwd recovery, matching,
  ordering, dedupe, cancellation. Pinned by `test/history-search.test.ts`.
- `src/history-panel.ts` — the Ctrl+R modal panel (query input, scope
  tabs, list, details, responsive layout). Pinned by
  `test/history-panel.test.ts` and the `test/ctrl-r.test.ts` integration
  suite.
- Runner wiring in `src/index.ts`: boot seed, per-session seed in
  `initLiveSession`, append on submit in `dispatchUserInput` (v2 rows),
  migration, and the injected `FileHistorySearchSource`.
- `docs/README.md` — index.
