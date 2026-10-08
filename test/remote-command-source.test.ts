/**
 * Supporting app-side source/composition unit tests (no L1–L6 level) for the
 * Remote command source (M3-4 PR4 Step 2). The real L3 Remote adapter proof is
 * `test/remote-surface-authority-reader.test.ts` over
 * `src/runtime/remote/surface-authority-remote.ts`.
 *
 * This file covers the branch-specific command authority read assembled from
 * the ONE Remote aggregate — generation fencing (a replaced Connection never
 * commits a stale snapshot), error propagation (never an empty success), and the
 * neutral application face satisfied by the real bundle with no cast.
 * @module @xmoon76/dsh-pi-tui/remote-command-source.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteCommandSource, type RemoteCommandSource } from '../src/app/remote/command-source.ts'
import { composeRemoteSurfaceCatalog } from '../src/app/command/surface.ts'
import { CatalogRefreshCoordinator } from '../src/app/command/catalog-refresh.ts'
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

/** A generation source double with a REAL observable (subscribe + notify). */
function observableGenerationSource(initial: RemoteConnectionGeneration | undefined) {
  let snapshot = initial
  let listeners: Array<() => void> = []
  return {
    getSnapshot: (): RemoteConnectionGeneration | undefined => snapshot,
    replace(next: RemoteConnectionGeneration | undefined) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void): () => void {
      listeners.push(listener)
      return () => { listeners = listeners.filter(entry => entry !== listener) }
    },
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
    ['captureTransportToken', 'connectionGeneration', 'isTransportTokenCurrent', 'read', 'readCommands', 'subscribeConnectionGeneration'],
    'the exposed bundle carries ONLY the metadata reads + the transport fence + the generation delegation — no execute, no callbacks, no registry')
})

/* ── M3-6 PR2 §14.1: the generation delegation (RCS-G1/G2) ─────────────── */

test('RCS-G1: connectionGeneration() returns the EXACT official snapshot object by identity', () => {
  const generation = { id: 7 } as RemoteConnectionGeneration
  const source = createRemoteCommandSource({
    authority: { commands: { list: async () => ({ ok: true, value: [] }) }, skills: { list: async () => ({ ok: true, value: { skills: [] } }) } },
    generation: generationSource(generation),
    bindings: bindingsSource({ session: {} }),
  })
  assert.equal(Object.is(source.connectionGeneration(), generation), true,
    'the delegated snapshot IS the official token object (never a copied {id} DTO)')
})

test('RCS-G2: subscribeConnectionGeneration delegates exactly — one notify while subscribed, none after unsubscribe', () => {
  const generation = observableGenerationSource({ id: 1 } as RemoteConnectionGeneration)
  const source = createRemoteCommandSource({
    authority: { commands: { list: async () => ({ ok: true, value: [] }) }, skills: { list: async () => ({ ok: true, value: { skills: [] } }) } },
    generation,
    bindings: bindingsSource({ session: {} }),
  })
  let notified = 0
  const unsubscribe = source.subscribeConnectionGeneration(() => { notified += 1 })
  generation.replace({ id: 2 } as RemoteConnectionGeneration)
  assert.equal(notified, 1, 'the source generation emission reached the subscribed listener exactly once')
  unsubscribe()
  generation.replace({ id: 3 } as RemoteConnectionGeneration)
  assert.equal(notified, 1, 'a later emission does not reach the unsubscribed listener')
})


