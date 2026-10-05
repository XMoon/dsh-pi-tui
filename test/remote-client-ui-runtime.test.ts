/**
 * M3-6 PR1 — Remote Client UI runtime supporting/component test (plan §14.1).
 *
 * Supporting evidence; NO L1–L6 label: this suite proves the Client UI
 * subtree's own composition invariants on a real Cordis `Context` with the
 * REAL `createRemoteClientUiRuntime()` —
 *
 * ```text
 * A. exact service ownership (runtime.extensionService === ctx.get(...))
 * B. startup facts are detached, callback-free, and frozen at construction
 * C. first-party builtins register on the Client service
 * D. subtree dispose is exact (services gone; idempotent)
 * E. subtree disposal does not dispose the Client root Context
 * ```
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - a real Cordis `Context` and the real plugin modules
 *   (`src/extensions.ts`, `src/builtins.ts`) mounted as real Cordis plugin
 *   fibers (inject/caller-fiber lifecycle stays real).
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - none: the Client UI subtree is TUI-local and needs no Host service.
 *
 * DELIBERATELY ABSENT
 * - the official Client transport/data core (this is the subtree-only
 *   component proof; the aggregate composition is
 *   test/remote-application-runtime.test.ts and the runner-level locality is
 *   test/runner-remote-command-plane.test.ts).
 *
 * @module @xmoon76/dsh-pi-tui/remote-client-ui-runtime.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import { PI_TUI_EXTENSIONS_SERVICE } from '../src/extensions.ts'
import { TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'
import { createRemoteClientUiRuntime } from '../src/app/remote/client-ui-runtime.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

interface LedgerView {
  snapshot(slot: string): { records: Array<{ id: string }> }
}

interface LedgeredService {
  _ledger(): LedgerView
}

/** `ctx.get()` returns a fresh Cordis traceable proxy per call around the
 * ONE underlying service instance; `symbols.original` unwraps it. Service
 * identity assertions compare the UNWRAPPED implementations. */
function unwrapService(value: unknown): unknown {
  const original = (value as Record<symbol, unknown>)[symbols.original]
  return original ?? value
}

function serviceLedger(context: Context): LedgerView | undefined {
  const service = context.get(PI_TUI_EXTENSIONS_SERVICE) as { _ledger(): LedgerView } | undefined
  return service?._ledger()
}

test('A. the runtime resolves exactly the Client Context\'s own extension service', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const runtime = await createRemoteClientUiRuntime({
    context,
    startup: {},
  })
  life.defer(() => runtime.dispose().catch(() => {}))
  assert.equal(unwrapService(runtime.extensionService),
    unwrapService(context.get(PI_TUI_EXTENSIONS_SERVICE)),
    'runtime.extensionService unwraps to the same implementation as the Client Context service')
  // Behavioral identity through the shared ledger: registering through one
  // face is observable through the other.
  const viaGet = context.get(PI_TUI_EXTENSIONS_SERVICE) as LedgeredService
  const ids = viaGet._ledger().snapshot('chrome.header.badge').records.map(record => record.id)
  assert.ok(ids.includes('builtin-version'), 'the Context face observes the same live ledger')
})

test('B. the Client tuiStartup facts are detached, frozen and callback-free', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const source: {
    sessionId?: string
    presetId?: string
  } & Record<string, unknown> = { sessionId: 'client-ui-s', presetId: 'minimal' }
  const runtime = await createRemoteClientUiRuntime({ context, startup: source })
  life.defer(() => runtime.dispose().catch(() => {}))

  const startup = context.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined
  assert.ok(startup !== undefined, 'the Client tuiStartup facts are provided')
  assert.equal(startup.sessionId, 'client-ui-s')
  assert.equal(startup.presetId, 'minimal')
  assert.equal('markSurfaceMounted' in startup, false,
    'the Host-only markSurfaceMounted callback must never enter the Client Context')

  // Mutating the caller's source object after construction must not change
  // the provided Client facts (detached copy, not a pass-by-reference).
  source.sessionId = 'mutated-after-construction'
  source.extra = 'mutated-extra-field'
  const after = context.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined
  assert.equal(after?.sessionId, 'client-ui-s',
    'the provided Client facts are a detached copy of the caller value')
  assert.equal('extra' in (after ?? {}), false,
    'fields added to the caller object after construction never leak in')
})

