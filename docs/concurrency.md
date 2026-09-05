# Session ownership and safety

Session writer ownership has exactly two layers on the master baseline:

1. **Host writer ownership (cross-process)** — DSH's `SessionHandle` +
   `SessionWriteLease` (a kernel flock on `session.lock`) is the sole
   cross-process authority for who may write a session. One process-owned
   surface per session is guaranteed by DSH authority; the TUI adds no
   second persistence/artifact-level owner lock.
2. **TUI local coordination (in-process)** — `SessionTransitionGate`,
   `SessionOperationBarrier`, and generation/stale fences keep the TUI's
   own surface consistent while it switches sessions.

## Host writer ownership: DSH SessionHandle + SessionWriteLease

dsh sessions cannot be shared across processes. Two dsh processes (TUI +
web, or two TUIs) holding one session each number events from their own
in-memory log length, so both can mint the same `seq` and corrupt the log
at the `session/end-seed` resume marker. DSH closes the OPEN path itself:
`agents.create` / `agents.resume` return a `SessionHandle` whose
`dispose()` is the structured teardown of the persistence writer, and the
kernel-flock `SessionWriteLease` (on `session.lock`) is the cross-process
writer authority. A competing opener is refused with
`SessionAlreadyOwnedError`; the TUI surfaces that refusal and leaves the
session untouched — no pin, no retry, no fallback.

The TUI therefore performs NO TUI-side lock bookkeeping: no `owner.lock`
file, no pid/starttime stale takeover, no lease/cooling verifier, no
PINNED quarantine, no manual lock recovery. A clean exit needs no lock
release — the DSH session teardown releases the lease. The TUI's physical
owner.lock / lease / cooling / PINNED stack is removed legacy.

## Session v2 event planes

The TUI keeps DSH's two Session v2 event planes distinct:

- durable `assistant/message` is the surface settlement; durable
  `assistant/attempt` is non-surface attempt evidence that may be projected as
  interrupted UI evidence but never as a model-visible message;
- transient `agent/assistant-stream` carries live deltas and controls before
  durable settlement, and is not used as a second persistence format. Its
  `block-end` control carries the completed content block; the TUI replaces
  that block index in the live projection rather than appending a duplicate.
  The Direct adapter also retains the active prefix per exact live Agent for a
  late subagent-viewer attach, clears it at end/restart/disposal, and never
  writes that transient baseline to the durable Session. A continuable child
  viewer follows the current registered Agent lifecycle, so a same-session
  cold-resume after disposal rebinds to the new Agent while delayed frames from
  the retired Agent remain fenced.

The session picker consumes the semantic list and zero-I/O projection-cache
seams only. It never observes a cold Session merely to fill a label and never
triggers historical migration; DSH persistence owns migration when an explicit
resume opens the Session.

### The field-observed worst shape

Without the open-time refusal, the worst corruption shape unfolds
silently:

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

The DSH `SessionWriteLease` closes the OPEN path so the scenario never
starts: the second opener's `resume` is refused with
`SessionAlreadyOwnedError` before any persistence work happens.

## TUI local coordination

The DSH lease protects the session FILE from cross-process writers. A
separate hazard is IN-PROCESS interleaving between the TUI's own
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

### SessionTransitionGate — one transition at a time

`src/transition-gate.ts` is a **process-local single-writer queue**: every
transition path runs inside `SessionTransitionGate.run`, held from BEFORE
the child create (for rewind) or the resume (for switches) until the
transaction settles. Tasks are strictly FIFO; a rejected task fails its own
caller and never blocks the queue; re-entering the gate from inside a task
is refused loudly (AsyncLocalStorage detects it — re-entry would deadlock
the queue). The runner exposes the gate as `runner.withSessionTransition(task)`.

On top of the gate, all paths share ONE transaction shape
(`runner.transitionTo` / `RewindCommitHost.transitionTo`), whose phase
order — fixed in `src/transition.ts` (`runTransitionTo`, unit-tested) —
is the whole point:

