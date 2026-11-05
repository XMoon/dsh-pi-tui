/**
 * M5-W PR-B — official Web frontend runtime toggle (L5).
 *
 * Evidence level: L5 composition over the REAL pinned Cordis Loader/Entry
 * (`@deepseek-ai/cordis-plugin-loader@1.0.6`) with lightweight controlled
 * plugins standing in for the 59 official Web packages. The Loader,
 * `Entry.update`, fiber activation/disposal/settlement, the fallback seat
 * semantics and the service registry are the real ones; only the package
 * modules are fixtures. The two-OS-process HTTP/Browser proof is
 * `scripts/split-process-smoke.mjs` `t73-web-runtime-toggle`.
 *
 * The contract pinned here:
 *   - the toggle drives exactly the 59 declared rows, in the frozen
 *     enable/disable order, through `Entry.update({ disabled })`;
 *   - `disabled` / `enabled` / `changing` / `unavailable` are read from the
 *     live Loader and the official Web services, never from the request;
 *   - repeated/concurrent requests never remount a row and never duplicate the
 *     SPA fallback seat;
 *   - a failed enable withdraws what it mounted; a failed disable keeps
 *     closing; an unprovable state is never reported as `disabled`;
 *   - no persistent Loader write, no profile patch, no ConfigEditor path.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/web-access.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  PI_TUI_WEB_ACCESS_DISABLE_ORDER,
  PI_TUI_WEB_ACCESS_ENABLE_ORDER,
  PI_TUI_WEB_ACCESS_OPTIONAL_PENDING_ROWS,
  PI_TUI_WEB_ACCESS_ROWS,
  PiTuiWebAccessHostService,
} from '../../../src/app/host/features/web-access.ts'
import {
  PI_TUI_WEB_ACCESS_SET_ENABLED,
  parsePiTuiWebAccessStatus,
  type PiTuiWebAccessStatus,
} from '../../../src/runtime/remote/pi-tui-web-access-contract.ts'

/** Cordis `FiberState` values (the enum is a const enum with no runtime value). */
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2
const FIBER_DISPOSED = 4

/** The official Web services whose presence the status vocabulary claims. */
const WEB_SERVICES = ['webApp', 'clientModules', 'terminalController'] as const

/** The Host owners that must keep their fiber identity across every toggle. */
const PROTECTED_ROWS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
  { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver' },
  { id: 'workspace-controller', name: '@deepseek-ai/dsh-api-workspace-controller' },
  { id: 'split-host-pi-tui-runtime', name: '@xmoon76/dsh-pi-tui/host-runtime' },
]

/** One controlled lightweight plugin, the shape the Loader really imports. */
interface ControlledPlugin {
  readonly name: string
  readonly inject?: readonly string[]
  readonly apply: (ctx: Context) => void | Promise<void>
}

/** Apply/dispose counters for one official package fixture. */
interface RowFacts {
  applies: number
  disposes: number
}

/** Per-row behaviour a single case needs. */
interface RowOverride {
  /** Extra inject requirements (a missing provider keeps the row PENDING). */
  readonly inject?: readonly string[]
  /** Replace the apply body; a rejection is a real plugin apply failure. */
  readonly apply?: (ctx: Context) => void | Promise<void>
  /** Provide this Cordis service from the row's own fiber. */
  readonly provide?: string
  /** Mount the official SPA fallback child plugin (the `web-runtime` shape). */
  readonly fallback?: boolean
}

/** The official loopback origin the fixture's Web frontend would serve. */
const FIXTURE_ORIGIN = 'http://127.0.0.1:4321'
/** The fixture launch token the official Connection owner appends. */
const FIXTURE_TOKEN = 'fixture-launch-token'

/** The one loopback listener every Web fixture registers its fallback on. */
interface WebServerFixture {
  readonly service: {
    registerFallback(handler: unknown): () => void
    /** The official bound origin every launch URL is built from. */
    getOrigin(): string
  }
  facts(): { readonly registered: boolean; readonly registrations: number; readonly disposals: number }
}

/**
 * The OFFICIAL `webServer.registerFallback` seat semantics: one seat, a second
 * registration throws, and the returned disposer releases only that seat.
 */
function createWebServerFixture(): WebServerFixture {
  let holder: unknown
  let registrations = 0
  let disposals = 0
  return {
    service: {
      getOrigin: () => FIXTURE_ORIGIN,
      registerFallback(handler: unknown): () => void {
        if (holder !== undefined) throw new Error('webserver: fallback already registered')
        holder = handler
        registrations += 1
        return () => {
          if (holder !== handler) return
          holder = undefined
          disposals += 1
        }
      },
    },
    facts: () => ({ registered: holder !== undefined, registrations, disposals }),
  }
}

/** One row of the live Loader as the harness reads it. */
interface LiveRow {
  readonly options: { readonly id: string; readonly name: string }
  readonly fiber?: Fiber
  readonly disabled: boolean
}

