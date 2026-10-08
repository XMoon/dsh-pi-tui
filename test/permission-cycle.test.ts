/**
 * M3-4 PR4 Step 6 permission qualification (supporting mapper/owner unit; no
 * L1–L6 level — the REAL Remote runner composition lives in the separate
 * `test/runner-remote-permission.test.ts`):
 *
 * The projection mapper:
 * - the permissions projection view ({currentValue}) maps onto the status
 *   DTO's permission field (well-formed only; foreign shapes read absent).
 *
 * The cycle owner (over a status-runtime double):
 * - cyclePermission over the PR4 authority: projection current → catalog
 *   next → exactly ONE semantic apply; applied does NOT install the value
 *   locally; a stale scope after the await repaints/notifies NOTHING for
 *   the replacement; unavailable surfaces truthfully; a rejected apply
 *   reports without retrying; the Remote branch NEVER calls a Host
 *   permissionPresets.set (negative lock).
 *
 * @module @xmoon76/dsh-pi-tui/permission-cycle.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { detachedSessionStatus } from '../src/runtime/session-status-projection.ts'
import { createStatusRuntime, type StatusRuntimeDeps } from '../src/app/surface/status-runtime.ts'

/* ──────────────────────── the projection mapper ──────────────────────── */

test('§6.1 the permissions projection view maps onto the status DTO', () => {
  const status = detachedSessionStatus('s', {
    permissions: { currentValue: 'workspace-write' },
  }, undefined)
  assert.equal(status.permission, 'workspace-write')
})

test('§6.1 a foreign/absent permissions view reads absent (never guessed)', () => {
  assert.equal(detachedSessionStatus('s', {}, undefined).permission, undefined)
  assert.equal(detachedSessionStatus('s', { permissions: null }, undefined).permission, undefined)
  assert.equal(detachedSessionStatus('s', { permissions: { currentValue: '' } }, undefined).permission, undefined)
  assert.equal(detachedSessionStatus('s', { permissions: { currentValue: 42 } }, undefined).permission, undefined)
})

/* ──────────────────── the cycle owner (§6.3) ─────────────────────────── */

/** A minimal surface double recording notifies. */
function harness(options: {
  readonly current?: string
  readonly names?: readonly string[]
  readonly outcome?: { kind: 'applied' } | { kind: 'unavailable'; cause: 'commands' | 'permission' } | { kind: 'indeterminate'; reason: string } | { kind: 'throw'; error: Error }
  readonly staleAfterApply?: boolean
  /** The transport token flips stale during the apply await (scope stays
   *  current — a same-id binding rollover WITHOUT a TUI owner commit). */
  readonly transportStaleAfterApply?: boolean
}) {
  const applied: Array<{ sessionId: string; presetId: string }> = []
  const notices: Array<{ message: string; kind: 'info' | 'error' }> = []
  let scopeCurrent = true
  let transportCurrent = true
  const ctx = new Context()
  const deps = {
    // runOwned's mandatory diagnostics channel (the cycle is an OWNED
    // operation since PR4 §6.3).
    diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} },
    surface: {
      app: {
        notify: (message: string, kind: 'info' | 'error') => { notices.push({ message, kind }) },
      },
      status: { snapshot: () => ({}) },
      commitStatus: () => {},
    },
    isCleanedUp: () => false,
    liveAgent: () => undefined,
    generation: () => 1,
    currentSessionId: () => 'session-a',
    measureContext: () => undefined,
    model: {
      selection: () => undefined,
      currentOf: () => undefined,
      defaultSelection: () => undefined,
      marker: () => undefined,
      preset: () => undefined,
    },
    host: () => ({}) as never,
    presentation: { mainStats: () => ({ snapshot: () => ({}) }) as never },
    viewer: { read: () => undefined },
    clientCwd: '/ws',
    permissionCycle: {
      captureLiveScope: () => ({ subject: {}, sessionId: 'session-a', generation: 1 }) as never,
      isScopeCurrent: () => scopeCurrent,
      captureTransportToken: () => ({ token: 'transport-identity' }),
      isTransportTokenCurrent: () => transportCurrent,
      currentPermission: () => options.current,
      presetNames: () => options.names ?? ['read-only', 'workspace-write', 'danger-full-access'],
      apply: async (sessionId: string, presetId: string) => {
        applied.push({ sessionId, presetId })
        if (options.staleAfterApply) scopeCurrent = false
        if (options.transportStaleAfterApply) transportCurrent = false
        const outcome = options.outcome
        if (outcome === undefined) return { kind: 'applied' as const }
        if (outcome.kind === 'throw') throw outcome.error
        return outcome
      },
    },
  } as unknown as StatusRuntimeDeps
  const runtime = createStatusRuntime(deps)
  return {
    runtime,
    applied,
    notices,
    deps,
    ctx,
  }
}

