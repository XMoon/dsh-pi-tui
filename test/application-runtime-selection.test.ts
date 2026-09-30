/**
 * M3-4 PR1 — application runtime selection unit tests (plan §10.2).
 *
 * The selector under test is the ONE internal application runtime-selection
 * seam. It must prove:
 *
 * ```text
 * Direct selection:
 *   remote loader not invoked
 *   selected.kind == direct
 *   backend/owners/retirement are the exact Direct instances
 *
 * Remote selection:
 *   Remote loader invoked once
 *   selected.kind == remote
 *   ONE application runtime returned
 *   no Direct factory invoked
 * ```
 *
 * The Direct application runtime and the Remote aggregate are test doubles
 * here: this suite is about the SELECTION seam's branching and instance
 * identity, not the compositions themselves (those have their own suites —
 * the Direct production path in the bundle tests, the Remote aggregate in
 * test/remote-application-runtime.test.ts). The seam is exercised through
 * the same source-level function the bootstrap calls
 * (`selectApplicationRuntime`), so no user-visible selector exists or is
 * simulated.
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - the Direct runtime and the Remote loader callback are doubles (identity
 *   probes); no Host Context is composed in this suite.
 *
 * DELIBERATELY ABSENT
 * - any real Remote wire/backend/owner composition (see
 *   test/remote-application-runtime.test.ts)
 * - any mounted TUI main surface / secondary surfaces.
 *
 * @module @xmoon76/dsh-pi-tui/application-runtime-selection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { selectApplicationRuntime } from '../src/app/bootstrap.ts'
import type { SelectedApplicationRuntime } from '../src/app/application-runtime.ts'

/** A minimal Direct application runtime double: identity probes for the
 *  backend/owners/retirement the selected core must carry EXACTLY. */
function directDouble() {
  const backend = { kind: 'direct', sessionLifecycle: {} }
  const owners = { fromHandle: () => undefined }
  const retirement = { retire: async () => ({ failures: [], durabilityFailure: undefined }) }
  return { backend, owners, retirement } as never
}

test('Direct selection: the Remote loader is never invoked and the exact Direct instances are carried', async () => {
  const direct = directDouble()
  let remoteLoads = 0
  const selected = await selectApplicationRuntime({
    kind: 'direct',
    direct,
    loadRemote: () => {
      remoteLoads += 1
      return Promise.resolve({ kind: 'remote' } as never)
    },
  })
  assert.equal(remoteLoads, 0, 'a Direct selection must not even load the Remote module')
  assert.equal(selected.kind, 'direct')
  assert.equal(selected.backend, (direct as { backend: object }).backend, 'the exact Direct backend instance')
  assert.equal(selected.owners, (direct as { owners: object }).owners, 'the exact Direct owner provider instance')
  assert.equal(selected.retirement, (direct as { retirement: object }).retirement, 'the exact Direct retirement instance')
  // The no-op transport disposer settles without effect and is idempotent.
  await assert.doesNotReject(selected.disposeTransport())
  await assert.doesNotReject(selected.disposeTransport())
})

test('Remote selection: the loader is invoked exactly once and returns the ONE application runtime', async () => {
  const direct = directDouble()
  let remoteLoads = 0
  const remoteSelected: SelectedApplicationRuntime = {
    kind: 'remote',
    backend: { kind: 'remote' } as never,
    owners: {} as never,
    retirement: {} as never,
    disposeTransport: async () => {},
  }
  const selected = await selectApplicationRuntime({
    kind: 'remote',
    direct,
    loadRemote: () => {
      remoteLoads += 1
      return Promise.resolve(remoteSelected)
    },
  })
  assert.equal(remoteLoads, 1, 'the Remote aggregate is constructed exactly once')
  assert.equal(selected, remoteSelected, 'the selected core IS the aggregate the loader returned — no second graph')
  assert.equal(selected.kind, 'remote')
})

test('Remote selection without the lazy boundary fails closed', async () => {
  await assert.rejects(
    selectApplicationRuntime({ kind: 'remote', direct: directDouble(), loadRemote: undefined }),
    /requires the lazy backend-loader boundary/,
    'the Remote branch must never fall back to constructing the Remote graph itself',
  )
})

test('the Remote selection propagates a loader failure (no partial selected core)', async () => {
  await assert.rejects(
    selectApplicationRuntime({
      kind: 'remote',
      direct: directDouble(),
      loadRemote: () => Promise.reject(new Error('induced remote construction failure')),
    }),
    /induced remote construction failure/,
  )
})

test('the production bootstrap calls the seam with the Direct branch only (no user-visible selector)', async () => {
  const bootstrapSource = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const seamCall = bootstrapSource.match(/const selectedRuntime = await selectApplicationRuntime\(\{[\s\S]*?\}\)/)
  assert.ok(seamCall !== null, 'the bootstrap must construct its selected runtime through the seam')
  assert.ok(seamCall[0].includes("kind: 'direct'"), 'the production bootstrap selects Direct')
  assert.ok(seamCall[0].includes('loadRemote: undefined'), 'the production bootstrap passes no Remote loader')
  // No public/config/env Remote selector exists: the only Remote
  // construction reachability is the lazy boundary function in backend-loader.
  assert.ok(!/DSH_PI_TUI_BACKEND|PI_TUI_REMOTE|--remote/.test(bootstrapSource),
    'the bootstrap must not read any backend env/flag')
})
