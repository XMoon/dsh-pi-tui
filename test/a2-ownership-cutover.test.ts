/**
 * A2-2 ownership-cutover locks: the runner keeps NO local ownership authority,
 * the core is the single state owner, the current owner is published only
 * through the injected SessionOwnerAccess provider (Direct composition today,
 * Remote from M3-2) into the core slot, and no sessionId→Agent lookup
 * reconstructs currentness.
 * @module @xmoon76/dsh-pi-tui/a2-ownership-cutover.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compositionSource } from './support/composition-surface.ts'

const indexSource = compositionSource()
const coreSource = readFileSync(new URL('../src/app/session/ownership-core.ts', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL('../src/app/direct/runtime.ts', import.meta.url), 'utf8')
const retirementSource = readFileSync(new URL('../src/app/direct/owner-retirement.ts', import.meta.url), 'utf8')
const sessionRuntimeSource = readFileSync(new URL('../src/app/session/runtime.ts', import.meta.url), 'utf8')
// A4-7: the presentation event routing moved into the surface owner, so the
// currentness locks below are anchored to the surface routing bodies and the
// runner's injected core read.
const surfaceSource = readFileSync(new URL('../src/app/surface/runtime.ts', import.meta.url), 'utf8')
// A5b-4: the submission admission fences + the param-agent interrupt fences
// moved into the submission owners, so the currentness locks below read the
// OWNER modules explicitly (never a glob).
const submissionControllerSource = readFileSync(new URL('../src/app/submission/controller.ts', import.meta.url), 'utf8')
const localShellSource = readFileSync(new URL('../src/app/submission/user-shell.ts', import.meta.url), 'utf8')

test('the runner keeps NO local ownership authority (A2-2 cutover)', () => {
  assert.ok(!/\blet liveAgent\b/.test(indexSource), 'no local liveAgent declaration')
  assert.ok(!/\blet liveHandle\b/.test(indexSource), 'no local liveHandle declaration')
  assert.ok(!/\blet sessionGeneration\b/.test(indexSource), 'no local sessionGeneration storage')
  assert.ok(!/\blet navigationEpoch\b/.test(indexSource), 'no local navigationEpoch storage')
  assert.ok(!/^\s*liveAgent = /m.test(indexSource), 'no liveAgent assignment')
  assert.ok(!/^\s*liveHandle = /m.test(indexSource), 'no liveHandle assignment')
  assert.ok(!/const transitionGate = new SessionTransitionGate/.test(indexSource), 'no local gate instance')
  assert.ok(!/const operationBarrier = new SessionOperationBarrier/.test(indexSource), 'no local barrier instance')
  assert.ok(!/pendingOwnerReleases/.test(indexSource), 'no local release ledger')
})

test('the ownership core is the single state owner', () => {
  assert.ok(coreSource.includes('let generation = 0'), 'the core owns the generation')
  assert.ok(coreSource.includes('let currentOwner: SessionOwnerRef | undefined'), 'the core owns the owner slot')
  assert.ok(coreSource.includes('let currentSessionId: string | undefined'), 'the core owns the session id')
  assert.ok(coreSource.includes('let navigationEpoch = 0'), 'the core owns the navigation epoch')
  assert.ok(coreSource.includes('new SessionTransitionGate()'), 'the core owns the gate')
  assert.ok(coreSource.includes('new SessionOperationBarrier()'), 'the core owns the barrier')
  assert.ok(coreSource.includes('const pendingOwnerReleases = new Map<string, Set<Promise<void>>>()'), 'the core owns the release ledger')
})

test('the current owner is published only through the injected SessionOwnerAccess provider into the core slot', () => {
  // ALL FOUR commit shapes publish inside the bound runtime, each resolving the
  // owner from the handle that shape actually owns (a Direct attachment or a
  // Remote Client generation — the injected provider decides, never the
  // runner). The runner never publishes an owner itself.
  assert.equal((indexSource.match(/setCurrentOwner\(/g) ?? []).length, 0,
    'the runner must not publish the current owner at all')
  assert.ok(sessionRuntimeSource.includes('const nextOwner = resumed === undefined ? undefined : deps.owners.fromHandle(resumed)'),
    'resume publication goes through the injected owner provider (runtime)')
  assert.ok(sessionRuntimeSource.includes('const nextOwner = deps.owners.fromHandle(next as SessionHandle)'),
    'ordinary-transition publication goes through the injected owner provider (runtime)')
  assert.ok(sessionRuntimeSource.includes('let nextOwner = deps.owners.fromHandle(handle)'),
    'fork publication goes through the injected owner provider (runtime)')
  assert.ok(sessionRuntimeSource.includes('const childOwner = deps.owners.fromHandle(handle)'),
    'first-session publication goes through the injected owner provider (runtime)')
  const publishes = sessionRuntimeSource.match(/core\.setCurrentOwner\(/g) ?? []
  assert.equal(publishes.length, 4, `expected the 4 runtime publish sites, saw ${publishes.length}`)
  // The production bootstrap is still the Direct composition: it selects the
  // Direct application runtime through the M3-4 selection seam and injects
  // its owner provider into the runtime (the Remote provider is composed by
  // the Remote branch of the same seam, never a second bootstrap truth).
  assert.ok(indexSource.includes('owners: selectedRuntime.owners,'),
    'the production bootstrap injects the selected (Direct) owner provider')
  assert.ok(indexSource.includes('retirement: selectedRuntime.retirement,'),
    'the production bootstrap injects the selected (Direct) retirement provider')
  assert.ok(indexSource.includes('const selectedRuntime = await selectApplicationRuntime({'),
    'the M3-4 selection seam constructs the selected runtime core')
  assert.ok(indexSource.includes('      kind: \'direct\','),
    'normal package apply() selects Direct')
  // M3-4 PR2: the read is branch-safe (optional chain — a Remote selection
  // has no Direct runtime); it is still a DERIVED registry projection of the
  // SAME accessor, never a stored second truth.
  assert.ok(indexSource.includes('const agentNow = (): Agent | undefined => directRuntime()?.owners.currentDirectAttachment()'),
    'the current attachment is a DERIVED registry projection')
  // M3-4 PR1 removed the runner's last Direct owner-handle read
  // (`handleNow`): the fatal catch now runs the ONE memoized retirement
  // coordinator unconditionally (it covers parked owners and pending forks
  // too), so no Direct-handle-based owner-presence gate remains.
  assert.ok(!indexSource.includes('handleNow'),
    'the runner keeps no Direct-handle-based owner-presence gate (the coordinator owns retirement)')
  assert.ok(!indexSource.includes('currentOwnerPresentRef'),
    'no Direct-handle owner-presence ref remains in the composition root')
})

/**
 * The contiguous source span from one marker to the next. Assertions on a span
 * prove a source and its USE are the SAME expression, which a global
 * `includes()` check cannot.
 */
