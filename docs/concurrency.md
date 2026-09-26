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

The in-process layer lives in the session layer (A2): the ownership core
(`src/app/session/ownership-core.ts`) owns the ONE current-owner slot, the
session generation, the navigation epoch, the transition gate, the operation
barrier and the owner-release ledger; the bound runtime
(`src/app/session/runtime.ts`) runs the four commit shapes
(`src/app/session/commit-order.ts`) plus the retirement coordination; the
consumer-owned ports are in `src/app/session/owner-access.ts`; and
`src/app/direct/owner-registry.ts` + `src/app/direct/owner-retirement.ts` are
the Direct adapters. The runner keeps the surface providers and the Direct
composition root.

## Host writer ownership: DSH SessionHandle + SessionWriteLease

dsh sessions cannot be shared across processes. Two dsh processes (TUI +
web, or two TUIs) holding one session each number events from their own
in-memory log length, so both can mint the same `seq` and corrupt the log
at the `session/end-seed` marker. DSH closes the OPEN path itself:
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

## DSH Session persistence and v2 event planes

The TUI leaves durable format generation to DSH (V2 on the minimum rc.1 runtime,
V3 on the compatible rc.2 runtime) while keeping its two Session v2 event planes
distinct:

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
  cold-resume after disposal rebinds to the new Agent at `turn/start` (before
  the first assistant frame) while delayed frames from the retired Agent remain
  fenced.

The session picker consumes the semantic list and zero-I/O projection-cache
seams only. It never observes a cold Session merely to fill a label and never
triggers historical migration; DSH persistence owns migration when an explicit
resume opens the Session.

### The field-observed worst shape

Without the open-time refusal, the worst corruption shape unfolds
silently:

