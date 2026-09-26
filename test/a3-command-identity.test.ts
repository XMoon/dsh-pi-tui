/**
 * A3 static locks for the command layer's session identity (plan §1.1/§2, and
 * the `/skill` pairing fix): a session-scoped operation must never pair one
 * session's Direct Agent with another session's scope.
 *
 * A3-2 removes the Direct Agent from the command layer entirely: the captured
 * `LiveSessionScope` IS the single identity. The original pairing bug — an
 * awaited agent resolution followed by a SEPARATE scope capture, which could
 * resume in a later microtask and pair A's agent with B's scope — can no longer
 * be expressed, so the lock now proves that shape is gone: no paired resolver,
 * and every `/skill` path threads ONE atomically captured scope through
 * `loadSkill` and the per-Agent prompt admission.
 * @module @xmoon76/dsh-pi-tui/a3-command-identity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const commandsSource = readFileSync(new URL('../src/commands.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

function span(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `span start not found: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `span end not found: ${end}`)
  return source.slice(from, to)
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

/** Strip comments so only executable code is counted. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('the /skill paths resolve ONE atomic live scope and never pair two identity reads', () => {
  // The obsolete paired resolver is deleted from the interface AND the index
  // provider: the scope is the only identity the command layer handles.
  assert.equal(count(commandsSource, 'requireLiveAgentScope'), 0,
    'the agent+scope pairing member must be gone from the command layer')
  assert.equal(count(indexSource, 'requireLiveAgentScope'), 0,
    'the agent+scope pairing provider must be gone from the index')
  // The rejected shape: an awaited agent resolution paired with a scope. A
  // destructured agent+scope tuple never appears, and no command reads a live
  // agent identity at all.
  assert.equal(count(commandsSource, 'const { agent, scope }'), 0,
    'no path may destructure a paired agent+scope identity')
  assert.equal(count(commandsSource, 'runner.liveAgent'), 0,
    'the command layer never reads a Direct Agent')
  // Four /skill call sites (two wrappers, the handler, the picker): every one
  // threads the SAME atomically captured scope.
  assert.equal(count(commandsSource, 'loadSkill(scope,'), 4,
    'every loadSkill call must receive the captured scope')
  assert.ok(!commandsSource.includes('loadSkill(agent,'),
    'loadSkill must receive the captured scope, never a separately resolved agent')
})

test('loadSkill uses the captured scope for every session-scoped operation', () => {
  const body = span(commandsSource, 'const loadSkill = async (', '\n  const skillDisposers = new Map<string, () => void>()')
  assert.equal(body.includes('agent.session.id'), false,
    'a session-scoped call must use scope.sessionId, never an agent-derived id')
  // Every catalog interaction goes through a SCOPE-BOUND facade: the captured
  // scope is never downgraded to a bare sessionId handed to a current-owner
  // resolver.
  assert.ok(body.includes('runner.resolveScopedSkill(scope, name)'),
    'the skill definition read is scope-bound')
  assert.ok(body.includes('runner.hostLoadsSkillBody(scope)'),
    'the Host skill-pre-step probe is scope-bound')
  assert.equal(body.includes('catalog.skills.'), false,
    'loadSkill must not reach into the raw catalog port with a bare session id')
  assert.ok(body.includes('withSessionWriter(scope.sessionId,'), 'the writer section uses the scope id')
  assert.ok(body.includes('sessionWriter.prompt(scope.sessionId,'), 'the prompt writes use the scope id')
  // The prompt admission rides the SAME captured scope; its provider reads the
  // CURRENT Direct attachment inside the writer section (§10.1) — no agent
  // identity ever reaches the command layer.
  assert.ok(body.includes('withPromptAdmission(scope,'), 'the admission rides the captured scope')
  const bodyCode = code(body)
  assert.equal((bodyCode.match(/\bagent\b/g) ?? []).length, 0,
    'the command layer never names an agent')
})

test('requireLiveSessionScope ensures the session then captures the scope atomically', () => {
  const facade = span(indexSource, 'requireLiveSessionScope: async () => {', '\n      },')
  assert.ok(facade.includes('await sessionRuntime.ensureSession()'),
    'the facade must ensure the lazy session first')
  assert.ok(facade.includes('const scope = sessionScope.captureLive()'), 'the ONE synchronous capture')
  assert.ok(facade.includes("if (scope === undefined) throw new Error('session could not be created')"))
  assert.equal(count(facade, 'await'), 1,
    'only the ensureSession await: the scope capture is a single synchronous step')
  assert.ok(facade.includes('return scope'), 'the captured scope is returned alone')
})

test('sessionGeneration no longer exists in the command layer', () => {
  assert.equal(commandsSource.includes('sessionGeneration'), false,
    'A3-2 deletes the member: the scope-bound refresh facade carries the target key')
})

test('scope-bound reads admit through ONE stale-throwing helper, never a raw current read', () => {
  const admission = span(
    indexSource,
    'const agentForLiveScope = (scope: SessionScope): Agent => {',
    '\n    const runner: TuiCommandRunner = {',
  )
  // A stale scope THROWS (never returns a value, never retargets to the current
  // owner) and the exact attachment is resolved in the SAME synchronous step.
  assert.ok(admission.includes('throw new SupersededReadError('),
    'a stale scope must throw SupersededReadError')
  assert.ok(admission.includes('sessionScope.isCurrent(scope)'),
    'currentness must come from the scope authority')
  assert.ok(admission.includes('const agent = agentNow()'),
    'the exact attachment is resolved inside the same synchronous admission')
  // Every scope-bound read provider routes through that admission (the provider
  // spans are delimited by the NEXT facade declaration, in source order).
  const facades = [
    'resolveScopedSkill',
    'hostLoadsSkillBody',
    'listScopedSkills',
    'currentSessionActivity',
    'currentSessionRouting',
    'currentApprovalOverride',
    'currentSessionStats',
    'lastAssistantText',
    'refreshSessionCatalog',
  ]
  for (let index = 0; index < facades.length; index += 1) {
    const at = indexSource.indexOf(`${facades[index]}: `)
    assert.ok(at > 0, `${facades[index]} provider not found`)
    const next = index + 1 < facades.length
      ? indexSource.indexOf(`${facades[index + 1]}: `, at)
      : indexSource.indexOf('\n      withSessionWriter:', at)
    assert.ok(next > at, `${facades[index]} provider span not found`)
    const body = indexSource.slice(at, next)
    assert.ok(body.includes('agentForLiveScope(scope)'),
      `${facades[index]} must admit through agentForLiveScope`)
    assert.ok(!body.includes('agentNow()'),
      `${facades[index]} must not read the current attachment directly`)
    // The ASYNC skill reads validate BEFORE the dispatch AND re-validate the
    // ORIGINAL scope after the await, so a superseded read is never presented.
    if (facades[index] === 'resolveScopedSkill' || facades[index] === 'listScopedSkills') {
      const awaitAt = body.indexOf('await ')
      const recheckAt = body.indexOf('sessionScope.isCurrent(scope)')
      assert.ok(awaitAt > 0 && recheckAt > awaitAt,
        `${facades[index]} must re-validate the ORIGINAL scope AFTER its await`)
      assert.ok(body.includes('throw new SupersededReadError('),
        `${facades[index]} must refuse a superseded read`)
    }
  }
})

test('scope-bound WRITES refuse a stale scope BEFORE dispatching its sessionId', () => {
  // The frozen §3.2 write contract: a stale scope takes an EXPLICIT refusal path
  // and its sessionId is never dispatched to a replacement-owner resolver.
  const writes = ['applyPermissionPreset', 'setSessionApprovalPolicy']
  const end = indexSource.indexOf('\n      switchSession:', indexSource.indexOf('setSessionApprovalPolicy: '))
  assert.ok(end > 0, 'the write provider span end was not found')
  for (let index = 0; index < writes.length; index += 1) {
    const at = indexSource.indexOf(`${writes[index]}: `)
    assert.ok(at > 0, `${writes[index]} provider not found`)
    const next = index + 1 < writes.length
      ? indexSource.indexOf(`${writes[index + 1]}: `, at)
      : end
    const body = indexSource.slice(at, next)
    // The exact-owner admission and the explicit refusal...
    assert.ok(body.includes('agentForLiveScope(scope)'),
      `${writes[index]} must admit through agentForLiveScope`)
    assert.ok(body.includes('if (!sessionScope.isCurrent(scope)) return'),
      `${writes[index]} must REFUSE a stale scope explicitly (never retarget)`)
    // ...BOTH of which precede the ONLY sessionId dispatch.
    const guard = body.indexOf('agentForLiveScope(scope)')
    const dispatch = body.indexOf('scope.sessionId')
    assert.ok(dispatch > guard, `${writes[index]} must guard before dispatching scope.sessionId`)
    assert.ok(!body.includes('agentNow()'), `${writes[index]} must not read the current attachment directly`)
  }
  // The ASYNC permission write re-checks the ORIGINAL scope after its await, so
  // a settlement is never presented for a superseded owner.
  const permissionWrite = indexSource.slice(
    indexSource.indexOf('applyPermissionPreset: '),
    indexSource.indexOf('setSessionApprovalPolicy: '),
  )
  assert.ok(
    (permissionWrite.match(/sessionScope\.isCurrent\(scope\)/g) ?? []).length >= 2,
    'the async write must re-check the ORIGINAL scope after its await',
  )
})

test('a superseded skill/permission interaction is refused gracefully, never thrown out of the command path', () => {
  // The /skill definition read and the picker's catalog read map a superseded
  // read to the user-visible stale notice instead of propagating it.
  assert.ok(commandsSource.includes("text: 'the session changed while loading the skill — try again'"),
    'the skill definition read reports the stale refusal')
  assert.ok(commandsSource.includes("text: 'the session changed while loading skills — try again'"),
    'the skill catalog read reports the stale refusal')
  // The picker SELECTION must not let the error escape the overlay callback.
  assert.ok(commandsSource.includes("app.notify('the session changed while loading skills — try again', 'error')"),
    'the picker selection notifies instead of throwing')
  // The stale /settings panel CLOSES and tells the user instead of dispatching
  // the retained scope to the replacement owner.
  assert.ok(commandsSource.includes("app.notify('the session changed — the approval policy was not applied', 'error')"),
    'the settings panel reports the refused write')
  assert.ok(commandsSource.includes('closeSettings()'), 'the stale panel closes itself')
  // /yolo maps the refused write to a command error.
  assert.ok(commandsSource.includes("text: 'the session changed before the permission preset could be applied — try again'"),
    'the permission preset refusal is user-visible')
})
