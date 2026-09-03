# Cross-process safety: the open-time lock and the lease model

## Why the open-time lock exists

dsh has **no cross-process session coordination** — an upstream limitation,
not a bug we can fix. Two dsh processes (TUI + web, or two TUIs) holding one
session each number events from their own in-memory log length, so both can
mint the same `seq` and corrupt the log at the `session/end-seed` resume
marker. The TUI cannot prevent the corruption upstream, so it refuses the
OPEN instead: the README documents the human rule ("one surface per
session"), and the owner lock (`src/session-lock.ts`) + process lease +
cooling verifier enforce it.

Why not file locking? Because dsh's persistence `open(path, "a")` → write →
**close** on every flush, so NO process ever holds the session file open —
an fd-based lock or `lsof` check has nothing to detect. A small `owner.lock`
file next to the log, verified against the live owner before any takeover,
is the only reliable single-writer mechanism.

## Why the lock is required (the field-observed worst shape)

Without the open-time refusal, the worst corruption shape unfolds silently:

1. Process A resumes session S and is mid-turn (an open `step/start` is the
   last event, A's in-memory seq is `n+1`).
2. Process B resumes S. dsh's persistence `prepare` sees the open turn and
   **synthesizes interrupted-turn closers into the shared log** (`step/end`,
   `turn/end interrupted`, then the constructor's `session/end-seed`), all
   appended to the file at seqs `n+1…n+3`.
3. B's in-memory log is now `n+4` — it MATCHES the file, so B proceeds. A,
   meanwhile, still holds seq `n+1` in memory and keeps appending
   `assistant/chunk` at seq `n+1` — colliding with B's synthesized events
   and corrupting the log. No post-open check can catch this: B's memory
   equals the file from its very first write.

The open-time lock closes the OPEN path so the scenario never starts:
whoever opens a session first records a tiny lock file next to the log; a
second opener verifies the owner is still a live dsh process and REFUSES
the open.

### The ownership model (convergence plan — final)

Every writable target requires its physical owner lock BEFORE any DSH
call (`acquired` is the only acceptable result; held/unverifiable/
unavailable fail closed). The transition runs: quiesce old → ALL
TUI-owned preflight → target lease → markTouched (the DSH boundary) →
create/resume (NEVER retried — a rejection is PINNED immediately, see
the sticky-quarantine rule below) → synchronous COMMIT (no lock changes)
→ retire (dispose + local detach gate + COOLING). A post-DSH failure
never unlocks the target: it enters a process-lifetime PINNED quarantine.
The old session's lock is released only
by the cooling verifier after quiet + durable parity + stable samples
(or kept forever on any uncertainty). TUI writers serialize against
transitions through the SessionOperationBarrier.

No submit-time detection can fix the scenario above: B's memory equals the
file from its first write, so there is nothing to compare. The open-time
lock (`src/session-lock.ts`) is the mechanism — and because it is the ONLY
mechanism, it is fail-closed: a writable existing session REQUIRES its
`acquired` lock; `unavailable` (no lock dir, no write access) refuses the
open rather than proceeding unowned.

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
- **Release**: the physical lock file is unlinked ONLY by the verified
  cooling release of the lease that retired the session (`releaseAfter
  VerifiedCooling`) — never by the switch-away itself (the old lock
  stays until quiet + durable parity), and a CLEAN EXIT does NOT release
  touched locks either: they stay as stale records that the next open's
  stale check takes over (a crash leaves the same stale record). Release
  is idempotent; there is no TTL, no heartbeat, no manual cleanup.
- **No heartbeat, deliberately**: the lock means "this process holds the
  session", not "this process is currently writing". A live matching owner is
  a valid lock even while idle (SIGSTOP, long GC, laptop sleep); expiring it
  early would create the exact double-writer window the lock exists to
  prevent.
- **Same process**: a re-open of one's own session (e.g. `/sessions` back to
  the current session) short-circuits the PHYSICAL acquire on pid +
  starttime match — but the LEASE POLICY still applies: a held COOLING
  lease is reactivated through `reserveForActivation` (epoch++), while a
  PINNED lease is REFUSED by the sticky quarantine (a re-open can never
  demote a quarantine).

## Lock lifecycle in the TUI

| Entry | Behavior |
|---|---|
| `--session <id>` launch | ALL preflight first, then acquire before `agents.resume()`; refusal/unavailable is fatal (the user asked for a specific session, there is no safe fallback); a post-DSH failure pins the session |
| `/resume` / `/sessions` switch | acquire the TARGET lease while STILL HOLDING the current one (multi-slot holder; a non-blocking refusal); the current lock is released only by the COOLING verifier after the old handle's dispose + detach gate + durable parity (review round 10) — a refusal or resume failure leaves the current session live WITH its lock (no vacuum window) |
| `/new` / `/fork` | acquire the child's lease BEFORE the create (pre-generated id, old lease still held — the target-before-DSH rule); the OLD lease is released only by the cooling verifier |
| first deferred message | acquire the child's lease BEFORE the create (pre-generated id — the target-before-DSH rule) |
| switch away | the old session enters COOLING; its lock is released only after verified quiet + durable parity (or stays PINNED) |
| clean exit | touched locks are NOT released — they stay as stale records; the next open's stale-takeover handles them |
| crash / kill -9 | lock stays; the next open's stale check takes it over |

Two orderings are load-bearing and were both bug-fixed in review:

- **Flush before release.** The transaction flushes the outgoing session
  (phase 1, with its lock still held); the lock handover itself happens
  in RETIRE, after the old handle is disposed. Releasing first would open
  a window where a racing opener's resume synthesizes closers into the
  shared log while our flush still appends from our in-memory seq — the
  exact corruption the lock exists to prevent.
- **Old lock survives until RETIRE — and RETIRE does NOT release it.**
  The lock holder is multi-slot (`src/open-locks.ts`): the transition
  acquires the TARGET while still holding the OLD lock. RETIRE disposes
  the old handle, runs the local detach gate, and hands the old session
  to COOLING — the transition itself NEVER releases the old lock. The
  release happens only afterwards, inside the cooling coordinator, after
  the durable parity verification succeeds (review round 10; corrected
  for the reactivation model — the old "released inside RETIRE" wording
  is gone). A FRESH target's lock is physically pre-created:
  `acquireSessionLock` pre-creates the session artifact directory (0700)
  when the write would ENOENT, so the lock file exists BEFORE the session
  log is materialized (review round 7 — otherwise "target-lock-before-
  create" silently degenerated to publish-before-lock via no-lock-dir).
  A released lock on an empty pre-created directory best-effort removes
  the directory, so a failed fresh transition leaves no residue. The
  acquire result is structured (`acquired | unavailable | refused`): a
  EVERY writable target's transition requires `acquired` — fresh AND
  existing — `unavailable` fails closed (convergence plan phase 2: the
  lock is the ONLY single-writer mechanism, so an unowned open is never
  acceptable).
  With the multi-slot order a failed switch never drops the old lock in
  the first place (the OLD single-slot design released old-first and its
  failed re-take then left the current session live WITHOUT its lock —
  two processes holding one session; that ordering is what this model
  eliminates), and two processes switching in opposite directions both
  refuse (the acquire is a non-blocking refusal, never a wait) and keep
  their own locks.

## The submit path is guard-free (the decision)

A per-submit cross-process consistency check (stat + a full committed read
comparing the file against memory) USED to run before every Enter/Ctrl+S
send. It was removed: its cost grew with the session history
(`readFrom(id, 0)` parses the whole artifact), long submissions sat for
seconds on a silent no-feedback UI, and its one-time force-through token
invited exactly the double-write it existed to prevent. With the old guard
gone, the single-writer boundary is ONLY the open-time owner lock + lease
+ cooling verifier, and the submit hot path performs ZERO persistence work
(a runner-level test pins this: `test/submit-hot-path.test.ts`). The web
surface and pre-lock TUIs are out of scope by design — they are not part
of this project's ownership model.

## Why release keeps the cooling verifier (the decision, DSH 0.1.2-alpha.1)

The release-barrier convergence plan evaluated replacing the polling
cooling verifier with a deterministic close barrier:
`dispose ⇒ final flush durable ⇒ release lease/lock`. The DSH capabilities
were audited against the pinned source (`0.1.2-alpha.1`, commit `cd5ef814`).
Present: the awaited store flush entry (`sessions.flush(session)` dispatches
the awaited `session/flush` durability checkpoint), the write-behind
quiescent drain with durable batch completion, `Agent.whenIdle()`, and the
ordered agent dispose (abort admission → `machine.cancel` → `whenIdle` →
scope dispose). Missing: **an awaitable post-dispose durability barrier**.
The agent dispose tears down the agent's scope, which detaches the old
session from the store; the store's flush entry then rejects detached
sessions, and the persistence coordinator's retirement drain (started by its
`session/disposed` observer) is deliberately fire-and-forget — session
disposal is observe-only and the retirement promise is private. Teardown
events (an interrupted turn's closers are appended while dispose cancels an
active turn) land after any pre-dispose flush, so flushing before dispose is
not a sound replacement either. Per the plan's stop condition, the release
path therefore RETAINS the cooling verifier: owner.lock + process lease +
cooling remains the release authority on next. Revisit only when DSH exposes
an awaitable final lifecycle barrier (for example, session detach awaiting
its final persistence drain, or a public awaited retirement handle).

## Counting events in a session file (trap)

File rows are the **storage format**, not events. Packed `*-chunks` rows
(`seq0` + `dt`) expand via `decodeStorageRecord` into individual events with
real `seq` values. Any code that counts "events in the file" must expand
rows through the persistence read path (`readFrom`), which expands them;
naive line-counting does not.

## In-process session transitions: the single-writer gate

The lock protects the session FILE from cross-process writers.
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

The fix has two layers. `src/transition-gate.ts` is a **process-local
single-writer queue**: every transition path runs inside
`SessionTransitionGate.run`, held from BEFORE the child create (for
rewind) or the resume (for switches) until the transaction settles. Tasks
are strictly FIFO; a rejected task fails its own caller and never blocks
the queue; re-entering the gate from inside a task is refused loudly
(AsyncLocalStorage detects it — re-entry would deadlock the queue). The
runner exposes the gate as `runner.withSessionTransition(task)`.

On top of the gate, all paths share ONE transaction shape
(`runner.transitionTo` / `RewindCommitHost.transitionTo`), whose phase
order — fixed in `src/transition.ts` (`runTransitionTo`, unit-tested) —
is the whole point:

1. QUIESCE OLD — `old.whenIdle()` then the FINAL flush, with the old
   session's open lock still held;
1b. TARGET LOCK — the child's PRE-GENERATED session id's open lock is
   acquired BEFORE the DSH call (the old lock is still held — the
   multi-slot holder). Every fallible ownership operation happens before
   the durable child is published: a refusal aborts with zero child side
   effects. Once the DSH boundary is crossed (markTouched), a failure
   NEVER gets a same-id recovery — the target is PINNED immediately
   (fail-closed: the first DSH call may have left a hidden lifecycle, so
   a retry cannot clear the uncertainty), never released, never a
   second fresh fallback (the old
   create-then-lock order is historical).
   quiescence (`machine.cancel → whenIdle → scope.dispose`), and a
   cancelled RUNNING turn appends its closure events (interrupted
   assistant/message, step/end, turn/end) in `finally` blocks — releasing
   the old lock before the old agent is idle would let another dsh
   process resume the session while those closures are still appended
   (the two-writers/seq-collision this lock exists to prevent).
   May fail → abort, ZERO child side effects. PRODUCT SEMANTICS: a
   transition while the agent is busy (/new, /fork, /sessions switch)
   WAITS for the current activity instead of aborting it;
2. caller-owned `prepare` (rewind's stale gate, switch lock pre-checks) —
   may fail → abort;
3. create/resume the CHILD — may fail → abort; once it SUCCEEDS the child
   is published (`session/created` → persistence may already write its
   seed) and there is NO failure path after this point that may be
   interpreted as "the child never happened": `dispose()` stops an agent
   but never deletes a persisted session, and dsh has no durable
   rollback API;
4. COMMIT — a synchronous critical section (generation
   bump, live handle/agent replacement — the target lock was acquired in
   phase 2 and stays held; NO lock changes happen here, review round 10)
   with no awaits between its steps;
5. RETIRE — in this order: (1) the OLD handle is disposed — `whenIdle`
   only idles the agent machine; session-scoped async writers (e.g. the
   title generator awaiting a provider) are aborted only by
   `session/disposed`, which the dispose fires; (2) the LOCAL DETACH
   GATE: the old agent/session must be gone from the live registries —
   otherwise the old lease is PINNED (a dispose that did not detach
   means the old session may still be written); (3) the old session
   enters COOLING with its final snapshot — its physical lock is
   released ONLY by the cooling verifier (quiet + durable parity +
   stable samples), never by the transition (review round 10; a
   verifier that cannot settle keeps the lock, pinned); (4) child
   whenIdle, surface rebuild, catalog refresh. Every failure is recorded
   as diagnostics and NEVER rolls the committed child back.

A rejected `create`/`resume` is handled WITHOUT any publication-phase
inference (the old `isDurablePublished` three-state taxonomy is gone)
and WITHOUT a same-id recovery (the old retry is gone too): the target
was TOUCHED before the DSH call, so a rejection PINNS it immediately —
its physical lock stays with this process (a second fresh session is
never created, and an unlocked durable ghost is impossible by
construction). The failure message says the session stays locked.

`whenIdle()` is an INSTANT check, not a freeze: the old agent can be
woken again by a followup/steer while the transition still awaits
(flush, prepare, create). A write in that window would target a session
whose lock is about to be released. The transition gate therefore
doubles as a WRITE FENCE: while a transition is in flight
(`SessionTransitionGate.busy`), every agent-write entry point — plain
submit, busy-Enter steer, Ctrl+S steer, the command fallback followup,
DIRECT slash-command execution (a bare `commands.execute` that landed
across a transition could write an agent whose lock a concurrent
transition is about to release — review round 27), the `!` shell
submit, and the per-skill slash invocations — refuses the write,
restores/keeps the draft or the invocation line (or keeps the shell
card) and notifies "a session transition is in progress". The live
`/preset` swap (recompose + `agent-preset/selected` append) likewise
runs INSIDE the transition gate, so the captured agent can never be
quiesced or unlocked mid-append (review round 27). The submission
re-validation (agent object + session generation) covers the window
AFTER the transition commits; the fence covers the window DURING it.
The `busy` flag alone cannot stop a writer that started BEFORE the
transition and is still awaiting a provider/IO — the
`SessionOperationBarrier` (convergence plan phase 3) therefore runs
every TUI-owned session write inside `runWriter` and every transition
inside `runTransition`: a transition waits for in-flight writers to
drain before it quiesces the old agent, and frozen writers are refused.

### The retirement lifecycle (convergence plan phases 4-6)

Once the DSH boundary is crossed (`agents.create/resume`), NO business
path may release the target lease: a rejection PINNS the target
immediately (NO same-id recovery — the first DSH call may have left a
hidden lifecycle, so a retry cannot clear the uncertainty; lock kept
for this process's lifetime) — there is no second-fresh fallback
anywhere. The transition
COMMIT makes no lock changes at all. The OLD session enters COOLING
after the dispose (with a local detach gate: the old agent/session must
be gone from the live registries): the cooling coordinator verifies the
durable state against the FINAL pre-switch snapshot — the FULL parity
triple (event count, last seq, SHA-256 tail fingerprint; a truncated
history with the same tail never matches) — 1s quiet, 500ms samples,
3 stable samples, 5s max (including the quiet) — then releases the
physical lock; any uncertainty
(missing inspect, read error, mismatch that never settles, empty
session that materialized, non-empty that disappeared) PINNS it.
`DSH_PI_TUI_SESSION_COOLING_RELEASE=0` disables releases (emergency).

### COOLING can be superseded: the same-process reactivation rule

COOLING is NOT terminal. The user may re-enter the retired session in
the SAME process (a `/sessions`/`/resume` switch or a remount while the
old session is still cooling). That path runs through
`reserveForActivation` (NEVER the physical-layer `reserve`, which throws
on a held COOLING/PINNED lease): the previous lifecycle epoch is
invalidated SYNCHRONOUSLY (epoch++, cooling fields cleared, state →
RESERVED, untouched) before any DSH resume, and the physical lock never
leaves this process. A RELEASED tombstone, by contrast, MUST be
re-acquired physically (another process may own the session now).

**Each retirement carries an epoch/token** (`lifecycleEpoch` +
`coolingEpoch` on the lease record; `beginCooling` returns the new
epoch). The cooling verifier is bound to ITS epoch: it re-checks
`isCoolingCurrent(sessionId, epoch)` at every await boundary, and its
release/pin go through the manager's epoch-atomic
`releaseAfterVerifiedCooling(sessionId, epoch)` /
`pinCooling(sessionId, epoch, reason)`. A verifier whose epoch is no
longer current (reactivated, or superseded by a newer retirement) is a
silent stale no-op — it can never release nor pin a later lifecycle,
and it never logs a release success. The in-flight tracker is keyed by
(sessionId → epoch), so a newer retirement is accepted while the older
verifier still runs. An HMR/remount abort of the lifecycle signal is
NEUTRAL (never a pin): the new mount's `resumePending()` continues the
SAME cooling epoch.

### PINNED is a sticky process-lifetime quarantine

PINNED has NO business out-edges. It is the fail-closed state for every
source of "the process cannot prove the session has no hidden writer":
a dispose that did not pass the local detach gate, a cooling verifier
that cannot settle, a refused detach, and a rejected create/resume
(dispose failure, detach-gate failure, and resume/create rejection all
mean the DSH call may have left a hidden lifecycle — the uncertainty is
inherently unresolvable, so a new resume cannot clear it, and a LATER
normal cooling release would hand the lock to another process while
the hidden lifecycle could still write: a cross-process writer window).
Therefore:

- `reserveForActivation` on a held PINNED lease REFUSES (the sticky
  quarantine notice: the session stays locked by this TUI until the
  process exits — restart this TUI before reopening it). A same-process
  reactivation is never allowed to demote a quarantine.
- `beginCooling` and `markActive` on a PINNED lease THROW (BUG: a pinned
  session must never re-enter the lifecycle).
- There is NO same-ID recovery after any post-DSH rejection: the
  create-rejection branch pins immediately (the retry was removed —
  `TransitionSteps.recover` and `createWithPublicationRecovery` are
  gone from `runTransitionTo`, `switchSessionLocked`, the `--session`
  launch and the rewind commit path).

Only process exit — plus the next opener's stale-lock takeover (the
holder is gone) — ends the quarantine: the lock file survives the pin,
so a CRASHED TUI's pinned session is safely re-opened by the next
process, while a LIVE TUI's pinned session stays locked until it exits.

```text
ACTIVE
  │ switch away
  ▼
COOLING(epoch=N) ── verified parity ──► RELEASED
  │  ▲
  │  └─ same-process reactivation (reserveForActivation): epoch=N+1,
  │     state=RESERVED, lock stays — every older verifier goes stale
  ▼
uncertainty / timeout / mismatch (SAME epoch) → PINNED (NO out-edges:
reserveForActivation refuses, beginCooling/markActive throw)
old async completion after epoch changed → STALE NO-OP
```

The old code created the child first and flushed the old session:
a flush failure after the create left a durable ghost branch, and the
old lock was released before the old agent had quiesced. Failures now
only happen before the create: a stale rewind never creates a child at
all, and a failed quiesce/flush/create leaves the current session
untouched.
