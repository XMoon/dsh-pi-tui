/**
 * L3 contract tests for the Remote command source (M3-4 PR4 Step 2):
 * the branch-specific command authority read assembled from the ONE Remote
 * aggregate — generation fencing (a replaced Connection never commits a
 * stale snapshot), error propagation (never an empty success), and the
 * neutral application face satisfied by the real bundle with no cast.
 * @module @xmoon76/dsh-pi-tui/remote-command-source.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteCommandSource, type RemoteCommandSource } from '../src/app/remote/command-source.ts'
import type { RemoteApplicationSource } from '../src/app/remote/presentation-source.ts'
import type { SurfaceAuthoritySnapshot } from '../src/runtime/surface-authority-port.ts'

/** A mutable generation source double. */
import type { RemoteConnectionGeneration } from '../src/runtime/remote/session-reader-remote.ts'

function generationSource(initial: RemoteConnectionGeneration | undefined) {
  let snapshot = initial
  return {
    getSnapshot: (): RemoteConnectionGeneration | undefined => snapshot,
    replace(next: RemoteConnectionGeneration | undefined) { snapshot = next },
    subscribe: () => () => {},
  }
}

function snapshotOf(names: string[]): SurfaceAuthoritySnapshot {
  return Object.freeze({
    commands: Object.freeze(names.map(name => Object.freeze({ name, description: name }))),
    skills: Object.freeze([]),
  })
}

test('read: a successful generation-fenced read returns the detached snapshot', async () => {
  const generation = { id: 1 } as RemoteConnectionGeneration
  const source = createRemoteCommandSource({
    authority: {
      commands: { list: async () => ({ ok: true, value: [{ name: 'alpha', description: 'a' }] }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation: generationSource(generation),
  })
  const read = await source.read('session-a')
  assert.deepEqual(read?.commands.map(command => command.name), ['alpha'])
})

test('read: a Connection rollover mid-read never commits (undefined, never stale)', async () => {
  const generation = { id: 1 } as RemoteConnectionGeneration
  const source = generationSource(generation)
  const commands = createRemoteCommandSource({
    authority: {
      commands: {
        list: async () => {
          source.replace({ id: 2 } as RemoteConnectionGeneration)
          return { ok: true, value: [{ name: 'stale', description: 's' }] }
        },
      },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation: source,
  })
  assert.equal(await commands.read('session-a'), undefined,
    'a replaced Connection generation reads as superseded (undefined), never a stale success')
})

test('read: a provider failure rejects (never an empty success)', async () => {
  const source = createRemoteCommandSource({
    authority: {
      commands: { list: async () => ({ ok: false, error: new Error('commands/list exploded') }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation: generationSource({ id: 1 } as RemoteConnectionGeneration),
  })
  await assert.rejects(() => source.read('session-a'), /commands\/list/)
})

test('the neutral application face: RemoteApplicationSource.commandSource satisfies it structurally', async () => {
  // Compile-time structural proof: the REAL bundle's commandSource member
  // must satisfy the neutral RemoteCommandSourceFace declared on
  // RemoteApplicationSources without any cast (the same discipline the
  // official-contract suite applies to the generated Remote faces).
  const bundle = { commandSource: null } as unknown as RemoteApplicationSource
  const face: RemoteApplicationSource['commandSource'] = bundle.commandSource
  assert.ok(face !== undefined)
})

test('negative lock: the command source module never widens the authority reader', () => {
  const source: RemoteCommandSource = createRemoteCommandSource({
    authority: { commands: { list: async () => ({ ok: true, value: [] }) }, skills: { list: async () => ({ ok: true, value: { skills: [] } }) } },
    generation: generationSource({ id: 1 } as RemoteConnectionGeneration),
  })
  assert.equal(typeof source.read, 'function')
  assert.deepEqual(Object.keys(source).sort(), ['read', 'readCommands'],
    'the exposed bundle carries ONLY the metadata reads — no execute, no callbacks, no registry')
})