/** The whole controlled composition one test drives. */
interface WebAccessFixture {
  readonly ctx: Context
  readonly service: PiTuiWebAccessHostService
  readonly rows: ReadonlyMap<string, LiveRow>
  readonly webServer: WebServerFixture
  /** Apply/dispose counters keyed by official package name. */
  readonly facts: ReadonlyMap<string, RowFacts>
  /** How many times the persistent Loader write was invoked. */
  readonly writes: () => number
  /** The recorded call stacks of every Loader write (diagnosis only). */
  readonly writeStacks: () => readonly string[]
  /** How many times `loader.update` / `loader.remove` / `loader.create` ran after boot. */
  readonly treeMutations: () => number
  dispose(): Promise<void>
}

interface FixtureOptions {
  /** Per-row overrides keyed by roster id. */
  readonly overrides?: ReadonlyMap<string, RowOverride>
  /** Roster ids the Host deliberately does NOT declare (negative control). */
  readonly skipRows?: readonly string[]
}

/**
 * Build the real Loader, the 59 declared rows (disabled, exactly like the
 * Host-only overlay) and the mounted service. `loader.internal` is the Loader's
 * own documented module-import hook: it lets the REAL `Entry.update` import a
 * controlled module while every row keeps its exact official package name.
 */
async function createFixture(options: FixtureOptions = {}): Promise<WebAccessFixture> {
  const behaviours = new Map<string, RowOverride>(options.overrides ?? [])
  const defaults = new Map<string, RowOverride>([
    // The official shapes the production rows really have.
    ['web-runtime', { inject: ['webServer'], provide: 'webApp', fallback: true }],
    ['modules', { provide: 'clientModules' }],
    ['client-hmr', { inject: ['clientModules', 'webServer'] }],
    ['terminal-controller', { provide: 'terminalController' }],
    // The ONE row allowed to stay PENDING: its real dependency
    // (`workspaceChanges`) is not part of this stage.
    ['ui-deliverables', { inject: ['workspaceChanges'] }],
  ])
  for (const [id, behaviour] of defaults) if (!behaviours.has(id)) behaviours.set(id, behaviour)
  const behaviourForPackage = new Map<string, RowOverride>()
  for (const [id, behaviour] of behaviours) {
    const row = PI_TUI_WEB_ACCESS_ROWS.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`the fixture override names an unknown row: ${id}`)
    behaviourForPackage.set(row.name, behaviour)
  }

  const webServer = createWebServerFixture()
  const ctx = new Context()
  const facts = new Map<string, RowFacts>()
  for (const row of PI_TUI_WEB_ACCESS_ROWS) facts.set(row.name, { applies: 0, disposes: 0 })
  for (const row of PROTECTED_ROWS) facts.set(row.name, { applies: 0, disposes: 0 })

  const modules = new Map<string, ControlledPlugin>()
  /** The controlled module of one official package. */
  const moduleFor = (name: string): ControlledPlugin => {
    const known = modules.get(name)
    if (known !== undefined) return known
    const override = behaviourForPackage.get(name)
    const rowFacts = facts.get(name) as RowFacts
    const plugin: ControlledPlugin = {
      name,
      ...(override?.inject === undefined ? {} : { inject: override.inject }),
      apply: pluginCtx => {
        rowFacts.applies += 1
        pluginCtx.effect(() => () => {
          rowFacts.disposes += 1
        }, `${name}: fixture lifeline`)
        if (override?.fallback === true) {
          // The official `web-runtime` shape: a CHILD plugin owns the fallback
          // seat, so the seat leaves with the row's own fiber.
          pluginCtx.plugin(childCtx => {
            childCtx.effect(() => childCtx.webServer.registerFallback(() => undefined), 'fixture: fallback seat')
          })
        }
        if (override?.provide !== undefined) pluginCtx.provide(override.provide, { fixture: name })
        return override?.apply?.(pluginCtx)
      },
    }
    modules.set(name, plugin)
    return plugin
  }

  ctx.provide('webServer', webServer.service)
  // The official Connection owner's ONE public URL builder: the ONLY source of a
  // Web launch URL. The fixture appends its own launch token so a test can prove
  // the getter reaches THIS authority (and never invents a URL).
  ctx.provide('connection', {
    authenticatedUrl: (baseUrl: string) => `${baseUrl}?token=${FIXTURE_TOKEN}`,
  })
  // The structural shape of the official Typert registry. The service only
  // needs it to exist (the Host Runtime owns the descriptors); the REAL Gateway
  // dispatch is proven by the split-process lane.
  ctx.provide('typert', { register: async () => undefined })
  const loaderFiber = ctx.plugin(Loader)
  await loaderFiber
  const loader = ctx.get('loader') as Loader
  const internal = { version: 'v2', import: async (specifier: string) => moduleFor(specifier) }
  ;(loader as unknown as { internal: unknown }).internal = internal

  // Recorder around the Loader's OWN persistent surface: the toggle must never
  // reach it. Original functions are kept unbound and called with this loader.
  let writes = 0
  let treeMutations = 0
  const writeStacks: string[] = []
  const write = loader.write
  loader.write = (...args: Parameters<Loader['write']>) => {
    writes += 1
    writeStacks.push(new Error('loader.write').stack ?? '')
    return write.apply(loader, args)
  }
  const update = loader.update
  loader.update = async (...args: Parameters<Loader['update']>) => {
    treeMutations += 1
    return update.apply(loader, args)
  }
  const create = loader.create
  loader.create = async (...args: Parameters<Loader['create']>) => {
    treeMutations += 1
    return create.apply(loader, args)
  }
  const remove = loader.remove
  loader.remove = (...args: Parameters<Loader['remove']>) => {
    treeMutations += 1
    return remove.apply(loader, args)
  }

  const skipped = new Set(options.skipRows ?? [])
  // `ensureId` honours a supplied id; the published TYPE omits it because a
  // caller normally lets the tree name a row.
  const createRow = async (spec: { readonly id: string; readonly name: string; readonly disabled?: boolean }): Promise<void> => {
    await loader.create(spec as unknown as Parameters<Loader['create']>[0])
  }
  for (const row of PI_TUI_WEB_ACCESS_ROWS) {
    if (skipped.has(row.id)) continue
    await createRow({ id: row.id, name: row.name, disabled: true })
  }
  for (const row of PROTECTED_ROWS) await createRow({ id: row.id, name: row.name })
  await loader.await()
  // Boot-time row creation is not a toggle mutation: the recorders start at
  // zero after the Host's own composition exists.
  treeMutations = 0
  writes = 0
  writeStacks.length = 0

  const serviceFiber = ctx.inject(PiTuiWebAccessHostService.inject, pluginCtx => {
    new PiTuiWebAccessHostService(pluginCtx)
  })
  await serviceFiber
  const service = ctx.reflect.get('piTuiWebAccess') as PiTuiWebAccessHostService
  const rows = new Map<string, LiveRow>([...PI_TUI_WEB_ACCESS_ROWS, ...PROTECTED_ROWS]
    .filter(row => !skipped.has(row.id))
    .map(row => [row.id, loader.resolve(row.id) as unknown as LiveRow]))
  return {
    ctx,
    service,
    rows,
    webServer,
    facts,
    writes: () => writes,
    writeStacks: () => writeStacks,
    treeMutations: () => treeMutations,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** The live fiber state of one roster row. */
function fiberState(fixture: WebAccessFixture, id: string): number | undefined {
  return fixture.rows.get(id)?.fiber?.state
}

/** Assert every declared row is effectively disabled with no active fiber. */
function assertAllRowsDisabled(fixture: WebAccessFixture): void {
  for (const row of PI_TUI_WEB_ACCESS_ROWS) {
    const entry = fixture.rows.get(row.id)
    if (entry === undefined) continue
    assert.equal(entry.disabled, true, `"${row.id}" must be effectively disabled`)
    const state = fiberState(fixture, row.id)
    assert.ok(state === undefined || state === FIBER_DISPOSED,
      `"${row.id}" must have no active graph, found state ${String(state)}`)
  }
  for (const service of WEB_SERVICES) {
    assert.equal(fixture.ctx.reflect.get(service), undefined, `the official "${service}" service must be released`)
  }
}

/** Total applies over the Web roster (one per mounted row). */
function webApplies(fixture: WebAccessFixture): number {
  return PI_TUI_WEB_ACCESS_ROWS.reduce((total, row) => total + (fixture.facts.get(row.name)?.applies ?? 0), 0)
}

test('the toggle drives off -> on -> off -> on through the real Entry.update', async t => {
  const fixture = await createFixture()
  t.after(() => fixture.dispose())

  assert.deepEqual(await fixture.service.getStatus(), { state: 'disabled' })
  assert.equal(fixture.webServer.facts().registered, false, 'no fallback may exist before enable')
  const protectedUids = new Map(PROTECTED_ROWS.map(row => [row.id, fixture.rows.get(row.id)?.fiber?.uid]))
  const protectedApplies = new Map(PROTECTED_ROWS.map(row => [row.id, fixture.facts.get(row.name)?.applies]))

  // ── enable ───────────────────────────────────────────────────────────────
  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  for (const row of PI_TUI_WEB_ACCESS_ROWS) {
    const state = fiberState(fixture, row.id)
    if (PI_TUI_WEB_ACCESS_OPTIONAL_PENDING_ROWS.has(row.id)) {
      assert.equal(state, FIBER_PENDING, `"${row.id}" is the one optional PENDING row`)
      continue
    }
    assert.equal(state, FIBER_ACTIVE, `"${row.id}" must be active after enable`)
  }
  assert.deepEqual(fixture.webServer.facts(), { registered: true, registrations: 1, disposals: 0 })
  // Every row whose graph is mounted applied exactly once; the single optional
  // PENDING row never applied because its dependency is absent by design.
  assert.equal(webApplies(fixture), PI_TUI_WEB_ACCESS_ROWS.length - PI_TUI_WEB_ACCESS_OPTIONAL_PENDING_ROWS.size,
    'each mounted row applied exactly once')
  for (const service of WEB_SERVICES) {
    assert.notEqual(fixture.ctx.reflect.get(service), undefined, `the official "${service}" service must be live`)
  }
  for (const row of PROTECTED_ROWS) {
    assert.equal(fixture.rows.get(row.id)?.fiber?.uid, protectedUids.get(row.id),
      `the protected "${row.id}" owner must keep its fiber`)
    assert.equal(fixture.facts.get(row.name)?.applies, protectedApplies.get(row.id),
      `the protected "${row.id}" owner must not be re-applied`)
  }

  // ── disable ──────────────────────────────────────────────────────────────
  assert.deepEqual(await fixture.service.setEnabled(false), { state: 'disabled' })
  assertAllRowsDisabled(fixture)
  // The SPA fallback disposer ran EXACTLY once: the seat is gone and no second
  // registration ever happened.
  assert.deepEqual(fixture.webServer.facts(), { registered: false, registrations: 1, disposals: 1 })
  assert.deepEqual(await fixture.service.getStatus(), { state: 'disabled' })

  // ── enable again on the SAME Loader ──────────────────────────────────────
  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  assert.deepEqual(fixture.webServer.facts(), { registered: true, registrations: 2, disposals: 1 })
  for (const row of PROTECTED_ROWS) {
    assert.equal(fixture.rows.get(row.id)?.fiber?.uid, protectedUids.get(row.id),
      `the protected "${row.id}" owner must survive the second enable`)
  }

  // The whole toggle wrote NOTHING persistent: no Loader write, no Loader tree
  // mutation (no `loader.update`, no `loader.create`, no `loader.remove`).
  assert.equal(fixture.writes(), 0, `the toggle must not persist the Loader tree: ${fixture.writeStacks().join('\n---\n')}`)
  assert.equal(fixture.treeMutations(), 0, 'the toggle must not use loader.update/create/remove')
})

/**
 * The frozen order contract, shared by the positive assertion and its negative
 * control: the enable must assemble the browser graph before the SPA fallback
 * can serve `/`, and the disable must withdraw the fallback before anything
 * else. Shared so the control proves THIS assertion rejects a mutation.
 */
function assertFrozenOrders(enable: readonly string[], disable: readonly string[]): void {
  const ids = PI_TUI_WEB_ACCESS_ROWS.map(row => row.id)
  for (const [label, order] of [['enable', enable], ['disable', disable]] as const) {
    assert.equal(order.length, 59, `the ${label} order must name the whole 59-row roster`)
    assert.equal(new Set(order).size, 59, `the ${label} order must name every row exactly once`)
    assert.deepEqual([...order].sort(), [...ids].sort(), `the ${label} order must be the roster, not a subset`)
  }
  // The browser graph is assembled first, the SPA fallback is mounted last.
  assert.deepEqual(enable.slice(0, 4), ['modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller'],
    'the browser graph must be assembled first')
  assert.equal(enable[enable.length - 1], 'web-runtime', 'the SPA fallback row must be mounted LAST')
  // The fallback is withdrawn FIRST, the browser graph (and its repository of
  // browser bundles) LAST, in reverse order.
  assert.equal(disable[0], 'web-runtime', 'the SPA fallback row must be withdrawn FIRST')
  assert.deepEqual(disable.slice(-4), ['terminal-controller', 'cordis-client-runner', 'client-hmr', 'modules'],
    'the browser graph rows must be withdrawn last, in reverse order')
  // The 54 presentation rows keep the overlay's canonical order on the way out
  // and its reverse on the way in.
  const presentation = ids.filter(id => !['web-runtime', 'modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller'].includes(id))
  assert.deepEqual(enable.slice(4, -1), presentation, 'the presentation rows keep the canonical order on enable')
  assert.deepEqual(disable.slice(1, -4), [...presentation].reverse(),
    'the presentation rows are released in reverse canonical order')
}

test('the enable and disable orders are the frozen production orders', () => {
  assertFrozenOrders(PI_TUI_WEB_ACCESS_ENABLE_ORDER, PI_TUI_WEB_ACCESS_DISABLE_ORDER)
  // Negative controls: the SAME assertion rejects a reordered, dropped or
  // extended order, so it cannot be satisfied by the current source alone.
  assert.throws(
    () => assertFrozenOrders([...PI_TUI_WEB_ACCESS_ENABLE_ORDER].reverse(), PI_TUI_WEB_ACCESS_DISABLE_ORDER),
    /browser graph must be assembled first/u,
    'an enable that mounts the SPA row first must be refused',
  )
  assert.throws(
    () => assertFrozenOrders(PI_TUI_WEB_ACCESS_ENABLE_ORDER, [PI_TUI_WEB_ACCESS_DISABLE_ORDER[1], ...PI_TUI_WEB_ACCESS_DISABLE_ORDER.slice(2), PI_TUI_WEB_ACCESS_DISABLE_ORDER[0]]),
    /withdrawn FIRST/u,
    'a disable that leaves the SPA row for last must be refused',
  )
  assert.throws(
    () => assertFrozenOrders(PI_TUI_WEB_ACCESS_ENABLE_ORDER.slice(1), PI_TUI_WEB_ACCESS_DISABLE_ORDER),
    /59-row roster/u,
  )
})

test('an already-settled state is a no-op: no remount and no second fallback', async t => {
  const fixture = await createFixture()
  t.after(() => fixture.dispose())

  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  const afterFirst = webApplies(fixture)
  const enabledUids = new Map(PI_TUI_WEB_ACCESS_ROWS.map(row => [row.id, fixture.rows.get(row.id)?.fiber?.uid]))
  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  assert.equal(webApplies(fixture), afterFirst, 'a duplicate enable must not re-apply any row')
  for (const row of PI_TUI_WEB_ACCESS_ROWS) {
    assert.equal(fixture.rows.get(row.id)?.fiber?.uid, enabledUids.get(row.id),
      `a duplicate enable must not remount "${row.id}"`)
  }
  assert.deepEqual(fixture.webServer.facts(), { registered: true, registrations: 1, disposals: 0 })

  assert.deepEqual(await fixture.service.setEnabled(false), { state: 'disabled' })
  assert.deepEqual(await fixture.service.setEnabled(false), { state: 'disabled' })
  assert.deepEqual(fixture.webServer.facts(), { registered: false, registrations: 1, disposals: 1 },
    'a duplicate disable must not touch the released seat again')
})

test('concurrent requests are serialized, report changing, and settle on the Loader truth', async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['modules', {
      provide: 'clientModules',
      apply: () => {
        entered()
        return gate
      },
    }]]),
  })
  // A failing assertion must still release the held row, or the Host teardown
  // would wait for it forever.
  t.after(async () => {
    release()
    await fixture.dispose()
  })

  const enable = fixture.service.setEnabled(true)
  await started
  // One mutation is in flight: the status must say so instead of guessing.
  assert.deepEqual(await fixture.service.getStatus(), { state: 'changing' })
  // A second, conflicting request is queued behind it.
  const disable = fixture.service.setEnabled(false)
  assert.deepEqual(await fixture.service.getStatus(), { state: 'changing' })
  release()
  assert.deepEqual(await enable, { state: 'enabled' })
  // The queued disable ran AFTER the enable and observed the settled Loader.
  assert.deepEqual(await disable, { state: 'disabled' })
  assertAllRowsDisabled(fixture)
  assert.deepEqual(fixture.webServer.facts(), { registered: false, registrations: 1, disposals: 1 },
    'the conflicting pair must leave exactly one fallback registration and one release')
  assert.deepEqual(await fixture.service.getStatus(), { state: 'disabled' })
})