1. Process A opens session S and is mid-turn (an open `step/start` is the
   last event, A's in-memory seq is `n+1`).
2. Process B opens S. dsh's persistence `prepare` sees the open turn and
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
transition paths — `/new`, `/fork`, `/rewind`, `/sessions` switch/open
and the first-session creation. Before the gate, two such workflows could
overlap across their awaits:

- a fork child can be published while the visible surface moves; publication
  is not rolled back because the persisted child is authoritative. The stale
  child owner is parked in a Direct-only pool and a later `/sessions` open
  claims it instead of starting a second writer;
- a rewind adoption's identity check could pass, then yield across the
  old-owner retirement await, letting a concurrent switch land and later be
  overwritten by the first continuation. The adoption critical section now
  rechecks the navigation identity under the gate.

### SessionTransitionGate — one transition at a time

`src/transition-gate.ts` is a **process-local single-writer queue**: ordinary
session transitions run inside `SessionTransitionGate.run`, held from BEFORE
the child create or Direct `resume` until the transaction settles. Host fork
dispatch is intentionally outside this destructive transition queue; only a
known-current fork adoption enters the gate for the visible handoff and
old-owner retirement. Tasks are strictly FIFO; a rejected task fails its own
caller and never blocks the queue; re-entering the gate from inside a task
is refused loudly (AsyncLocalStorage detects it — re-entry would deadlock
the queue). The runner exposes the gate as `runner.withSessionTransition(task)`.

On top of the gate, ordinary session transitions share ONE transaction shape
(`runner.transitionTo`), whose phase order — fixed in `src/transition.ts`
(`runTransitionTo`, unit-tested) — is the whole point:

1. QUIESCE OLD — `old.whenIdle()` then the FINAL flush. (A `/new`
   while the agent is busy WAITS for the current activity instead of aborting
   it — the deliberate product semantics.) May fail → abort, ZERO child
   side effects.
2. ALL TUI-owned preflight (preset/composition/stale checks — BEFORE the
   DSH boundary, so failures abort with ZERO side effects).
3. create/open the CHILD — may fail → abort; once it SUCCEEDS the child
   is published (`session/created` → persistence may already write its
   seed) and there is NO failure path after this point that may be
   interpreted as "the child never happened": `dispose()` stops an agent
   but never deletes a persisted session, and dsh has no durable rollback
   API. A rejection is NEVER retried (no same-ID recovery): the old
   session stays current and the user may retry.
4. COMMIT — a synchronous critical section: the generation reset runs BEFORE
   the new owner is published into the ownership core
   (`runOrdinaryCommit`, `src/app/session/commit-order.ts`), with no awaits
   between its steps.
5. RETIRE — retire the OLD owner through the retirement port, which owns the
   official session-close order (see the session-owner retirement section);
   child surface/catalog work is best-effort and the committed child always
   stands.

### Fork dispatch and adoption

`/fork` and `/rewind` are deliberately not ordinary transition transactions.
They capture the source identity and navigation epoch, dispatch the semantic
Host fork immediately without `whenIdle()` or the destructive transition gate,
and keep the operation in the session runtime's pending-fork ledger through
adoption or parking. The Host boundary fixes the completed-turn cut at
admission, so a busy source is not waited to a later boundary.

When a known child settles, the runner rechecks the captured identity. A newer
navigation leaves the visible surface unchanged and parks the successful Direct
owner; it does not roll back the published child. If the identity is current,
a short gated handoff swaps the visible handle, bumps the generation, restores
rewind draft state, and retires the old owner. Cleanup waits for pending forks
before retiring current and parked Direct owners, including late published-
with-error settlements.

A rejected `create`/`open` is handled WITHOUT any publication-phase
inference: the old session simply stays current and the user may retry.

`whenIdle()` is an INSTANT check, not a freeze: the old agent can be
woken again by a prompt in `queue` or `steer` mode while the transition still
awaits (flush, prepare, create). A write in that window would target a session
the transition is about to retire. Two mechanisms cover it, on DIFFERENT sides
of admission:

- A writer that starts BEFORE the transition has `whenIdle()` observe the
  active turn, but the transition cannot wait for it via `whenIdle()`. The
  `SessionOperationBarrier` is what makes the transition WAIT: every TUI-owned
  session write runs inside `runWriter` and every transition inside
  `runTransition`, so once a writer is ADMITTED the transition drains it before
  quiescing the old agent. An admitted writer therefore never re-reads the
  transition gate — doing so would truncate it mid-sweep (the writer-first
  contract).
- A writer that STARTS while a transition already holds the barrier is refused
  by the barrier itself (`TransitionInProgressError`), restores/keeps the
  draft, the invocation line or the shell card, and notifies "a session
  transition is in progress". This is the only gate-based refusal for a
  semantic write; there is no automatic retry.
- The submission re-validation (agent object + session generation) covers the
  window AFTER the transition commits.

The legacy `SessionTransitionGate.busy` pre-read survives ONLY as the
attachment-intake UX fence (`sessionTransitionPending()`); no semantic writer
re-reads it. The live `/preset` swap (the official
`agentPresets.select` blank check + recompose transaction + durable
`agent-preset/selected` commit) likewise runs INSIDE the transition gate,
so the captured Session can never be quiesced mid-swap (review round 27).

### SessionOperationBarrier — writers vs. transitions

The `busy` flag alone cannot stop a writer that started BEFORE the
transition and is still awaiting a provider/IO — the
`SessionOperationBarrier` therefore runs every TUI-owned session write
inside `runWriter` and every transition inside `runTransition`: a
transition waits for in-flight writers to drain before it quiesces the old
agent, and writers that start while a transition holds the barrier are
refused (`TransitionInProgressError`).

### SessionRuntime.withWriter — the writer-admission owner

Every TUI-owned session writer enters the barrier through the BOUND session
runtime (`src/app/session/runtime.ts`, `SessionRuntime.withWriter(scope, task)`).
This is the ONE writer-admission owner: `src/index.ts` holds no direct
`barrier.runWriter` call. No semantic writer re-checks the transition gate
AFTER it was admitted: the submission-facing entrypoints (plain prompt, busy
delivery, steer, queue pull-back, `HostCommandPort` submission, shell submit)
admit through the bound runtime and, once admitted, carry only the
surface-lifetime fence — an admitted writer is never truncated by a waiting
transition. Reading `transitionGate.busy` is therefore allowed ONLY as a
PRE-admission quick refusal, in exactly two places:

1. the attachment-intake UX fence (`sessionTransitionPending()`, `src/commands.ts`), and
2. the command-dispatch refusal in `app/submission/runtime.ts`'s
   `executeHostCommandSubmission`, which fires BEFORE its writer section is
   entered (a command about to execute during a transition's pre-freeze window
   would write an agent that is being retired).

Both are pre-admission refusals: nothing committed is ever truncated by them.

- The admission is SCOPE-BOUND and a NO-YIELD section: the scope-currentness
  read (`SessionScopeAuthority.isCurrent`) and the barrier occupancy run in the
  SAME synchronous call stack — there is deliberately no `await` between them,
  so a transition started immediately after the writer returns must wait for it,
  and a stale capture cannot be overtaken by a transition that commits in a
  later microtask.
- The two refusals are DISTINCT signals and must never be conflated. A STALE
  capture (the owner/generation the scope pinned is gone) rejects with
  `SessionScopeSupersededError` (exported from `src/app/session/scope.ts`)
  BEFORE the task body runs; a writer arriving after a transition already FROZE
  the barrier keeps the barrier's own `TransitionInProgressError` (no automatic
  retry — the caller restores its draft). Collapsing them would misreport a
  stale owner as a frozen transition.
