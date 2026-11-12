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
import { PI_TUI_WEB_ACCESS_NAMESPACE } from '../../src/runtime/remote/pi-tui-web-access-contract.ts'
import { PI_TUI_HOST_USER_SHELL_NAMESPACE } from '../../src/runtime/remote/pi-tui-host-user-shell-contract.ts'
import { PI_TUI_SKILLS_NAMESPACE } from '../../src/runtime/remote/pi-tui-skills-contract.ts'
import { PI_TUI_AUTHORIZATION_NAMESPACE } from '../../src/runtime/remote/pi-tui-authorization-contract.ts'
import { PI_TUI_CREDENTIAL_RECORDS_NAMESPACE } from '../../src/runtime/remote/pi-tui-credential-records-contract.ts'
import type { PiTuiTerminalProgressFrame } from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'

/** Cordis `FiberState.ACTIVE` (const enum: no runtime value). */
const FIBER_ACTIVE = 2

interface HostContextOptions {
  readonly typert?: boolean
  readonly agents?: boolean
  readonly fileReferences?: boolean
  readonly workingDirectory?: boolean
  readonly sessions?: boolean
  readonly sandboxPolicy?: boolean
  readonly sandbox?: boolean
  readonly subprocess?: boolean
  readonly workspaceRegistry?: boolean
  readonly skills?: boolean
  readonly agentPresets?: boolean
  readonly loader?: boolean
}

/** Build the minimal real Host prerequisite graph the runtime injects. */
async function hostContext(options: HostContextOptions = {}): Promise<Context> {
  const ctx = new Context()
  if (options.typert !== false) await ctx.plugin(TypertRegistry)
  if (options.agents !== false) ctx.provide('agents', { get: () => undefined })
  if (options.fileReferences !== false) ctx.provide('fileReferences', { list: async () => [] })
  if (options.workingDirectory !== false) ctx.provide('workingDirectory', { get: () => process.cwd() })
  if (options.sessions !== false) ctx.provide('sessions', { get: () => undefined })
  if (options.sandboxPolicy !== false) ctx.provide('sandboxPolicy', {})
  if (options.sandbox !== false) ctx.provide('sandbox', {})
  if (options.subprocess !== false) ctx.provide('subprocess', {})
  // The official Host Skills standing authorities. This suite pins the
  // COMPOSITION, so a registry/lease shape that returns an empty complete
  // observation is enough; the real Host semantics live in
  // test/app/host/skills.test.ts and test/app/remote-skills-wire.test.ts.
  if (options.workspaceRegistry !== false) ctx.provide('workspaceRegistry', { get: () => undefined })
  if (options.skills !== false) {
    ctx.provide('skills', { snapshot: async () => ({ skills: [], complete: true }) })
  }
  if (options.agentPresets !== false) {
    ctx.provide('agentPresets', {
      acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }),
    })
  }
  // The Host's own Loader is the official Web frontend toggle's ONLY authority.
  // This suite pins composition, so an empty Loader view is enough; the real
  // `Entry.update` transitions live in `test/app/host/web-access.test.ts`.
  if (options.loader !== false) {
    ctx.provide('loader', { entries: () => [], await: async () => undefined })
  }
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