test('§6.3 the cycle computes next from the projection current and dispatches EXACTLY ONE apply', async () => {
  const h = harness({ current: 'read-only' })
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(h.applied, [{ sessionId: 'session-a', presetId: 'workspace-write' }],
    'one semantic apply with the catalog-next preset')
  assert.deepEqual(h.notices.map(notice => notice.message), ['permission: workspace-write'],
    'the notice is the gesture feedback')
})

test('§6.3 applied does NOT install the value locally — no status repaint claims the commit', async () => {
  const h = harness({ current: 'read-only' })
  const commits: unknown[] = []
  ;(h.deps.surface as unknown as { commitStatus: (patch: unknown) => void }).commitStatus = (patch: unknown) => {
    commits.push(patch)
  }
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  // The legacy Direct path repaints; the authority path must NOT have
  // committed an access patch carrying the next preset (the pushed
  // projection owns the repaint).
  const accessCommits = commits.filter(patch =>
    (patch as { access?: { permissionPreset?: { id?: string } } }).access?.permissionPreset?.id === 'workspace-write')
  assert.equal(accessCommits.length, 0,
    'no optimistic committed-preset repaint (§D7 — the projection repaints)')
})

test('§6.3 a stale scope after the await notifies NOTHING (no replacement-session contamination)', async () => {
  const h = harness({ current: 'read-only', staleAfterApply: true })
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.applied.length, 1, 'the write WAS dispatched (may have committed on the old session)')
  assert.deepEqual(h.notices, [], 'a stale owner repaints/notifies nothing for the replacement (§15.6)')
})

test('§6.3/§16 a same-id transport rollover during the apply notifies NOTHING (the scope alone proves nothing)', async () => {
  // The binding was replaced under the SAME session id with no TUI owner
  // commit: the scope stays current, the transport token does not.
  const h = harness({ current: 'read-only', transportStaleAfterApply: true })
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.applied.length, 1, 'the write WAS dispatched (may have committed on the old binding)')
  assert.deepEqual(h.notices, [], 'a stale transport must not notify/repaint the replacement binding (§16)')
})

test('§6.3 an indeterminate outcome reports the unknown settle truthfully (never as failure, never retried)', async () => {
  const h = harness({
    current: 'read-only',
    outcome: { kind: 'indeterminate', reason: 'the permission switch was dispatched but cancelled before its result arrived' },
  })
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.applied.length, 1, 'exactly one dispatch')
  assert.equal(h.notices.length, 1)
  assert.equal(h.notices[0]?.kind, 'error')
  assert.match(h.notices[0]!.message, /unknown/, 'the notice says the RESULT is unknown, not that the switch failed')
  assert.doesNotMatch(h.notices[0]!.message, /unavailable|failed/, 'an indeterminate settle is never masked as unavailable/failed')
})

test('§6.3 an unavailable outcome surfaces truthfully (never a retry)', async () => {
  const h = harness({ current: 'read-only', outcome: { kind: 'unavailable', cause: 'permission' } })
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.applied.length, 1)
  assert.equal(h.notices[0]?.kind, 'error')
  assert.match(h.notices[0]!.message, /unavailable/)
})

test('§6.3 a rejected apply reports the failure without retrying', async () => {
  const h = harness({ current: 'workspace-write', outcome: { kind: 'throw', error: new Error('wire exploded') } })
  h.runtime.cyclePermission()
  // The owned settlement defers through runOwned's promise chain.
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(h.applied.length, 1, 'exactly one dispatch — no automatic retry')
  assert.match(h.notices[0]?.message ?? '', /wire exploded/)
})

test('§6.3 danger-full-access keeps its warning severity', async () => {
  const h = harness({ current: 'workspace-write' })
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(h.applied.map(entry => entry.presetId), ['danger-full-access'])
  assert.equal(h.notices[0]?.kind, 'error')
})

test('§6.3 an unknown projection current cycles from the catalog start (never a guessed index)', async () => {
  const h = harness({ current: 'custom-unknown' })
  h.runtime.cyclePermission()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(h.applied.map(entry => entry.presetId), ['read-only'],
    'an unmatched current cycles to the first catalog option')
})

test('§7.5 negative lock: the authority path never touches the Host permissionPresets service', () => {
  const source = readFileSync(new URL('../src/app/surface/status-runtime.ts', import.meta.url), 'utf8')
  const cycle = source.slice(
    source.indexOf('const cyclePermission = (): void => {'),
    source.indexOf('// PR D2: the explicit, event-driven context measurement path'),
  )
  const authorityBlock = cycle.slice(0, cycle.indexOf('// Direct-only legacy path'))
  assert.equal(authorityBlock.includes('permissionPresets'), false,
    'the authority path reads the projection + ConfigPort, never the Host preset service')
  assert.equal(authorityBlock.includes('.set('), false,
    'the authority path never calls a synchronous preset set')
})