- The M3 `session/writer-held` caller/UI insertion point is
  `src/app/submission/runtime.ts`: it owns the submission-facing APPLICATION
  entrypoints (`submitPrompt`, `deliverBusy`, `steer`, `pullBackQueue`,
  `executeHostCommandSubmission`, `submitShell`) and, for each, the
  `WriteOutcome` classification plus the draft/queue/card settlement. Every
  write they perform enters through `SessionRuntime.withWriter`, so the future
  Remote writer-held recovery hangs off this ONE caller-side module rather than
  every writer site.

### D2.1 write settlement

D2.1 makes the current Direct writes asynchronous at the semantic boundary
without changing the ownership or ordering rules:

- Ordinary input uses `SessionWriter.prompt(sessionId, message, mode)`;
  `queue` and `steer` are explicit. Direct Agent admission exceptions settle as
  the official `session/agent-busy` rejection (`prompt rejected` plus the
  exception reason); only a successful Direct call settles as `committed`.
- Ctrl+S remains one operation-barrier turn. A payload-bearing draft takes
  priority and is sent alone through `prompt(..., 'steer')`; it never sweeps
  the queue. With an empty draft, it reads the `PendingInputReader` snapshot,
  selects only `placement: 'queued'`, revalidates the agent identity and
  generation, then calls `updateQueue({ kind: 'steer' })` once per occurrence in
  FIFO order. An empty-draft gesture is gated on `PendingInputSnapshot.running`;
  an idle subject is left untouched. Queue races settle per occurrence rather
  than aborting the whole sweep; missing/unavailable occurrences stop it quietly
  without replay, and a genuine or indeterminate failure never claims
  atomicity or retries. Direct validates edit content before Agent lookup;
  successful removals retire user `rpcId` upload bindings. A failure after
  removal, including retirement failure, is `indeterminate`; cancellation
  before confirmed removal remains `cancelled`.
- Alt+Up is a TUI-only recall-all extension: it calls
  `updateQueue({ kind: 'remove' })` one occurrence at a time in FIFO order,
  then stages the removed content in the editor. It is not the official in-place
  `updateQueue({ kind: 'edit' })` operation, so the recalled draft is a new
  human submission if the user sends it. Already-`steering` and `context`
  placements are not recall targets. A known partial refusal restores only
  confirmed removals; an indeterminate removal keeps every recalled
  representation for manual review and is never retried.
  If a session transition queues while the writer is in flight, visible
  reconciliation waits for its outcome: a committed transition discards the
  staged references without injecting old content, while a failed transition
  restores the appropriate confirmed or indeterminate representation in the
  original editor.
- Host command execution uses `HostCommandPort` after the runner has already
  decided that the line belongs to the Host. Cancellation-shaped adapter throws
  settle `cancelled`; other execution throws settle `indeterminate`, so the
  runner never restores or automatically retries a command whose side effect
  status is unknown. A settled command result is committed separately from the
  TUI's fallback prompt path.
