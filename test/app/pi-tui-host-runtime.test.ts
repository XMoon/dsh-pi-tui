/**
 * M4-B2-HF unit contract for the built-in PiTui Host Runtime row
 * (`app/host/pi-tui-host-runtime.ts`).
 *
 * Real Cordis Contexts and the real Typert registry are used; the Host facts
 * the business rows resolve (`agents`, `fileReferences`, `workingDirectory`)
 * are minimal structural stand-ins because this row's contract is composition,
 * not Agent/Session behavior (the L5 suites keep the real business semantics).
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-host-runtime.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as piTuiHostRuntime from '../../src/app/host/pi-tui-host-runtime.ts'
import {
  PI_TUI_FILE_REFERENCES_NAMESPACE,
} from '../../src/runtime/remote/pi-tui-file-reference-contract.ts'
import {
  PI_TUI_TERMINAL_PROGRESS_NAMESPACE,
} from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import type { PiTuiTerminalProgressFrame } from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'

/** Cordis `FiberState.ACTIVE` (const enum: no runtime value). */
const FIBER_ACTIVE = 2

interface HostContextOptions {
  readonly typert?: boolean
  readonly agents?: boolean
  readonly fileReferences?: boolean
  readonly workingDirectory?: boolean
}

/** Build the minimal real Host prerequisite graph the runtime injects. */
async function hostContext(options: HostContextOptions = {}): Promise<Context> {
  const ctx = new Context()
  if (options.typert !== false) await ctx.plugin(TypertRegistry)
  if (options.agents !== false) ctx.provide('agents', { get: () => undefined })
  if (options.fileReferences !== false) ctx.provide('fileReferences', { list: async () => [] })
  if (options.workingDirectory !== false) ctx.provide('workingDirectory', {})
  return ctx
}

interface PrivateBindingLike {
  readonly serviceKey: string
  readonly namespace: string
}

function bindingOf(ctx: Context, serviceKey: string): PrivateBindingLike {
  const service = ctx.reflect.get(serviceKey) as { readonly typertRemote?: PrivateBindingLike } | undefined
  assert.ok(service?.typertRemote !== undefined, `${serviceKey} must expose a Typert binding`)
  return service.typertRemote
}

test('one contribution registers both private services and publishes readiness last', async () => {
  const ctx = await hostContext()
  const fiber = ctx.plugin(piTuiHostRuntime)
  await fiber
  assert.equal(fiber.state, FIBER_ACTIVE, 'the runtime fiber must be active after apply')
  assert.ok(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined,
    'piTuiHostReady must be published')
  assert.equal(bindingOf(ctx, 'piTuiFileReferences').serviceKey, 'piTuiFileReferences')
  assert.equal(bindingOf(ctx, 'piTuiFileReferences').namespace, PI_TUI_FILE_REFERENCES_NAMESPACE)
  assert.equal(bindingOf(ctx, 'piTuiTerminalProgress').serviceKey, 'piTuiTerminalProgress')
  assert.equal(bindingOf(ctx, 'piTuiTerminalProgress').namespace, PI_TUI_TERMINAL_PROGRESS_NAMESPACE)
  // Both private endpoints are registered by the ONE package contribution.
  assert.equal(
    ctx.typert.local.get('piTuiFileReferences/list')?.id,
    '@xmoon76/dsh-pi-tui#piTuiFileReferences/list',
  )
  assert.equal(
    ctx.typert.local.get('piTuiTerminalProgress/watch')?.id,
    '@xmoon76/dsh-pi-tui#piTuiTerminalProgress/watch',
  )
  await ctx.fiber.dispose()
})

test('disposing the ONE built-in fiber withdraws both services, the contribution and live watchers', async () => {
  const ctx = await hostContext()
  const fiber = ctx.plugin(piTuiHostRuntime)
  await fiber
  const terminalProgress = ctx.reflect.get('piTuiTerminalProgress') as {
    watch(sessionId: string, signal: AbortSignal): AsyncGenerator<PiTuiTerminalProgressFrame>
  }
  const controller = new AbortController()
  const iterator = terminalProgress.watch('no-live-agent', controller.signal)
  const opening = await iterator.next()
  assert.equal(opening.done, false)
  assert.equal(opening.value.kind, 'snapshot')
  const pending = iterator.next()
  await fiber.dispose()
  const ended = await pending
  assert.equal(ended.done, true, 'an interrupted subscription must end instead of hanging')
  assert.equal(ctx.reflect.get('piTuiFileReferences'), undefined)
  assert.equal(ctx.reflect.get('piTuiTerminalProgress'), undefined)
  assert.equal(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE), undefined)
  assert.equal(ctx.typert.local.get('piTuiFileReferences/list'), undefined)
  assert.equal(ctx.typert.local.get('piTuiTerminalProgress/watch'), undefined)
  await ctx.fiber.dispose()
})

test('every required Host inject keeps the fiber from completing when missing', async () => {
  for (const missing of ['typert', 'agents', 'fileReferences', 'workingDirectory'] as const) {
    const ctx = await hostContext({ [missing]: false })
    const fiber = ctx.plugin(piTuiHostRuntime)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.notEqual(fiber.state, FIBER_ACTIVE,
      `the runtime must not complete without "${missing}"`)
    assert.equal(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE), undefined,
      `piTuiHostReady must not exist without "${missing}"`)
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('a failing second service mount unwinds the first service and the contribution', async () => {
  const ctx = await hostContext()
  // Pre-owning the terminal-progress service key makes the SECOND child mount
  // reject after the contribution and the file-reference service are live.
  ctx.provide('piTuiTerminalProgress', { preOwned: true })
  const fiber = ctx.plugin(piTuiHostRuntime)
  await assert.rejects(Promise.resolve(fiber), /has been registered|already registered/iu)
  assert.equal(ctx.reflect.get('piTuiFileReferences'), undefined,
    'the first child service must be withdrawn on failure')
  assert.equal(ctx.typert.local.get('piTuiFileReferences/list'), undefined,
    'the package contribution must be withdrawn on failure')
  assert.equal(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE), undefined,
    'readiness must never be published by a failed mount')
  await ctx.fiber.dispose()
})

test('a second mount on the same Host is rejected; a separate Host owns its own contribution', async () => {
  const first = await hostContext()
  await first.plugin(piTuiHostRuntime)
  await assert.rejects(Promise.resolve(first.plugin(piTuiHostRuntime)), /already registered/iu,
    'the same Host must reject a duplicate package contribution')
  assert.ok(first.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined,
    'the rejection must not damage the live runtime')

  const second = await hostContext()
  await second.plugin(piTuiHostRuntime)
  assert.ok(second.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined)
  const firstService = first.reflect.get('piTuiFileReferences') as object
  const secondService = second.reflect.get('piTuiFileReferences') as object
  assert.notEqual(firstService, secondService, 'each Host must own a distinct service instance')

  await first.fiber.dispose()
  assert.ok(second.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined,
    'disposing one Host must not affect another')
  await second.fiber.dispose()
})
