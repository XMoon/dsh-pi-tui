/**
 * A2-2 ownership-cutover locks: the runner keeps NO local ownership authority,
 * the core is the single state owner, the current owner is published only
 * through the Direct registry into the core slot, and no sessionId→Agent
 * lookup reconstructs currentness.
 * @module @xmoon76/dsh-pi-tui/a2-ownership-cutover.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const coreSource = readFileSync(new URL('../src/app/session/ownership-core.ts', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL('../src/app/direct/runtime.ts', import.meta.url), 'utf8')
const retirementSource = readFileSync(new URL('../src/app/direct/owner-retirement.ts', import.meta.url), 'utf8')
const sessionRuntimeSource = readFileSync(new URL('../src/app/session/runtime.ts', import.meta.url), 'utf8')

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

test('the current owner is published only through the Direct registry into the core slot', () => {
  // ALL FOUR commit shapes publish inside the bound runtime, each resolving the
  // owner from the handle that shape actually owns. The runner never publishes an
  // owner itself.
  assert.equal((indexSource.match(/setCurrentOwner\(/g) ?? []).length, 0,
    'the runner must not publish the current owner at all')
  assert.ok(sessionRuntimeSource.includes('const nextOwner = resumed === undefined ? undefined : deps.owners.fromHandle(resumed)'),
    'resume publication goes through the registry (runtime)')
  assert.ok(sessionRuntimeSource.includes('const nextOwner = deps.owners.fromHandle(owner as SessionHandle)'),
    'ordinary-transition publication goes through the registry (runtime)')
  assert.ok(sessionRuntimeSource.includes('const nextOwner = deps.owners.fromHandle(handle)'),
    'fork publication goes through the registry (runtime)')
  assert.ok(sessionRuntimeSource.includes('const childOwner = deps.owners.fromHandle(handle)'),
    'first-session publication goes through the registry (runtime)')
  const publishes = sessionRuntimeSource.match(/core\.setCurrentOwner\(/g) ?? []
  assert.equal(publishes.length, 4, `expected the 4 runtime publish sites, saw ${publishes.length}`)
  assert.ok(indexSource.includes('const agentNow = (): Agent | undefined => directRuntime.owners.currentDirectAttachment()'),
    'the current attachment is a DERIVED registry projection')
  assert.ok(indexSource.includes('const handleNow = (): AgentHandle | undefined =>'),
    'the retirement handle is read through the core slot')
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

  // Task Browser jobs fence: source + key + Host read in ONE span
  const readJobs = span('readJobs: () => {', '// The LIVE runtime fact')
  assert.ok(readJobs.includes('const sessionId = ownership.currentSessionId()'),
    'readJobs takes its session id from the core')
  assert.ok(readJobs.includes('const key = `${ownership.generation()}:${sessionId}`'),
    'the Job snapshot identity key is built from the core generation + session id')
  assert.ok(readJobs.includes('jobs.list(SessionId(sessionId))'),
    'the Job listing reads the SAME core session id')
  assert.ok(!readJobs.includes('agentNow('), 'readJobs must not read the Direct attachment')

  // session/event main routing: the captured variable and the gate in ONE span
  const eventRouting = span('const ownerSessionId = ownership.currentSessionId()',
    'applyOwnerStreamingToolPreviewEvent(mainStreamingToolPreviews, folder, event)')
  assert.ok(eventRouting.includes('if (session.id !== ownerSessionId) return'),
    'the main routing gate uses the CORE-captured session id')
  assert.ok(!/const ownerSessionId = [^o]/.test(eventRouting),
    'ownerSessionId must be assigned from the ownership core only')

  // assistant-stream input gate: source + gate in ONE span
  const onInput = span('onInput: (input) => {', 'assistantStreamBaselineFor = ')
  assert.ok(onInput.includes('const sessionId = ownership.currentSessionId()'),
    'the assistant-stream input takes its session id from the core')
  assert.ok(onInput.includes('if (sessionId === undefined || input.sessionId !== sessionId) return'),
    'the assistant-stream input gate uses the SAME core session id')
  assert.ok(!onInput.includes('agentNow('), 'the assistant-stream input gate must not read the Direct attachment')

  // exact-Agent identity helper + assistant-stream current check
  assert.ok(indexSource.includes('if (isCurrentOwnerAgent(subject)) return true'),
    'the exact-Agent main-surface check resolves the identity from the core owner')
  const helper = span('const isCurrentOwnerAgent = ', '// The semantic backend')
  assert.ok(helper.includes('const owner = ownership.owner()') && helper.includes('attachmentOf(owner)?.agent === candidate'),
    'the exact-Agent identity helper starts from the core owner')

  // agent/status ownership: owner + completion identity in ONE span
  const agentStatus = span("ctx.on('agent/status'", '// Provider-topology and credential events')
  assert.ok(agentStatus.includes('const currentAgentId = owner === undefined ? undefined : directRuntime.owners.completionIdentity(owner)'),
    'the agent/status ownership check resolves the completion identity from the core owner')
  assert.ok(agentStatus.includes('agent.id === currentAgentId'),
    'the agent/status main branch compares against the core-derived completion identity')
  assert.ok(!agentStatus.includes('agentNow('), 'agent/status must not read the Direct attachment')

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
  const subjectFences = indexSource.match(/captureMatches\(/g) ?? []
  assert.ok(subjectFences.length >= 5, `expected the admission fences to be subject-based, saw ${subjectFences.length}`)
  const legacyFences = indexSource.match(/sessionUnchanged\(/g) ?? []
  assert.equal(legacyFences.length, 2,
    'only the two param-agent interrupt fences may keep the exact-Agent sessionUnchanged compare')
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
