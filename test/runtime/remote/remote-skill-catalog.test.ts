/**
 * Contract tests for the Remote skill catalog adapter
 * (runtime/remote/skill-remote.ts): the official Session-addressed
 * `skills/list` mapping with detached DTOs and truthful failure semantics;
 * the private Host Workspace standing read; and the private Host Skills
 * invalidation stream (first-frame refresh, generation re-arm, disposer).
 * @module @xmoon76/dsh-pi-tui/remote-skill-catalog.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteSkillCatalog,
  type PiTuiSkillsRemotes,
  type RemoteSkillListValue,
} from '../../../src/runtime/remote/skill-remote.ts'
import type {
  PiTuiSkillsInvalidationFrame,
  PiTuiSkillsStandingCall,
  PiTuiSkillsStandingRequest,
} from '../../../src/runtime/remote/pi-tui-skills-contract.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import { createObservableGenerationHarness } from '../../support/remote-generation.ts'

type ListCall = { request: { sessionId: string }; signal: AbortSignal | undefined }

interface ScriptedStanding {
  readonly result?: PiTuiSkillsStandingCall
  readonly throw?: unknown
  readonly gate?: Promise<void>
}

/** One controllable private stream handle (downlink queue + abort). */
function streamHandle(
  signal: AbortSignal,
  onAbort: () => void,
): {
  readonly handle: RemoteStreamHandle<PiTuiSkillsInvalidationFrame, never>
  enqueue(frame: PiTuiSkillsInvalidationFrame): void
} {
  const frames: PiTuiSkillsInvalidationFrame[] = []
  let wake: (() => void) | undefined
  let closed = false
  const stop = (): void => {
    closed = true
    const resume = wake
    wake = undefined
    resume?.()
  }
  signal.addEventListener('abort', stop, { once: true })
  return {
    enqueue: (frame) => {
      if (closed) return
      frames.push(frame)
      const resume = wake
      wake = undefined
      resume?.()
    },
    handle: {
      send: () => {},
      end: () => {},
      dispose: () => { stop(); onAbort() },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const frame = frames.shift()
          if (frame !== undefined) {
            yield frame
            continue
          }
          if (closed || signal.aborted) return
          await new Promise<void>(resolve => { wake = resolve })
        }
      },
    },
  }
}

function harness(options: {
  result?: { ok: true; value: RemoteSkillListValue } | { ok: false; error: unknown }
  throw?: unknown
  gate?: Promise<void>
  standing?: ScriptedStanding
} = {}) {
  const generation = createObservableGenerationHarness()
  const calls: ListCall[] = []
  const standingCalls: Array<{ request: PiTuiSkillsStandingRequest; signal: AbortSignal | undefined }> = []
  const streams: Array<{
    readonly signal: AbortSignal
    enqueue(frame: PiTuiSkillsInvalidationFrame): void
    readonly disposed: boolean
  }> = []
  const skills = {
    list: async (request: { sessionId: string }, signal?: AbortSignal) => {
      calls.push({ request, signal })
      if (options.gate !== undefined) await options.gate
      if (options.throw !== undefined) throw options.throw
      return options.result ?? { ok: true as const, value: { skills: [] } }
    },
  }
  const piTuiSkills: PiTuiSkillsRemotes = {
    standing: async (request, signal) => {
      standingCalls.push({ request, signal })
      if (options.standing?.gate !== undefined) await options.standing.gate
      if (options.standing?.throw !== undefined) throw options.standing.throw
      if (options.standing?.result !== undefined) return options.standing.result
      return { ok: true, value: { skills: [], complete: true } }
    },
    watchInvalidations: (signal = new AbortController().signal) => {
      const record = { signal, disposed: false, enqueue: (_frame: PiTuiSkillsInvalidationFrame) => {} }
      const stream = streamHandle(signal, () => { record.disposed = true })
      record.enqueue = stream.enqueue
      streams.push(record)
      return stream.handle
    },
  }
  return {
    generation,
    calls,
    standingCalls,
    streams,
    catalog: new RemoteSkillCatalog(skills, piTuiSkills, generation.source),
  }
}