- Task Center child interruption uses `SubagentPort` with the durable direct
  parent and child identities. The semantic writer hides Direct cancellation
  knobs such as the user reason and inbox-preservation option.
- Continuable viewer prompts carry the runner-resolved `queue` or `steer`
  delivery from the child running state and `busyEnter` policy. The prompt
  port forwards that delivery with human provenance; it does not force every
  viewer prompt into a FIFO queue. An empty accelerated viewer submit is a
  child-scoped queue steer-all: it snapshots only the live child’s `queued`
  occurrences and never calls the child prompt API. If that no-payload sweep
  cannot settle, the original child draft (including whitespace-only input) is
  restored to the current editor or the stale child slot. Child queue occurrence
  reads and mutations require the exact interactive continuable viewer Agent,
  its live registry identity, and its pinned direct parent; ordinary child
  prompts retain `SubagentPort` parent authority. The queue pane reads that
  same active child subject while the viewer is mounted; an unavailable child
  clears the pane rather than falling back to the parent's queue.

Known-unwritten outcomes are never reported as committed. An indeterminate
future wire result is not retried automatically or restored as if the queued
occurrence were known-unwritten. A no-payload whitespace draft may still be
restored as editor input; that does not restore or replay the occurrence. Direct
normally returns confirmed `committed` or explicit
refusal outcomes; its exceptional non-occurrence failures continue through the
owned rejection path, while occurrence-level exceptions remain indeterminate
because removal may already have happened.

A single process-local submit FIFO covers ordinary prompts, explicit queue
prompts, Ctrl+S per-occurrence steer sweeps, and command execution including its fallback
prompt. Each gesture takes its turn before async preparation and releases it
only after the semantic command/write path settles, so delayed mention or
attachment preparation cannot let a later gesture overtake an earlier one.

### D2.3 model / preset / create-open ordering

- A live Session model selection is a Session WRITE: `/model` dispatches
  `ModelCatalog.selectSessionModel` INSIDE the writer barrier
  (`SessionRuntime.withWriter(scope, …)`), so a transition that started first
  refuses the write before dispatch and a transition that starts after waits for
  it. The picker
  itself enters an in-place `Selecting…` state (a duplicate apply is never a
  second commit) and the footer shows the in-flight choice as `(selecting…)`
  while keeping the authoritative current value. The
  outcome drives presentation: `committed` follows the authoritative Session
  projection, `rejected`/`cancelled` returns to the model list with the Host
  refusal, and `indeterminate` dismisses without retry and never claims the
  requested model. `/model` and `/preset` capture their semantic SUBJECT once —
  the Session generation PLUS the exact session identity (including `undefined`
  for a sessionless surface) — and re-fence it after EVERY await and before any
  UI mutation; a same-generation Session-identity drift is `superseded` exactly
  like a generation bump, so it is dropped (no repaint, no close/open decision,
  no notice). A dropped live Session write also makes no default-intent claim:
  the sessionless global-default tracker is never entered by a live Session
  write, so nothing leaks into a later fresh create.
- Preset selection stays inside the local transition gate as coordination
  only: the Host owns the serialized switch, the blank re-check, the recompose
  transaction and the durable commit. The command captures the subject once
  (the typed `/preset <id>` path binds the subject it started with, never
  whatever Session exists when an await returns) and revalidates it after every
  await — roster, resolve, the Host transition (before classifying the result)
  and the follow-up catalog refresh (a superseded refresh never repaints).
  Blankness for the picker comes from the official turn-boundary projection,
  never the TUI transcript. `agent-preset/locked` is the
  race-proof final authority and maps to the started-session wording; the TUI
  never mutates its display to a rejected choice.