test('PR4 F2b (review round 3): through the REAL composition, a FAILED commands provider keeps the FULFILLED skills', async () => {
  // The production path — not a hand-made snapshot: the real command source
  // (whose readCommands rejects on a provider failure) composed by the real
  // `composeRemoteSurfaceCatalog`.
  const generation = generationSource({ id: 1 } as RemoteConnectionGeneration)
  const bindings = bindingsSource({ session: {} })
  const source = createRemoteCommandSource({
    authority: {
      commands: { list: async () => ({ ok: false, error: new Error('commands/list exploded') }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation,
    bindings: bindings as never,
  })
  const snapshot = await composeRemoteSurfaceCatalog({
    source,
    listHumanSkills: async () => ({
      skills: [{ name: 'fresh-skill', description: 'f' }],
      complete: true,
    }) as never,
    sessionId: 'session-a',
    signal: new AbortController().signal,
  })
  assert.deepEqual(snapshot.commands, [], 'the failed commands field degrades to empty + an issue')
  assert.deepEqual(snapshot.skills.map(skill => skill.name), ['fresh-skill'],
    'the FULFILLED skills provider is never discarded by a commands failure')
  assert.equal(snapshot.issues.length, 1)
  assert.equal(snapshot.issues[0]?.provider, 'commands')
})

test('PR4 F2b (review round 3): the coordinator over the REAL composition keeps the last-good Host claims and adopts the fresh skills', async () => {
  let commandsFail = false
  let skillsVersion = 'old'
  const generation = generationSource({ id: 1 } as RemoteConnectionGeneration)
  const bindings = bindingsSource({ session: {} })
  const source = createRemoteCommandSource({
    authority: {
      commands: {
        list: async () => commandsFail
          ? { ok: false, error: new Error('commands/list exploded') }
          : { ok: true, value: [{ name: 'last-good-host', description: 'h' }] },
      },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation,
    bindings: bindings as never,
  })
  const installed: Array<{ commands: readonly { name: string }[]; skills: readonly { name: string }[] }> = []
  const diag = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} }
  const coordinator = new CatalogRefreshCoordinator({
    readAgent: async () => composeRemoteSurfaceCatalog({
      source,
      listHumanSkills: async () => ({
        skills: [{ name: `${skillsVersion}-skill`, description: 's' }],
        complete: true,
      }) as never,
      sessionId: 'session-a',
      signal: new AbortController().signal,
    }),
    readStanding: async () => { throw new Error('unused') },
    installSnapshot: (snapshot) => { installed.push(snapshot as never) },
    enterCatalogTransition: () => {},
  }, new AbortController().signal, diag as never)

  const first = await coordinator.refresh({ source: 'live-session', target: { kind: 'agent', key: 1 }, agent: {} as never })
  assert.equal(first.kind, 'applied')
  // Now the commands provider fails while the skills provider moves on.
  commandsFail = true
  skillsVersion = 'fresh'
  const second = await coordinator.refresh({ source: 'reload', target: { kind: 'agent', key: 1 }, agent: {} as never })
  assert.equal(second.kind, 'applied', 'a commands-provider failure is not a whole-refresh failure')
  if (second.kind === 'applied') {
    assert.deepEqual(second.snapshot.commands.map(c => c.name), ['last-good-host'],
      'mergePartial kept the last-good HOST claims (the claim set is never erased)')
    assert.deepEqual(second.snapshot.skills.map(s => s.name), ['fresh-skill'],
      'the successful skills provider updated its own field')
  }
})

test('PR4 F2b.2 (review round 4): a FULFILLED-UNDEFINED skills observation is an issue, never an empty success', async () => {
  // The port contract declares `undefined` = "no skill registry reachable
  // for this session" (catalog-port §listHumanSkills). The composition must
  // degrade it to a skills ISSUE (the coordinator's merge keeps last-good
  // skills) — never fold it into `skills: []`, which a same-target registry
  // blip would otherwise use to ERASE the installed set.
  const generation = generationSource({ id: 1 } as RemoteConnectionGeneration)
  const bindings = bindingsSource({ session: {} })
  const source = createRemoteCommandSource({
    authority: {
      commands: { list: async () => ({ ok: true, value: [{ name: 'fresh-host', description: 'h' }] }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation,
    bindings: bindings as never,
  })
  const snapshot = await composeRemoteSurfaceCatalog({
    source,
    listHumanSkills: async () => undefined,
    sessionId: 'session-a',
    signal: new AbortController().signal,
  })
  assert.deepEqual(snapshot.commands.map(command => command.name), ['fresh-host'],
    'the successful commands provider still commits its own field')
  assert.deepEqual(snapshot.skills, [],
    'the unavailable skills observation contributes NO fresh rows of its own')
  assert.equal(snapshot.issues.length, 1)
  assert.equal(snapshot.issues[0]?.provider, 'skills',
    'the unavailable observation degrades to a skills issue (never a silent empty success)')
})

test('PR4 F2b.2 (review round 4): the coordinator keeps the LAST-GOOD skills across a fulfilled-undefined observation; a genuinely empty complete catalog still clears', async () => {
  let skillsState: 'good' | 'unreachable' | 'empty-complete' = 'good'
  const generation = generationSource({ id: 1 } as RemoteConnectionGeneration)
  const bindings = bindingsSource({ session: {} })
  const source = createRemoteCommandSource({
    authority: {
      commands: { list: async () => ({ ok: true, value: [{ name: 'host-cmd', description: 'h' }] }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    },
    generation,
    bindings: bindings as never,
  })
  const diag = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} }
  const coordinator = new CatalogRefreshCoordinator({
    readAgent: async () => composeRemoteSurfaceCatalog({
      source,
      listHumanSkills: async () => {
        if (skillsState === 'unreachable') return undefined
        return {
          skills: skillsState === 'empty-complete' ? [] : [{ name: 'installed-skill', description: 's' }],
          complete: true,
        } as never
      },
      sessionId: 'session-a',
      signal: new AbortController().signal,
    }),
    readStanding: async () => { throw new Error('unused') },
    installSnapshot: () => {},
    enterCatalogTransition: () => {},
  }, new AbortController().signal, diag as never)

  const first = await coordinator.refresh({ source: 'live-session', target: { kind: 'agent', key: 1 }, agent: {} as never })
  assert.equal(first.kind, 'applied')
  // A same-target registry blip (fulfilled undefined): the installed skills
  // must SURVIVE (the issue routes the field to mergePartial's last-good).
  skillsState = 'unreachable'
  const second = await coordinator.refresh({ source: 'reload', target: { kind: 'agent', key: 1 }, agent: {} as never })
  assert.equal(second.kind, 'applied')
  if (second.kind === 'applied') {
    assert.deepEqual(second.snapshot.skills.map(skill => skill.name), ['installed-skill'],
      'an unreachable registry keeps the last-good skills (never an erasing empty success)')
  }
  // A genuinely EMPTY-but-complete observation is a real catalog fact: it
  // must still CLEAR the field (the fix must not smuggle staleness back).
  skillsState = 'empty-complete'
  const third = await coordinator.refresh({ source: 'reload', target: { kind: 'agent', key: 1 }, agent: {} as never })
  assert.equal(third.kind, 'applied')
  if (third.kind === 'applied') {
    assert.deepEqual(third.snapshot.skills, [],
      'a complete empty catalog legitimately clears the installed skills')
  }
})
