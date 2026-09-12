/**
 * Contract tests for the live-session command/skill authority Remote reader.
 * The tests exercise official RemoteResult handling, detached whitelisting,
 * cancellation, and Connection-generation fencing.
 * @module @xmoon76/dsh-pi-tui/remote-surface-authority-reader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSurfaceAuthorityReader,
  type RemoteCommandDescriptor,
  type RemoteSkillEntry,
  type RemoteSurfaceAuthoritySource,
} from '../src/runtime/remote/surface-authority-remote.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
  RemoteReadResult,
} from '../src/runtime/remote/session-reader-remote.ts'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: unknown) => void
} {
  return Promise.withResolvers<T>()
}

function result<T>(value: T): RemoteReadResult<T> {
  return { ok: true, value }
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

function sourceOf(options: {
  commands?: (sessionId: string) => Promise<RemoteReadResult<readonly RemoteCommandDescriptor[]>>
  skills?: (request: { readonly sessionId: string }, signal: AbortSignal) => Promise<RemoteReadResult<{ readonly skills: readonly RemoteSkillEntry[] }>>
} = {}): RemoteSurfaceAuthoritySource {
  return {
    commands: {
      list: options.commands ?? (async () => result([])),
    },
    skills: {
      list: options.skills ?? (async () => result({ skills: [] })),
    },
  }
}

test('returns undefined without a Connection generation and does not probe Remotes', async () => {
  let commandCalls = 0
  let skillCalls = 0
  const clock = generations()
  clock.set(undefined)
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({
      commands: async () => {
        commandCalls += 1
        return result([])
      },
      skills: async () => {
        skillCalls += 1
        return result({ skills: [] })
      },
    }),
    clock.source,
  )

  assert.equal(await reader.read('session-a'), undefined)
  assert.equal(commandCalls, 0)
  assert.equal(skillCalls, 0)
})

test('maps and freezes only official command/skill authority metadata', async () => {
  let commandSession: string | undefined
  let skillRequest: { readonly sessionId: string } | undefined
  let skillSignal: AbortSignal | undefined
  const commandInput = { hint: '[message]', attachments: true }
  const commands: Array<RemoteCommandDescriptor & { readonly extra?: string }> = [{
    definitionId: 'command-definition',
    name: 'plan',
    description: 'Enter plan mode',
    input: commandInput,
    extra: 'must not cross',
  }, {
    definitionId: 'bare-definition',
    name: 'compact',
    description: 'Compact output',
  }]
  const skills: Array<RemoteSkillEntry & { readonly extra?: string }> = [{
    path: '/host/skills/secret/SKILL.md',
    name: 'eli5',
    description: 'Explain simply',
    whenToUse: 'when the user asks',
    modelInvocable: false,
    extra: 'must not cross',
  }]
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({
      commands: async (sessionId) => {
        commandSession = sessionId
        return result(commands)
      },
      skills: async (request, signal) => {
        skillRequest = request
        skillSignal = signal
        return result({ skills })
      },
    }),
    generations().source,
  )

  const snapshot = await reader.read('session-a')
  assert.ok(snapshot !== undefined)
  assert.equal(commandSession, 'session-a')
  assert.deepEqual(skillRequest, { sessionId: 'session-a' })
  assert.ok(skillSignal !== undefined)
  assert.deepEqual(snapshot.commands, [{
    definitionId: 'command-definition',
    name: 'plan',
    description: 'Enter plan mode',
    input: { hint: '[message]', attachments: true },
  }, {
    definitionId: 'bare-definition',
    name: 'compact',
    description: 'Compact output',
  }])
  assert.deepEqual(snapshot.skills, [{
    name: 'eli5',
    description: 'Explain simply',
    whenToUse: 'when the user asks',
    modelInvocable: false,
  }])
  assert.equal('path' in snapshot.skills[0]!, false, 'Host-local skill path must not cross the semantic port')
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.commands) && Object.isFrozen(snapshot.skills))
  assert.ok(Object.isFrozen(snapshot.commands[0]) && Object.isFrozen(snapshot.commands[0]?.input))
  assert.ok(Object.isFrozen(snapshot.skills[0]))

  commandInput.hint = 'mutated'
  ;(commands[0] as { description: string }).description = 'mutated'
  ;(skills[0] as { description: string }).description = 'mutated'
  assert.equal(snapshot.commands[0]?.input?.hint, '[message]')
  assert.equal(snapshot.commands[0]?.description, 'Enter plan mode')
  assert.equal(snapshot.skills[0]?.description, 'Explain simply')
})

test('unwraps a failed RemoteResult immediately instead of fabricating an empty catalog', async () => {
  const pendingSkills = deferred<RemoteReadResult<{ readonly skills: readonly RemoteSkillEntry[] }>>()
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({
      commands: async () => ({ ok: false, error: { code: 'COMMANDS_DOWN', message: 'try later' } }),
      skills: async () => pendingSkills.promise,
    }),
    generations().source,
  )

  await assert.rejects(reader.read('session-a'), /commands\/list failed: COMMANDS_DOWN: try later/u)
  pendingSkills.resolve(result({ skills: [] }))
})

test('wraps ordinary Remote promise rejection with a bounded provider error', async () => {
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({
      commands: async () => { throw new Error('commands promise failed') },
    }),
    generations().source,
  )

  await assert.rejects(reader.read('session-a'), /commands\/list failed: commands promise failed/u)
})

test('throws a failed skills RemoteResult instead of returning an empty skill list', async () => {
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({
      skills: async () => ({ ok: false, error: { code: 'SKILLS_DOWN', message: 'try later' } }),
    }),
    generations().source,
  )

  await assert.rejects(reader.read('session-a'), /skills\/list failed: SKILLS_DOWN: try later/u)
})

test('discards stale success after a Connection generation change', async () => {
  const commandRead = deferred<RemoteReadResult<readonly RemoteCommandDescriptor[]>>()
  const skillRead = deferred<RemoteReadResult<{ readonly skills: readonly RemoteSkillEntry[] }>>()
  const clock = generations()
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({ commands: async () => commandRead.promise, skills: async () => skillRead.promise }),
    clock.source,
  )
  const read = reader.read('session-a')
  clock.set({ id: 'g2' })
  commandRead.resolve(result([{ name: 'late', description: 'late' }]))
  skillRead.resolve(result({ skills: [] }))

  assert.equal(await read, undefined)
})

test('discards stale Remote failure after a Connection generation change', async () => {
  const commandRead = deferred<RemoteReadResult<readonly RemoteCommandDescriptor[]>>()
  const skillRead = deferred<RemoteReadResult<{ readonly skills: readonly RemoteSkillEntry[] }>>()
  const clock = generations()
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({ commands: async () => commandRead.promise, skills: async () => skillRead.promise }),
    clock.source,
  )
  const read = reader.read('session-a')
  clock.set({ id: 'g2' })
  commandRead.resolve({ ok: false, error: { code: 'STALE', message: 'old generation' } })
  skillRead.resolve(result({ skills: [] }))

  assert.equal(await read, undefined)
})

test('caller cancellation wins over a Remote rejection', async () => {
  const controller = new AbortController()
  const skillRead = deferred<RemoteReadResult<{ readonly skills: readonly RemoteSkillEntry[] }>>()
  const reader = new RemoteSurfaceAuthorityReader(
    sourceOf({
      commands: async () => result([]),
      skills: async (_request, signal) => {
        if (signal.aborted) skillRead.reject(signal.reason)
        else signal.addEventListener('abort', () => skillRead.reject(signal.reason), { once: true })
        return skillRead.promise
      },
    }),
    generations().source,
  )
  const read = reader.read('session-a', controller.signal)
  controller.abort()

  await assert.rejects(read, (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError')
    return true
  })
})