- A sessionless `/model` choice is a global-default intent. The footer derives
  its sessionless marker from that single tracker: `(selecting…)` while the
  default write is in flight, an explicit `(unconfirmed)` once it settles
  `indeterminate`, and NOTHING once an authoritative Host read reconciles it
  (the persisted default either carries the choice — committed — or proves it
  did not land); a reconciliation that restores an older still-pending intent
  shows `(selecting…)` again. EVERY in-flight
  write (and its fenced correction) is tracked and a fresh create AWAITS their
  settle before dispatching, so the Direct adapter's Host-default activation
  cannot race an older value; the wait is abort-aware, so a hung Host save can
  never block first creation past shutdown. The fresh create consumes the
  SETTLED persisted Host default and
  never durable-seeds a Session choice: a committed save is observed
  dynamically, and a FAILED latest intent is walked back in the UI (v2 §0.8.4)
  — the create uses the actual Host default, it does NOT seed the failed
  selection (a fabricated choice would freeze a default the user never
  durably set, and the sticky failure would leak into later creates). The
  global default is BEST-EFFORT Host state (plan §6.1): a fencing correction
  that itself fails is warned and leaves the persisted default stale until the
  next save — it never becomes durable Session authority.
- Fresh create has NO blind retry: one Host dispatch, and a post-publication
  create error is never reported as "the Session was never created" — the
  requested/published identity is preserved for later reconciliation (D2.4
  closes the full reconnect-settlement matrix). `/new` keeps the old surface
  until the create commits.
- Remote open is a Client selection, not Host activation:
  `ClientSessions.open()/binding()`. It fails closed for an unaddressable
  Session and never invents a Host resume RPC.

### Generation/stale fences

- The ownership core (`src/app/session/ownership-core.ts`) keeps the ONE
  **monotonic session generation**, bumped on EVERY session swap (switch,
  `/new`, `/fork`, rewind, open) by the bound runtime. Late async work from the
  old session captures the generation it started under and refuses to commit
  state once a newer generation owns the surface. Session IDENTITY is the opaque
  `SessionOwnerRef` + generation (`SessionSubject`), never a session id alone;
  the Direct Agent object is reachable only through the Direct owner registry,
  and the transitional `currentDirectAttachment()` projection serves Direct
  DATA/OPERATION reads only — identity and currentness always come from the
  core.
- The submission re-validation checks the live owner SUBJECT (owner ref +
  generation) before mutating visible state.
- Rewind captures the source identity, generation and navigation epoch when the
  picker opens. Selection revalidates that full identity before dispatching the
  Host fork, so returning to the same Session id after newer navigation still
  rejects the stale picker row without creating a child.

## Session-owner retirement

The session layer drives retirement through the consumer-owned
`SessionOwnerRetirement` port (`src/app/session/owner-access.ts`): quiesce or
pre-cancel one owner, retire it in the official session-close order, park a
refused fork's owner for a later claim, and report the retirement outcome: when
a `durabilityFailure` exists the surface shows the SEMANTIC "the latest events
may not be persisted" warning; otherwise, if any failures remain, it summarizes
them for the user with the BACKEND-defined phase labels (diagnostic labels only
— never a cross-backend contract). The bound runtime owns WHEN to retire and
the control flow after an abort.

The backend adapter that implements the port on the in-process path is
`src/app/direct/owner-retirement.ts`; it owns the exactly-once shutdown cancel,
the abort listener and the fixed-phase execution
(`src/runtime/direct/owned-session-retirement.ts`). On the Direct backend the
TUI and the Host share one process and the TUI created the top-level Agent, so
the adapter's cancel/dispose really does release Agent-scoped work. That is
NOT a future Remote `session.close` RPC — a Remote client closes its client-side
observation/connection state through official DSH client contracts and never
destroys the Host Agent, which is exactly why the port fixes only the
observable contract (await quiescence and report which condition ended the
wait) and leaves HOW an abort is reflected onto the owner to the backend.

The retirement order is fixed (mirroring the official DSH ACP session
close):

```text
cancel → idle → descendants → flush → dispose
```

- `cancel` — `agent.cancel({ kind: 'user' })` stops new main-Agent work.
- `idle` — `agent.whenIdle()` awaits the main Agent's quiescence.
- `descendants` — `subagents.drainContinuableDescendants([agent])` closes
  continuable admission below the exact parent, stops visible descendant
  Activations, and releases their `AgentHandle`s child-first. This is the
  piece that previously let a continuable subagent keep the process alive
  for minutes after the TUI exited.
- `flush` — the FINAL `sessions.flush` runs AFTER the descendant drain, so
  the durability boundary includes every descendant settlement.
