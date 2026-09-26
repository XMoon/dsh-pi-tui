/**
 * A3 static locks for the command layer's session identity (plan §1.1/§2, and the
 * `/skill` pairing fix): a session-scoped operation must never pair one
 * session's Direct Agent with another session's scope.
 *
 * The production pairing is atomic inside the runner facade's
 * `requireLiveAgentScope()`: after the `ensureSession()` await it reads the scope
 * AND the agent in ONE synchronous step, so no switch can interleave between the
 * two identities. The command layer must consume that pair — two separate reads
 * (an awaited agent resolution plus a later scope capture) would resume in a
 * later microtask and could pair A's agent with B's scope.
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

test('the /skill paths resolve the agent and its scope in ONE atomic step', () => {
  // Three call sites: the direct wrapper, the revalidating wrapper, the handler.
  assert.equal(count(commandsSource, 'const { agent, scope } = await runner.requireLiveAgentScope()'), 3,
    'every /skill path must consume the paired resolution')
  // The rejected shape: an awaited agent resolution followed by a separate capture.
  assert.equal(count(commandsSource, 'await requireAgent()\n            // Captured beside the agent read'), 0,
    'no /skill path may pair a separate agent read with a separate scope capture')
  assert.ok(!commandsSource.includes('loadSkill(liveAgent,'),
    'loadSkill must receive the paired agent, never a separately resolved one')
})

test('loadSkill uses the captured scope for every session-scoped operation', () => {
  const body = span(commandsSource, 'const loadSkill = async (', '\n  const skillDisposers = new Map<string, () => void>()')
  assert.equal(body.includes('agent.session.id'), false,
    'a session-scoped call must use scope.sessionId, never the agent-derived id')
  assert.ok(body.includes('resolveSkill(scope.sessionId, name)'), 'the catalog read uses the scope id')
  assert.ok(body.includes('withSessionWriter(scope.sessionId,'), 'the writer section uses the scope id')
  assert.ok(body.includes('sessionWriter.prompt(scope.sessionId,'), 'the prompt writes use the scope id')
  // The Direct Agent itself is needed ONLY for the per-Agent prompt admission
  // (owner-resolved in A3-3; until then it is the writer-section agent).
  assert.ok(body.includes('withPromptAdmission(agent,'), 'the per-Agent admission keeps the agent')
  const bodyCode = code(body)
  assert.equal((bodyCode.match(/\bagent\b/g) ?? []).length, 2,
    'the agent may only appear as its own parameter and in the per-Agent admission')
})

test('requireLiveAgentScope reads the scope and the agent in ONE synchronous step', () => {
  const facade = span(indexSource, 'requireLiveAgentScope: async () => {', '\n      },')
  const ensureAt = facade.indexOf('await sessionRuntime.ensureSession()')
  assert.ok(ensureAt >= 0, 'the facade must ensure the lazy session first')
  const pairSpan = facade.slice(
    facade.indexOf('const scope = sessionScope.captureLive()'),
    facade.indexOf('const agent = agentNow()'),
  )
  assert.equal(count(pairSpan, 'await'), 0,
    'no await may run between the scope capture and the agent read')
  assert.ok(facade.includes('const scope = sessionScope.captureLive()'), 'the scope capture')
  assert.ok(facade.includes('const agent = agentNow()'), 'the agent read in the same step')
  assert.ok(facade.includes('return { agent, scope }'), 'the pair is returned together')
})