test('two simultaneous enables leave one fallback and one settle each', async t => {
  let opened = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['web-runtime', {
      inject: ['webServer'],
      provide: 'webApp',
      fallback: true,
      apply: () => {
        opened += 1
        return gate
      },
    }]]),
  })
  t.after(async () => {
    release()
    await fixture.dispose()
  })
  const first = fixture.service.setEnabled(true)
  const second = fixture.service.setEnabled(true)
  release()
  assert.deepEqual(await Promise.all([first, second]), [{ state: 'enabled' }, { state: 'enabled' }])
  assert.equal(opened, 1, 'the second request must not remount the SPA row')
  assert.deepEqual(fixture.webServer.facts(), { registered: true, registrations: 1, disposals: 0 })
})

test('a failed enable withdraws what it mounted and never reports enabled', async t => {
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['modules', {
      provide: 'clientModules',
      apply: () => { throw new Error('fixture: the module graph refused to compose') },
    }]]),
  })
  t.after(() => fixture.dispose())
  const status = await fixture.service.setEnabled(true)
  assert.equal(status.state, 'unavailable', 'a failed enable must never claim enabled')
  assert.match((status as { reason: string }).reason, /module graph refused to compose/u)
  // Rollback: the whole roster is back to disabled and NO fallback is served.
  assertAllRowsDisabled(fixture)
  assert.deepEqual(fixture.webServer.facts(), { registered: false, registrations: 0, disposals: 0 })
  assert.deepEqual(await fixture.service.getStatus(), { state: 'disabled' })

  // A later request still runs: the failure did not poison the queue.
  const retry = await fixture.service.setEnabled(true)
  assert.equal(retry.state, 'unavailable', 'the same broken row must fail again, not silently pass')
  assertAllRowsDisabled(fixture)
})