test('one contribution registers every private service and publishes readiness last', async () => {
  const ctx = await hostContext()
  const fiber = ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
  await fiber
  assert.equal(fiber.state, FIBER_ACTIVE, 'the runtime fiber must be active after apply')
  assert.ok(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined,
    'piTuiHostReady must be published')
  assert.equal(bindingOf(ctx, 'piTuiFileReferences').serviceKey, 'piTuiFileReferences')
  assert.equal(bindingOf(ctx, 'piTuiFileReferences').namespace, PI_TUI_FILE_REFERENCES_NAMESPACE)
  assert.equal(bindingOf(ctx, 'piTuiTerminalProgress').serviceKey, 'piTuiTerminalProgress')
  assert.equal(bindingOf(ctx, 'piTuiTerminalProgress').namespace, PI_TUI_TERMINAL_PROGRESS_NAMESPACE)
  // The third internal module: the official Web frontend toggle.
  assert.equal(bindingOf(ctx, 'piTuiWebAccess').serviceKey, 'piTuiWebAccess')
  assert.equal(bindingOf(ctx, 'piTuiWebAccess').namespace, PI_TUI_WEB_ACCESS_NAMESPACE)
  assert.equal(bindingOf(ctx, 'piTuiHostUserShell').namespace, PI_TUI_HOST_USER_SHELL_NAMESPACE)
  assert.equal(bindingOf(ctx, 'piTuiSkills').serviceKey, 'piTuiSkills')
  assert.equal(bindingOf(ctx, 'piTuiSkills').namespace, PI_TUI_SKILLS_NAMESPACE)
  assert.equal(bindingOf(ctx, 'piTuiAuthorization').serviceKey, 'piTuiAuthorization')
  assert.equal(bindingOf(ctx, 'piTuiAuthorization').namespace, PI_TUI_AUTHORIZATION_NAMESPACE)
  // The stored-credential-record bridge resolves the official store per call,
  // so this Host Context (which has NO credentials service) still mounts it.
  assert.equal(bindingOf(ctx, PI_TUI_CREDENTIAL_RECORDS_NAMESPACE).serviceKey, PI_TUI_CREDENTIAL_RECORDS_NAMESPACE)
  assert.equal(bindingOf(ctx, PI_TUI_CREDENTIAL_RECORDS_NAMESPACE).namespace, PI_TUI_CREDENTIAL_RECORDS_NAMESPACE)
  // Every private endpoint is registered by the ONE package contribution.
  assert.equal(
    ctx.typert.local.get('piTuiFileReferences/list')?.id,
    '@xmoon76/dsh-pi-tui#piTuiFileReferences/list',
  )
  assert.equal(
    ctx.typert.local.get('piTuiTerminalProgress/watch')?.id,
    '@xmoon76/dsh-pi-tui#piTuiTerminalProgress/watch',
  )
  assert.equal(
    ctx.typert.local.get('piTuiWebAccess/getStatus')?.id,
    '@xmoon76/dsh-pi-tui#piTuiWebAccess/getStatus',
  )
  assert.equal(
    ctx.typert.local.get('piTuiWebAccess/setEnabled')?.id,
    '@xmoon76/dsh-pi-tui#piTuiWebAccess/setEnabled',
  )
  assert.equal(
    ctx.typert.local.get('piTuiWebAccess/getAuthenticatedUrl')?.id,
    '@xmoon76/dsh-pi-tui#piTuiWebAccess/getAuthenticatedUrl',
  )
  assert.equal(ctx.typert.local.get('piTuiHostUserShell/run')?.id, '@xmoon76/dsh-pi-tui#piTuiHostUserShell/run')
  assert.equal(ctx.typert.local.get('piTuiHostUserShell/complete')?.id, '@xmoon76/dsh-pi-tui#piTuiHostUserShell/complete')
  assert.equal(ctx.typert.local.get('piTuiSkills/standing')?.id, '@xmoon76/dsh-pi-tui#piTuiSkills/standing')
  assert.equal(ctx.typert.local.get('piTuiSkills/watchInvalidations')?.id, '@xmoon76/dsh-pi-tui#piTuiSkills/watchInvalidations')
  assert.equal(ctx.typert.local.get('piTuiAuthorization/list')?.id, '@xmoon76/dsh-pi-tui#piTuiAuthorization/list')
  assert.equal(ctx.typert.local.get('piTuiAuthorization/run')?.id, '@xmoon76/dsh-pi-tui#piTuiAuthorization/run')
  assert.equal(ctx.typert.local.get('piTuiAuthorization/respond')?.id, '@xmoon76/dsh-pi-tui#piTuiAuthorization/respond')
  assert.equal(ctx.typert.local.get('piTuiAuthorization/cancel')?.id, '@xmoon76/dsh-pi-tui#piTuiAuthorization/cancel')
  assert.equal(ctx.typert.local.get('piTuiCredentialRecords/list')?.id, '@xmoon76/dsh-pi-tui#piTuiCredentialRecords/list')
  assert.equal(ctx.typert.local.get('piTuiCredentialRecords/delete')?.id, '@xmoon76/dsh-pi-tui#piTuiCredentialRecords/delete')
  await ctx.fiber.dispose()
})

test('disposing the ONE built-in fiber withdraws every service, the contribution and live watchers', async () => {
  const ctx = await hostContext()
  const fiber = ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
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
  assert.equal(ctx.reflect.get('piTuiWebAccess'), undefined)
  assert.equal(ctx.reflect.get('piTuiHostUserShell'), undefined)
  assert.equal(ctx.reflect.get('piTuiSkills'), undefined)
  assert.equal(ctx.reflect.get('piTuiAuthorization'), undefined)
  assert.equal(ctx.reflect.get(PI_TUI_CREDENTIAL_RECORDS_NAMESPACE), undefined)
  assert.equal(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE), undefined)
  assert.equal(ctx.typert.local.get('piTuiFileReferences/list'), undefined)
  assert.equal(ctx.typert.local.get('piTuiTerminalProgress/watch'), undefined)
  assert.equal(ctx.typert.local.get('piTuiWebAccess/getStatus'), undefined)
  assert.equal(ctx.typert.local.get('piTuiWebAccess/setEnabled'), undefined)
  assert.equal(ctx.typert.local.get('piTuiWebAccess/getAuthenticatedUrl'), undefined)
  assert.equal(ctx.typert.local.get('piTuiHostUserShell/run'), undefined)
  assert.equal(ctx.typert.local.get('piTuiHostUserShell/complete'), undefined)
  assert.equal(ctx.typert.local.get('piTuiSkills/standing'), undefined)
  assert.equal(ctx.typert.local.get('piTuiSkills/watchInvalidations'), undefined)
  assert.equal(ctx.typert.local.get('piTuiAuthorization/list'), undefined)
  assert.equal(ctx.typert.local.get('piTuiAuthorization/run'), undefined)
  assert.equal(ctx.typert.local.get('piTuiAuthorization/respond'), undefined)
  assert.equal(ctx.typert.local.get('piTuiAuthorization/cancel'), undefined)
  assert.equal(ctx.typert.local.get('piTuiCredentialRecords/list'), undefined)
  assert.equal(ctx.typert.local.get('piTuiCredentialRecords/delete'), undefined)
  await ctx.fiber.dispose()
})

