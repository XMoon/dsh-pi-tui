/**
 * Contract tests for the private `piTuiFileReferences` Host service
 * (app/remote/pi-tui-file-reference-host.ts), its transport-neutral Host
 * bridge (runtime/remote/pi-tui-file-reference-host-bridge.ts) and its
 * handwritten Typert descriptor
 * (runtime/remote/pi-tui-file-reference-contract.ts): ONE invocation
 * descriptor shared by the Host registration and the Client contribution, the
 * explicit registration/withdrawal lifetime, and the Host facts the method
 * resolves (Session→Agent, the official provider, the scoped Host scanner).
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-file-reference-host.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  PI_TUI_FILE_REFERENCE_PACKAGE,
  PI_TUI_FILE_REFERENCES_LIST,
} from '../src/runtime/remote/pi-tui-file-reference-contract.ts'
import {
  PI_TUI_CLIENT_CONTRIBUTION,
  PI_TUI_HOST_CONTRIBUTION,
  PI_TUI_REMOTE_PACKAGE,
} from '../src/runtime/remote/pi-tui-remote-contribution.ts'
import { PI_TUI_TERMINAL_PROGRESS_PACKAGE } from '../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import {
  PiTuiFileReferenceHostService,
  type FileReferencesServiceLike,
  type PiTuiFileReferenceHostDeps,
} from '../src/app/remote/pi-tui-file-reference-host.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const abort = new AbortController().signal

/** The Host facts one service instance answers with, over a temp workspace. */
function hostDeps(
  life: TestLifecycle,
  files: Record<string, string>,
  options: {
    readonly officialItems?: readonly { path: string; kind: 'file' | 'directory' }[]
    readonly officialAbsent?: boolean
  } = {},
): PiTuiFileReferenceHostDeps & { readonly root: string; readonly officialCalls: string[] } {
  const root = life.tempDir('dsh-hfrh-')
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const officialCalls: string[] = []
  const official: FileReferencesServiceLike = {
    list: async (_agent, query) => {
      officialCalls.push(query)
      return options.officialItems ?? []
    },
  }
  return {
    root,
    officialCalls,
    agentFor: sessionId => sessionId === 'session-live' ? { session: { header: { cwd: root } } } : undefined,
    official: () => options.officialAbsent === true ? undefined : official,
    fdPath: null,
  }
}

test('the private contract owns ONE invocation descriptor both contributions derive from', () => {
  // rc.2 admits exactly ONE contribution per package identity (Host:
  // `package#face`, Client: the package), so the package's single contribution
  // carries every private descriptor; the Host registration and the Client
  // mount must still share the SAME descriptor object.
  assert.equal(PI_TUI_HOST_CONTRIBUTION.package, PI_TUI_REMOTE_PACKAGE)
  assert.equal(PI_TUI_HOST_CONTRIBUTION.package, PI_TUI_FILE_REFERENCE_PACKAGE)
  assert.equal(PI_TUI_HOST_CONTRIBUTION.package, PI_TUI_TERMINAL_PROGRESS_PACKAGE)
  assert.equal(PI_TUI_HOST_CONTRIBUTION.face, 'host')
  assert.equal(PI_TUI_HOST_CONTRIBUTION.invocations[0], PI_TUI_FILE_REFERENCES_LIST,
    'the file-reference descriptor is registered by the package contribution')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST, PI_TUI_CLIENT_CONTRIBUTION.descriptors[0],
    'the Host registration and the Client contribution must share the exact descriptor object')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST.id, '@xmoon76/dsh-pi-tui#piTuiFileReferences/list')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST.service, 'piTuiFileReferences')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST.namespace, 'piTuiFileReferences')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST.method, 'list')
  assert.deepEqual(PI_TUI_FILE_REFERENCES_LIST.parameters.map(parameter => parameter.wire), ['sessionId', 'query'])
  assert.ok(PI_TUI_FILE_REFERENCES_LIST.parameters.every(parameter => parameter.codec.mode === 'strict'),
    'the Client contribution requires strict input codecs')
  assert.deepEqual(PI_TUI_FILE_REFERENCES_LIST.cancellation, { parameter: 'signal' })
  assert.equal(PI_TUI_FILE_REFERENCES_LIST.invocation.kind, 'direct')
})