test('a failed SPA row enable reports unavailable with no served index', async t => {
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['web-runtime', {
      inject: ['webServer'],
      provide: 'webApp',
      fallback: true,
      apply: () => { throw new Error('fixture: the official frontend dist is missing') },
    }]]),
  })
  t.after(() => fixture.dispose())
  const status = await fixture.service.setEnabled(true)
  assert.equal(status.state, 'unavailable')
  assert.match((status as { reason: string }).reason, /frontend dist is missing/u)
  assertAllRowsDisabled(fixture)
  assert.equal(fixture.webServer.facts().registered, false, 'a failed SPA mount must not leave a fallback')
})

test('a missing required Web service keeps the composition unavailable', async t => {
  const fixture = await createFixture({
    // The row mounts, but publishes no `clientModules`: a mounted fiber is not
    // a working browser graph.
    overrides: new Map<string, RowOverride>([['modules', {}]]),
  })
  t.after(() => fixture.dispose())
  const status = await fixture.service.setEnabled(true)
  assert.equal(status.state, 'unavailable')
  assert.match((status as { reason: string }).reason, /clientModules|client-hmr/u)
  // Recovery keeps closing: no SPA row stays mounted behind an unavailable graph.
  assert.equal(fixture.webServer.facts().registered, false)
  assertAllRowsDisabled(fixture)
})