function span(from: string, to: string): string {
  return spanOf(indexSource, from, to)
}

/** The contiguous source span from one marker to the next in one source text. */
function spanOf(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `cannot slice "${from}" .. "${to}"`)
  return source.slice(start, end)
}

test('currentness identity comes from the ownership core, never from the Direct attachment', () => {
  // fork navigation fence (bound runtime) + admission identity (runner)
  const forkFence = spanOf(sessionRuntimeSource, 'const isNavigationCurrent = ', 'const parkForkOwner = ')
  assert.ok(forkFence.includes('isRewindIdentityCurrent(core.captureNavigationIdentity(), expected)'),
    'the fork navigation fence captures through the core')
  assert.ok(!forkFence.includes('agentNow('), 'the fork navigation fence must not read the Direct attachment')
  const forkAdmission = spanOf(sessionRuntimeSource, 'const forkSession = async (', 'const pin = core.beginForkSourcePin(')
  assert.ok(forkAdmission.includes('const before = core.captureNavigationIdentity()'),
    'fork admission captures the navigation identity through the core')
  assert.ok(!forkAdmission.includes('agentNow('), 'fork admission must not read the Direct attachment')

  // switch no-op (bound runtime)
  const switchLocked = spanOf(sessionRuntimeSource, 'const switchSessionLocked = ', '// Draft cleanup happens ONLY after')
  assert.ok(switchLocked.includes('if (core.currentSessionId() === sessionId) {'),
    'the switch no-op compares the CORE session id')
  assert.ok(!switchLocked.includes('agentNow('), 'the switch no-op must not read the Direct attachment')

  // Task Browser jobs fence: the composition root derives the key + injects the
  // session id from the ownership core; the A5b-6 retention policy (the
  // retained snapshot + the same-session fence) is Task-Center-owned and reads
  // both at CALL time (locked in test/a5b-bootstrap-closure.test.ts).
  const jobFence = spanOf(indexSource, 'currentKey: () => {', 'listDescendants:')
  assert.ok(jobFence.includes('const sessionId = ownership.currentSessionId()'),
    'the Job snapshot key takes its session id from the core')
  assert.ok(jobFence.includes('`${ownership.generation()}:${sessionId}`'),
    'the Job snapshot identity key is built from the core generation + session id')
  assert.ok(jobFence.includes('currentSessionId: () => ownership.currentSessionId()'),
    'the runner injects the SAME core session id for the owner-side jobs read')
  assert.ok(!indexSource.includes('readJobs'),
    'the root must not provide the jobs-read retention policy (moved to the surface owner)')

  // session/event main routing (A4-7): the gate moved into the surface owner;
  // the runner injects the core session id. Gate + injection in ONE assertion
  // each, so neither side can drift.
  const eventRouting = spanOf(surfaceSource, 'const ownerSessionId = source.currentSessionId()',
    'main.applyToolPreview(event)')
  assert.ok(eventRouting.includes('if (session.id !== ownerSessionId) return'),
    'the main routing gate uses the injected session id')
  assert.ok(!/const ownerSessionId = [^s]/.test(eventRouting),
    'ownerSessionId must be assigned from the injected core read only')
  assert.ok(indexSource.includes('currentSessionId: () => ownership.currentSessionId()'),
    'the runner must inject the ownership-core session id')

  // assistant-stream input gate (A4-7): the surface owns the routing; source +
  // gate in ONE span.
  const onInput = spanOf(surfaceSource, 'const applyAssistantInput = ', 'const applyResumedCompaction = ')
  assert.ok(onInput.includes('const sessionId = source.currentSessionId()'),
    'the assistant-stream input takes its session id from the injected core read')
  assert.ok(onInput.includes('if (sessionId === undefined || input.sessionId !== sessionId) return'),
    'the assistant-stream input gate uses the SAME core session id')
  assert.ok(!onInput.includes('agentNow('), 'the assistant-stream input gate must not read the Direct attachment')

  // exact-Agent identity helper + assistant-stream current check
  assert.ok(surfaceSource.includes('if (source.isCurrentOwnerAgent(subject)) return true'),
    'the exact-Agent main-surface check resolves the identity through the injected helper')
  const helper = span('const isCurrentOwnerAgent = ', '// The semantic backend')
  assert.ok(helper.includes('const owner = ownership.owner()') && helper.includes('attachmentOf(owner)?.agent === candidate'),
    'the exact-Agent identity helper starts from the core owner')
  assert.ok(indexSource.includes('isCurrentOwnerAgent: (agent) => isCurrentOwnerAgent(agent as Agent)'),
    'the runner must inject its exact-Agent identity helper')

  // agent/status ownership (A4-7): owner + completion identity in ONE span in
  // the surface; the runner injects the core-derived completion identity.
  const agentStatus = spanOf(surfaceSource, 'const routeAgentStatus = ', 'const routeProviderRefresh = ')
  assert.ok(agentStatus.includes('const currentAgentId = source.completionOwnerId()'),
    'the agent/status ownership check resolves the injected completion identity')
  assert.ok(agentStatus.includes('agentId === currentAgentId'),
    'the agent/status main branch compares against the core-derived completion identity')
  assert.ok(!agentStatus.includes('agentNow('), 'agent/status must not read the Direct attachment')
  assert.ok(indexSource.includes('completionOwnerId: () => {')
    && indexSource.includes('directRuntime()?.owners.completionIdentity(owner)'),
    'the runner must inject the completion identity from the core owner')

  // No identity/currentness judgement may use the Direct attachment as the
  // authority (existence checks like `agentNow() === undefined` are fine).
  assert.ok(!/[A-Za-z_$][\w$]*\s*===\s*agentNow\(\)/.test(indexSource),
    'nothing may be identified by equality against the Direct attachment')
  assert.ok(!/agent\.id === current\.id/.test(indexSource),
    'the agent/status ownership check must not compare against a Direct-attachment snapshot')
  assert.ok(!/current\.session\.id === sessionId/.test(indexSource),
    'the switch no-op must not compare against a Direct-attachment snapshot')
  assert.ok(indexSource.includes('ownership.currentSessionId()'),
    'the runner resolves the current session id through the core')
})

