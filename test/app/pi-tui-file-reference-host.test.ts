/**
 * Contract tests for the private `piTuiFileReferences` Host service
 * (app/host/features/file-reference.ts), its transport-neutral Host
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
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  PI_TUI_FILE_REFERENCE_PACKAGE,
  PI_TUI_FILE_REFERENCES_LIST,
  PI_TUI_FILE_REFERENCES_LIST_WORKSPACE,
} from '../../src/runtime/remote/pi-tui-file-reference-contract.ts'
import {
  PI_TUI_CLIENT_CONTRIBUTION,
  PI_TUI_HOST_CONTRIBUTION,
  PI_TUI_REMOTE_PACKAGE,
} from '../../src/runtime/remote/pi-tui-remote-contribution.ts'
import { PI_TUI_TERMINAL_PROGRESS_PACKAGE } from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import {
  PiTuiFileReferenceHostService,
  type FileReferencesServiceLike,
  type PiTuiFileReferenceHostDeps,
} from '../../src/app/host/features/file-reference.ts'
import { DirectHostDiscoveryDriver } from '../../src/runtime/direct/file-completion/host-discovery.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const abort = new AbortController().signal

/** A recording official Workspace registry stand-in: `get` is the ONLY
 *  identity/path authority the sessionless verb consults. */
interface RecordingWorkspaceRegistry {
  get(id: string): { readonly path: string } | undefined
  readonly calls: string[]
  /** Make every read AFTER the first answer with `value` (the scan's
   *  post-read re-check), so a registry change during a scan is observable. */
  setResultAfterFirst(value: { readonly path: string } | undefined): void
}

function workspaceRegistry(initial: { readonly path: string } | undefined): RecordingWorkspaceRegistry {
  let pending: { readonly path: string } | undefined
  let hasPending = false
  return {
    calls: [],
    get(id) {
      this.calls.push(id)
      if (!hasPending) return initial
      hasPending = false
      return pending
    },
    setResultAfterFirst(value) {
      pending = value
      hasPending = true
    },
  }
}

/** The Host facts one service instance answers with, over a temp workspace. */
function hostDeps(
  life: TestLifecycle,
  files: Record<string, string>,
  options: {
    readonly officialItems?: readonly { path: string; kind: 'file' | 'directory' }[]
    readonly officialAbsent?: boolean
  } = {},
): PiTuiFileReferenceHostDeps & {
  readonly root: string
  readonly officialCalls: string[]
  readonly registry: RecordingWorkspaceRegistry
} {
  const root = life.tempDir('dsh-hfrh-')
  const registry = workspaceRegistry({ path: root })
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
    registry,
    agentFor: sessionId => sessionId === 'session-live' ? { session: { header: { cwd: root } } } : undefined,
    official: () => options.officialAbsent === true ? undefined : official,
    fdPath: null,
    workspaces: () => registry,
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
async function mountService(deps: PiTuiFileReferenceHostDeps, remoteInvocation?: unknown): Promise<{
  readonly service: PiTuiFileReferenceHostService
  readonly ctx: Context
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  if (remoteInvocation !== undefined) Object.defineProperty(ctx, 'invocation', { configurable: true, value: remoteInvocation })
  const service = new PiTuiFileReferenceHostService(ctx, deps)
  return { service, ctx }
}

function ownerInvocation(signal = new AbortController().signal): unknown {
  return { peer: { id: 'peer-owner', principal: { kind: 'owner' }, signal }, signal }
}

test('the REGISTERED Host descriptor carries STRICT codecs on both faces (migrated from the retired built-bundle smoke)', async (t) => {
  // The retired `smoke:pi-tui-file-reference-built` located a built chunk and
  // asserted that the endpoint is served by the handwritten EXPLICIT
  // contribution (strict codecs) rather than by the source-mode `src-json`
  // decorator fallback. That is a registration fact, not a wire fact, so it
  // belongs here — over the REAL Typert registry the Host row mounts.
  const life = testLifecycle(t)
  const deps = hostDeps(life, {})
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  try {
    // The explicit contribution is what puts the endpoint in the registry.
    ctx.typert.register(PI_TUI_HOST_CONTRIBUTION)
    const descriptor = ctx.typert.local.get('piTuiFileReferences/list')
    assert.ok(descriptor !== undefined, 'the Host descriptor must be registered through the explicit contribution')
    assert.equal(descriptor.id, '@xmoon76/dsh-pi-tui#piTuiFileReferences/list')
    assert.equal(descriptor.namespace, 'piTuiFileReferences')
    assert.equal(descriptor.method, 'list')
    assert.ok(descriptor.parameters.every(parameter => parameter.codec.mode === 'strict'),
      'every registered parameter codec must be STRICT (never a source-mode src-json codec)')
    assert.equal(descriptor.result.mode, 'strict',
      'the registered result codec must be STRICT (the decorator fallback synthesizes src-json)')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('the composition registers the endpoint in its OWN fiber and disposal withdraws it', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, {})
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  // The built-in PiTui Host Runtime owns the package contribution; this
  // fixture reproduces its two independent fibers (contribution + service row).
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

test('the Workspace descriptor is the package ONE shared descriptor with strict codecs', () => {
  assert.equal(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.id, '@xmoon76/dsh-pi-tui#piTuiFileReferences/listWorkspace')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.service, 'piTuiFileReferences')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.namespace, 'piTuiFileReferences')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.method, 'listWorkspace')
  assert.equal(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.invocation.kind, 'direct')
  assert.deepEqual(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.parameters.map(parameter => parameter.wire),
    ['workspaceId', 'query'])
  assert.ok(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.parameters.every(parameter => parameter.codec.mode === 'strict'),
    'every sessionless parameter codec is strict')
  assert.deepEqual(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.cancellation, { parameter: 'signal' })
  assert.equal(PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.result.mode, 'strict')
  assert.equal(PI_TUI_HOST_CONTRIBUTION.invocations[1], PI_TUI_FILE_REFERENCES_LIST_WORKSPACE,
    'the Host contribution registers the SAME sessionless descriptor object')
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.descriptors[1], PI_TUI_FILE_REFERENCES_LIST_WORKSPACE,
    'the Client contribution mounts the SAME sessionless descriptor object')
  // The strict decoders reject a malformed wire result at the boundary.
  const decode = PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.result.create().parse as (value: unknown) => unknown
  assert.throws(() => decode({ kind: 'ok', items: [{ path: 1 }] }), /candidate/u)
  assert.throws(() => decode({ kind: 'unavailable' }), /reason/u)
  assert.throws(() => decode({ kind: 'ok', items: 'nope' }), /ok\(items\)/u)
  // The workspaceId parameter rejects an EMPTY id at the WIRE boundary (plan
  // §4.2) — never a fabricated id reaching the Host business layer.
  const parameter = PI_TUI_FILE_REFERENCES_LIST_WORKSPACE.parameters[0]!
  const workspaceId = (parameter.codec as { create: () => { parse: (value: unknown) => string } }).create().parse
  assert.throws(() => workspaceId(''), /non-empty Workspace id/u)
  assert.throws(() => workspaceId(42 as unknown), /must be a string/u)
  assert.equal(workspaceId('workspace-9'), 'workspace-9')
})

