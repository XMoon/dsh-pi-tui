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

function readerOf(read: SurfaceAuthorityReader['read'], isLive = (_sessionId: string) => true): SurfaceAuthorityReader & { isLive(sessionId: string): boolean } {
  return { read, isLive }
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

test('fences reentrant generation reset during the live gate', async () => {
  const clock = generations()
  let remoteCalls = 0
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => { assert.fail('stale gate must not start Direct discovery') }, () => {
      clock.set({ id: 'g2' })
      return false
    }),
    readerOf(async () => {
      remoteCalls += 1
      return snapshot()
    }),
    clock.source,
  )

  assert.deepEqual(await shadow.compare({ sessionId: 'session-a' }), {
    status: 'discarded',
    reason: 'stale-generation',
  })
  assert.equal(remoteCalls, 0)
  shadow.dispose()
})

test('reports caller cancellation reentrant from the live gate', async () => {
  const controller = new AbortController()
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => { assert.fail('cancelled gate must not start Direct discovery') }, () => {
      controller.abort()
      return false
    }),
    readerOf(async () => {
      assert.fail('cancelled gate must not start Remote discovery')
    }),
    generations().source,
  )

  assert.deepEqual(await shadow.compare({ sessionId: 'session-a', signal: controller.signal }), {
    status: 'cancelled',
  })
  shadow.dispose()
})

test('starts both observations before deferred discovery and catalog mutation', async () => {
  let catalog = snapshot([{ name: 'a', description: 'Catalog A' }])
  const discovery = deferred<void>()
  const started: string[] = []
  let directSignal: AbortSignal | undefined
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async (_sessionId, signal) => {
      started.push('direct')
      directSignal = signal
      const captured = catalog
      await discovery.promise
      return captured
    }),
    readerOf(async (_sessionId, signal) => {
      started.push('remote')
      assert.equal(signal, directSignal)
      const captured = catalog
      await discovery.promise
      return captured
    }),
    generations().source,
  )
  const pending = shadow.compare({ sessionId: 'session-a' })
  // No Connection generation change: only the Host catalog changes while
  // discovery is pending. Serial reads would observe A followed by B.
  catalog = snapshot([{ name: 'b', description: 'Catalog B' }])
  discovery.resolve()
  const outcome = await pending
  assert.deepEqual(started, ['direct', 'remote'])
  assert.equal(outcome.status, 'compared')
  if (outcome.status === 'compared') assert.equal(outcome.report.comparable, true)
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

  let remoteCallsWithoutDirect = 0
  const directUnavailable = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => { assert.fail('ineligible Session must not discover Direct catalog') }, sessionId => {
      assert.equal(sessionId, 'session-a')
      return false
    }),
    readerOf(async () => {
      remoteCallsWithoutDirect += 1
      return snapshot()
    }),
    generations().source,
  )
  assert.deepEqual(await directUnavailable.compare({ sessionId: 'session-a' }), {
    status: 'unavailable',
    reason: 'direct-unavailable',
  })
  assert.equal(remoteCallsWithoutDirect, 0, 'Remote must not probe without a live Direct Agent')
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

test('aborts the owned operation when the current provider fails', async () => {
  let remoteSignal: AbortSignal | undefined
  const remoteFailure = new Error('current Remote failure')
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot()),
    readerOf(async (_sessionId, signal) => {
      remoteSignal = signal
      throw remoteFailure
    }),
    generations().source,
  )

  const outcome = await shadow.compare({ sessionId: 'session-a' })
  assert.equal(outcome.status, 'error')
  if (outcome.status === 'error') assert.equal(outcome.error, remoteFailure)
  assert.ok(remoteSignal)
  assert.equal(remoteSignal.aborted, true)
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

test('discards stale Remote failure after a Connection generation change', async () => {
  const remoteRead = deferred<SurfaceAuthoritySnapshot | undefined>()
  const remoteStarted = deferred<void>()
  const clock = generations()
  const shadow = new RemoteSurfaceAuthorityShadow(
    readerOf(async () => snapshot()),
    readerOf(async () => {
      remoteStarted.resolve()
      return remoteRead.promise
    }),
    clock.source,
  )
  const compare = shadow.compare({ sessionId: 'session-a' })
  await remoteStarted.promise
  clock.set({ id: 'g2' })
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
