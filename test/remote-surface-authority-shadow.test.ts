/**
 * Contract tests for the Direct-vs-Remote live-session authority shadow.
 * They cover bounded parity fields, metadata-derived command claims, and the
 * operation/generation/disposal fences that prevent stale diagnostics.
 * @module @xmoon76/dsh-pi-tui/remote-surface-authority-shadow.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SurfaceAuthorityReader, SurfaceAuthoritySnapshot } from '../src/runtime/surface-authority-port.ts'
import {
  RemoteSurfaceAuthorityShadow,
  commandClaimOf,
  type SurfaceAuthorityShadowOutcome,
} from '../src/runtime/remote/surface-authority-shadow.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from '../src/runtime/remote/session-reader-remote.ts'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: unknown) => void
} {
  return Promise.withResolvers<T>()
}

function generations(initial: RemoteConnectionGeneration | undefined = { id: 'g1' }): {
  source: RemoteConnectionGenerationSource
  set: (generation: RemoteConnectionGeneration | undefined) => void
} {
  let current: RemoteConnectionGeneration | undefined = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set: (generation) => {
      current = generation
      for (const listener of listeners) listener()
    },
  }
}

function snapshot(
  commands: SurfaceAuthoritySnapshot['commands'] = [],
  skills: SurfaceAuthoritySnapshot['skills'] = [],
): SurfaceAuthoritySnapshot {
  return Object.freeze({
    commands: Object.freeze(commands),
    skills: Object.freeze(skills),
  })
}

function readerOf(read: SurfaceAuthorityReader['read']): SurfaceAuthorityReader {
  return { read }
}

function status(outcome: SurfaceAuthorityShadowOutcome): SurfaceAuthorityShadowOutcome['status'] {
  return outcome.status
}

test('reports an exact match as comparable with no mismatches', async () => {
  const value = snapshot(
    [{ definitionId: 'fixture', name: 'plan', description: 'Plan', input: { hint: '[message]' } }],
    [{ name: 'eli5', description: 'Explain', modelInvocable: true }],
  )
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => value),
    readerOf(async () => value),
    generations().source,
  )

  const outcome = await shadow.compare({ sessionId: 'session-a' })
  assert.equal(outcome.status, 'compared')
  if (outcome.status === 'compared') {
    assert.equal(outcome.report.comparable, true)
    assert.deepEqual(outcome.report.mismatches, [])
  }
  shadow.dispose()
})

test('reports command and skill membership mismatches separately', async () => {
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot(
      [{ name: 'direct-command', description: 'Direct' }],
      [{ name: 'direct-skill', description: 'Direct', modelInvocable: true }],
    )),
    readerOf(async () => snapshot(
      [{ name: 'remote-command', description: 'Remote' }],
      [{ name: 'remote-skill', description: 'Remote', modelInvocable: true }],
    )),
    generations().source,
  )

  const outcome = await shadow.compare({ sessionId: 'session-a' })
  assert.equal(outcome.status, 'compared')
  if (outcome.status === 'compared') {
    assert.deepEqual(outcome.report.mismatches.map(item => item.field), ['commands.ids', 'skills.ids'])
  }
  shadow.dispose()
})

test('compares command identity/input and skill metadata, and derives bare/argument claims', async () => {
  const direct = snapshot(
    [
      {
        definitionId: 'global-plan',
        name: 'plan',
        description: 'Direct plan',
        input: { hint: '[message]', attachments: true },
      },
      { name: 'compact', description: 'Direct compact' },
    ],
    [
      { name: 'eli5', description: 'Direct explain', whenToUse: 'when asked', modelInvocable: true },
      { name: 'find', description: 'Direct find', modelInvocable: false },
    ],
  )
  const remote = snapshot(
    [
      { name: 'compact', description: 'Direct compact', input: { hint: '[compact]' } },
      {
        definitionId: 'remote-plan',
        name: 'plan',
        description: 'Remote plan',
        input: { hint: '[text]', attachments: false },
      },
    ],
    [
      { name: 'find', description: 'Remote find', modelInvocable: true },
      { name: 'eli5', description: 'Remote explain', whenToUse: 'always', modelInvocable: false },
    ],
  )
  const clock = generations()
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => direct),
    readerOf(async () => remote),
    clock.source,
  )

  const outcome = await shadow.compare({ sessionId: 'session-a' })
  assert.equal(status(outcome), 'compared')
  if (outcome.status !== 'compared') return
  assert.equal(outcome.report.comparable, false)
  assert.deepEqual(new Set(outcome.report.mismatches.map(item => item.field)), new Set([
    'commands.order',
    'command.definitionId',
    'command.description',
    'command.input.presence',
    'command.input.hint',
    'command.input.attachments',
    'skill.description',
    'skill.whenToUse',
    'skill.modelInvocable',
    'skills.order',
  ]))
  assert.deepEqual(outcome.report.commandClaims.direct, [
    { name: 'plan', claim: { bare: true, withArguments: true } },
    { name: 'compact', claim: { bare: true, withArguments: false } },
  ])
  assert.deepEqual(outcome.report.commandClaims.remote, [
    { name: 'compact', claim: { bare: true, withArguments: true } },
    { name: 'plan', claim: { bare: true, withArguments: true } },
  ])
  assert.deepEqual(commandClaimOf(direct.commands[1]!), {
    name: 'compact',
    claim: { bare: true, withArguments: false },
  })
  shadow.dispose()
})

test('bounds mismatch diagnostics instead of copying unbounded remote metadata', async () => {
  const longName = 'n'.repeat(700)
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot([{ name: longName, description: 'Direct' }])),
    readerOf(async () => snapshot()),
    generations().source,
  )

  const outcome = await shadow.compare({ sessionId: 'session-a' })
  assert.equal(outcome.status, 'compared')
  if (outcome.status === 'compared') {
    const expected = outcome.report.mismatches[0]?.expected
    assert.ok(Array.isArray(expected))
    assert.equal((expected[0] as string).length, 512)
    assert.equal(outcome.report.commandClaims.direct[0]?.name.length, 512)
    assert.equal(outcome.report.mismatches.length, 1)
  }
  shadow.dispose()

  const manyShadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot(Array.from({ length: 65 }, (_, index) => ({
      name: `command-${index}`,
      description: 'Direct',
    })))),
    readerOf(async () => snapshot()),
    generations().source,
  )
  const manyOutcome = await manyShadow.compare({ sessionId: 'session-a' })
  assert.equal(manyOutcome.status, 'compared')
  if (manyOutcome.status === 'compared') assert.equal(manyOutcome.report.commandClaims.direct.length, 64)
  manyShadow.dispose()
})

test('returns unavailable/error outcomes without turning failures into empty catalogs', async () => {
  const disconnected = generations()
  disconnected.set(undefined)
  const disconnectedShadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot()),
    readerOf(async () => snapshot()),
    disconnected.source,
  )
  assert.deepEqual(await disconnectedShadow.compare({ sessionId: 'session-a' }), {
    status: 'unavailable',
    reason: 'disconnected',
  })
  disconnectedShadow.dispose()

  const directUnavailable = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => undefined),
    readerOf(async () => snapshot()),
    generations().source,
  )
  assert.deepEqual(await directUnavailable.compare({ sessionId: 'session-a' }), {
    status: 'unavailable',
    reason: 'direct-unavailable',
  })
  directUnavailable.dispose()

  const remoteFailure = new Error('Remote transport failed')
  const failed = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot()),
    readerOf(async () => { throw remoteFailure }),
    generations().source,
  )
  const errorOutcome = await failed.compare({ sessionId: 'session-a' })
  assert.equal(errorOutcome.status, 'error')
  if (errorOutcome.status === 'error') assert.equal(errorOutcome.error, remoteFailure)
  failed.dispose()

  const remoteUnavailable = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot()),
    readerOf(async () => undefined),
    generations().source,
  )
  assert.deepEqual(await remoteUnavailable.compare({ sessionId: 'session-a' }), {
    status: 'unavailable',
    reason: 'remote-unavailable',
  })
  remoteUnavailable.dispose()
})

test('aborts a pending sibling read when the current provider fails', async () => {
  const pendingDirect = deferred<SurfaceAuthoritySnapshot | undefined>()
  let directSignal: AbortSignal | undefined
  const remoteFailure = new Error('current Remote failure')
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async (_sessionId, signal) => {
      directSignal = signal
      return pendingDirect.promise
    }),
    readerOf(async () => { throw remoteFailure }),
    generations().source,
  )

  const outcome = await shadow.compare({ sessionId: 'session-a' })
  assert.equal(outcome.status, 'error')
  if (outcome.status === 'error') assert.equal(outcome.error, remoteFailure)
  const observedSignal = directSignal
  assert.ok(observedSignal)
  assert.equal(observedSignal.aborted, true)
  pendingDirect.resolve(snapshot())
  shadow.dispose()
})

test('discards a stale success when a newer compare supersedes it', async () => {
  const firstDirect = deferred<SurfaceAuthoritySnapshot | undefined>()
  const firstRemote = deferred<SurfaceAuthoritySnapshot | undefined>()
  let directCalls = 0
  let remoteCalls = 0
  const value = snapshot([{ name: 'plan', description: 'Plan' }])
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => directCalls++ === 0 ? firstDirect.promise : value),
    readerOf(async () => remoteCalls++ === 0 ? firstRemote.promise : value),
    generations().source,
  )

  const first = shadow.compare({ sessionId: 'session-a' })
  const second = shadow.compare({ sessionId: 'session-a' })
  firstDirect.resolve(value)
  firstRemote.resolve(value)

  assert.deepEqual(await first, { status: 'discarded', reason: 'superseded' })
  assert.equal((await second).status, 'compared')
  shadow.dispose()
})

test('discards stale failure after a Connection generation change', async () => {
  const directRead = deferred<SurfaceAuthoritySnapshot | undefined>()
  const remoteRead = deferred<SurfaceAuthoritySnapshot | undefined>()
  const clock = generations()
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => directRead.promise),
    readerOf(async () => remoteRead.promise),
    clock.source,
  )
  const compare = shadow.compare({ sessionId: 'session-a' })
  clock.set({ id: 'g2' })
  directRead.reject(new Error('stale direct failure'))
  remoteRead.reject(new Error('stale remote failure'))

  assert.deepEqual(await compare, { status: 'discarded', reason: 'stale-generation' })
  shadow.dispose()
})

test('reports caller cancellation and disposal rather than committing late results', async () => {
  const firstDirect = deferred<SurfaceAuthoritySnapshot | undefined>()
  const firstRemote = deferred<SurfaceAuthoritySnapshot | undefined>()
  const controller = new AbortController()
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => firstDirect.promise),
    readerOf(async () => firstRemote.promise),
    generations().source,
  )
  const cancelled = shadow.compare({ sessionId: 'session-a', signal: controller.signal })
  controller.abort()
  firstDirect.resolve(snapshot())
  firstRemote.resolve(snapshot())
  assert.deepEqual(await cancelled, { status: 'cancelled' })

  const lateDirect = deferred<SurfaceAuthoritySnapshot | undefined>()
  const lateRemote = deferred<SurfaceAuthoritySnapshot | undefined>()
  const disposedShadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => lateDirect.promise),
    readerOf(async () => lateRemote.promise),
    generations().source,
  )
  const disposed = disposedShadow.compare({ sessionId: 'session-a' })
  disposedShadow.dispose()
  lateDirect.resolve(snapshot())
  lateRemote.resolve(snapshot())
  assert.deepEqual(await disposed, { status: 'discarded', reason: 'disposed' })
})
