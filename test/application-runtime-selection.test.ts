/**
 * M3-4 PR1 — application runtime selection tests (plan §10.2).
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
 * TWO lanes:
 * - UNIT (counting doubles): the seam's branching and instance identity —
 *   the Remote lane injects a test loader through the seam's loader seam.
 * - REAL CHAIN (the production fixture): `selectApplicationRuntime` loads
 *   `runtime/backend-loader.ts` and constructs the REAL Remote aggregate —
 *   the canonical `seam -> backend-loader -> createRemoteApplicationRuntime`
 *   path the plan freezes, exercised end-to-end over a real Host Context
 *   (the fixture shape of test/remote-application-runtime.test.ts).
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - unit lane: the Direct factory and the Remote loader are counting
 *   doubles; no Host Context is composed.
 * - real-chain lane: the prompt serializer (PR1 does not own production
 *   submission serialization), plus the shared fixture's minimal readiness
 *   inputs (`StubLlmAdapter` smoke route, hand-provided agentDefaultModel /
 *   attachments / webServer — the proven M3-1 L5 shape, none on the composed
 *   Client/Host graph under test); the official Client/Gateway path and the
 *   M3 additive Host composition are real.
 *
 * DELIBERATELY ABSENT
 * - any mounted TUI main surface / secondary surfaces.
 *
 * @module @xmoon76/dsh-pi-tui/application-runtime-selection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  selectApplicationRuntime,
  __setApplicationRuntimeLoaderForTests,
} from '../src/app/bootstrap.ts'
import type { ApplicationRuntimeSelection } from '../src/app/application-runtime.ts'
import {
  createRemoteApplicationHostFixture,
  testLifecycle,
  testPromptSerializer,
} from './support/remote-application-fixture.ts'

// ---------------------------------------------------------------------------
// Unit lane — counting doubles
// ---------------------------------------------------------------------------

/** A counting Direct factory double. */
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

test('Direct selection: the Remote loader is never invoked and the exact Direct instances are carried', async () => {
  const direct = directFactoryDouble()
  let remoteLoads = 0
  const restore = __setApplicationRuntimeLoaderForTests(async () => {
    remoteLoads += 1
    return { createRemoteApplicationRuntime: (() => Promise.reject(new Error('must not run'))) as never }
  })
  try {
    const selected = await selectApplicationRuntime({
      kind: 'direct',
      createDirect: direct.createDirect,
      remote: { hostContext: {}, waitForHostPrerequisites: async () => {}, promptSerializer: {} },
    })
    assert.equal(remoteLoads, 0, 'a Direct selection must not even load the Remote module')
    assert.equal(direct.constructionCount(), 1, 'the Direct factory ran exactly once')
    assert.equal(selected.kind, 'direct')
    assert.equal(selected.backend, direct.parts.backend, 'the exact Direct backend instance')
    assert.equal(selected.owners, direct.parts.owners, 'the exact Direct owner provider instance')
    assert.equal(selected.retirement, direct.parts.retirement, 'the exact Direct retirement instance')
    await assert.doesNotReject(selected.disposeTransport())
    await assert.doesNotReject(selected.disposeTransport())
  } finally {
    restore()
  }
})

test('Remote selection: the loader is invoked exactly once, the Direct factory is NEVER invoked, and the ONE aggregate core is returned', async () => {
  const direct = directFactoryDouble()
  let remoteLoads = 0
  const remoteSelected: import('../src/app/application-runtime.ts').SelectedApplicationRuntime = {
    kind: 'remote',
    backend: { kind: 'remote' } as never,
    owners: {} as never,
    retirement: {} as never,
    disposeTransport: async () => {},
  }
  const restore = __setApplicationRuntimeLoaderForTests(async () => {
    remoteLoads += 1
    return {
      createRemoteApplicationRuntime: (async (options: { promptSerializer: unknown }) => {
        assert.equal(options.promptSerializer, PROMPT_STANDIN, 'the composition input crosses to the aggregate untouched')
        return { selected: remoteSelected }
      }) as never,
    }
  })
  const PROMPT_STANDIN = { preflight: () => ({ kind: 'unsupported', reason: 'unit' }) }
  try {
    const selected = await selectApplicationRuntime({
      kind: 'remote',
      createDirect: direct.createDirect,
      remote: { hostContext: {}, waitForHostPrerequisites: async () => {}, promptSerializer: PROMPT_STANDIN },
    })
    assert.equal(remoteLoads, 1, 'the Remote aggregate is constructed exactly once')
    assert.equal(direct.constructionCount(), 0,
      'a Remote selection must not invoke the Direct factory (plan §10.2: no Direct graph constructed)')
    assert.equal(selected, remoteSelected, 'the selected core IS the aggregate\'s selected core — no second graph')
    assert.equal(selected.kind, 'remote')
  } finally {
    restore()
  }
})

test('a Direct factory failure propagates (no partial selected core)', async () => {
  await assert.rejects(
    selectApplicationRuntime({
      kind: 'direct',
      createDirect: () => { throw new Error('induced direct construction failure') },
      remote: undefined,
    }),
    /induced direct construction failure/,
  )
})