test('every required Host inject keeps the fiber from completing when missing', async () => {
  for (const missing of ['typert', 'agents', 'fileReferences', 'workingDirectory', 'sessions', 'sandboxPolicy', 'sandbox', 'subprocess', 'workspaceRegistry', 'skills', 'agentPresets'] as const) {
    const ctx = await hostContext({ [missing]: false })
    const fiber = ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
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
  const fiber = ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
  await assert.rejects(Promise.resolve(fiber), /has been registered|already registered/iu)
  assert.equal(ctx.reflect.get('piTuiFileReferences'), undefined,
    'the first child service must be withdrawn on failure')
  assert.equal(ctx.typert.local.get('piTuiFileReferences/list'), undefined,
    'the package contribution must be withdrawn on failure')
  assert.equal(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE), undefined,
    'readiness must never be published by a failed mount')
  await ctx.fiber.dispose()
})

test('a Host without a Loader keeps readiness and reports the Web access row unusable', async () => {
  const ctx = await hostContext({ loader: false })
  const fiber = ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
  await fiber
  assert.equal(fiber.state, FIBER_ACTIVE,
    'the built-in runtime must still mount without a Loader service')
  const webAccess = ctx.reflect.get('piTuiWebAccess') as { getStatus(): Promise<{ state: string; reason?: string }> }
  const status = await webAccess.getStatus()
  assert.equal(status.state, 'unavailable', 'a Host without a Loader cannot describe the Web frontend')
  assert.match(String(status.reason ?? ''), /Loader/u)
  await ctx.fiber.dispose()
})

test('a failing THIRD service mount unwinds the earlier services and the contribution', async () => {
  const ctx = await hostContext()
  // Pre-owning the Web access service key makes the THIRD child mount reject
  // after the contribution and both earlier services are live.
  ctx.provide('piTuiWebAccess', { preOwned: true })
  const fiber = ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
  await assert.rejects(Promise.resolve(fiber), /has been registered|already registered/iu)
  assert.equal(ctx.reflect.get('piTuiFileReferences'), undefined,
    'the first child service must be withdrawn on the third mount failure')
  assert.equal(ctx.reflect.get('piTuiTerminalProgress'), undefined,
    'the second child service must be withdrawn on the third mount failure')
  assert.equal(ctx.typert.local.get('piTuiWebAccess/getStatus'), undefined,
    'the package contribution must be withdrawn on failure')
  assert.equal(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE), undefined,
    'readiness must never be published by a failed mount')
  await ctx.fiber.dispose()
})

test('a failing FIFTH service mount unwinds the earlier services and the contribution', async () => {
  const ctx = await hostContext()
  // Pre-owning the Skills service key makes the FIFTH child mount reject after
  // every earlier service is live: readiness must never be published and the
  // whole private roster must be withdrawn.
  ctx.provide('piTuiSkills', { preOwned: true })
  const fiber = ctx.plugin(piTuiHostRuntime, { sessionId: '' } as never)
  await assert.rejects(Promise.resolve(fiber), /has been registered|already registered/iu)
  assert.equal(ctx.reflect.get('piTuiFileReferences'), undefined)
  assert.equal(ctx.reflect.get('piTuiTerminalProgress'), undefined)
  assert.equal(ctx.reflect.get('piTuiWebAccess'), undefined)
  assert.equal(ctx.reflect.get('piTuiHostUserShell'), undefined)
  assert.equal(ctx.typert.local.get('piTuiSkills/standing'), undefined,
    'the package contribution must be withdrawn on failure')
  assert.equal(ctx.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE), undefined)
  await ctx.fiber.dispose()
})

test('a second mount on the same Host is rejected; a separate Host owns its own contribution', async () => {
  const first = await hostContext()
  await first.plugin(piTuiHostRuntime, { sessionId: '' } as never)
  await assert.rejects(Promise.resolve(first.plugin(piTuiHostRuntime, { sessionId: '' } as never)), /already registered/iu,
    'the same Host must reject a duplicate package contribution')
  assert.ok(first.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined,
    'the rejection must not damage the live runtime')

  const second = await hostContext()
  await second.plugin(piTuiHostRuntime, { sessionId: '' } as never)
  assert.ok(second.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined)
  const firstService = first.reflect.get('piTuiFileReferences') as object
  const secondService = second.reflect.get('piTuiFileReferences') as object
  assert.notEqual(firstService, secondService, 'each Host must own a distinct service instance')

  await first.fiber.dispose()
  assert.ok(second.reflect.get(piTuiHostRuntime.PI_TUI_HOST_READY_SERVICE) !== undefined,
    'disposing one Host must not affect another')
  await second.fiber.dispose()
})