test('a partial teardown is never reported as disabled', async t => {
  // The `clientModules` owner outlives its row (it is provided from the ROOT
  // context): the real shape of a teardown that did not close what the graph
  // owns. The status may not claim `disabled` on the requested boolean.
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['modules', {
      apply: pluginCtx => { pluginCtx.root.provide('clientModules', { fixture: 'root-owned' }) },
    }]]),
  })
  t.after(() => fixture.dispose())
  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  const status = await fixture.service.setEnabled(false)
  assert.equal(status.state, 'unavailable', 'a leaked Web service must not be reported as disabled')
  assert.match((status as { reason: string }).reason, /clientModules/u)
})

test('the status reads the live Loader on every call, never a cached flag', async t => {
  const fixture = await createFixture()
  t.after(() => fixture.dispose())
  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  // Someone else changes the graph behind the service's back: a cached
  // `enabled` boolean would keep lying.
  await (fixture.rows.get('terminal-controller') as unknown as { update(options: object): Promise<void> })
    .update({ disabled: true })
  const status = await fixture.service.getStatus()
  assert.equal(status.state, 'unavailable')
  assert.match((status as { reason: string }).reason, /1 of the 59 Web rows are disabled/u)
  assert.match((status as { reason: string }).reason, /terminal-controller/u,
    'the partial-state diagnostic must name the rows that left the graph')
})