/** One client generation token for standing-read fences. */
function standingResult(names: readonly string[], complete = true, notice?: string): PiTuiSkillsStandingCall {
  return {
    ok: true,
    value: {
      skills: names.map(name => ({ name, description: name, modelInvocable: true })),
      complete,
      ...(notice === undefined ? {} : { notice }),
    },
  }
}

/** Drain pending microtasks AND one macrotask (the stream pump between frames). */
async function drainStreamPump(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('listHumanSkills sends the EXACT session id and forwards the signal', async () => {
  const controller = new AbortController()
  const { catalog, calls } = harness()
  await catalog.listHumanSkills('session-42', controller.signal)
  assert.deepEqual(calls, [{ request: { sessionId: 'session-42' }, signal: controller.signal }])
})

test('the returned catalog is detached from the wire value', async () => {
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

test('malformed wire rows are refused, never coerced', async () => {
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

test('a Host error is an ERROR, not an empty success', async () => {
  const { catalog } = harness({ result: { ok: false, error: { code: 'session/not-found', message: 'no session' } } })
  await assert.rejects(catalog.listHumanSkills('s'), /no session/)
})

test('an abort stays a cancellation', async () => {
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

test('a result settling after a generation replacement is dropped as unavailable', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { catalog, generation } = harness({ gate })
  const pending = catalog.listHumanSkills('s')
  generation.set({ id: 2 })
  release()
  assert.equal(await pending, undefined)
})

test('a generation-replaced FAILURE is dropped too (not the new generation\'s error)', async () => {
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

// ── the private Host Workspace standing read ───────────────────────────────

test('standing sends ONLY the captured Host WorkspaceId and the preset over the private RPC', async () => {
  const { catalog, standingCalls } = harness({ standing: { result: standingResult(['alpha']) } })
  const controller = new AbortController()
  const read = await catalog.standing(
    'standard',
    { kind: 'host-workspace', workspaceId: 'ws-host-1' },
    controller.signal,
  )
  assert.deepEqual(standingCalls, [{
    request: { workspaceId: 'ws-host-1', presetId: 'standard' },
    signal: controller.signal,
  }], 'the Client cwd never appears in the Host standing request')
  assert.deepEqual(read, { catalog: { skills: [{ name: 'alpha', description: 'alpha', modelInvocable: true }], complete: true } })
})

test('a Remote standing read refuses a co-located Client directory instead of reading it', async () => {
  const { catalog, standingCalls } = harness()
  await assert.rejects(
    () => catalog.standing(undefined, { kind: 'co-located-directory', cwd: '/client/cwd' }),
    /Host workspace identity/,
    'Client cwd is never a Remote standing location',
  )
  assert.deepEqual(standingCalls, [], 'the refused location never reaches the Host')
})

test('an incomplete Host observation is preserved with its notice', async () => {
  const { catalog } = harness({
    standing: { result: standingResult(['alpha'], false, 'Preset scope is unavailable; showing global skills.') },
  })
  const read = await catalog.standing(undefined, { kind: 'host-workspace', workspaceId: 'ws-1' })
  assert.equal(read.catalog.complete, false)
  assert.equal(read.notice, 'Preset scope is unavailable; showing global skills.')
})

test('a Host standing failure rejects instead of becoming an empty catalog', async () => {
  const { catalog } = harness({ standing: { throw: new Error('Host workspace is unavailable') } })
  await assert.rejects(
    () => catalog.standing(undefined, { kind: 'host-workspace', workspaceId: 'ws-gone' }),
    /Host workspace is unavailable/,
  )
})

test('no connection refuses a standing read without any Host call', async () => {
  const { catalog, generation, standingCalls } = harness()
  generation.set(undefined)
  await assert.rejects(
    () => catalog.standing(undefined, { kind: 'host-workspace', workspaceId: 'ws-1' }),
    SupersededReadError,
  )
  assert.deepEqual(standingCalls, [])
})

test('a Host standing result settling after a generation replacement is refused', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { catalog, generation } = harness({ standing: { gate, result: standingResult(['stale']) } })
  const pending = catalog.standing(undefined, { kind: 'host-workspace', workspaceId: 'ws-1' })
  generation.set({ id: 2 })
  release()
  await assert.rejects(pending, SupersededReadError)
})

// ── the private Host Skills invalidation stream ────────────────────────────

test('the Host startup invalidation frame reaches the listener (subscribe-then-reread barrier)', async () => {
  const { catalog, streams } = harness()
  let fired = 0
  const dispose = catalog.onSkillsChange(() => { fired += 1 }, () => {})
  assert.equal(streams.length, 1, 'the subscription opens ONE private stream')
  streams[0]!.enqueue({ kind: 'invalidated' })
  await drainStreamPump()
  assert.equal(fired, 1, 'the first frame wakes the current owner reread')
  dispose()
})

test('a malformed downlink frame is refused and reported instead of waking a refresh', async () => {
  const { catalog, streams } = harness()
  let fired = 0
  const errors: unknown[] = []
  const dispose = catalog.onSkillsChange(() => { fired += 1 }, error => { errors.push(error) })
  streams[0]!.enqueue({ kind: 'bogus' } as unknown as PiTuiSkillsInvalidationFrame)
  await drainStreamPump()
  assert.equal(fired, 0)
  assert.equal(errors.length, 1)
  assert.match(String((errors[0] as Error | undefined)?.message), /kind must be invalidated/)
  dispose()
})

test('a new Connection generation re-arms the stream and the Host first frame invalidates the new owner', async () => {
  const { catalog, generation, streams } = harness()
  let fired = 0
  const dispose = catalog.onSkillsChange(() => { fired += 1 }, () => {})
  assert.equal(streams.length, 1)
  generation.set({ id: 2 })
  assert.equal(streams[0]!.signal.aborted, true, 'the previous generation stream is aborted')
  assert.equal(streams.length, 2, 'the replacement generation opens its own private stream')
  streams[1]!.enqueue({ kind: 'invalidated' })
  await drainStreamPump()
  assert.equal(fired, 1, 'the startup frame of the NEW stream triggers the sessionless/live reread')
  dispose()
  assert.equal(streams[1]!.signal.aborted, true)
})

test('an explicit rearm after a stream failure opens ONE replacement stream and its startup frame refreshes', async () => {
  const { catalog, streams } = harness()
  let fired = 0
  const errors: unknown[] = []
  const dispose = catalog.onSkillsChange(() => { fired += 1 }, error => { errors.push(error) })
  assert.equal(streams.length, 1)
  streams[0]!.enqueue({ kind: 'bogus' } as unknown as PiTuiSkillsInvalidationFrame)
  await drainStreamPump()
  assert.equal(errors.length, 1, 'the failed stream is reported, not silently lost')
  // No hidden retry: the adapter does NOT open a replacement on its own.
  assert.equal(streams.length, 1)
  catalog.rearmSkillsChange()
  assert.equal(streams.length, 2, 'the explicit owner refresh re-establishes observation')
  streams[1]!.enqueue({ kind: 'invalidated' })
  await drainStreamPump()
  assert.equal(fired, 1, 'the rearmed stream startup frame reaches the listener')
  // A second rearm while the replacement is live is a no-op.
  catalog.rearmSkillsChange()
  assert.equal(streams.length, 2)
  dispose()
})

test('the disposer releases the exact private stream before the coordinator goes away', () => {
  const { catalog, streams } = harness()
  const dispose = catalog.onSkillsChange(() => {}, () => {})
  dispose()
  assert.equal(streams[0]!.signal.aborted, true)
  dispose()
  assert.equal(streams.length, 1, 'a second dispose never opens another stream')
})

test('the Client skill-body read stays unavailable', async () => {
  const { catalog } = harness()
  assert.deepEqual(await catalog.resolveSkill('s', 'review-fix-loop'), { kind: 'unavailable' })
})

test('hostLoadsSkillBody is a composition fact, not a wire probe', () => {
  const { catalog, calls } = harness()
  assert.equal(catalog.hostLoadsSkillBody('s'), true)
  assert.deepEqual(calls, [], 'the composition fact never dispatches a Host call')
})