1. QUIESCE OLD — `old.whenIdle()` then the FINAL flush. (A `/new` or
   `/fork` while the agent is busy WAITS for the current activity instead
   of aborting it — the deliberate product semantics.) May fail → abort,
   ZERO child side effects.
2. ALL TUI-owned preflight (preset/composition/stale checks — BEFORE the
   DSH boundary, so failures abort with ZERO side effects).
3. create/resume the CHILD — may fail → abort; once it SUCCEEDS the child
   is published (`session/created` → persistence may already write its
   seed) and there is NO failure path after this point that may be
   interpreted as "the child never happened": `dispose()` stops an agent
   but never deletes a persisted session, and dsh has no durable rollback
   API. A rejection is NEVER retried (no same-ID recovery): the old
   session stays current and the user may retry.
4. COMMIT — a synchronous critical section (generation bump, live
   handle/agent replacement) with no awaits between its steps.
5. RETIRE — dispose the old handle; child surface/catalog work is
   best-effort and the committed child always stands.

A rejected `create`/`resume` is handled WITHOUT any publication-phase
inference: the old session simply stays current and the user may retry.

`whenIdle()` is an INSTANT check, not a freeze: the old agent can be
woken again by a followup/steer while the transition still awaits
(flush, prepare, create). A write in that window would target a session
the transition is about to retire. The transition gate therefore doubles
as a WRITE FENCE: while a transition is in flight
(`SessionTransitionGate.busy`), every agent-write entry point — plain
submit, busy-Enter steer, Ctrl+S steer, the command fallback followup,
DIRECT slash-command execution (a bare `commands.execute` that landed
across a transition could write an agent a concurrent transition is
about to retire — review round 27), the `!` shell submit, and the
per-skill slash invocations — refuses the write, restores/keeps the draft
or the invocation line (or keeps the shell card) and notifies "a session
transition is in progress". The live `/preset` swap (recompose +
`agent-preset/selected` append) likewise runs INSIDE the transition gate,
so the captured agent can never be quiesced mid-append (review round 27).
The submission re-validation (agent object + session generation) covers
the window AFTER the transition commits; the fence covers the window
DURING it.

### SessionOperationBarrier — writers vs. transitions

The `busy` flag alone cannot stop a writer that started BEFORE the
transition and is still awaiting a provider/IO — the
`SessionOperationBarrier` therefore runs every TUI-owned session write
inside `runWriter` and every transition inside `runTransition`: a
transition waits for in-flight writers to drain before it quiesces the old
agent, and writers that start while a transition holds the barrier are
refused (`TransitionInProgressError`).

### Generation/stale fences

- The runner keeps a **monotonic session generation**, bumped on EVERY
  session swap (switch, `/new`, `/fork`, rewind, resume). Late async work
  from the old session captures the generation it started under and
  refuses to commit state once a newer generation owns the surface.
- The submission re-validation checks the live agent object AND the session
  generation before mutating visible state.
- Rewind commits run a **stale gate** before anything is created: the
  source identity captured when the picker opened must still own the
  surface, or the selection is rejected as `stale` (a stale selection
  never creates a child).

## The submit path is guard-free (the decision)

A per-submit cross-process consistency check (stat + a full committed read
comparing the file against memory) USED to run before every Enter/Ctrl+S
send. It was removed: its cost grew with the session history
(`readFrom(id, 0)` parses the whole artifact), long submissions sat for
seconds on a silent no-feedback UI, and its one-time force-through token
invited exactly the double-write it existed to prevent. With the old guard
gone, the single-writer boundary is the DSH `SessionWriteLease`, and the
submit hot path performs ZERO persistence work (a runner-level test pins
this: `test/submit-hot-path.test.ts`). The web surface and other
pre-baseline TUIs are out of scope by design — they are not part of this
project's ownership model.

## Counting events in a session file (trap)

File rows are the **storage format**, not events. Packed `*-chunks` rows
(`seq0` + `dt`) expand via `decodeStorageRecord` into individual events with
real `seq` values. Any code that counts "events in the file" must expand
rows through the persistence read path (`readFrom`), which expands them;
naive line-counting does not.
