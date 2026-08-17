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
- Format: one JSON object per line (`{"content": "..."}`), submission
  order (oldest first). Multi-line submissions are one JSON line (newlines
  escaped by `JSON.stringify`), so pastes cannot corrupt the layout.
- Writes: append-only (`O_APPEND`), 0600 file, 0700 directory, created on
  demand. Consecutive repeats and empty lines are skipped (shell-history
  behavior); non-consecutive repeats are legal history and survive.
- Cap: `HISTORY_LIMIT` (100) entries per directory, trimmed on load.
- Corrupt lines are skipped on load, never fatal.
- `!` shell commands are stored verbatim (with the `!`), so ↑ recall
  restores them as text and Enter re-runs the shell branch (kimi does the
  same with its bash-mode flag).
- The runner loads the file per session (and once at boot for the launch
  cwd, so a fresh window recalls immediately — see below) and appends on
  every submitted line.

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
  (`parseHistoryLines`), load+trim (`loadHistoryFile`), append rules
  (`appendHistoryLine`). Pinned by `test/history.test.ts`.
- Runner wiring in `src/index.ts`: boot seed, per-session seed in
  `initLiveSession`, append on submit in `dispatchUserInput`, migration.
- `docs/README.md` — index.