test('an unrecognized roster is refused instead of toggled partially', async t => {
  // 1. A Host whose Loader does not declare the roster at all.
  const missing = await createFixture({ skipRows: ['terminal-controller', 'ui-plan'] })
  t.after(() => missing.dispose())
  const absent = await missing.service.setEnabled(true)
  assert.equal(absent.state, 'unavailable')
  assert.match((absent as { reason: string }).reason, /terminal-controller/u)
  assertAllRowsDisabled(missing)
  assert.equal(missing.webServer.facts().registered, false)

  // 2. The same preflight over a structural Loader view, so the duplicate and
  // re-pointed-row branches are driven by the production code path too.
  const roster = PI_TUI_WEB_ACCESS_ROWS.map(row => pseudoRow(row.id, row.name, true))
  for (const [label, rows, expected] of [
    ['a duplicated row', [...roster, pseudoRow('modules', '@deepseek-ai/dsh-client-modules', true)], /more than one "modules" row/u],
    ['a re-pointed row', roster.map(row => row.options.id === 'web-runtime'
      ? pseudoRow('web-runtime', '@deepseek-ai/dsh-host-webserver', true)
      : row), /"web-runtime" row loads/u],
    ['a missing row', roster.filter(row => row.options.id !== 'ui-trajectory'), /ui-trajectory/u],
  ] as ReadonlyArray<readonly [string, readonly PseudoRow[], RegExp]>) {
    const stub = await createFixture({ overrides: new Map() })
    const status = await driveStub(stub, rows)
    assert.equal(status.state, 'unavailable', `${label} must be refused`)
    assert.match((status as { reason: string }).reason, expected, `${label} must name the real cause`)
  }
})

/** Minimal Loader entry view for the roster preflight negative controls. */
interface PseudoRow {
  readonly options: { readonly id: string; readonly name: string }
  readonly disabled: boolean
  update(options: { readonly disabled?: boolean }): Promise<void>
  readonly fiber?: { readonly uid: number | null; readonly state: number; await(): Promise<unknown> }
}

/** One row that is declared, disabled and never mounted. */
function pseudoRow(id: string, name: string, disabled: boolean): PseudoRow {
  return {
    options: { id, name },
    disabled,
    update: async () => undefined,
  }
}

/**
 * Drive the production service against a structural Loader. The service is
 * mounted on a context whose `loader` is the structural view; no production
 * code is replaced.
 */
