/**
 * Tests for the subagent model-selection allowlist picker
 * (subagent-model-menu.ts): the official-setting write-through, the
 * marker bookkeeping, and the official "enabled requires at least one
 * route" client-side guard.
 * @module @xmoon76/dsh-pi-tui/subagent-model-menu.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SubagentModelAllowlistSubmenu,
  allowlistSummary,
  lastRouteWhileEnabled,
  type AllowlistSubmenuDeps,
} from '../src/subagent-model-menu.ts'
import type { SubagentAllowedModelRoute, SubagentModelSelectionConfig } from '../src/runtime/config-port.ts'
import type { OwnedTaskOptions } from '../src/detached.ts'

function selectionStore(initial: { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }): {
  config: SubagentModelSelectionConfig
  writes: Array<{ enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }>
  /** Every set() call's settlement promise (deterministic awaits). */
  setPromises: Promise<void>[]
  failNext: () => void
} {
  let state = initial
  let fail = false
  const writes: Array<{ enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }> = []
  const setPromises: Promise<void>[] = []
  return {
    config: {
      available: () => true,
      get: () => ({ enabled: state.enabled, allowedModels: state.allowedModels }),
      set: async value => {
        const attempt = (async () => {
          if (fail) {
            fail = false
            throw new Error('official validation rejected the section')
          }
          writes.push({ ...value, allowedModels: [...value.allowedModels] })
          state = { enabled: value.enabled, allowedModels: [...value.allowedModels] }
        })()
        setPromises.push(attempt)
        await attempt
      },
    },
    writes,
    setPromises,
    failNext: () => { fail = true },
  }
}

interface DepsRig {
  deps: AllowlistSubmenuDeps
  store: ReturnType<typeof selectionStore>
  notices: Array<{ message: string; kind: 'info' | 'error' }>
  renders: number
  dones: Array<string | undefined>
  /** Every owned task's settlement promise — tests await these instead of
   * fixed timers (the repo's timing rule). */
  settled: Promise<void>[]
}

function rig(initial: { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }, models: readonly string[] = ['m1', 'm2']): DepsRig {
  const store = selectionStore(initial)
  const notices: DepsRig['notices'] = []
  const dones: DepsRig['dones'] = []
  const settled: Promise<void>[] = []
  let renders = 0
  const deps: AllowlistSubmenuDeps = {
    selection: store.config,
    catalog: {
      listProviders: () => [{ id: 'p', name: 'Provider P' }],
      listModels: async () => models.map(id => ({ id })),
    },
    notify: (message: string, kind: 'info' | 'error') => { notices.push({ message, kind }) },
    requestRender: () => { renders += 1 },
    done: (selected?: string) => { dones.push(selected) },
    runOwned: <T,>(_label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
      settled.push((async () => {
        try {
          options.onResult?.(await task())
        } catch (error) {
          options.onError?.(error as Error)
        }
      })())
    },
  }
  return { deps, store, notices, renders, dones, settled }
}

/** Flush the submenu's serialized write chain and await every section
 * write started so far. The chain advances one microtask per link, so a
 * bounded microtask flush (never a fixed timer) lets each queued write
 * reach the store; `allSettled` keeps a deliberately-rejected write from
 * failing the flush itself. */
async function settle(harness: DepsRig, expectedWrites: number): Promise<void> {
  for (let i = 0; i < 16 && harness.store.setPromises.length < expectedWrites; i += 1) {
    await Promise.resolve()
  }
  await Promise.allSettled([...harness.settled, ...harness.store.setPromises])
}

const ENTER = '\r'

test('allowlistSummary and lastRouteWhileEnabled are pure', () => {
  assert.equal(allowlistSummary([]), '0 routes')
  assert.equal(allowlistSummary([{ provider: 'p', model: 'm' }]), '1 route')
  assert.equal(allowlistSummary([{ provider: 'p', model: 'm' }, { provider: 'q', model: 'n' }]), '2 routes')
  const only: readonly SubagentAllowedModelRoute[] = [{ provider: 'p', model: 'm' }]
  assert.equal(lastRouteWhileEnabled(true, only, { provider: 'p', model: 'm' }), true)
  assert.equal(lastRouteWhileEnabled(false, only, { provider: 'p', model: 'm' }), false)
  assert.equal(lastRouteWhileEnabled(true, [...only, { provider: 'q', model: 'n' }], { provider: 'p', model: 'm' }), false)
})

