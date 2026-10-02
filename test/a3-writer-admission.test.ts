/**
 * A3-3 behavior locks for the scope-bound writer admission and the submission
 * runtime's terminal settlement (plan §1.3/§4.3).
 *
 * 1. `SessionRuntime.withWriter(scope, task)` admits SYNCHRONOUSLY: the scope
 *    check and the barrier occupancy happen in the same call stack, so a
 *    transition started immediately after it returns must WAIT for the writer
 *    (the no-yield invariant). A writer arriving after a transition froze is
 *    refused with the barrier's own `TransitionInProgressError` (no retry); a
 *    STALE scope is refused with the dedicated `SessionScopeSupersededError`
 *    BEFORE the task body runs — never the two conflated.
 * 2. The submission runtime turns those two refusals into their DISTINCT
 *    terminal UX (draft restore + ack): a frozen transition restores the draft,
 *    a stale capture takes the stale path, and neither runs the prompt write.
 * 3. The queue-recall state commits on a committed transition and aborts on a
 *    failed one.
 * 4. A3-4: the SUBMISSION-domain writer sections (busy/steer, queue pull-back,
 *    HostCommandPort submission) enter through the submission runtime's
 *    `withWriter`, which delegates to `SessionRuntime.withWriter`; the runner
 *    holds no direct `barrier.runWriter` site and the command layer no
 *    `withSessionWriter`.
 * @module @xmoon76/dsh-pi-tui/a3-writer-admission.test
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import {
  bindSessionRuntime,
  type SessionRuntimeDeps,
} from '../src/app/session/runtime.ts'
import type { SessionOwnershipCore } from '../src/app/session/ownership-core.ts'
import { SessionScopeSupersededError, type LiveSessionScope } from '../src/app/session/scope.ts'
import {
  bindSubmissionRuntime,
  deliverBusy,
  executeHostCommandSubmission,
  type HostCommandSubmissionDeps,
  type PromptSubmission,
  type SteerSubmissionDeps,
  type SubmissionRuntimeSurface,
} from '../src/app/submission/runtime.ts'
import { SessionOperationBarrier, TransitionInProgressError } from '../src/session-operation-barrier.ts'
import { SESSION_WRITER_HELD_GUIDANCE } from '../src/runtime/remote/write-failure.ts'
import { compositionSource } from './support/composition-surface.ts'
import { productionSources } from './support/owner-modules.ts'

const SCOPE = { sessionId: 's1' } as unknown as LiveSessionScope

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Bind the real session runtime over a bare barrier + a scope predicate. */
function bind(isScopeCurrent: (scope: LiveSessionScope) => boolean) {
  const barrier = new SessionOperationBarrier()
  const runtime = bindSessionRuntime(
    { barrier } as unknown as SessionOwnershipCore,
    { isScopeCurrent } as unknown as SessionRuntimeDeps,
  )
  return { runtime, barrier }
}

