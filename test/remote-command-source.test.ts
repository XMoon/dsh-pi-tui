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

/** A mutable sessions-binding source double (the §16 exact-binding fence). */
function bindingsSource(initial: unknown) {
  let current = initial
  return {
    binding: () => current,
    replace(next: unknown) { current = next },
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
    bindings: bindingsSource({ session: {} }),
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
    bindings: bindingsSource({ session: {} }),
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
    bindings: bindingsSource({ session: {} }),
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

test('readCommands: a same-id binding-only rollover mid-read never commits (undefined)', async () => {
  // The Connection generation does NOT change; only the exact binding under
  // the SAME session id is replaced (release/re-retain). The retired
  // generation-only fence missed exactly this — §16 requires the settled
  // read to drop.
  const generation = generationSource({ id: 1 } as RemoteConnectionGeneration)
  const bindings = bindingsSource({ session: { marker: 'binding-X' } })
  const source = createRemoteCommandSource({
    authority: {
      commands: {
        list: async () => {
          bindings.replace({ session: { marker: 'binding-Y' } })
          return { ok: true, value: [{ name: 'retired-host-command', description: 'r' }] }
        },
      },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation,
    bindings: bindings as never,
  })
  assert.equal(await source.readCommands('session-a'), undefined,
    'a same-id binding rollover reads as superseded (undefined), never the retired binding\'s descriptors')
})

test('readCommands: an unretained session never issues the wire read', async () => {
  const generation = generationSource({ id: 1 } as RemoteConnectionGeneration)
  let wireReads = 0
  const source = createRemoteCommandSource({
    authority: {
      commands: { list: async () => { wireReads += 1; return { ok: true, value: [] } } },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation,
    bindings: bindingsSource(undefined),
  })
  assert.equal(await source.readCommands('session-a'), undefined)
  assert.equal(wireReads, 0, 'no binding means no wire read (never a cold-open side effect)')
})

test('transport fence: the admission token invalidates on binding rollover and on generation replacement', async () => {
  const generation = generationSource({ id: 1 } as RemoteConnectionGeneration)
  const bindings = bindingsSource({ session: { marker: 'binding-X' } })
  const source = createRemoteCommandSource({
    authority: {
      commands: { list: async () => ({ ok: true, value: [] }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation,
    bindings: bindings as never,
  })
  const token = source.captureTransportToken('session-a')
  assert.equal(source.isTransportTokenCurrent('session-a', token), true)
  // Binding-only rollover (same generation): stale.
  bindings.replace({ session: { marker: 'binding-Y' } })
  assert.equal(source.isTransportTokenCurrent('session-a', token), false,
    'a binding-only rollover invalidates the admission token')
  // Generation-only replacement (binding back to X): still stale.
  bindings.replace({ session: { marker: 'binding-X' } })
  generation.replace({ id: 2 } as RemoteConnectionGeneration)
  assert.equal(source.isTransportTokenCurrent('session-a', token), false,
    'a Connection generation replacement invalidates the admission token')
  assert.equal(source.isTransportTokenCurrent('session-a', undefined), false,
    'a missing token is never current')
})

test('negative lock: the command source module never widens the authority reader', () => {
  const source: RemoteCommandSource = createRemoteCommandSource({
    authority: { commands: { list: async () => ({ ok: true, value: [] }) }, skills: { list: async () => ({ ok: true, value: { skills: [] } }) } },
    generation: generationSource({ id: 1 } as RemoteConnectionGeneration),
    bindings: bindingsSource({ session: {} }),
  })
  assert.equal(typeof source.read, 'function')
  assert.deepEqual(Object.keys(source).sort(),
    ['captureTransportToken', 'isTransportTokenCurrent', 'read', 'readCommands'],
    'the exposed bundle carries ONLY the metadata reads + the transport fence — no execute, no callbacks, no registry')
})
