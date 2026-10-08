/**
 * Contract tests for the M3-3A Remote skill catalog adapter
 * (runtime/remote/skill-remote.ts): the official Session-addressed
 * `skills/list` mapping with detached DTOs, truthful failure semantics, and
 * the explicitly-unsupported sessionless/body/hot-invalidation surfaces.
 * @module @xmoon76/dsh-pi-tui/remote-skill-catalog.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSkillCatalog, type RemoteSkillListValue } from '../src/runtime/remote/skill-remote.ts'
import { createObservableGenerationHarness } from './support/remote-generation.ts'

type ListCall = { request: { sessionId: string }; signal: AbortSignal | undefined }

function harness(options: {
  result?: { ok: true; value: RemoteSkillListValue } | { ok: false; error: unknown }
  throw?: unknown
  gate?: Promise<void>
} = {}) {
  const generation = createObservableGenerationHarness()
  const calls: ListCall[] = []
  const skills = {
    list: async (request: { sessionId: string }, signal?: AbortSignal) => {
      calls.push({ request, signal })
      if (options.gate !== undefined) await options.gate
      if (options.throw !== undefined) throw options.throw
      return options.result ?? { ok: true as const, value: { skills: [] } }
    },
  }
  return { generation, calls, catalog: new RemoteSkillCatalog(skills, generation.source) }
}

test('S1: listHumanSkills sends the EXACT session id and forwards the signal', async () => {
  const controller = new AbortController()
  const { catalog, calls } = harness()
  await catalog.listHumanSkills('session-42', controller.signal)
  assert.deepEqual(calls, [{ request: { sessionId: 'session-42' }, signal: controller.signal }])
})

test('S2: the returned catalog is detached from the wire value', async () => {
  const { catalog } = harness({
    result: {
      ok: true,
      value: {
        skills: [{
          path: '/host/SKILL.md', name: 'review-fix-loop', description: 'review',
          whenToUse: 'when reviewing', modelInvocable: true,
        }],
      },
    },
  })
  const first = await catalog.listHumanSkills('s')
  const second = await catalog.listHumanSkills('s')
  assert.deepEqual(first, { skills: [{ name: 'review-fix-loop', description: 'review', whenToUse: 'when reviewing', modelInvocable: true }], complete: true })
  assert.notEqual(first, second, 'each read is a fresh detached observation')
})

test('S2b: malformed wire rows are refused, never coerced', async () => {
  const { catalog } = harness({
    result: {
      ok: true,
      value: {
        skills: [
          { name: 'good', description: 'ok', modelInvocable: false },
          { name: '', description: 'bad name', modelInvocable: false },
          { name: 'no-desc', description: 42 as unknown as string, modelInvocable: false },
        ],
      },
    },
  })
  const catalogValue = await catalog.listHumanSkills('s')
  assert.deepEqual(catalogValue?.skills.map(skill => skill.name), ['good'])
})

test('S3: a Host error is an ERROR, not an empty success', async () => {
  const { catalog } = harness({ result: { ok: false, error: { code: 'session/not-found', message: 'no session' } } })
  await assert.rejects(catalog.listHumanSkills('s'), /no session/)
})

test('S4: an abort stays a cancellation', async () => {
  const { catalog } = harness({ result: { ok: false, error: { code: 'gateway/cancelled', message: 'cancelled' } } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(catalog.listHumanSkills('s', controller.signal), /aborted/)
  const thrown = harness({ throw: Object.assign(new Error('stopped'), { name: 'AbortError' }) })
  await assert.rejects(thrown.catalog.listHumanSkills('s'), (error: unknown) => {
    assert.equal((error as { name?: string }).name, 'AbortError', 'a thrown abort-shaped error stays abort-shaped')
    return true
  })
})

test('S5: a result settling after a generation replacement is dropped as unavailable', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { catalog, generation } = harness({ gate })
  const pending = catalog.listHumanSkills('s')
  generation.set({ id: 2 })
  release()
  assert.equal(await pending, undefined)
})

test('S5b: a generation-replaced FAILURE is dropped too (not the new generation\'s error)', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { catalog, generation } = harness({
    gate,
    result: { ok: false, error: { code: 'gateway/internal', message: 'old host broke' } },
  })
  const pending = catalog.listHumanSkills('s')
  generation.set({ id: 3 })
  release()
  assert.equal(await pending, undefined)
})

test('no connection reads unavailable without any Host call', async () => {
  const { catalog, generation, calls } = harness()
  generation.set(undefined)
  assert.equal(await catalog.listHumanSkills('s'), undefined)
  assert.deepEqual(calls, [])
})

test('S6: the sessionless standing catalog is explicitly unsupported (no Client scan)', async () => {
  const { catalog } = harness()
  await assert.rejects(catalog.standing(undefined, '/host/cwd'), /no sessionless standing skill catalog/)
})

test('S7: the Client skill-body read stays unavailable', async () => {
  const { catalog } = harness()
  assert.deepEqual(await catalog.resolveSkill('s', 'review-fix-loop'), { kind: 'unavailable' })
})

test('S8: hostLoadsSkillBody is a composition fact, not a wire probe', () => {
  const { catalog, calls } = harness()
  assert.equal(catalog.hostLoadsSkillBody('s'), true)
  assert.deepEqual(calls, [], 'the composition fact never dispatches a Host call')
})

test('onSkillsChange installs no private event seam', () => {
  const { catalog } = harness()
  let fired = false
  catalog.onSkillsChange(() => { fired = true })
  assert.equal(fired, false, 'no private forwarding event exists to fire')
})