async function driveStub(
  fixture: WebAccessFixture,
  rows: readonly PseudoRow[],
): Promise<Awaited<ReturnType<PiTuiWebAccessHostService['setEnabled']>>> {
  const ctx = new Context()
  ctx.provide('typert', { register: async () => undefined })
  ctx.provide('loader', {
    entries: () => rows,
    await: async () => undefined,
  })
  const fiber = ctx.inject(PiTuiWebAccessHostService.inject, pluginCtx => {
    new PiTuiWebAccessHostService(pluginCtx)
  })
  await fiber
  try {
    return await (ctx.reflect.get('piTuiWebAccess') as PiTuiWebAccessHostService).setEnabled(true)
  } finally {
    await ctx.fiber.dispose()
  }
}

test('the wire result codec accepts the four states and refuses any other shape', () => {
  for (const state of ['disabled', 'enabled', 'changing'] as const) {
    assert.deepEqual(parsePiTuiWebAccessStatus({ state }), { state })
  }
  assert.deepEqual(parsePiTuiWebAccessStatus({ state: 'unavailable', reason: 'not tonight' }),
    { state: 'unavailable', reason: 'not tonight' })
  for (const [label, value] of [
    ['a non-object', 'enabled'],
    ['no state', {}],
    ['an unknown state', { state: 'on' }],
    ['a missing reason', { state: 'unavailable' }],
    ['an empty reason', { state: 'unavailable', reason: '' }],
    ['a non-string reason', { state: 'unavailable', reason: 1 }],
    ['a stray field', { state: 'enabled', reason: 'x' }],
    ['a stray token field', { state: 'disabled', token: 'secret' }],
  ] as ReadonlyArray<readonly [string, unknown]>) {
    assert.throws(() => parsePiTuiWebAccessStatus(value), TypeError, `${label} must be refused`)
  }
  // The mutation's argument codec admits a boolean and nothing else.
  const codec = PI_TUI_WEB_ACCESS_SET_ENABLED.parameters[0]?.codec
  assert.ok(codec !== undefined, 'the mutation must declare its argument codec')
  const parser = (codec as { create(): { parse(value: unknown): unknown } }).create()
  assert.equal(parser.parse(true), true)
  assert.equal(parser.parse(false), false)
  for (const value of ['true', 1, null, undefined, {}]) {
    assert.throws(() => parser.parse(value), TypeError, `${JSON.stringify(value)} is not a wire boolean`)
  }
})

test('unmounting the Host runtime during a mutation leaves no unhandled rejection', async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['modules', { provide: 'clientModules', apply: () => gate }]]),
  })
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  t.after(async () => {
    process.off('unhandledRejection', onRejection)
    await fixture.dispose()
  })
  const pending = fixture.service.setEnabled(true)
  // Host shutdown while the transition is in flight.
  await fixture.ctx.fiber.dispose()
  release()
  const settled = await Promise.race([
    pending,
    // Bounded window: a hang fails HERE instead of pending forever.
    new Promise<'timeout'>(resolve => { setTimeout(() => resolve('timeout'), 5_000).unref() }),
  ])
  assert.notEqual(settled, 'timeout', 'the in-flight mutation must settle, not hang')
  // One more turn of the event loop: a late unhandled rejection would surface.
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(rejections, [], 'a Host shutdown during a toggle must not leak a rejection')
})

/* ── M5-W PR-C: the official authenticated URL getter ─────────────────────── */

test('getAuthenticatedUrl answers only while the frontend is enabled, from the official authority', async t => {
  const fixture = await createFixture()
  t.after(() => fixture.dispose())

  // Disabled: no URL is produced at all, and the failure never carries one.
  await assert.rejects(
    fixture.service.getAuthenticatedUrl(),
    (error: unknown) => {
      assert.match(String(error), /not enabled/u)
      assert.doesNotMatch(String(error), new RegExp(FIXTURE_TOKEN, 'u'), 'no token in a disabled failure')
      return true
    },
  )

  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  const { url } = await fixture.service.getAuthenticatedUrl()
  assert.equal(url, `${FIXTURE_ORIGIN}/?token=${FIXTURE_TOKEN}`,
    'the URL is connection.authenticatedUrl(webServer.getOrigin() + "/") — the official path only')

  // The getter never stores or mirrors the value: the status stays the small
  // availability vocabulary, and a second call reads the authority again.
  const status = await fixture.service.getStatus()
  assert.deepEqual(status, { state: 'enabled' })
  assert.doesNotMatch(JSON.stringify(status), /token|127\.0\.0\.1:4321/u)
  assert.deepEqual(await fixture.service.getAuthenticatedUrl(), { url })

  // Disabled again: the same getter refuses instead of serving a stale link.
  assert.deepEqual(await fixture.service.setEnabled(false), { state: 'disabled' })
  await assert.rejects(fixture.service.getAuthenticatedUrl(), /not enabled/u)
})

