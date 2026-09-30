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
 * - the Direct factory and the Remote loader callback are doubles (counting
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
import type { ApplicationRuntimeSelection, SelectedApplicationRuntime } from '../src/app/application-runtime.ts'

/** A counting Direct factory double: proves whether the seam invoked the
 *  Direct construction at all, and hands out identity probes for the exact
 *  backend/owners/retirement the selected core must carry. */
function directFactoryDouble() {
  let constructions = 0
  const parts = {
    backend: { kind: 'direct', sessionLifecycle: {} },
    owners: { fromHandle: () => undefined },
    retirement: { retire: async () => ({ failures: [], durabilityFailure: undefined }) },
  }
  const createDirect: ApplicationRuntimeSelection['createDirect'] = () => {
    constructions += 1
    return parts as never
  }
  return { createDirect, parts, constructionCount: () => constructions }
}

/** A counting Remote loader double. */
function remoteLoaderDouble(selected: SelectedApplicationRuntime) {
  let loads = 0
  const createRemote = () => {
    loads += 1
    return Promise.resolve(selected)
  }
  return { createRemote, loadCount: () => loads }
}

test('Direct selection: the Remote loader is never invoked and the exact Direct instances are carried', async () => {
  const direct = directFactoryDouble()
  const remote = remoteLoaderDouble({ kind: 'remote' } as never)
  const selected = await selectApplicationRuntime({ kind: 'direct', createDirect: direct.createDirect, createRemote: remote.createRemote })
  assert.equal(remote.loadCount(), 0, 'a Direct selection must not even load the Remote module')
  assert.equal(direct.constructionCount(), 1, 'the Direct factory ran exactly once')
  assert.equal(selected.kind, 'direct')
  assert.equal(selected.backend, direct.parts.backend, 'the exact Direct backend instance')
  assert.equal(selected.owners, direct.parts.owners, 'the exact Direct owner provider instance')
  assert.equal(selected.retirement, direct.parts.retirement, 'the exact Direct retirement instance')
  // The no-op transport disposer settles without effect and is idempotent.
  await assert.doesNotReject(selected.disposeTransport())
  await assert.doesNotReject(selected.disposeTransport())
})

test('Remote selection: the loader is invoked exactly once, the Direct factory is NEVER invoked, and the ONE application runtime is returned', async () => {
  const direct = directFactoryDouble()
  const remoteSelected: SelectedApplicationRuntime = {
    kind: 'remote',
    backend: { kind: 'remote' } as never,
    owners: {} as never,
    retirement: {} as never,
    disposeTransport: async () => {},
  }
  const remote = remoteLoaderDouble(remoteSelected)
  const selected = await selectApplicationRuntime({
    kind: 'remote',
    createDirect: direct.createDirect,
    createRemote: remote.createRemote,
  })
  assert.equal(remote.loadCount(), 1, 'the Remote aggregate is constructed exactly once')
  assert.equal(direct.constructionCount(), 0,
    'a Remote selection must not invoke the Direct factory (plan §10.2: no Direct graph constructed)')
  assert.equal(selected, remoteSelected, 'the selected core IS the aggregate the loader returned — no second graph')
  assert.equal(selected.kind, 'remote')
})

test('a Direct factory failure propagates (no partial selected core)', async () => {
  await assert.rejects(
    selectApplicationRuntime({
      kind: 'direct',
      createDirect: () => { throw new Error('induced direct construction failure') },
      createRemote: undefined,
    }),
    /induced direct construction failure/,
  )
})

test('Remote selection without the lazy boundary fails closed (and still invokes no Direct factory)', async () => {
  const direct = directFactoryDouble()
  await assert.rejects(
    selectApplicationRuntime({ kind: 'remote', createDirect: direct.createDirect, createRemote: undefined }),
    /requires the lazy backend-loader boundary/,
    'the Remote branch must never fall back to constructing the Remote graph itself',
  )
  assert.equal(direct.constructionCount(), 0, 'failing closed must not construct a Direct graph either')
})

test('the Remote selection propagates a loader failure (no partial selected core, no Direct fallback)', async () => {
  const direct = directFactoryDouble()
  await assert.rejects(
    selectApplicationRuntime({
      kind: 'remote',
      createDirect: direct.createDirect,
      createRemote: () => Promise.reject(new Error('induced remote construction failure')),
    }),
    /induced remote construction failure/,
  )
  assert.equal(direct.constructionCount(), 0, 'a Remote failure must not fall back to constructing Direct')
})

test('the production bootstrap calls the seam with the Direct branch only (no user-visible selector)', async () => {
  const bootstrapSource = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const seamCall = bootstrapSource.match(/const selectedRuntime = await selectApplicationRuntime\(\{[\s\S]*?\}\)/)
  assert.ok(seamCall !== null, 'the bootstrap must construct its selected runtime through the seam')
  assert.ok(seamCall[0].includes("kind: 'direct'"), 'the production bootstrap selects Direct')
  assert.ok(seamCall[0].includes('createRemote: undefined'), 'the production bootstrap passes no Remote constructor')
  assert.ok(seamCall[0].includes('createDirect: createDirectApplication'),
    'the production seam call supplies the DIRECT FACTORY (the construction runs inside the seam)')
  // The Direct construction site itself lives inside that factory — a
  // Remote selection through this seam constructs NO Direct graph (the
  // factory is never invoked on the Remote branch).
  const factoryStart = bootstrapSource.indexOf('const createDirectApplication = (): DirectApplicationRuntime => {')
  const factorySpan = bootstrapSource.slice(factoryStart, bootstrapSource.indexOf('const selectedRuntime = await selectApplicationRuntime({'))
  assert.ok(factoryStart >= 0 && factorySpan.includes('createDirectApplicationRuntime({'),
    'the one Direct construction site must live inside the Direct factory passed to the seam')
  assert.equal(bootstrapSource.indexOf('createDirectApplicationRuntime({'), bootstrapSource.lastIndexOf('createDirectApplicationRuntime({'),
    'exactly one createDirectApplicationRuntime call site exists in the bootstrap')
  // No public/config/env Remote selector exists: the only Remote
  // construction reachability is the lazy boundary function in backend-loader.
  assert.ok(!/DSH_PI_TUI_BACKEND|PI_TUI_REMOTE|--remote/.test(bootstrapSource),
    'the bootstrap must not read any backend env/flag')
})