test('listWorkspace refuses without an Owner invocation BEFORE any registry read', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'a.ts': 'x' })
  for (const invocation of [undefined, { peer: { id: 'viewer', principal: { kind: 'viewer' }, signal: abort }, signal: abort }]) {
    const { service, ctx } = await mountService(deps, invocation)
    // BOTH routes refuse identically: the bare query AND an explicit path scope.
    for (const query of ['a', '../outside/', '/abs/path/']) {
      const result = await service.listWorkspace('workspace-a', query, abort)
      assert.equal(result.kind, 'unavailable', 'only the authenticated Owner peer may read Host workspace files')
    }
    assert.deepEqual(deps.registry.calls, [], 'a non-Owner request never touches the registry')
    await ctx.fiber.dispose()
  }
})

test('listWorkspace answers the OFFICIAL workspace search for the registered id, without an Agent', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'src/deep.ts': 'x', 'node_modules/hidden.ts': 'x', 'README.md': 'x' })
  const { service, ctx } = await mountService(deps, ownerInvocation())
  try {
    const result = await service.listWorkspace('workspace-a', 'deep', abort)
    assert.equal(result.kind, 'ok')
    if (result.kind === 'ok') {
      assert.deepEqual(result.items, [{ path: 'src/deep.ts', kind: 'file' }])
    }
    // The official default exclusions apply: a bare query never sees
    // node_modules, and the official result limit is 20.
    const bare = await service.listWorkspace('workspace-a', '', abort)
    assert.equal(bare.kind, 'ok')
    if (bare.kind === 'ok') {
      assert.ok(bare.items.length <= 20)
      assert.ok(bare.items.every(item => !item.path.startsWith('node_modules/')))
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('listWorkspace rejects an unregistered WorkspaceId as unavailable (never ok([]))', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, {})
  const registry = deps.registry
  const { service, ctx } = await mountService(deps, ownerInvocation())
  try {
    // The fixture answers the first read only; the scan's post-read re-check
    // then finds the registration gone.
    registry.setResultAfterFirst(undefined)
    const result = await service.listWorkspace('workspace-gone', 'a', abort)
    assert.equal(result.kind, 'unavailable')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('listWorkspace withdraws an answer whose Workspace changed during the scan', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'a.ts': 'x' })
  const { service, ctx } = await mountService(deps, ownerInvocation())
  try {
    deps.registry.setResultAfterFirst({ path: join(deps.root, 'elsewhere') })
    const result = await service.listWorkspace('workspace-a', 'a', abort)
    assert.equal(result.kind, 'unavailable', 'a replaced root during the scan never returns the old candidates')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('listWorkspace rejects an EMPTY WorkspaceId before any registry lookup', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, {})
  const { service, ctx } = await mountService(deps, ownerInvocation())
  try {
    const result = await service.listWorkspace('', 'a', abort)
    assert.equal(result.kind, 'unavailable')
    assert.deepEqual(deps.registry.calls, [], 'an empty id never reaches the registry')
  } finally {
    await ctx.fiber.dispose()
  }
})

/** Spy the PRODUCTION Host discovery driver through its prototype. The saved
 *  originals are NOT bound: `original.call(this, …)` keeps the real receiver,
 *  and teardown restores the SAME function identities. */
interface SpyableDiscoveryDriver {
  find(baseDir: string, term: string, signal: AbortSignal): Promise<readonly unknown[] | null>
  listDirectory(baseDir: string, relativeDir: string, signal: AbortSignal): Promise<readonly unknown[] | null>
}

function spyDriver(calls: string[], onList?: () => void): () => void {
  const target = DirectHostDiscoveryDriver.prototype as unknown as SpyableDiscoveryDriver
  const originalFind = target.find
  const originalList = target.listDirectory
  target.find = function (baseDir, term, signal) {
    calls.push(`find:${baseDir}:${term}`)
    return originalFind.call(this, baseDir, term, signal)
  }
  target.listDirectory = function (baseDir, relativeDir, signal) {
    calls.push(`list:${baseDir}:${relativeDir}`)
    onList?.()
    return originalList.call(this, baseDir, relativeDir, signal)
  }
  return () => {
    target.find = originalFind
    target.listDirectory = originalList
  }
}

test('listWorkspace answers an EXPLICIT scope through the shared Host scanner, never the official provider', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'src/deep/utility.ts': 'x', 'src/top.ts': 'x' })
  const { service, ctx } = await mountService(deps, ownerInvocation())
  try {
    assert.deepEqual(await service.listWorkspace('workspace-a', 'src/deep/uti', abort),
      { kind: 'ok', items: [{ path: 'src/deep/utility.ts', kind: 'file' }] })
    assert.deepEqual(deps.officialCalls, [], 'an explicit workspace scope never consults the official provider')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('listWorkspace enumerates an explicit parent scope OUTSIDE the registered root', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'inside.ts': 'x' })
  // A sibling directory next to the registry root: `../<sibling>/` from the
  // root must enumerate it, keeping the user-typed `../` prefix.
  const sibling = `${deps.root}-sibling`
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'sib.ts'), 'x')
  const { service, ctx } = await mountService(deps, ownerInvocation())
  try {
    assert.deepEqual(await service.listWorkspace('workspace-a', `../${basename(sibling)}/`, abort),
      { kind: 'ok', items: [{ path: `../${basename(sibling)}/sib.ts`, kind: 'file' }] })
  } finally {
    await ctx.fiber.dispose()
  }
})

