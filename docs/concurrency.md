# Cross-process safety: the divergence guard

## Why the guard exists

dsh has **no cross-process session coordination** — an upstream limitation,
not a bug we can fix. Two dsh processes (TUI + web, or two TUIs) holding one
session each number events from their own in-memory log length, so both can
mint the same `seq` and corrupt the log at the `session/end-seed` resume
marker. The TUI cannot prevent the corruption, so it detects it and blocks
the write; the README documents the human rule ("one surface per session"),
`src/guard.ts` enforces it as far as the TUI can.

Why not file locking? Because dsh's persistence `open(path, "a")` → write →
**close** on every flush, so NO process ever holds the session file open —
an fd-based lock or `lsof` check has nothing to detect. Comparing committed
event counts against the live log is the only reliable external-writer
signal.

## How the guard works (the decision)

Before each session-writing submission the guard runs a two-step check:

1. **Cheap gate** — `locate()` + `fs.stat` on the session file.
2. **Committed read** — `readFrom(id, 0)` (a full committed read), comparing
   the file's committed event count against the live `session.events.length`.

File ahead of memory ⇒ an external writer ⇒ **block**.

### Force-through: the one-time token

The same operation (same session, same observed file revision, same action —
`submit` vs `save` — and the same draft) executed a second time binds a
ONE-TIME token that forces the write through. Any of *edited draft, swapped
key, new file revision, session switch* invalidates it. So "press Enter
again" forces, but a changed draft can never silently clobber the other
writer.

### tail-mismatch

A same-count but different-tail rewrite (same `seq`/`type`/content-hash
comparison) reports `tail-mismatch` and blocks too: the file was rewritten,
not appended.

Guard state is per-session and resets on switch. `readFrom` throws on a
corrupt committed prefix — that is the unreadable case: the file is damaged
and the guard refuses rather than guessing. (Repair is a separate,
deliberate act — see `repair-session.md`.)

## Counting events in a session file (trap)

File rows are the **storage format**, not events. Packed `*-chunks` rows
(`seq0` + `dt`) expand via `decodeStorageRecord` into individual events with
real `seq` values. Any code that counts "events in the file" must expand rows
first — the guard's `readFrom` does; naive line-counting does not.