test('withWriter admits synchronously: a transition started right after must wait', async () => {
  const { runtime, barrier } = bind(() => true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writerInside = false
  const pending = runtime.withWriter(SCOPE, async () => {
    writerInside = true
    await gate
  })
  // The writer is occupied BEFORE the returned promise is awaited — the
  // no-yield admission. A transition started now must wait for it to drain.
  assert.equal(barrier.activeWriters, 1, 'the writer must be occupied synchronously at admission')
  let transitionDone = false
  const transition = barrier.runTransition(async () => { transitionDone = true })
  await flush()
  assert.equal(writerInside, true)
  assert.equal(transitionDone, false, 'the transition must wait for the admitted writer')
  release()
  await pending
  await transition
  assert.equal(transitionDone, true)
})

test('withWriter arriving after a transition froze keeps TransitionInProgressError (no retry)', async () => {
  const { runtime, barrier } = bind(() => true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  // Freeze the barrier SYNCHRONOUSLY (runTransition flips `frozen` before its
  // first await) and hold the transition open.
  const transition = barrier.runTransition(async () => { await gate })
  let taskRan = false
  await assert.rejects(
    runtime.withWriter(SCOPE, () => { taskRan = true }),
    (error: unknown) => error instanceof TransitionInProgressError,
  )
  assert.equal(taskRan, false, 'a frozen transition must refuse BEFORE the task body')
  release()
  await transition
})

test('withWriter on a stale scope rejects SessionScopeSupersededError and runs NO task body', async () => {
  // The scope predicate answers stale: the captured owner is gone. This is a
  // DIFFERENT signal from a frozen transition and must never be reported as one.
  const { runtime, barrier } = bind(() => false)
  let taskRan = false
  await assert.rejects(
    runtime.withWriter(SCOPE, () => { taskRan = true }),
    (error: unknown) => error instanceof SessionScopeSupersededError
      && !(error instanceof TransitionInProgressError),
  )
  assert.equal(taskRan, false, 'a stale scope must not run the task body')
  assert.equal(barrier.activeWriters, 0, 'a stale admission must not occupy the writer')
})

/** A full recording surface; overrides flip individual behaviors. */
function recordingSurface(overrides: Partial<SubmissionRuntimeSurface>): {
  surface: SubmissionRuntimeSurface
  calls: string[]
} {
  const calls: string[] = []
  const never = (): never => { throw new Error('unexpected surface call') }
  const surface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: () => { calls.push('merge'); return true },
    consumeDraftAttachments: () => { calls.push('consume') },
    markDispatch: () => { calls.push('dispatch') },
    beginLocalSubmission: () => { calls.push('echo') },
    settleLocalSubmission: () => { calls.push('settleLocal') },
    settleSubmitAck: (reason) => { calls.push(`ack:${reason}`) },
    notify: (message, kind) => { calls.push(`notify:${kind}:${message}`) },
    refuseByTransitionFence: () => { calls.push('fence') },
    prepareMessage: never,
    prompt: never,
    ...overrides,
  }
  return { surface, calls }
}

const SUBMISSION: PromptSubmission = {
  text: 'hello',
  scope: SCOPE,
  requestId: 'request-1',
  ackToken: 7,
  generation: 3,
  echoInstalled: true,
}

test('a frozen transition refuses the prompt write, restores the draft and settles its ack', async () => {
  const { surface, calls } = recordingSurface({
    withWriter: () => Promise.reject(new TransitionInProgressError()),
    withPromptAdmission: () => { throw new Error('the admission must never run') },
  })
  const runtime = bindSubmissionRuntime({ surface })
  await runtime.submitPrompt(SUBMISSION)
  assert.deepEqual(calls, [
    'settleLocal',
    'ack:submit refused by transition fence',
    'fence',
  ], 'the fence refusal settles the echo/ack and restores the draft — never a prompt write')
})

test('a stale scope refused at admission takes the distinct stale path and runs no write', async () => {
  const { surface, calls } = recordingSurface({
    withWriter: () => Promise.reject(new SessionScopeSupersededError()),
    withPromptAdmission: () => { throw new Error('the admission must never run') },
  })
  const runtime = bindSubmissionRuntime({ surface })
  await runtime.submitPrompt(SUBMISSION)
  assert.deepEqual(calls, [
    'merge',
    'settleLocal',
    'ack:submit stale',
    `notify:error:the session changed while sending — try again`,
  ], 'a stale capture takes the stale path — never the transition refusal')
})

test('a committed transition settles the queue recall; a failed one restores it', () => {
  const { surface } = recordingSurface({})
  const runtime = bindSubmissionRuntime({ surface })
  const log: string[] = []
  runtime.deferQueueRecall({ commit: () => log.push('commit'), abort: () => log.push('abort') })
  runtime.settleQueueRecalls(true)
  assert.deepEqual(log, ['commit'])
  runtime.deferQueueRecall({ commit: () => log.push('commit-2'), abort: () => log.push('abort-2') })
  runtime.settleQueueRecalls(false)
  assert.deepEqual(log, ['commit', 'abort-2'])
  // Settling with nothing parked is a no-op (a preflight failure still settles).
  runtime.settleQueueRecalls(false)
  assert.deepEqual(log, ['commit', 'abort-2'])
})

test('app/submission owns the submission domain only: no Direct module, no Host Agent', () => {
  const source = readFileSync(new URL('../src/app/submission/runtime.ts', import.meta.url), 'utf8')
  for (const forbidden of [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-session',
    'app/direct/',
    'runtime/direct/',
  ]) {
    assert.equal(source.includes(forbidden), false, `app/submission must not reach ${forbidden}`)
  }
})

test('the queue-recall state and the plain-submit write body live in app/submission', () => {
  const index = compositionSource()
  // The concrete state and its settle body moved out; only the WHEN seam
  // (`SessionRuntimeSurface.settlePendingQueueRecalls`) remains in the runner.
  assert.equal(index.includes('const pendingQueueRecalls'), false,
    'the pendingQueueRecalls state must live in app/submission')
  assert.equal(index.includes('pendingQueueRecalls.push'), false,
    'the settle body must live in app/submission')
  // The plain-prompt write orchestration (prepare → semantic write → consume)
  // is gone from the runner: the write sites delegate to the submission
  // runtime through `submitPrompt`. A5b-4 moved the sites into the submission
  // controller owner, so the lock follows the authority there. M3-4 PR4 §1.3
  // collapsed the former TWO sites into ONE: the command-dispatch window is
  // now always open (Direct through the in-process executor, Remote through
  // the Client registry + HostCommandPort), so the post-window "no commands
  // service" fallthrough became unreachable and was deleted; the single
  // remaining delegation is the command-submission fallback the runtime
  // drives for an agent-facing line.
  const controller = readFileSync(new URL('../src/app/submission/controller.ts', import.meta.url), 'utf8')
  assert.equal((controller.match(/deps\.submissionRuntime\.submitPrompt\(/g) ?? []).length, 1,
    'the agent-facing write must delegate to the submission runtime through submitPrompt')
  assert.ok(controller.includes('submitPrompt: (submission) => deps.submissionRuntime.submitPrompt(submission)'),
    'the delegation is the command-submission fallback hook (never a second write path)')
})

// ── A3-4: the submission-domain writer sections (moved sites) ──────────────

/**
 * Bind the REAL submission runtime over the REAL session runtime + barrier, so
 * the moved-domain locks exercise the actual admission rather than a stub.
 */
function bindSubmissionOverSession(isScopeCurrent: (scope: LiveSessionScope) => boolean): {
  runtime: ReturnType<typeof bindSubmissionRuntime>
  barrier: SessionOperationBarrier
} {
  const { runtime: sessionRuntime, barrier } = bind(isScopeCurrent)
  const { surface } = recordingSurface({
    withWriter: (scope, task) => sessionRuntime.withWriter(scope, task),
  })
  return { runtime: bindSubmissionRuntime({ surface }), barrier }
}

/** Assert the writer-first contract for one moved submission domain: the
 * domain occupies the barrier BEFORE it yields, and a transition started
 * immediately after must wait for it to drain. */
test('moved domain (HostCommand submission): the submission runtime occupies the barrier before the execute yields', async () => {
  const { runtime, barrier } = bindSubmissionOverSession(() => true)
  let ran = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = runtime.withWriter(SCOPE, async () => {
    ran = true
    await gate
  })
  assert.equal(barrier.activeWriters, 1, 'HostCommand submission: admission is synchronous')
  let transitionDone = false
  const transition = barrier.runTransition(async () => { transitionDone = true })
  await flush()
  assert.equal(ran, true)
  assert.equal(transitionDone, false, 'the transition waits for the HostCommand writer')
  release()
  await pending
  await transition
  assert.equal(transitionDone, true)
})

test('moved domain (queue pull-back): the submission runtime occupies the barrier before the removals yield', async () => {
  const { runtime, barrier } = bindSubmissionOverSession(() => true)
  let ran = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = runtime.withWriter(SCOPE, async () => {
    ran = true
    await gate
  })
  assert.equal(barrier.activeWriters, 1, 'queue pull-back: admission is synchronous')
  let transitionDone = false
  const transition = barrier.runTransition(async () => { transitionDone = true })
  await flush()
  assert.equal(ran, true)
  assert.equal(transitionDone, false, 'the transition waits for the pull-back writer')
  release()
  await pending
  await transition
  assert.equal(transitionDone, true)
})

test('moved domain (busy delivery/steer): the submission runtime occupies the barrier before the steer yields', async () => {
  const { runtime, barrier } = bindSubmissionOverSession(() => true)
  let ran = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = runtime.withWriter(SCOPE, async () => {
    ran = true
    await gate
  })
  assert.equal(barrier.activeWriters, 1, 'busy/steer: admission is synchronous')
  let transitionDone = false
  const transition = barrier.runTransition(async () => { transitionDone = true })
  await flush()
  assert.equal(ran, true)
  assert.equal(transitionDone, false, 'the transition waits for the steer writer')
  release()
  await pending
  await transition
  assert.equal(transitionDone, true)
})

test('the moved domains refuse a FROZEN transition before the task body', async () => {
  const { runtime, barrier } = bindSubmissionOverSession(() => true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transition = barrier.runTransition(async () => { await gate })
  for (const domain of ['HostCommand', 'pull-back', 'steer']) {
    let ran = false
    await assert.rejects(
      runtime.withWriter(SCOPE, () => { ran = true }),
      (error: unknown) => error instanceof TransitionInProgressError,
      `${domain}: a frozen transition must throw TransitionInProgressError`,
    )
    assert.equal(ran, false, `${domain}: a frozen transition runs NO task body`)
  }
  release()
  await transition
})

test('the moved domains refuse a STALE capture with SessionScopeSupersededError, never the transition error', async () => {
  const { runtime, barrier } = bindSubmissionOverSession(() => false)
  for (const domain of ['HostCommand', 'pull-back', 'steer']) {
    let ran = false
    await assert.rejects(
      runtime.withWriter(SCOPE, () => { ran = true }),
      (error: unknown) => error instanceof SessionScopeSupersededError
        && !(error instanceof TransitionInProgressError),
      `${domain}: a stale capture must reject with its own signal`,
    )
    assert.equal(ran, false, `${domain}: a stale capture runs NO task body`)
  }
  assert.equal(barrier.activeWriters, 0, 'a stale admission never occupies the writer')
})

// ── A3-4: the four static exit criteria ────────────────────────────────────

function span(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `span start not found: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `span end not found: ${end}`)
  return source.slice(from, to)
}

/** Every `.ts` file under src/, as a path relative to src/. */
function srcTsFiles(dir: URL, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...srcTsFiles(new URL(`${entry.name}/`, dir), rel))
    else if (entry.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

test('A3-4 static exit: index.ts has ZERO direct writer admission; commands.ts has ZERO withSessionWriter', () => {
  const index = compositionSource()
  const commands = readFileSync(new URL('../src/commands.ts', import.meta.url), 'utf8')
  assert.equal(index.includes('ownership.barrier.runWriter('), false,
    'the composition surface must hold no direct runWriter site')
  assert.equal(index.includes('.barrier.runWriter('), false,
    'the composition surface must reach no raw barrier writer admission')
  assert.equal(commands.includes('withSessionWriter'), false,
    'TuiCommandRunner.withSessionWriter must be deleted')
})

test('A3-4 static exit: sessionTransitionPending() is used ONLY by the attachment-intake UX fence', () => {
  const commands = readFileSync(new URL('../src/commands.ts', import.meta.url), 'utf8')
  // The /skill semantic write enters through withWriter: no gate.busy re-check.
  const skill = span(commands, 'const loadSkill = async (', '\n  const skillDisposers = new Map<string, () => void>()')
  assert.equal(skill.includes('sessionTransitionPending()'), false,
    'the /skill writer section must not pre-check the transition gate')
  // The only remaining uses are the attachment-intake UX fence (a draft-stage
  // gate, NOT a semantic session write).
  const intake = span(
    commands,
    'const stageAttachmentCommand = (',
    "\n  registerTuiCommand({\n    name: 'attach'",
  )
  const fenced = intake.match(/sessionTransitionPending\(\)/g) ?? []
  assert.equal(fenced.length, 3, 'the attachment intake keeps its three UX checks')
  // The lock scans EVERY production source, not just commands.ts (A5b review
  // finding): deriving `all` from the same file as `fenced` made a second
  // caller in any other module invisible. Every occurrence across src/** must
  // be in commands.ts, and the only non-fence occurrence there is the
  // interface declaration.
  const sites = productionSources().flatMap(({ rel, source }) =>
    Array.from(source.matchAll(/sessionTransitionPending\(\)/g), () => rel),
  )
  assert.deepEqual(
    sites,
    Array.from({ length: fenced.length + 1 }, () => 'src/commands.ts'),
    'the only sessionTransitionPending() outside the intake fence is the interface declaration in src/commands.ts (whole-tree)',
  )
})

test('A3-4 static exit: SessionRuntime is the SOLE operation-barrier writer admission owner', () => {
  const root = new URL('../src/', import.meta.url)
  const offenders = srcTsFiles(root)
    .filter(rel => rel !== 'app/session/runtime.ts')
    .filter(rel => readFileSync(new URL(rel, root), 'utf8').includes('.barrier.runWriter('))
  assert.deepEqual(offenders, [],
    'only SessionRuntime.withWriter may call the operation barrier')
})

test('P1-1 static: no production fence carries the transition gate into an admitted writer', () => {
  // The transition gate may gate a writer that has NOT yet been admitted, but
  // once a writer holds the barrier the gate must WAIT for the whole writer.
  // Re-reading `gate.busy` inside an admitted writer's fence truncates it.
  const index = compositionSource()
  const runtime = readFileSync(new URL('../src/app/submission/runtime.ts', import.meta.url), 'utf8')
  for (const [file, source] of [['the composition surface', index], ['../src/app/submission/runtime.ts', runtime]] as const) {
    assert.equal(/fence:\s*\(\)\s*=>[^\n]*gate\.busy/u.test(source), false,
      `${file}: an admitted writer's fence must never read the transition gate`)
  }
  // The main steer and the shell submit share the SURFACE-lifetime-only fence
  // (after A3-4 they live in the submission runtime's deps hooks).
  assert.equal((runtime.match(/fence: \(\) => deps\.isDisposed\(\)/gu) ?? []).length, 2,
    'the main steer and the shell submit keep the surface-lifetime fence')
  // The child-viewer steer is a DIFFERENT ownership axis: the viewer
  // generation, never the session transition gate. A5b-5 moved the event
  // adapter into its owner, so the positive anchor follows it there.
  const eventsOwner = readFileSync(new URL('../src/app/surface/application-events.ts', import.meta.url), 'utf8')
  assert.ok(eventsOwner.includes('fence: () => deps.lifecycle.isCleanedUp() || app.getViewerGeneration() !== childViewerGeneration,'),
    'the child-viewer steer keeps its own viewer-generation axis')
  // The pull-back's delayed-representation reconciliation still reads the
  // queued transition + the frozen barrier together. A5b-4 moved the pull-back
  // body into the submission controller owner, so the composition root now
  // supplies the narrow `transitionPending` capability the owner reads.
  assert.ok(index.includes('transitionPending: () => ownership.gate.pending || ownership.barrier.inTransition,'),
    'the pull-back transition reconciliation is untouched')
  // ...and the OWNER must actually CONSUME that capability at its pull-back
  // reconciliation: a root-only injection assertion would keep passing if the
  // owner stopped reading it (A5b-4 review finding).
  const controller = readFileSync(new URL('../src/app/submission/controller.ts', import.meta.url), 'utf8')
  const pullBackAt = controller.indexOf('isTransitionPending: () => deps.ownership.transitionPending(),')
  assert.ok(pullBackAt > 0,
    'the submission controller must consume the injected transition-pending capability in its pull-back reconciliation')
})

test('the queue pull-back reconciles a STALE pre-entry refusal distinctly from a transition', () => {
  // DEFENSIVE branch: this path is currently synchronous from the scope capture
  // to the writer entry, so only a frozen transition can land in the outer catch
  // today. The stale branch exists because the two refusals are DIFFERENT signals
  // (plan §1.3): if a future refactor introduces an await in that window, a stale
  // capture must drop the staged refs and report the STALE notice — never leave
  // them behind while claiming a transition is in progress.
  // The pull-back orchestration now lives in `app/submission/runtime.ts`; the
  // runner keeps only the narrow hooks.
  const source = readFileSync(new URL('../src/app/submission/runtime.ts', import.meta.url), 'utf8')
  const pullBack = source.slice(
    source.indexOf("runOwned('queue pull-back'"),
    source.indexOf("onError: (_error) => {", source.indexOf("runOwned('queue pull-back'")),
  )
  const outerCatch = pullBack.slice(pullBack.lastIndexOf('.catch(error => {'))
  assert.ok(outerCatch.includes('if (error instanceof TransitionInProgressError) {'),
    'the transition refusal keeps its branch')
  assert.ok(outerCatch.includes('} else if (error instanceof SessionScopeSupersededError) {'),
    'a stale pre-entry refusal has its OWN branch')
  const staleBranch = outerCatch.slice(outerCatch.indexOf('SessionScopeSupersededError'))
  assert.ok(staleBranch.includes('discardStaged()'),
    'a stale refusal discards the staged attachments')
  assert.ok(staleBranch.includes("failureKind = 'stale'"),
    'a stale refusal reports the stale kind')
  assert.ok(source.includes("if (failureKind === 'stale')"),
    'the stale kind has its own user notice')
  assert.ok(source.includes('the session changed while pulling messages back'),
    'the stale notice text is the session change, not a transition')
})

test('the transition gate has exactly ONE production reader: the intake UX fence', () => {
  const runtime = readFileSync(new URL('../src/app/submission/runtime.ts', import.meta.url), 'utf8')
  // The gate has exactly ONE production reader across ALL of `src/**` (not just
  // the composition surface): the attachment-intake UX fence
  // (`sessionTransitionPending`). Reading only the composition surface made a
  // second reader in an unlisted module invisible. The HostCommand quick fence
  // was removed; `SessionRuntime.withWriter` is the sole writer-admission
  // authority.
  const readers = productionSources()
    .flatMap(({ rel, source }) => Array.from(source.matchAll(/ownership\.gate\.busy/g), () => rel))
  assert.deepEqual(readers, ['src/app/bootstrap.ts'],
    'the gate may be read only by the attachment-intake UX fence (in src/app/bootstrap.ts)')
  assert.equal(runtime.includes('isTransitionBusy'), false,
    'app/submission must not read the transition gate')
  const command = runtime.slice(
    runtime.indexOf('export function executeHostCommandSubmission'),
    runtime.indexOf("runOwned('command execution'"),
  )
  assert.equal(command.includes('isTransitionBusy'), false,
    'the command dispatch no longer pre-checks the transition gate')
})

test('the HostCommand path maps a frozen transition to the proven-refusal settlement', async () => {
  const calls: string[] = []
  const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }
  const deps = {
    isDisposed: () => false,
    notify: (message: string, kind: string) => { calls.push(`notify:${kind}:${message}`) },
    loggerError: (message: string) => { calls.push(`log:${message}`) },
    readDraft: () => '',
    mergeDraftIntoEditor: () => true,
    restoreSubmissionDraft: () => { calls.push('restore') },
    consumeDraftAttachments: () => {},
    draftHasAttachments: () => false,
    pinDraftAttachments: () => () => {},
    settleLocalSubmission: () => { calls.push('settleLocal') },
    settleSubmitAck: (reason: string) => { calls.push(`ack:${reason}`) },
    notifySubmissionFailure: () => { calls.push('notifyFailure') },
    isScopeCurrent: () => true,
    refuseByTransitionFence: () => { calls.push('fence') },
    lateAttachmentRefusal: () => undefined,
    commandSubmitAttachments: () => [],
    isTuiOwnedCommand: () => false,
    commandPlaneOwnsLine: () => false,
    submittedHostClaim: () => undefined,
    commandSignal: () => new AbortController().signal,
    invokeCommandPlane: async () => { throw new TransitionInProgressError() },
    beginCommandSettlement: () => {},
    abortCommandSettlement: () => {},
    settleCommandSettlement: () => {},
    trackSettlementWork: () => {},
    captureCommandHealthRef: () => 'health-ref',
    clearCommandHealthError: () => {},
    recordCommandHealthError: () => { calls.push('health') },
    readCommandDraftDisposition: () => undefined,
    shouldConsumeAdvertisedMiss: () => false,
    isIndeterminateSkillWrite: () => false,
    startArtifactSave: () => {},
    submitPrompt: async () => {},
    commandSessionId: () => 's1',
    markTurnTransferred: () => {},
    diag,
  }
  executeHostCommandSubmission(deps as unknown as HostCommandSubmissionDeps, {
    text: '/compact',
    toggled: '/compact',
    scope: SCOPE,
    submitRequestId: 'request-1',
    submitAckToken: 7,
    generation: 1,
    localEchoInstalled: false,
    wasAdvertisedAtSubmit: true,
    parsedName: 'compact',
    submitTurn: { wait: Promise.resolve(), release: () => {} },
  })
  await flush()
  await flush()
  assert.ok(calls.includes('fence'), 'the draft is restored via the transition refusal')
  assert.ok(calls.includes('ack:submit refused by transition fence'),
    'the ack settles as the proven pre-dispatch refusal')
  assert.ok(!calls.includes('health'),
    'a frozen transition is never recorded as a command-health error')
  assert.ok(!calls.some(call => call.startsWith('log:')),
    'the generic command-failure logger never runs')
  assert.ok(!calls.includes('notifyFailure'),
    'the generic submission-failure notice never runs')
})