test('C. the first-party builtins register on the Client service', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const runtime = await createRemoteClientUiRuntime({ context, startup: {} })
  life.defer(() => runtime.dispose().catch(() => {}))

  const ledger = serviceLedger(context)
  assert.ok(ledger !== undefined, 'the extension service (and its ledger) exists')
  const badgeIds = ledger.snapshot('chrome.header.badge').records.map(record => record.id)
  const dockIds = ledger.snapshot('input.dock.item').records.map(record => record.id)
  assert.ok(badgeIds.includes('builtin-version'),
    `the builtin version badge registered on the Client service: ${JSON.stringify(badgeIds)}`)
  assert.ok(dockIds.includes('builtin-todo-summary'),
    `the builtin todo dock item registered on the Client service: ${JSON.stringify(dockIds)}`)
})

test('D. subtree dispose removes both services exactly and is idempotent', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const runtime = await createRemoteClientUiRuntime({ context, startup: {} })

  await runtime.dispose()
  assert.equal(context.get(PI_TUI_EXTENSIONS_SERVICE), undefined,
    'the Client extension service is gone after the subtree disposal')
  assert.equal(context.get(TUI_STARTUP_SERVICE), undefined,
    'the Client tuiStartup facts are gone after the subtree disposal')
  // Idempotent: a second dispose must not throw.
  await runtime.dispose()
})

test('E. subtree disposal leaves the Client root Context itself usable', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const runtime = await createRemoteClientUiRuntime({ context, startup: {} })

  await runtime.dispose()
  // The subtree disposer must NOT have disposed the supplied Context root:
  // a fresh, independent service/fiber still mounts on it afterwards. This
  // locks "subtree dispose != Client root dispose".
  let provided = false
  const fiber = context.plugin(clientCtx => {
    clientCtx.provide('client-ui-runtime-test-probe', { mark: () => { provided = true } })
  })
  await fiber
  const probe = context.get('client-ui-runtime-test-probe') as { mark(): void } | undefined
  assert.ok(probe !== undefined, 'the Client root Context still accepts new services after subtree disposal')
  probe.mark()
  assert.equal(provided, true, 'the probe service is live')
  await fiber.dispose()
})

// ── F. construction-failure unwind (the R1 review F1 regressions) ─────────

/** Wrap `context.plugin` to observe/inject on the subtree mounts (1-based
 * ordinal over ALL plugin calls on this Context). Records each created
 * fiber's disposal in `disposeOrder`; `failDisposeAt` makes one fiber's
 * disposal reject; `throwAt` makes one mount throw SYNCHRONOUSLY inside
 * `context.plugin` (the stage variable never assigns — the phantom-
 * `fiber!.dispose()` shape the review probe reproduced); `rejectAt` gives
 * one plugin a REJECTING async startup (the assigned-before-await shape). */
function instrumentContext(
  context: Context,
  options: {
    readonly throwAt?: number
    readonly rejectAt?: number
    readonly rejectWith?: Error
    readonly disposeOrder?: string[]
    readonly failDisposeAt?: number
  } = {},
): void {
  const original = context.plugin.bind(context)
  let ordinal = 0
  context.plugin = ((pluginArg: unknown, ...rest: unknown[]) => {
    ordinal += 1
    const mine = ordinal
    if (options.throwAt === mine) {
      throw options.rejectWith ?? new Error(`induced fiber-${mine} mount throw`)
    }
    const plugin = options.rejectAt === mine
      ? (async (ctx: Context): Promise<void> => {
          void ctx
          throw options.rejectWith ?? new Error(`induced fiber-${mine} startup rejection`)
        }) as unknown
      : pluginArg
    const fiber = (original as (p: unknown, ...r: unknown[]) => Fiber)(plugin as never, ...rest)
    if (options.disposeOrder !== undefined) {
      const record = options.disposeOrder
      const instrumented = fiber as unknown as { dispose(): Promise<void> }
      const originalDispose = instrumented.dispose.bind(fiber)
      instrumented.dispose = async () => {
        record.push(`fiber-${mine}`)
        if (options.failDisposeAt === mine) throw new Error(`induced fiber-${mine} disposal failure`)
        await originalDispose()
      }
    }
    return fiber
  }) as typeof context.plugin
}