test('toggling a model writes the WHOLE official section and re-derives the outer summary on close', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistSubmenu(harness.deps)
  menu.render(60)
  // Provider row Enter → the models load asynchronously.
  menu.handleInput(ENTER)
  await settle(harness, 0)
  // Toggle m1 on.
  menu.handleInput(ENTER)
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes, [
    { enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }] },
  ], 'the whole official section rides every write')
  // Esc from the model list returns to the provider list; Esc again closes.
  menu.handleInput('\x1b')
  menu.handleInput('\x1b')
  assert.deepEqual(harness.dones.at(-1), '1 route', 'the close reports the fresh summary for the outer row')
})

test('removing the LAST route while enabled is refused with the official rule', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }] })
  const menu = new SubagentModelAllowlistSubmenu(harness.deps)
  menu.render(60)
  menu.handleInput(ENTER)
  await settle(harness, 0)
  // The cursor starts on m1 (the only, allowed route): Enter tries to REMOVE it.
  menu.handleInput(ENTER)
  await settle(harness, 0)
  assert.deepEqual(harness.store.writes, [], 'the refused toggle never writes')
  assert.equal(harness.notices.at(-1)?.kind, 'error')
  assert.match(harness.notices.at(-1)?.message ?? '', /disable subagent model selection before removing the last route/u)
})

test('a REJECTED official write rolls the working copy back to the committed section', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistSubmenu(harness.deps)
  menu.render(60)
  menu.handleInput(ENTER)
  await settle(harness, 1)
  harness.store.failNext()
  menu.handleInput(ENTER)
  await settle(harness, 2)
  assert.equal(harness.notices.at(-1)?.kind, 'error')
  assert.match(harness.notices.at(-1)?.message ?? '', /allowlist write failed/u)
  assert.deepEqual(harness.store.config.get().allowedModels, [], 'the section stays at its committed state')
})

test('overlapping toggles serialize: a failed earlier write never corrupts a later commit or the markers', async () => {
  // The review's concurrent-toggle race: two toggles in flight, the FIRST
  // write rejected. Writes are serialized (the second commits its captured
  // payload), and every settle re-derives ALL visible markers from the
  // committed section — a stale row can never survive a rollback.
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistSubmenu(harness.deps)
  menu.render(60)
  menu.handleInput(ENTER) // open the provider's models
  await settle(harness, 0)
  harness.store.failNext()
  menu.handleInput(ENTER) // toggle m1 ON — this write is REJECTED
  menu.handleInput('\x1b[B') // move to m2
  menu.handleInput(ENTER) // toggle m2 ON — commits after the failure
  await settle(harness, 2)
  assert.equal(harness.notices.at(-1)?.kind, 'error', 'the rejected write surfaces a notice')
  assert.match(harness.notices.at(-1)?.message ?? '', /allowlist write failed/u)
  // The second write's captured payload commits; the final section and the
  // visible markers agree (both rows show the allowed marker).
  assert.deepEqual(harness.store.config.get().allowedModels, [
    { provider: 'p', model: 'm1' },
    { provider: 'p', model: 'm2' },
  ])
  const view = menu.render(60).join('\n')
  assert.ok(view.includes('← allowed'), `the model list must show the allowed markers:\n${view}`)
  // A further toggle builds on the SYNCED state (the working copy was
  // re-derived from the committed section after the failure).
  menu.handleInput('\x1b[B') // move to m3? no — only m1/m2 exist; wrap to m1
  menu.handleInput(ENTER) // toggle m1 OFF
  await settle(harness, 3)
  assert.deepEqual(harness.store.config.get().allowedModels, [{ provider: 'p', model: 'm2' }])
})

test('a write settling AFTER the submenu closed converges the outer row and stays silent', async () => {
  // The review's close-mid-write scenario: the user toggles a route, Esc
  // closes the submenu (the outer row shows the OPTIMISTIC count), and the
  // write then FAILS. The committed summary must still reach the outer row
  // (the fork's done() updates it without re-opening), and the late
  // failure must not toast a panel the user already left.
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistSubmenu(harness.deps)
  menu.render(60)
  menu.handleInput(ENTER) // open the provider's models
  await settle(harness, 0)
  harness.store.failNext()
  menu.handleInput(ENTER) // toggle m1 ON — this write will FAIL
  menu.handleInput('\x1b') // Esc: model list -> provider list
  menu.handleInput('\x1b') // Esc: provider list -> CLOSE (optimistic '1 route')
  assert.deepEqual(harness.dones.at(-1), '1 route', 'the close reports the optimistic summary')
  await settle(harness, 1) // the failed write settles AFTER the close
  assert.deepEqual(harness.dones.at(-1), '0 routes',
    'the outer row converges to the COMMITTED summary after the late failure')
  assert.equal(harness.notices.length, 0, 'a failure settling after close stays silent')
})