/** Flush microtasks/setImmediate rounds until `done` (a bounded drain). */
async function drainUntil(done: () => boolean): Promise<boolean> {
  for (let index = 0; index < 50; index += 1) {
    if (done()) return true
    await flush()
  }
  return done()
}

test('P1 lock: a session/writer-held steer rejection is settled by the submission owner', async () => {
  const calls: string[] = []
  const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }
  const agent = { session: { id: 's1' }, status: 'running' }
  const deps = {
    isDisposed: () => false,
    isViewing: () => false,
    currentAgent: () => agent,
    currentGeneration: () => 1,
    captureOwnerToken: () => 'owner',
    isOwnerTokenCurrent: () => true,
    readPendingInput: () => ({ running: true, items: [] }),
    draftHasAttachments: () => false,
    draftHasImages: () => false,
    clearSettledLocalMessages: () => {},
    mergeDraftIntoEditor: (text: string) => { calls.push(`merge:${text}`); return true },
    notify: (message: string, kind: string) => { calls.push(`notify:${kind}:${message}`) },
    acceptSubmitAck: () => 7,
    settleLocalSubmission: () => { calls.push('settleLocal') },
    settleSubmitAck: (reason: string) => { calls.push(`ack:${reason}`) },
    beginLocalSteerEcho: () => {},
    takeSubmitTurn: () => ({ wait: Promise.resolve(), release: () => {} }),
    pinDraftAttachments: () => () => {},
    persistAfterSession: async (resolve: () => Promise<string | undefined>, persist: (id: string | undefined) => void) => {
      const id = await resolve()
      if (id !== undefined) persist(id)
    },
    ensureSession: async () => {},
    withPromptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => Promise<unknown>) => task(),
    prepareMessage: async () => ({}),
    markDispatch: () => {},
    restoreSubmissionDraft: (text: string) => { calls.push(`restore:${text}`) },
    notifySubmissionFailure: () => { calls.push('notifyFailure') },
    consumeDraftAttachments: () => { calls.push('consume') },
    writerSection: async (task: () => Promise<unknown>) => task(),
    pendingInputReader: { snapshot: () => ({ running: true, items: [] }) },
    writer: {
      prompt: async () => ({
        kind: 'rejected' as const,
        error: { code: 'session/writer-held', message: SESSION_WRITER_HELD_GUIDANCE },
      }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
    },
    diag,
  }
  deliverBusy(deps as unknown as SteerSubmissionDeps, { text: 'held draft' })
  assert.equal(await drainUntil(() => calls.some(call => call.startsWith('ack:'))), true,
    'the steer gesture must settle its ack')
  assert.ok(calls.includes('merge:held draft'),
    'the submission owner restores the draft')
  assert.ok(calls.some(call => call.includes(SESSION_WRITER_HELD_GUIDANCE)),
    'the writer-held guidance is surfaced')
  assert.ok(calls.some(call => call.startsWith('ack:steer rejected: session/writer-held')),
    'the owner reads the rejection code')
  assert.ok(calls.every(call => !call.includes('try again')),
    'a proven refusal never tells the user to try again')
  assert.deepEqual(calls.filter(call => call.startsWith('restore:')), [],
    'the helper never restores behind the owner (no double restore)')
})