test('getAuthenticatedUrl refuses during a mutation and on an unavailable roster', async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['modules', {
      provide: 'clientModules',
      apply: () => {
        entered()
        return gate
      },
    }]]),
  })
  t.after(async () => {
    release()
    await fixture.dispose()
  })
  const enabling = fixture.service.setEnabled(true)
  await started
  await assert.rejects(fixture.service.getAuthenticatedUrl(), /not enabled/u,
    'a changing Host must not hand out a URL')
  release()
  assert.deepEqual(await enabling, { state: 'enabled' })

  // A partially disabled roster is `unavailable`: no URL either.
  const row = fixture.rows.get('ui-theme') as unknown as {
    update(options: { readonly disabled: boolean }): Promise<void>
  }
  await row.update({ disabled: true })
  await assert.rejects(fixture.service.getAuthenticatedUrl(), /unavailable/u)
})

/* ── M5-W PR-C: profile recomposition preserves the live target ───────────── */

/** Wait for the serialized recomposition repair to reach the expected state. */
async function waitForStatus(
  fixture: WebAccessFixture,
  expected: PiTuiWebAccessStatus['state'],
  label: string,
): Promise<PiTuiWebAccessStatus> {
  const deadline = Date.now() + 10_000
  let status = await fixture.service.getStatus()
  while (status.state !== expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    status = await fixture.service.getStatus()
  }
  assert.equal(status.state, expected, `${label}: reached ${JSON.stringify(status)}`)
  return status
}

/** Emulate the official recompose's re-application of the overlay rows. */
async function reapplyOverlayDisabled(fixture: WebAccessFixture): Promise<void> {
  for (const row of PI_TUI_WEB_ACCESS_ROWS) {
    const entry = fixture.rows.get(row.id) as unknown as {
      update(options: { readonly disabled: boolean }): Promise<void>
    }
    await entry.update({ disabled: true })
  }
}

test('an official profile recomposition restores the last successful enabled target', async t => {
  const fixture = await createFixture()
  t.after(() => fixture.dispose())

  // No repair before the first successful toggle: the cold-boot default stands.
  fixture.ctx.emit('app-boot/config-reload')
  await waitForStatus(fixture, 'disabled', 'cold boot before any toggle')
  assert.equal(webApplies(fixture), 0, 'no repair ran before the first successful toggle')

  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  const appliesWhileEnabled = webApplies(fixture)
  assert.equal(fixture.webServer.facts().registered, true)

  // The official Settings write recomposes the profile and re-applies the
  // overlay's declarative disabled rows, then emits the official event.
  await reapplyOverlayDisabled(fixture)
  assert.equal((await fixture.service.getStatus()).state, 'disabled',
    'the recomposition really disabled the live roster (negative control)')
  fixture.ctx.emit('app-boot/config-reload')
  await waitForStatus(fixture, 'enabled', 'recomposition repair')
  assert.equal(webApplies(fixture) > appliesWhileEnabled, true,
    'the repair re-mounted the live roster through the same Entry.update path')
  assert.deepEqual(fixture.webServer.facts(), { registered: true, registrations: 2, disposals: 1 },
    'the SPA fallback was re-registered exactly once by the repair')
})

test('a recomposition never re-enables after a successful disable or without a toggle', async t => {
  const fixture = await createFixture()
  t.after(() => fixture.dispose())
  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  assert.deepEqual(await fixture.service.setEnabled(false), { state: 'disabled' })
  const appliesWhileDisabled = webApplies(fixture)
  await reapplyOverlayDisabled(fixture)
  fixture.ctx.emit('app-boot/config-reload')
  await waitForStatus(fixture, 'disabled', 'disabled target after recomposition')
  assert.equal(webApplies(fixture), appliesWhileDisabled, 'a disabled target must never be re-enabled')

  const fresh = await createFixture()
  t.after(() => fresh.dispose())
  fresh.ctx.emit('app-boot/config-reload')
  await waitForStatus(fresh, 'disabled', 'no toggle at all')
  assert.equal(webApplies(fresh), 0, 'a never-toggled Host has no target to restore')
})

test('a failed recomposition repair never claims the restored state', async t => {
  let failReenable = false
  const fixture = await createFixture({
    overrides: new Map<string, RowOverride>([['modules', {
      provide: 'clientModules',
      apply: () => {
        if (failReenable) throw new Error('fixture: the module graph refused to compose again')
      },
    }]]),
  })
  t.after(() => fixture.dispose())
  assert.deepEqual(await fixture.service.setEnabled(true), { state: 'enabled' })
  await reapplyOverlayDisabled(fixture)
  failReenable = true
  fixture.ctx.emit('app-boot/config-reload')
  // The repair fails and rolls back to the fully disabled roster: the LIVE
  // status is that rolled-back truth (the repair never fabricates `enabled`).
  const status = await waitForStatus(fixture, 'disabled', 'failed recomposition repair')
  assert.equal(status.state, 'disabled')
  assert.equal((await fixture.service.getStatus()).state === 'enabled', false,
    'a failed repair must never claim the restored enabled state')
  assert.equal(fixture.webServer.facts().registered, false, 'the failed repair left no served fallback')
})