test('listWorkspace withdraws an EXPLICIT answer whose Workspace changed during the scan', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'src/a.ts': 'x' })
  const { service, ctx } = await mountService(deps, ownerInvocation())
  try {
    deps.registry.setResultAfterFirst({ path: join(deps.root, 'elsewhere') })
    const result = await service.listWorkspace('workspace-a', 'src/', abort)
    assert.equal(result.kind, 'unavailable', 'a replaced root during an explicit scan never returns the old candidates')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('listWorkspace honors an abort that fires mid explicit-scope read', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'src/a.ts': 'x' })
  const { service, ctx } = await mountService(deps, ownerInvocation())
  const controller = new AbortController()
  const calls: string[] = []
  const restore = spyDriver(calls, () => controller.abort())
  try {
    await assert.rejects(service.listWorkspace('workspace-a', 'src/', controller.signal), /aborted/u)
    assert.ok(calls.some(entry => entry.startsWith('list:')), 'the scoped route entered the Host driver before the abort')
  } finally {
    restore()
    await ctx.fiber.dispose()
  }
})

test('a BARE workspace query stays on the official WorkspaceFileSearch and never enters the Host scanner', async (t) => {
  const life = testLifecycle(t)
  const deps = hostDeps(life, { 'src/a.ts': 'x' })
  const { service, ctx } = await mountService(deps, ownerInvocation())
  const calls: string[] = []
  const restore = spyDriver(calls)
  try {
    assert.deepEqual(await service.listWorkspace('workspace-a', 'a', abort),
      { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }] })
    assert.deepEqual(calls, [], 'a bare workspace query never enters the scoped discovery driver')
    assert.deepEqual(deps.officialCalls, [], 'the workspace bare route is not the Session official provider either')
  } finally {
    restore()
    await ctx.fiber.dispose()
  }
})