test('F1. a synchronous mount throw leaves the stage fiber unassigned: the unwind skips it and keeps the ORIGINAL error primary with no phantom causes', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const disposeOrder: string[] = []
  // Mount 3 = builtins throws synchronously: startup (fiber-1) and
  // extension host (fiber-2) are assigned, builtinsFiber stays undefined.
  // The pre-fix shape manufactured a TypeError for the undefined fiber and
  // attached it as a phantom cleanup cause.
  const induced = new Error('induced builtins mount throw')
  instrumentContext(context, { throwAt: 3, rejectWith: induced, disposeOrder })
  const error = await createRemoteClientUiRuntime({ context, startup: {} })
    .then(() => undefined, (reason: unknown) => reason)
  assert.ok(error instanceof Error, 'the construction rejects with an Error')
  assert.equal(error, induced, 'the ORIGINAL construction failure is primary (identity)')
  assert.equal((error as { cause?: unknown }).cause, undefined,
    'no phantom cleanup failure may ride the cause chain — the unassigned builtins fiber owns nothing')
  assert.deepEqual(disposeOrder, ['fiber-2', 'fiber-1'],
    'the mounted fibers unwind in reverse (extension host before startup facts)')
  assert.equal(context.get(PI_TUI_EXTENSIONS_SERVICE), undefined,
    'the extension service is gone after the failed construction')
  assert.equal(context.get(TUI_STARTUP_SERVICE), undefined,
    'the startup facts are gone after the failed construction')
})

test('F2. a rejected plugin STARTUP still owns its fiber: the unwind disposes it at its own position, original error primary', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const disposeOrder: string[] = []
  instrumentContext(context, { rejectAt: 3, disposeOrder })
  const error = await createRemoteClientUiRuntime({ context, startup: {} })
    .then(() => undefined, (reason: unknown) => reason)
  assert.ok(error instanceof Error, 'the construction rejects with an Error')
  assert.match(error.message, /induced fiber-3 startup rejection/,
    'the rejected startup surfaces as the ORIGINAL failure')
  assert.equal((error as { cause?: unknown }).cause, undefined,
    'a successful unwind attaches no cleanup causes')
  assert.deepEqual(disposeOrder, ['fiber-3', 'fiber-2', 'fiber-1'],
    'the assigned rejected fiber unwinds first: builtins(fiber-3) -> extension host(fiber-2) -> startup facts(fiber-1)')
})

test('F3. a REAL cleanup failure rides the cause chain beside the original error (never replaces it, cleanup continues)', async (t) => {
  const life = testLifecycle(t)
  const context = new Context()
  life.defer(() => context.fiber.dispose())
  const disposeOrder: string[] = []
  // Builtins throws at mount AND the extension-host fiber's disposal (a
  // later unwind step) rejects: the original stays primary with the REAL
  // cleanup failure as its cause; the remaining step still runs.
  const induced = new Error('induced builtins mount throw')
  instrumentContext(context, { throwAt: 3, rejectWith: induced, disposeOrder, failDisposeAt: 2 })
  const error = await createRemoteClientUiRuntime({ context, startup: {} })
    .then(() => undefined, (reason: unknown) => reason)
  assert.ok(error instanceof Error, 'the construction rejects with an Error')
  assert.equal(error, induced, 'the original construction failure stays primary (identity)')
  const cause = (error as { cause?: unknown }).cause
  assert.ok(cause instanceof Error, 'the REAL cleanup failure rides the cause chain')
  assert.match(cause.message, /induced fiber-2 disposal failure/,
    'the cause is the genuine disposal failure of the extension-host fiber')
  assert.deepEqual(disposeOrder, ['fiber-2', 'fiber-1'],
    'the cleanup ran to completion despite the failing step (both remaining fibers disposed)')
})