test('Remote selection without the composition input fails closed (and still invokes no Direct factory)', async () => {
  const direct = directFactoryDouble()
  await assert.rejects(
    selectApplicationRuntime({ kind: 'remote', createDirect: direct.createDirect, remote: undefined }),
    /requires the Remote composition input/,
    'the Remote branch must never fall back to constructing the Remote graph itself',
  )
  assert.equal(direct.constructionCount(), 0, 'failing closed must not construct a Direct graph either')
})

test('the Remote selection propagates a loader/aggregate failure (no partial selected core, no Direct fallback)', async () => {
  const direct = directFactoryDouble()
  const restore = __setApplicationRuntimeLoaderForTests(async () => ({
    createRemoteApplicationRuntime: (() => Promise.reject(new Error('induced remote construction failure'))) as never,
  }))
  try {
    await assert.rejects(
      selectApplicationRuntime({
        kind: 'remote',
        createDirect: direct.createDirect,
        remote: { hostContext: {}, waitForHostPrerequisites: async () => {}, promptSerializer: {} },
      }),
      /induced remote construction failure/,
    )
    assert.equal(direct.constructionCount(), 0, 'a Remote failure must not fall back to constructing Direct')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Source locks — the seam owns the loader path; production stays Direct
// ---------------------------------------------------------------------------

test('the production bootstrap calls the seam with the Direct branch only (no user-visible selector)', async () => {
  const bootstrapSource = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const seamCall = bootstrapSource.match(/const selectedRuntime = await selectApplicationRuntime\(\{[\s\S]*?\}\)/)
  assert.ok(seamCall !== null, 'the bootstrap must construct its selected runtime through the seam')
  assert.ok(seamCall[0].includes("kind: 'direct'"), 'the production bootstrap selects Direct')
  assert.ok(seamCall[0].includes('remote: undefined'), 'the production bootstrap passes no Remote composition input')
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

test('the seam reaches the Remote aggregate ONLY through the backend-loader boundary (source-locked)', async () => {
  const bootstrapSource = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  assert.ok(bootstrapSource.includes("import { loadRemoteApplicationRuntime } from '../runtime/backend-loader.ts'"),
    'the bootstrap statically imports the loader (the sanctioned bootstrap -> backend-loader edge)')
  assert.ok(bootstrapSource.includes('await loadRemoteApplicationRuntimeForSelection()'),
    'the seam loads the Remote aggregate through the loader binding (the production binding is the backend-loader boundary)')
  assert.ok(bootstrapSource.includes('let loadRemoteApplicationRuntimeForSelection = loadRemoteApplicationRuntime'),
    'the production loader binding IS the backend-loader boundary function (no product re-binding)')
  assert.ok(!/from '\.\.\/app\/remote\//.test(bootstrapSource) && !/from '\.\.\/runtime\/remote\//.test(bootstrapSource),
    'the bootstrap holds no static Remote composition edge of its own')
  const loaderSource = readFileSync(new URL('../src/runtime/backend-loader.ts', import.meta.url), 'utf8')
  assert.ok(loaderSource.includes("import('../app/remote/runtime.ts')"),
    'the loader owns the ONE dynamic edge into the entry module')
  assert.ok(!loaderSource.includes("import('../app/remote/application-runtime.ts')"),
    'the loader must NOT carry a second dynamic target (ONE edge, frozen contract)')
  const entrySource = readFileSync(new URL('../src/app/remote/runtime.ts', import.meta.url), 'utf8')
  assert.ok(/export\s*\{[^}]*createRemoteApplicationRuntime[^}]*\}\s*from\s*'\.\/application-runtime\.ts'/.test(entrySource),
    'the entry module statically re-exports the aggregate constructor (the single-entry join)')
})

// ---------------------------------------------------------------------------
// Real chain — seam -> backend-loader -> REAL aggregate over a real Host
// ---------------------------------------------------------------------------

test('REAL CHAIN: selectApplicationRuntime -> backend-loader -> the real Remote aggregate over a real Host', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'm3-4-pr1-preset')
  host.ctx.sessions.create(SessionId('m3-4-pr1-selection-seed'), { meta: { cwd: host.anchorDir } })
  let prerequisites = 0
  // The production seam, the production loader, the production aggregate —
  // only the prompt serializer is the test stand-in (the manifest's single
  // substitution), plus the counting Direct factory proving no Direct graph.
  const direct = directFactoryDouble()
  const selected = await selectApplicationRuntime({
    kind: 'remote',
    createDirect: direct.createDirect,
    remote: {
      hostContext: host.ctx,
      waitForHostPrerequisites: async () => { prerequisites += 1 },
      promptSerializer: testPromptSerializer,
    },
  })
  try {
    assert.equal(direct.constructionCount(), 0, 'the real Remote selection constructed no Direct graph')
    assert.equal(prerequisites, 1, 'the composition waited on the Host prerequisite barrier')
    assert.equal(selected.kind, 'remote')
    assert.equal(selected.backend.kind, 'remote', 'the REAL aggregate backend came through the chain')
    assert.notEqual(host.ctx.reflect.get('connection'), undefined, 'the M3 additive Host rows mounted')
    await selected.disposeTransport()
    assert.equal(host.ctx.reflect.get('connection'), undefined, 'the M3 rows unwind with the transport disposal')
  } finally {
    await host.dispose()
  }
})
