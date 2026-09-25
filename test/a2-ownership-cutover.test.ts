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
  // One publish site per commit shape, each resolving the owner from the handle
  // that shape actually owns.
  assert.ok(indexSource.includes('const nextOwner = resumed === undefined ? undefined : directRuntime.owners.fromHandle(resumed)'),
    'resume publication goes through the registry')
  assert.ok(indexSource.includes('const nextOwner = directRuntime.owners.fromHandle(owner as SessionHandle)'),
    'ordinary-transition publication goes through the registry')
  assert.ok(indexSource.includes('const nextOwner = directRuntime.owners.fromHandle(handle)'),
    'fork publication goes through the registry')
  assert.ok(indexSource.includes('const nextOwner = directRuntime.owners.fromHandle(created)'),
    'first-session publication goes through the registry')
  const publishes = indexSource.match(/ownership\.setCurrentOwner\(nextOwner, /g) ?? []
  assert.equal(publishes.length, 4, `expected exactly the 4 commit publishes, saw ${publishes.length}`)
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
  const start = indexSource.indexOf(from)
  const end = indexSource.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `cannot slice "${from}" .. "${to}"`)
  return indexSource.slice(start, end)
}

test('currentness identity comes from the ownership core, never from the Direct attachment', () => {
  // fork navigation fence + admission identity
  const fork = span('const forkNavigationCurrent = ', 'const adoptFork = ')
  assert.ok(fork.includes('isRewindIdentityCurrent(ownership.captureNavigationIdentity(), expected)'),
    'the fork navigation fence captures through the core')
  assert.ok(!fork.includes('agentNow('), 'the fork navigation fence must not read the Direct attachment')
  const forkAdmission = span('// newer navigation. Validate that capture', 'const pickerCurrent = ')
  assert.ok(forkAdmission.includes('const before = ownership.captureNavigationIdentity()'),
    'fork admission captures the navigation identity through the core')
  assert.ok(!forkAdmission.includes('agentNow('), 'fork admission must not read the Direct attachment')

  // switch no-op
  const switchLocked = span('const switchSessionLocked = ', '// Draft cleanup happens ONLY after')
  assert.ok(switchLocked.includes('if (ownership.currentSessionId() === sessionId) {'),
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

test('the Direct runtime no longer accepts a getLiveAgent dep', () => {
  assert.ok(!runtimeSource.includes('getLiveAgent'),
    'the runtime projects the current owner from the core through its own registry')
})