/* ── PR5 (plan §3.8): stale Host-command settlement makes no visible commit ── */

test('PR5: a command settlement whose subject was REPLACED performs cleanup only, never a visible mutation', async () => {
  // The §3.8 invariant: the Host may finish the old command and the durable
  // Host-side settlement completes, but once the captured SessionScope is no
  // longer current the old operation cannot mutate the replacement TUI
  // surface — no draft restore/consume, no ack rows, no notices, no health
  // repaint, no artifact save. The release bookkeeping (pin + submit turn)
  // MUST still run.
  const calls: string[] = []
  const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }
  let released = false
  let scopeCurrent = true
  const deps = {
    isDisposed: () => false,
    notify: (message: string, kind: string) => { calls.push(`notify:${kind}:${message}`) },
    loggerError: (message: string) => { calls.push(`log:${message}`) },
    readDraft: () => '',
    mergeDraftIntoEditor: () => true,
    restoreSubmissionDraft: () => { calls.push('restore') },
    consumeDraftAttachments: () => { calls.push('consume') },
    draftHasAttachments: () => false,
    pinDraftAttachments: () => () => { calls.push('fallbackPin') },
    settleLocalSubmission: () => { calls.push('settleLocal') },
    settleSubmitAck: (reason: string) => { calls.push(`ack:${reason}`) },
    notifySubmissionFailure: () => { calls.push('notifyFailure') },
    isScopeCurrent: () => scopeCurrent,
    refuseByTransitionFence: () => { calls.push('fence') },
    lateAttachmentRefusal: () => undefined,
    commandSubmitAttachments: () => [],
    isTuiOwnedCommand: () => false,
    commandPlaneOwnsLine: () => false,
    submittedHostClaim: () => undefined,
    commandSignal: () => new AbortController().signal,
    // A HOST command that SUCCEEDS while held, then the subject is replaced
    // before the settlement runs (the /export artifact-save sink is the
    // strongly observable mutation the plan demands).
    invokeCommandPlane: async () => {
      scopeCurrent = false
      return { kind: 'committed' as const, matched: true, execution: { commandId: 'export', result: { kind: 'success' as const } } }
    },
    beginCommandSettlement: () => {},
    abortCommandSettlement: () => {},
    settleCommandSettlement: () => {},
    trackSettlementWork: () => {},
    captureCommandHealthRef: () => 'health-ref',
    clearCommandHealthError: () => { calls.push('health-clear') },
    recordCommandHealthError: () => { calls.push('health') },
    readCommandDraftDisposition: () => undefined,
    shouldConsumeAdvertisedMiss: () => false,
    isIndeterminateSkillWrite: () => false,
    startArtifactSave: () => { calls.push('artifactSave') },
    submitPrompt: async () => {},
    commandSessionId: () => 's1',
    markTurnTransferred: () => {},
    deps_diag_placeholder: diag,
    diag,
    // The submit turn's release is the leak-prevention bookkeeping.
    // (supplied via input.submitTurn below)
  }
  executeHostCommandSubmission(deps as unknown as HostCommandSubmissionDeps, {
    text: '/export',
    toggled: '/export',
    scope: SCOPE,
    submitRequestId: 'request-stale',
    submitAckToken: 9,
    generation: 1,
    localEchoInstalled: false,
    wasAdvertisedAtSubmit: true,
    parsedName: 'export',
    submitTurn: { wait: Promise.resolve(), release: () => { released = true; calls.push('turnRelease') } },
  })
  await drainUntil(() => calls.includes('fallbackPin'))
  assert.equal(released, true, 'the submit turn is ALWAYS released (leak prevention)')
  assert.ok(calls.includes('fallbackPin'), 'the fallback pin is ALWAYS released')
  // NO visible mutation of the replacement surface.
  assert.deepEqual(calls.filter(call =>
    call === 'restore' || call === 'consume' || call === 'settleLocal'
    || call.startsWith('ack:') || call.startsWith('notify') || call === 'health-clear'
    || call === 'health' || call === 'artifactSave' || call.startsWith('log:')), [],
    'a stale settlement performs no visible mutation (no restore/consume/ack/notice/health/artifact-save)')
})

