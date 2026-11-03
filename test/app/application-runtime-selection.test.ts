/**
 * The application runtime-selection seam contract.
 *
 * The seam adopts the ONE application runtime core:
 *
 * ```text
 * preselected (the internal split Client's FULLY ASSEMBLED Remote core)
 *   -> adopted by IDENTITY, no construction of any kind
 * kind: 'direct'
 *   -> the supplied Direct factory runs exactly once
 * any other kind without a preselected core
 *   -> FAIL CLOSED (the retired M3 in-process aggregate is test-only)
 * ```
 *
 * The retired M3 wire composer is no longer reachable from `src/**`; the
 * negative source locks below are what keep it that way.
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - the Direct factory is a counting double; no Host Context is composed.
 *
 * DELIBERATELY ABSENT
 * - any mounted TUI main surface, any Host Context, and any Remote wire.
 *
 * @module @xmoon76/dsh-pi-tui/application-runtime-selection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  selectApplicationRuntime,
} from '../../src/app/bootstrap/runtime-selection.ts'
import type { ApplicationRuntimeSelection } from '../../src/app/application-runtime.ts'

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

test('Direct selection: the exact Direct instances are carried and the factory ran once', async () => {
  const direct = directFactoryDouble()
  const selected = await selectApplicationRuntime({
    kind: 'direct',
    createDirect: direct.createDirect,
  })
  assert.equal(direct.constructionCount(), 1, 'the Direct factory ran exactly once')
  assert.equal(selected.kind, 'direct')
  assert.equal(selected.backend, direct.parts.backend, 'the exact Direct backend instance')
  assert.equal(selected.owners, direct.parts.owners, 'the exact Direct owner provider instance')
  assert.equal(selected.retirement, direct.parts.retirement, 'the exact Direct retirement instance')
  await assert.doesNotReject(selected.disposeTransport())
  await assert.doesNotReject(selected.disposeTransport())
})

test('a preselected core is adopted by IDENTITY and the Direct factory is NEVER invoked', async () => {
  const direct = directFactoryDouble()
  const preselected: import('../../src/app/application-runtime.ts').SelectedApplicationRuntime = {
    kind: 'remote',
    backend: { kind: 'remote' } as never,
    owners: {} as never,
    retirement: {} as never,
    disposeTransport: async () => {},
  }
  const selected = await selectApplicationRuntime({
    kind: 'direct',
    createDirect: direct.createDirect,
    preselected,
  })
  assert.equal(direct.constructionCount(), 0,
    'adopting the split Client core must construct no Direct graph')
  assert.equal(selected, preselected, 'the selected core IS the caller\'s core — no copy, no second graph')
  assert.equal(selected.kind, 'remote')
})

test('a Direct factory failure propagates (no partial selected core)', async () => {
  await assert.rejects(
    selectApplicationRuntime({
      kind: 'direct',
      createDirect: () => { throw new Error('induced direct construction failure') },
    }),
    /induced direct construction failure/,
  )
})

test('a Remote kind WITHOUT a preselected core fails closed and constructs nothing', async () => {
  const direct = directFactoryDouble()
  await assert.rejects(
    selectApplicationRuntime({ kind: 'remote', createDirect: direct.createDirect }),
    /no pre-assembled Remote application runtime/,
    'the seam must never build the retired in-process aggregate',
  )
  assert.equal(direct.constructionCount(), 0, 'failing closed must not construct a Direct graph either')
})

// ---------------------------------------------------------------------------
// Source locks — the seam owns the loader path; production stays Direct
// ---------------------------------------------------------------------------

test('the production bootstrap calls the seam with the Direct branch only (no user-visible selector)', async () => {
  const bootstrapSource = readFileSync(new URL('../../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const seamCall = bootstrapSource.match(/const selectedRuntime = await selectApplicationRuntime\(\{[\s\S]*?\}\)/)
  assert.ok(seamCall !== null, 'the bootstrap must construct its selected runtime through the seam')
  assert.ok(seamCall[0].includes("kind: 'direct'"), 'the production bootstrap selects Direct')
  assert.ok(!seamCall[0].includes('remote:'),
    'the production bootstrap passes no Remote composition input any more (the field is gone)')
  assert.ok(seamCall[0].includes('preselected: override.selected'),
    'the internal split Client\'s pre-assembled core is the ONE Remote-shaped input')
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

test('the production src graph can no longer reach the retired M3 in-process composition (source-locked)', async () => {
  const selectionSource = readFileSync(new URL('../../src/app/bootstrap/runtime-selection.ts', import.meta.url), 'utf8')
  // The seam holds no Remote composition edge at all: no loader, no aggregate.
  assert.ok(!selectionSource.includes('backend-loader'),
    'the seam must not import a Remote loader')
  assert.equal(/\bcreateRemoteApplicationRuntime\b(?!FromClient)/u.test(selectionSource), false,
    'the seam must not construct the retired Remote aggregate')
  assert.ok(!/from '\.\.\/app\/remote\//.test(selectionSource) && !/from '\.\.\/runtime\/remote\//.test(selectionSource),
    'the selection seam holds no static Remote composition edge of its own')
  // The retired modules' ABSENCE is asserted by the architecture gate's own
  // real-tree scan (`test/architecture/application-architecture-gate.test.mjs`),
  // which lists the scanned tree instead of reading a file that must not exist.
  const entrySource = readFileSync(new URL('../../src/app/remote/runtime.ts', import.meta.url), 'utf8')
  assert.ok(!entrySource.includes('createRemoteApplicationRuntime'),
    'the production Remote runtime module must not re-export the retired aggregate')
  assert.ok(!entrySource.includes('createExperimentalRemoteRuntime'),
    'the production Remote runtime module must not carry the retired in-process composer')
  // The test-only carrier declares its own boundary.
  const carrier = readFileSync(new URL('../support/m3-inprocess/host-runtime.ts', import.meta.url), 'utf8')
  assert.match(carrier, /TEST_ONLY_M3_CARRIER/u,
    'the legacy carrier must declare itself test-only')
})

test('Remote-selected Task composition resolves no Host ctx.jobs / ctx.subagents (source-locked, PR6)', async () => {
  const bootstrapSource = readFileSync(new URL('../../src/app/bootstrap.ts', import.meta.url), 'utf8')
  // The Task Center Host-service lookups are Direct-only: each must be gated on
  // the ABSENCE of the Remote composition input. A restored unconditional
  // `const subagents = ctx.get('subagents')` (or `jobs`) makes the Remote
  // composition root resolve a Host service it must never touch, even though
  // the Remote branch consumes neither value.
  assert.match(
    bootstrapSource,
    /const jobs = remoteSources === undefined \? ctx\.get\('jobs'\) : undefined/,
    'Remote-selected Task composition must not resolve Host ctx.jobs',
  )
  assert.match(
    bootstrapSource,
    /const subagents = remoteSources === undefined \? ctx\.get\('subagents'\) : undefined/,
    'Remote-selected Task composition must not resolve Host ctx.subagents',
  )
})

test('the extension service selection is branch-exclusive with NO Host fallback on Remote (source-locked, M3-6 PR1)', async () => {
  const bootstrapSource = readFileSync(new URL('../../src/app/bootstrap.ts', import.meta.url), 'utf8')
  // The exact D5 branch contract: `override === undefined` is the ONE
  // discriminator — Direct reads the Host/profile service, Remote consumes
  // `override.extensionService`.
  assert.match(
    bootstrapSource,
    /extensionService = override === undefined\n      \? ctx\.get\(PI_TUI_EXTENSIONS_SERVICE\) as typeof extensionService\n      : override\.extensionService as typeof extensionService/,
    'bootstrap must select the extension service by the override branch exactly',
  )
  // The extension selection span (from the assignment to the attach call)
  // must not contain any `??`-fallback that would reintroduce Host
  // extension authority on the Remote branch.
  const assignment = bootstrapSource.indexOf('extensionService = override === undefined')
  const attach = bootstrapSource.indexOf('surface.attachExtensionHost(extensionService)', assignment)
  assert.ok(assignment >= 0 && attach > assignment, 'the extension selection span must exist')
  const span = bootstrapSource.slice(assignment, attach)
  assert.ok(!span.includes('?? ctx.get(PI_TUI_EXTENSIONS_SERVICE)'),
    'the Remote branch must never fall back to the Host piTuiExtensions lookup')
  assert.ok(!span.includes('ctx.get(PI_TUI_EXTENSIONS_SERVICE) ??'),
    'the Host lookup must never fall back to the override either (one exclusive discriminator)')
  // `ctx.get(PI_TUI_EXTENSIONS_SERVICE)` appears exactly once in the whole
  // bootstrap: the Direct branch of this assignment.
  const lookups = [...bootstrapSource.matchAll(/ctx\.get\(PI_TUI_EXTENSIONS_SERVICE\)/g)]
  assert.equal(lookups.length, 1,
    'bootstrap resolves Host piTuiExtensions exactly once (the Direct branch); no other read exists')
})