test('no sessionId→Agent lookup reconstructs currentness in the runner', () => {
  assert.ok(!/agents\.get\(SessionId\(ownership\.currentSessionId\(\)\)\)/.test(indexSource),
    'the current session id must never be resolved back through the Host registry')
  assert.ok(!/agents\.get\(ownership\.currentSessionId\(\)/.test(indexSource), 'no bare currentSessionId registry lookup')
  assert.ok(indexSource.includes('ownership.currentSessionId()'), 'identity comparisons use the core session id')
})

test('the admission fences use the ownership subject; only the param-agent fences keep the exact-Agent compare', () => {
  // Plan A2-2: every asynchronous admission re-checks the ownership SUBJECT,
  // never an exact captured Agent. Each named site is asserted individually at
  // its real location: the previous aggregate `>= 5` merged the bootstrap
  // injection, the three admission checks and the two token-currentness
  // callbacks into one count, so deleting any ONE of them still passed (A5b
  // review finding). Aggregate counts must never be the only lock on a set.
  const lineCount = (source: string, expectedLine: string): number =>
    source.split('\n').filter(line => line.trim() === expectedLine).length

  // 1. The composition root injects the ownership-subject compare exactly once,
  //    as the Task-Center source's `subjectMatches`.
  assert.equal(
    lineCount(indexSource, 'subjectMatches: (subject) => captureMatches(subject),'),
    1,
    'the composition root must inject the ownership-subject compare exactly once',
  )
  // 2. The three submission admission checks — the deferred-start resolve, the
  //    deferred-start persist, and the stale-after-wait branch — each re-check
  //    the subject.
  for (const check of [
    'if (submittedAgent !== undefined && !deps.captureMatches(submittedSubject)) return undefined',
    'if (submittedAgent !== undefined && !deps.captureMatches(submittedSubject)) return',
    'if (submittedAgent !== undefined && !deps.captureMatches(submittedSubject)) {',
  ]) {
    assert.equal(
      lineCount(submissionControllerSource, check),
      1,
      `the submission admission must re-check the ownership subject exactly once at its real location: ${check}`,
    )
  }
  // 3. The two owner-token callbacks — the busy/steer delivery and the queue
  //    pull-back recall — resolve the captured token through the subject compare.
  assert.equal(
    lineCount(
      submissionControllerSource,
      'isOwnerTokenCurrent: (token) => deps.captureMatches(token as SessionSubject | undefined),',
    ),
    2,
    'the two owner-token callbacks must resolve the captured token through the subject compare',
  )
  // M3-4 PR3: the user-shell interrupt dropped the exact-Agent compare for
  // the semantic SessionWriter.cancel under a live-scope admission (§27), so
  // NO legacy sessionUnchanged fence may remain anywhere (the interrupt
  // fences are generation-fenced now).
  const legacyFences = (indexSource.match(/sessionUnchanged\(/g) ?? []).length
    + (localShellSource.match(/sessionUnchanged\(/g) ?? []).length
  assert.equal(legacyFences, 0,
    'no exact-Agent sessionUnchanged fence remains: the user-shell interrupt is generation-fenced (M3-4 PR3)')
})

test('a coordinator-level retirement failure never masquerades as a backend phase', () => {
  // The gate/barrier guard skips a retirement that would race an active
  // transition. No backend retirement phase ran, so the runtime must report it as
  // its OWN diagnostic instead of synthesizing a backend phase label that the
  // generic warning would then present as a real phase failure.
  assert.ok(indexSource.includes('session retirement was skipped (${reason})'),
    'the runner surface warns with its own coordinator wording')
  assert.ok(!/phase: 'cancel', error: `retirement skipped/.test(sessionRuntimeSource),
    'the coordinator must not fabricate a backend cancel-phase failure')
  assert.ok(!/retirement skipped/.test(indexSource),
    'the runner must not synthesize the skipped-retirement failure either')
  assert.ok(sessionRuntimeSource.includes('return { failures: [], durabilityFailure: undefined }'),
    'a skipped retirement returns an empty report, not a fake phase failure')
})

test('retirement failures are attributed to the owner that produced them', () => {
  // The runtime logs the CURRENT owner's failures with the owner-derived session
  // id; the Direct adapter logs each PARKED owner's failures with that owner's
  // own session id. The merged summary carries the user warning only, so it can
  // never re-label a parked failure as the current session's.
  const retireBlock = spanOf(sessionRuntimeSource,
    'const retire = async (): Promise<SessionRetirementReport> => {', '      try {')
  assert.ok(retireBlock.includes('const ownerSessionId = deps.owners.sessionId(owner)'),
    'the current owner failure log must use the OWNER-derived session id')
  assert.ok(retireBlock.includes("deps.diag.error('retire phase failed'"), 'the current owner failures are logged here')
  const parkedBlock = retirementSource.slice(
    retirementSource.indexOf('const retireParked = async'),
    retirementSource.indexOf('const park = ('),
  )
  assert.ok(parkedBlock.includes('session: agent.session.id'),
    "each parked owner's failures must carry ITS OWN session id")
  const mergedBlock = spanOf(sessionRuntimeSource, 'const reportRetirement', 'const retireOwnedSession')
  assert.ok(!mergedBlock.includes("diag.error('retire phase failed'"),
    'the merged summary must not re-label failures with the current session')
  assert.ok(mergedBlock.includes("deps.diag.info('retire complete'"), 'the merged summary reports the total count')
})

test('the Direct runtime no longer accepts a getLiveAgent dep', () => {
  assert.ok(!runtimeSource.includes('getLiveAgent'),
    'the runtime projects the current owner from the core through its own registry')
})