test('PR5 positive control: a current-scope settlement performs the normal visible behavior', async () => {
  const calls: string[] = []
  const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }
  const deps = {
    isDisposed: () => false,
    notify: (message: string, kind: string) => { calls.push(`notify:${kind}:${message}`) },
    loggerError: (message: string) => { calls.push(`log:${message}`) },
    readDraft: () => '',
    mergeDraftIntoEditor: () => true,
    restoreSubmissionDraft: () => { calls.push('restore') },
    consumeDraftAttachments: () => { calls.push('consume') },
    draftHasAttachments: () => false,
    pinDraftAttachments: () => () => {},
    settleLocalSubmission: () => { calls.push('settleLocal') },
    settleSubmitAck: (reason: string) => { calls.push(`ack:${reason}`) },
    notifySubmissionFailure: () => { calls.push('notifyFailure') },
    isScopeCurrent: () => true,
    refuseByTransitionFence: () => { calls.push('fence') },
    lateAttachmentRefusal: () => undefined,
    commandSubmitAttachments: () => [],
    isTuiOwnedCommand: () => false,
    commandPlaneOwnsLine: () => false,
    submittedHostClaim: () => undefined,
    commandSignal: () => new AbortController().signal,
    invokeCommandPlane: async () =>
      ({ kind: 'committed' as const, matched: true, execution: { commandId: 'export', result: { kind: 'success' as const } } }),
    beginCommandSettlement: () => {},
    abortCommandSettlement: () => {},
    settleCommandSettlement: () => {},
    trackSettlementWork: () => {},
    captureCommandHealthRef: () => 'health-ref',
    clearCommandHealthError: () => { calls.push('health-clear') },
    recordCommandHealthError: () => { calls.push('health') },
    readCommandDraftDisposition: () => undefined,
    shouldConsumeAdvertisedMiss: () => false,
    isIndeterminateSkillWrite: () => false,
    startArtifactSave: () => { calls.push('artifactSave') },
    submitPrompt: async () => {},
    commandSessionId: () => 's1',
    markTurnTransferred: () => {},
    diag,
  }
  executeHostCommandSubmission(deps as unknown as HostCommandSubmissionDeps, {
    text: '/export',
    toggled: '/export',
    scope: SCOPE,
    submitRequestId: 'request-live',
    submitAckToken: 10,
    generation: 1,
    localEchoInstalled: false,
    wasAdvertisedAtSubmit: true,
    parsedName: 'export',
    submitTurn: { wait: Promise.resolve(), release: () => {} },
  })
  await drainUntil(() => calls.includes('artifactSave'))
  assert.ok(calls.includes('artifactSave'), 'a current-scope /export success starts the artifact save')
  assert.ok(calls.includes('settleLocal') && calls.some(call => call.startsWith('ack:')),
    'a current-scope settlement settles its rows normally')
  assert.ok(calls.includes('consume'), 'a current-scope success consumes the draft attachments')
})