/** Mount a Host Context with the real Typert registry (the service's Host
 * prerequisite) and construct the private Host service over it. */
async function mountService(deps: PiTuiFileReferenceHostDeps): Promise<{
  readonly service: PiTuiFileReferenceHostService
  readonly ctx: Context
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const service = new PiTuiFileReferenceHostService(ctx, deps)
  return { service, ctx }
}

test('the composition registers the endpoint in its OWN fiber and disposal withdraws it', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, {})
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  // The composition owns the package contribution; the service row owns only
  // its binding (see host-runtime.ts step 0a/0b).
  const contribution = ctx.inject(['typert'], contributionCtx => {
    contributionCtx.effect(
      () => contributionCtx.typert.register(PI_TUI_HOST_CONTRIBUTION),
      'pi-tui-private-remote-host-test',
    )
  })
  await contribution
  const service = ctx.inject(PiTuiFileReferenceHostService.inject, pluginCtx => {
    new PiTuiFileReferenceHostService(pluginCtx, deps)
  })
  await service
  assert.equal(ctx.typert.local.get('piTuiFileReferences/list')?.id,
    '@xmoon76/dsh-pi-tui#piTuiFileReferences/list',
    'the strict descriptor is registered on the Host')
  await service.dispose()
  assert.equal(ctx.typert.local.get('piTuiFileReferences/list')?.id,
    '@xmoon76/dsh-pi-tui#piTuiFileReferences/list',
    'disposing the service row alone leaves the package contribution registered')
  await contribution.dispose()
  assert.equal(ctx.typert.local.get('piTuiFileReferences/list'), undefined,
    'unloading the composition withdraws the endpoint with its fiber')
  await ctx.fiber.dispose()
})

test('the Host service delegates a BARE query to the official provider and answers its order verbatim', async (t) => {
  const life = testLifecycle(t)
  const items = [{ path: 'host/only.ts', kind: 'file' as const }]
  const deps = hostDeps(life, { 'src/utility.ts': 'x' }, { officialItems: items })
  const { service, ctx } = await mountService(deps)
  assert.deepEqual(await service.list('session-live', 'uti', abort), { kind: 'ok', items })
  assert.deepEqual(deps.officialCalls, ['uti'], 'the official provider owns the bare route')
  // An unresolvable Session is unavailable — the official provider is never asked.
  const missing = await service.list('no-such-session', 'uti', abort)
  assert.equal(missing.kind, 'unavailable')
  assert.deepEqual(deps.officialCalls, ['uti'])
  await ctx.fiber.dispose()
})

test('the Host service reports an unmounted official provider as unavailable for a bare query', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, {}, { officialAbsent: true })
  const { service, ctx } = await mountService(deps)
  const result = await service.list('session-live', 'foo', abort)
  assert.equal(result.kind, 'unavailable')
  await ctx.fiber.dispose()
})

test('the Host service runs the scoped Host scanner for an explicit path scope', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'src/deep/utility.ts': 'x' }, {})
  const { service, ctx } = await mountService(deps)
  assert.deepEqual(await service.list('session-live', 'src/uti', abort),
    { kind: 'ok', items: [{ path: 'src/deep/utility.ts', kind: 'file' }] })
  assert.deepEqual(deps.officialCalls, [], 'the explicit route never consults the official provider')
  await ctx.fiber.dispose()
})

test('the Host service cancellation rejects before any Host fact is read', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, {})
  const { service, ctx } = await mountService(deps)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.list('session-live', 'foo', controller.signal), /aborted/u)
  assert.deepEqual(deps.officialCalls, [])
  await ctx.fiber.dispose()
})

test('the Host service HOME shorthand answers ABSOLUTE Host paths', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, {})
  const { service, ctx } = await mountService(deps)
  const result = await service.list('session-live', '~/', abort)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.ok(result.items.length > 0, 'the Host HOME directory lists')
    assert.ok(result.items.every(item => isAbsolute(item.path) && !item.path.startsWith('~')),
      `every value is an absolute Host path: ${JSON.stringify(result.items.map(item => item.path))}`)
  }
  await ctx.fiber.dispose()
})
