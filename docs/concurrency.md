# Cross-process safety: the divergence guard and the open-time lock

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

## The open-time lock (why the guard alone is not enough)

The guard protects the WRITE path, but the guard alone cannot prevent the
worst corruption shape, observed in the field:

1. Process A resumes session S and is mid-turn (an open `step/start` is the
   last event, A's in-memory seq is `n+1`).
2. Process B resumes S. dsh's persistence `prepare` sees the open turn and
   **synthesizes interrupted-turn closers into the shared log** (`step/end`,
   `turn/end interrupted`, then the constructor's `session/end-seed`), all
   appended to the file at seqs `n+1…n+3`.
3. B's in-memory log is now `n+4` — which MATCHES the file, so B's guard
   checks pass. A, meanwhile, still holds seq `n+1` in memory and keeps
   appending `assistant/chunk` at seq `n+1` — colliding with B's synthesized
   events and corrupting the log. A's guard then reports `unreadable`
   (the file is damaged) while B sails through.

The write-path guard cannot catch this: at B's first write, B's memory equals
the file. The open-time lock (`src/session-lock.ts`) closes the OPEN path so
the scenario never starts: whoever opens a session first records a tiny lock
file next to the log; a second opener verifies the owner is still a live dsh
process and REFUSES the open.

## How the lock works (the decision)

- **Lock file**: `owner.lock` next to `session.jsonl[.zstd]` in the session
  directory (`locate()` path + `.owner.lock`). Content: the owner's pid,
  `/proc/<pid>/stat` starttime (the pid-reuse guard), start time, and profile.
  Written 0600 via `writeFileSync` with the **`wx` flag** — a plain `w` write
  would silently overwrite a live owner's lock and the whole exclusion
  collapses (a regression that shipped once and was caught only by a real
  two-terminal test, not the memFs unit tests).
- **Acquire**: `O_CREAT|O_EXCL` semantics. First opener wins. A second opener
  reads the lock and probes the recorded pid against `/proc`:
  - process gone (`ESRCH`) / zombie (`Z`) / pid reused (starttime mismatch) /
    not a dsh invocation ⇒ **stale** ⇒ unlink + retry the atomic create
    (bounded retries; a lock that keeps reappearing is treated as held).
  - process alive and matches ⇒ **held** ⇒ refuse the open.
  - probe cannot verify (no /proc, permissions, unparsable stat) ⇒
    **unverifiable** ⇒ refuse (never take over a lock we cannot inspect).
- **Release**: clean exit and session switch away unlink the lock
  (idempotent). A crash leaves it behind; the next open's stale check takes
  it over — no TTL, no heartbeat, no manual cleanup.
- **No heartbeat, deliberately**: the lock means "this process holds the
  session", not "this process is currently writing". A live matching owner is
  a valid lock even while idle (SIGSTOP, long GC, laptop sleep); expiring it
  early would create the exact double-writer window the lock exists to
  prevent.
- **Same process**: a re-open of one's own session (e.g. `/sessions` back to
  the current session) short-circuits on pid + starttime match.

## Lock lifecycle in the TUI

| Entry | Behavior |
|---|---|
| `--session <id>` launch | acquire before `agents.resume()`; refusal is fatal (the runner exits with the refusal message — the user asked for a specific session, there is no safe fallback) |
| `/resume` / `/sessions` switch | release the CURRENT lock, then acquire the target before `agents.resume()`; a refusal re-takes the current lock (the switch did not happen) and returns an error text to the picker |
| `/new` / `/fork` | acquire in `swapTo` for the incoming session (covers every swapTo caller) |
| first deferred message | acquire after the session is created |
| switch away / clean exit | release (idempotent), AFTER the final flush |
| crash / kill -9 | lock stays; the next open's stale check takes it over |

Two orderings are load-bearing and were both bug-fixed in review:

- **Flush before release.** `swapTo` flushes the outgoing session, THEN
  releases its lock. Releasing first would open a window where a racing
  opener's resume synthesizes closers into the shared log while our flush
  still appends from our in-memory seq — the exact corruption the lock
  exists to prevent.
- **Release old before acquire new.** The lock tracker is a single slot;
  acquiring the target first overwrites it and the outgoing session's lock
  leaks for the whole TUI lifetime (a later release-by-id is a no-op). The
  switch therefore releases the current lock first; a refused or failed
  switch re-takes it because the current session stays live.

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

## Guard vs lock: the division of labor

- The **lock** prevents TUI-vs-TUI double opens — the common corruption
  source. It is best-effort: unavailable deployments (no persistence, no
  write access) proceed unlocked.
- The **guard** remains the backstop for everything the lock cannot see:
  the web surface, older TUIs that know nothing about the lock, a force-open
  after the refusal, or a lock file lost to manual deletion.

## Counting events in a session file (trap)

File rows are the **storage format**, not events. Packed `*-chunks` rows
(`seq0` + `dt`) expand via `decodeStorageRecord` into individual events with
real `seq` values. Any code that counts "events in the file" must expand rows
first — the guard's `readFrom` does; naive line-counting does not.

## In-process session transitions: the single-writer gate

The lock and the guard protect the session FILE from cross-process writers.
A separate hazard is IN-PROCESS interleaving between the TUI's own
transition paths — `/new`, `/fork`, `/rewind`, `/sessions` switch/resume
and the first-session creation. Before the gate, two such workflows could
overlap across their awaits:

- a fork child could be created — `session/created` published, persistence
  already writing its seed — and THEN the stale check notice the surface
  had moved; `AgentHandle.dispose()` stops the agent and removes it from
  the live registry, but it does **not** delete the persisted session, so a
  durable ghost branch would appear in `/sessions` that the user never
  entered;
- a rewind swap's identity check could pass, then yield across the
  old-handle `dispose()` await, letting a concurrent switch land and later
  be overwritten by the first continuation.

The fix (`src/transition-gate.ts`) is a **process-local single-writer
queue**: every transition path runs its whole workflow — prepare/create →
flush → dispose old → assign new → generation bump — inside
`SessionTransitionGate.run`, held from BEFORE the child create (for rewind)
or the resume (for switches) until the swap commits. Tasks are strictly
FIFO; a rejected task never blocks the queue; re-entering the gate from
inside a task is refused loudly (AsyncLocalStorage detects it — re-entry
would deadlock the queue). The runner exposes the gate as
`runner.withSessionTransition(task)`; the rewind commit wraps
`commitRewind` itself, so a stale selection is detected before any child
exists. The swap's `expected`-identity check and the commit's stale gates
remain as the defensive second line — with the gate held they are
unreachable in practice, but they protect against future callers that
forget the gate.