- `dispose` — `AgentHandle.dispose()` releases the persistence writer and
  stops Agent-scoped background jobs (the TUI never enumerates/kills jobs
  itself — DSH jobs lifecycle is bound to the Agent scope).

Every phase is individually contained: a failure is recorded and the next
phase still runs, so one failure can never re-create a handle leak (a
skipped dispose would pin the old session lease).

Where it runs:

- **Interactive exit** (`/exit`, Ctrl+C/D, plain `exit`): the exit
  controller latches, disposes the Client surface, then runs ONE synchronous
  Direct-retirement preparation hook, then prints the resume hint and
  requests `appExit`:

  ```text
  latch
  → dispose/restore the Client surface
  → synchronously cancel the exact CURRENT Direct owner
  → resume hint
  → appExit
  → application-tree disposer joins the SAME memoized retirement:
       idle → descendants → flush → dispose
  ```

  Only the FIRST cancel comes forward. It is needed because the ordinary
  exit reaches the appExit disposal through `transitionGate.run(...)`, whose
  task is scheduled on a promise continuation: the root teardown could
  unregister the inbox projection before the retirement's async `cancel`
  phase ran (`phase=cancel ... its projection registration is not active`).
  The TUI still never awaits `whenIdle` / drain / flush / dispose in front of
  `appExit` — that full retirement stays inside the application-tree disposal
  under the DSH process-shutdown watchdog.

  The pre-cancel is deduplicated by **exact Agent object identity**, not by a
  boolean or a session id: a session transition that commits during the exit
  replaces the current owner, and the NEW owner must still be cancelled by the
  retirement's cancel phase. A pre-cancel that THROWS is not recorded as done,
  so the retirement retries it. This is Direct-only shutdown preparation; it
  is not the Remote `session.close`, and parked owners are retired by the
  disposal's own loop rather than by the interactive call stack.

  Every shutdown-aware cancel shares that one identity set, because more than
  one owner can be cancelled in a single exit: the current owner is
  pre-cancelled before `appExit`, and a session transition or fork that commits
  AFTERWARDS still retires the owner it replaced. Those transition/fork cancel
  phases join the same set while the lifecycle signal is aborted (outside
  shutdown they keep the ordinary cancel semantics), which is what keeps a late
  non-cooperative child create from producing a second cancel after the root
  teardown unregistered the inbox projection. The `whenIdleOrAbort`
  lifecycle-abort listener contains a throwing cancel and rejects its quiesce
  instead: an `AbortSignal` is a Node EventTarget, so a listener exception
  would otherwise become an `uncaughtException` that the caller's `try`/`catch`
  cannot observe, and the memoized retirement would never get to retry. The
  listener rejects the RAW thrown value — any formatting step (`String(value)`,
  an unprotected `instanceof`, a `.message` read) can itself throw for a
  hostile value, which would escape the listener the same way; observation
  downstream goes through the repo's total error formatters.
- **HMR / runner fiber unload**: the fiber disposer is async (Cordis
  unloads await it) and runs the SAME memoized retirement — one teardown
  promise shared by every teardown path, never four copies. That entry has no
  exit-controller hook, so `retireOwnedSession` performs the same synchronous
  pre-cancel itself before creating the memoized promise.
- **Successful ordinary session transition** (`/new`, `/sessions` switch,
  or open): the pre-commit quiesce (whenIdle + flush) is preserved; AFTER the
  commit the old owner is retired with the same fixed order, so the old
  Agent's continuable descendants are drained and its final flush lands after
  the drain. A failed child create never drains or disposes the old owner —
  the old session stays current (the transaction semantics are unchanged).
- **Fork/rewind adoption:** Host publication is not rolled back on navigation
  supersession. Current Direct adoption retires the old owner after the gated
  visible handoff; a successful unselected child remains parked for a later
  owner claim, and runner teardown retires all remaining parked owners.

The process-local transition gate / operation barrier coordinate only the
TUI's Client writers; they do not take over Host ownership. The retirement
serializes against an in-flight transition through the same gate + barrier
(a FIFO no-op task waits for a running transition to settle — the lifecycle
abort already cancelled its create/open), then retires the CURRENT owner.

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
