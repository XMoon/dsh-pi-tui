/**
 * Adapter contract tests for the Direct Host-file port
 * (runtime/direct/host-file-direct.ts, migration M1.10, scoped route
 * TS8-HF1): the port is the locality boundary — `@`-reference DISCOVERY runs
 * against the HOST filesystem through the port, never a client fs assumption.
 * These tests pin the behavior (a BARE session query delegates the official
 * authority, an EXPLICIT path scope uses the Host scanner, the WORKSPACE
 * compatibility scan, stat existence checks on the Direct-only seam, and the
 * M3-3A official literal mention semantics) with the Direct adapter: detached
 * path-only DTOs, cancellation semantics, session scope resolution, and
 * fail-closed degradation.
 * @module @xmoon76/dsh-pi-tui/host-file-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DirectHostFilePort, resolveFdPath } from '../../src/runtime/direct/host-file-direct.ts'
import { isExplicitHostFileQuery } from '../../src/runtime/direct/host-file-augmentation-direct.ts'
import { RemoteHostFilePort } from '../../src/runtime/remote/host-file-remote.ts'
import { createPiTuiHostFileReferenceRuntime } from '../../src/runtime/remote/pi-tui-file-reference-host-bridge.ts'
import { createObservableGenerationHarness } from '../support/remote-generation.ts'
import { DirectHostDiscoveryDriver } from '../../src/runtime/direct/file-completion/host-discovery.ts'
import { ClientLocalDiscoveryDriver } from '../../src/client/file-completion/local-discovery.ts'
import type { LocalDirectoryEntry } from '../../src/domain/file-completion/discovery-policy.ts'
import type { PathCandidate } from '../../src/domain/file-completion/types.ts'
import { MentionProvider } from '../../src/tui/interaction/autocomplete/provider.ts'
import type { HostFileScope } from '../../src/runtime/host-file-port.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

/** A throwaway workspace with known files. */
function fixtureWorkspace(life: TestLifecycle): string {
  const root = life.tempDir('dsh-hostfile-')
  writeFileSync(join(root, 'file-one.txt'), 'one')
  writeFileSync(join(root, 'file-two.ts'), 'two')
  writeFileSync(join(root, 'my file.txt'), 'spaced')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep-nested.ts'), 'deep')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), 'ignored')
  return root
}

/** A workspace nested under a parent that also holds a sibling directory, so
 * explicit parent navigation (`../shared/fo`) has a controlled target. */
function nestedWorkspace(life: TestLifecycle): { parent: string; root: string } {
  const parent = life.tempDir('dsh-hostfile-parent-')
  const root = join(parent, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'file-one.txt'), 'one')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep-nested.ts'), 'deep')
  mkdirSync(join(parent, 'shared'))
  writeFileSync(join(parent, 'shared', 'foo.txt'), 'shared')
  return { parent, root }
}

const abort = new AbortController().signal

/** Unwrap an authoritative ok result (the tests only assert ok paths). */
function okItems(result: import('../../src/runtime/host-file-port.ts').HostFileListResult): readonly import('../../src/runtime/host-file-port.ts').HostFileCandidate[] {
  assert.equal(result.kind, 'ok')
  return result.items
}

/** The fallback-only adapter (fd forced absent) over a workspace scope. The
 *  workspace scope resolves through the OFFICIAL Host registry + official
 *  `WorkspaceFileSearch`, never a cwd and never the legacy scanner. */
const WORKSPACE_ID = 'workspace-live'

function workspaceContext(root: string, extra: {
  readonly official?: unknown
  /** The root every `get` answers (default: the fixture root). */
  readonly workspace?: { readonly path: string } | undefined
  /** The root `get` answers from the SECOND read onward (the post-scan
   *  re-check): a replacement root, or `undefined` to simulate removal. */
  readonly workspaceAfterFirst?: { readonly path: string } | undefined
} = {}): { get(name: string): unknown } {
  let reads = 0
  const registry = {
    create: async () => { throw new Error('the workspace fixture never creates') },
    list: () => [],
    get: (id: string) => {
      if (id !== WORKSPACE_ID) return undefined
      reads += 1
      if (reads > 1 && 'workspaceAfterFirst' in extra) return extra.workspaceAfterFirst
      return extra.workspace ?? { path: root }
    },
  }
  return {
    get(name: string) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'fileReferences') return extra.official
      return undefined
    },
  }
}

function workspaceScope(selectionRevision = 1): HostFileScope {
  return { kind: 'workspace', workspaceId: WORKSPACE_ID, selectionRevision }
}

function fallbackPort(root: string, extra: Parameters<typeof workspaceContext>[1] = {}): DirectHostFilePort {
  return new DirectHostFilePort(
    (sessionId) => sessionId === 'session-live' ? { session: { header: { cwd: root } } } : undefined,
    null,
    workspaceContext(root, extra),
  )
}

/** A recorded official `ctx.fileReferences` service stand-in. */
function officialService(candidates: readonly { path: string; kind: 'file' | 'directory' }[] = []) {
  const calls: Array<{ agent: unknown; query: string; signal: AbortSignal | undefined }> = []
  return {
    calls,
    service: {
      list: async (agent: unknown, query: string, signal?: AbortSignal) => {
        calls.push({ agent, query, signal })
        return candidates
      },
    },
  }
}

/** A session-scoped adapter over the official service stand-in. */
function officialPort(candidates?: readonly { path: string; kind: 'file' | 'directory' }[]): {
  port: DirectHostFilePort
  calls: Array<{ agent: unknown; query: string; signal: AbortSignal | undefined }>
} {
  const official = officialService(candidates)
  const live = { session: { header: { cwd: '/ws' } } }
  const port = new DirectHostFilePort(
    (sessionId) => sessionId === 'session-live' ? live : undefined,
    null,
    { get: (name: string) => name === 'fileReferences' ? official.service : undefined },
  )
  return { port, calls: official.calls }
}

test('resolveFdPath finds an executable fd on PATH and returns null otherwise', (t) => {
  const life = testLifecycle(t)
  const saved = process.env.PATH
  try {
    const dir = life.tempDir('dsh-fd-')
    const fd = join(dir, 'fd')
    writeFileSync(fd, '#!/bin/sh\nexit 0\n')
    chmodSync(fd, 0o755)
    process.env.PATH = dir
    assert.equal(resolveFdPath(), fd, 'the fd binary must resolve')
    process.env.PATH = '/nonexistent-dir'
    assert.equal(resolveFdPath(), null, 'a PATH without fd must yield null')
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
})

test('the workspace scope runs the OFFICIAL search: bare fuzzy, directory scope and the official exclusions', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  const file = okItems(await port.listReferences(workspaceScope(), 'file'))
  assert.ok(file.some(item => item.path === 'file-one.txt' && item.kind === 'file'),
    `file-one missing:\n${JSON.stringify(file)}`)
  assert.ok(file.some(item => item.path === 'file-two.ts' && item.kind === 'file'),
    `file-two missing:\n${JSON.stringify(file)}`)
  const nested = okItems(await port.listReferences(workspaceScope(), 'deep'))
  assert.ok(nested.some(item => item.path === 'src/deep-nested.ts' && item.kind === 'file'),
    `nested file missing:\n${JSON.stringify(nested)}`)
  const dirs = okItems(await port.listReferences(workspaceScope(), 'src'))
  assert.ok(dirs.some(item => item.path === 'src' && item.kind === 'directory'),
    `directory item missing:\n${JSON.stringify(dirs)}`)
  // A query into a nonexistent directory is an AUTHORITATIVE empty ok,
  // never an unavailable capability.
  assert.deepEqual(await port.listReferences(workspaceScope(), 'no-such-dir-zzz/'),
    { kind: 'ok', items: [] })
  // The official default exclusions apply: `.git` content never appears.
  const ignored = okItems(await port.listReferences(workspaceScope(), 'config'))
  assert.ok(!ignored.some(item => item.path.startsWith('.git/')),
    `the official excluded directories stay out: ${JSON.stringify(ignored)}`)
})

test('an UNSELECTED workspace scope answers unavailable without any Host read', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  let registryReads = 0
  const ctx = {
    get(name: string) {
      if (name !== 'workspaceRegistry') return undefined
      registryReads += 1
      return { create: async () => { throw new Error('never') }, list: () => [], get: () => undefined }
    },
  }
  const port = new DirectHostFilePort(() => undefined, null, ctx)
  const result = await port.listReferences({ kind: 'workspace', selectionRevision: 1 }, 'file')
  assert.equal(result.kind, 'unavailable')
  assert.match(result.kind === 'unavailable' ? result.reason : '', /Choose a Host workspace first/u)
  assert.equal(registryReads, 0, 'an unselected scope never touches the registry')

  const missing = await port.listReferences({ kind: 'workspace', workspaceId: 'not-registered', selectionRevision: 2 }, 'file')
  assert.equal(missing.kind, 'unavailable')
  // The root is irrelevant here: the registry is the ONLY path authority.
  assert.ok(root !== '')
})

test('an EXPLICIT workspace path scope enumerates the Host scope the user typed, bare fuzzy still bounds to the root', async (t) => {
  const life = testLifecycle(t)
  const { parent, root } = nestedWorkspace(life)
  const port = fallbackPort(root)
  // BARE fuzzy keeps the official index: a file OUTSIDE the registered root is
  // never auto-discovered by a bare query (the official WorkspaceFileSearch
  // only walks the root).
  assert.deepEqual(await port.listReferences(workspaceScope(), 'foo'),
    { kind: 'ok', items: [] }, 'bare fuzzy never scans outside the registered root')
  // An explicit parent scope enumerates the outside directory and keeps the
  // `../` prefix the user typed (Host cwd = the registry root).
  assert.deepEqual(await port.listReferences(workspaceScope(), '../shared/'),
    { kind: 'ok', items: [{ path: '../shared/foo.txt', kind: 'file' }] })
  // An explicit ABSOLUTE Host scope enumerates outside with its absolute path.
  assert.deepEqual(await port.listReferences(workspaceScope(), `${parent}/shared/`),
    { kind: 'ok', items: [{ path: `${parent}/shared/foo.txt`, kind: 'file' }] })
  // The home shorthand returns ABSOLUTE Host paths (never a literal `~/...`).
  const home = await port.listReferences(workspaceScope(), '~/')
  assert.equal(home.kind, 'ok')
  if (home.kind === 'ok') {
    assert.ok(home.items.length > 0, 'the Host HOME directory lists')
    for (const item of home.items) {
      assert.ok(isAbsolute(item.path) && !item.path.startsWith('~'),
        `every home-shorthand candidate is an ABSOLUTE Host path: ${item.path}`)
      assert.ok(item.path.startsWith(homedir()), `the Host HOME scope drives discovery: ${item.path}`)
    }
  }
})

test('an explicit workspace scope reaches officially-excluded and symlinked directories', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-hostfile-ws-excluded-')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), 'x')
  const target = life.tempDir('dsh-hostfile-ws-target-')
  writeFileSync(join(target, 'inside.ts'), 'x')
  symlinkSync(target, join(root, 'shared-link'))
  const port = fallbackPort(root)
  // An explicitly named officially-excluded directory is searchable when typed.
  assert.deepEqual(okItems(await port.listReferences(workspaceScope(), './.git/')),
    [{ path: './.git/config', kind: 'file' }])
  // An explicitly named symlink scope: searchable, never recursively descended.
  assert.deepEqual(okItems(await port.listReferences(workspaceScope(), 'shared-link/')),
    [{ path: 'shared-link/inside.ts', kind: 'file' }])
})

test('explicit workspace candidates are bare path/kind DTOs, keep the typed prefix and literal mentions', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  const result = okItems(await port.listReferences(workspaceScope(), 'src/'))
  const [item] = result
  assert.ok(item !== undefined)
  assert.deepEqual(Object.keys(item).sort(), ['kind', 'path'])
  assert.deepEqual(result, [{ path: 'src/deep-nested.ts', kind: 'file' }])
  // A quote/mention typed in the prompt stays literal on the workspace scope.
  assert.equal(
    await port.canonicalizeMentions(workspaceScope(), 'see @src/deep-nested.ts and "../shared/foo"'),
    'see @src/deep-nested.ts and "../shared/foo"',
  )
})

test('the bare/explicit classifier is a PURE token decision (POSIX and Windows adjacency)', () => {
  const posix = { homeDir: '/home/x', windowsHost: false }
  const windows = { homeDir: 'C:\\Users\\x', windowsHost: true }
  // POSIX: `/` is the only separator; `\` is a filename character and is left
  // to the official provider (fail closed), never claimed as a scope.
  for (const raw of ['', 'foo', 'a\\b']) {
    assert.equal(isExplicitHostFileQuery(raw, posix), false, `POSIX bare ${JSON.stringify(raw)}`)
  }
  for (const raw of ['.', '..', '~', 'src/', 'a/b', '/abs', '../shared', './']) {
    assert.equal(isExplicitHostFileQuery(raw, posix), true, `POSIX explicit ${JSON.stringify(raw)}`)
  }
  // Windows: `\` is a separator too, and any win32-absolute form is explicit.
  for (const raw of ['', 'foo']) {
    assert.equal(isExplicitHostFileQuery(raw, windows), false, `Windows bare ${JSON.stringify(raw)}`)
  }
  for (const raw of ['.', '..', '~', 'C:/x', 'C:\\x', 'a\\b', '\\\\server\\share', 'src/']) {
    assert.equal(isExplicitHostFileQuery(raw, windows), true, `Windows explicit ${JSON.stringify(raw)}`)
  }
})

test('the workspace scope returns RAW paths — quoting is the official grammar, ranking is the Host authority\'s', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  // The Host authority owns ranking/quoting: the adapter returns the official
  // `FileReferenceCandidate` values (no `@`, no quotes, no trailing slash).
  const result = okItems(await port.listReferences(workspaceScope(), 'my file'))
  assert.ok(result.some(item => item.path === 'my file.txt' && item.kind === 'file'),
    `the spaced path flows through raw:\n${JSON.stringify(result)}`)
  assert.ok(result.every(item => !item.path.startsWith('@') && !item.path.includes('"') && !item.path.endsWith('/')),
    `paths must be bare:\n${JSON.stringify(result.map(item => item.path))}`)
})

test('resolveReference honors an already-aborted request as CANCELLATION (no filesystem access)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const controller = new AbortController()
  controller.abort()
  // Cancellation is its own outcome (the M3-3A failure vocabulary): the
  // probe rejects, never reporting unavailable or asserting missing.
  await assert.rejects(
    fallbackPort(root).resolveReference(workspaceScope(), 'file-one.txt', { signal: controller.signal }),
    /aborted/u,
  )
})

test('a cancelled discovery rejects even with an UNRESOLVABLE scope (cancellation outranks unavailable)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    fallbackPort(root).listReferences({ kind: 'session', sessionId: 'no-such-agent' }, '@file', { signal: controller.signal }),
    /aborted/u,
    'the entry-time cancellation check precedes the unresolvable-scope unavailable')
  await assert.rejects(
    fallbackPort(root).resolveReference({ kind: 'session', sessionId: 'no-such-agent' }, 'file', { signal: controller.signal }),
    /aborted/u,
    'the entry-time cancellation check precedes the unresolvable-scope unavailable (resolve)')
})

test('an abort mid-scan cancels the fallback discovery (a rejection, never unavailable)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    fallbackPort(root).listReferences(workspaceScope(), '@file', { signal: controller.signal }),
    /aborted/u,
    'a cancelled discovery rejects — Direct and Remote share the one cancellation semantic')
})

test('a BARE session query maps the OFFICIAL service: exact agent, official query form, detached result', async () => {
  const { port, calls } = officialPort([{ path: 'src/a.ts', kind: 'file' }, { path: 'src', kind: 'directory' }])
  const result = await port.listReferences({ kind: 'session', sessionId: 'session-live' }, 'src')
  assert.deepEqual(result, { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }, { path: 'src', kind: 'directory' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.query, 'src', 'the port carries the OFFICIAL query form — path text after `@`, no prefix/quotes')
  assert.ok(calls[0]!.agent !== undefined, 'the exact live Agent crosses, never a cwd string')
})

test('the session scope fails closed without a live agent, and an explicit scope needs no official service', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const { port } = officialPort()
  const noAgent = await port.listReferences({ kind: 'session', sessionId: 'no-such' }, 'src')
  assert.equal(noAgent.kind, 'unavailable', 'no live Agent for the session identity')
  // A ctx-less construction (no official service): the BARE route is
  // unavailable, while the EXPLICIT route answers from the Host scanner.
  const ctxLess = new DirectHostFilePort(() => ({ session: { header: { cwd: root } } }), null)
  const noService = await ctxLess.listReferences({ kind: 'session', sessionId: 's' }, 'src')
  assert.equal(noService.kind, 'unavailable', 'the official service must be mounted for a bare query')
  assert.deepEqual(await ctxLess.listReferences({ kind: 'session', sessionId: 's' }, 'src/'),
    { kind: 'ok', items: [{ path: 'src/deep-nested.ts', kind: 'file' }] },
    'an explicit scope route works without the official capability')
  assert.equal((await ctxLess.resolveReference({ kind: 'session', sessionId: 's' }, 'file-one.txt')).kind, 'found',
    'the Direct-only existence seam still resolves through the agent cwd')
})

test('resolveReference probes existence with the mention resolution rules', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  const scope = workspaceScope()
  assert.deepEqual(await port.resolveReference(scope, 'file-one.txt'), { kind: 'found', path: join(root, 'file-one.txt') })
  assert.deepEqual(await port.resolveReference(scope, './file-one.txt'), { kind: 'found', path: join(root, 'file-one.txt') })
  // Bare `~` resolves to the Host home directory itself, not `<cwd>/~`
  // (the Direct diagnostic path resolution's home expansion, proven through
  // the public port behavior).
  assert.deepEqual(await port.resolveReference(scope, '~'), { kind: 'found', path: homedir() })
  assert.deepEqual(await port.resolveReference(scope, 'missing.txt'), { kind: 'missing' })
  // ~ expands through the homedir (a nonexistent home path stays missing).
  assert.deepEqual(await port.resolveReference(scope, '~/definitely-not-a-dir-xyz'), { kind: 'missing' })
})

test('canonicalizeMentions returns the text VERBATIM (the official mention semantics)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  const scope = workspaceScope()
  // The official client codec is `serialize: ref => ref` and the Host's
  // FILE_REFERENCE_PROMPT resolves relative paths from the workspace root:
  // the submitted text stays literal — on BOTH backends — with no
  // existence probe or absolute rewrite at send time.
  assert.equal(
    await port.canonicalizeMentions(scope, 'look at @file-one.txt'),
    'look at @file-one.txt',
  )
  assert.equal(
    await port.canonicalizeMentions(scope, 'see @"my file.txt" and @src/deep-nested.ts'),
    'see @"my file.txt" and @src/deep-nested.ts',
    'quoted and relative forms stay exactly as typed',
  )
  assert.equal(
    await port.canonicalizeMentions(scope, 'mail user@example.com and pkg@1.0.0 stay'),
    'mail user@example.com and pkg@1.0.0 stay',
  )
  // The unresolvable scope behaves identically: literal on every path.
  assert.equal(
    await port.canonicalizeMentions({ kind: 'session', sessionId: 'no-such-agent' }, '@file-one.txt'),
    '@file-one.txt',
  )
})

test('candidates are detached PATH-ONLY DTOs (path/kind — the official FileReferenceCandidate shape)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const [item] = okItems(await fallbackPort(root).listReferences(workspaceScope(), 'file'))
  assert.ok(item !== undefined)
  assert.deepEqual(Object.keys(item).sort(), ['kind', 'path'])
  assert.equal(typeof item.path, 'string')
  assert.ok(item.kind === 'file' || item.kind === 'directory')
})

/** A fake `fd` executable: a script that prints the fixture's RELATIVE
 * paths the way real fd does (directories with a trailing `/`). The fork
 * spawns it with `--base-directory <root>` and parses stdout. */
function fakeFd(life: TestLifecycle, body: string): string {
  const dir = life.tempDir('dsh-fakefd-')
  const script = join(dir, 'fd')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o755)
  return script
}

// ── session-vs-workspace routing (source -> route -> sink) ────────────────

/** The two facts one discovery driver answers with (the spy target shape). */
interface SpyableDiscoveryDriver {
  find(baseDir: string, term: string, signal: AbortSignal): Promise<readonly PathCandidate[] | null>
  listDirectory(baseDir: string, relativeDir: string, signal: AbortSignal): Promise<readonly LocalDirectoryEntry[] | null>
}

/**
 * Record every entry the PRODUCTION discovery driver is asked for. The
 * consumers construct their drivers themselves, so the spy is installed on the
 * class prototype those instances resolve through — the recorded calls are the
 * real consumer's, including the fs-only fallback path that never spawns a
 * finder.
 *
 * The saved originals are deliberately NOT bound: `original.call(this, ...)`
 * keeps the real receiver (a `.bind` clone would pin the prototype and hide
 * instance state). Teardown restores the SAME function identities.
 */
function spyDriver(target: SpyableDiscoveryDriver, calls: string[]): () => void {
  const originalFind = target.find
  const originalList = target.listDirectory
  target.find = function (baseDir, term, signal) {
    calls.push(`find:${baseDir}:${term}`)
    return originalFind.call(this, baseDir, term, signal)
  }
  target.listDirectory = function (baseDir, relativeDir, signal) {
    calls.push(`list:${baseDir}:${relativeDir}`)
    return originalList.call(this, baseDir, relativeDir, signal)
  }
  return () => {
    target.find = originalFind
    target.listDirectory = originalList
    if (target.find !== originalFind || target.listDirectory !== originalList) {
      throw new Error('a discovery driver spy was not fully restored')
    }
  }
}

test('a BARE session query routes to the official service ONLY — the Host scanner is never entered', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  // Independent sink witness: the pinned finder records its OWN process run, so
  // the fd spawn side is observable even beyond the driver call.
  const marker = join(life.tempDir('dsh-hostfile-route-'), 'finder-ran')
  const finder = fakeFd(life,
    `printf '%s' ran > ${JSON.stringify(marker)}\nprintf 'file-one.txt\\0'`)
  const calls: string[] = []
  const restoreDirect = spyDriver(DirectHostDiscoveryDriver.prototype, calls)
  try {
    // The Host authority's own answer — deliberately NOT anything the local
    // workspace scan would return for the same query.
    const official = officialService([{ path: 'host-answer/only.ts', kind: 'file' }])
    const live = { session: { header: { cwd: root } } }
    const port = new DirectHostFilePort(
      (sessionId) => sessionId === 'session-live' ? live : undefined,
      finder,
      { get: (name: string) => name === 'fileReferences' ? official.service : undefined },
    )
    // 1. A non-empty Host answer crosses verbatim, in the Host's order.
    assert.deepEqual(await port.listReferences({ kind: 'session', sessionId: 'session-live' }, 'file'),
      { kind: 'ok', items: [{ path: 'host-answer/only.ts', kind: 'file' }] },
      'the bare session scope returns the official answer verbatim')
    assert.equal(official.calls.length, 1, 'exactly one official Host list request')
    assert.equal(official.calls[0]!.query, 'file', 'the official query form crossed')
    // 2. An EMPTY Host answer stays authoritative empty — never a local fallback.
    const emptyService = new DirectHostFilePort(() => live, finder, { get: () => ({ list: async () => [] }) })
    assert.deepEqual(await emptyService.listReferences({ kind: 'session', sessionId: 'session-live' }, 'file'),
      { kind: 'ok', items: [] })
    // 3. An UNMOUNTED official capability stays unavailable for a BARE query —
    // never a local fallback.
    const unmounted = new DirectHostFilePort(() => live, finder)
    assert.equal((await unmounted.listReferences({ kind: 'session', sessionId: 'session-live' }, 'file')).kind,
      'unavailable')
    // 4. A FAILING official carrier rejects — never a local fallback.
    const failing = new DirectHostFilePort(() => live, finder, {
      get: () => ({ list: async () => { throw new Error('carrier down') } }),
    })
    await assert.rejects(failing.listReferences({ kind: 'session', sessionId: 'session-live' }, 'file'), /carrier down/)
    // THE FORBIDDEN SINK (both the finder process and the fs-only scan) never ran.
    // Snapshot before the assertion: `deepEqual(x, [])` narrows x itself to
    // `never[]`, which would break the positive-control reads below.
    const sessionCalls = [...calls]
    assert.deepEqual(sessionCalls, [], 'no Host find/listDirectory call for a bare session query')
    assert.equal(existsSync(marker), false, 'the Host finder process never spawned for a bare session query')
    // POSITIVE CONTROL: the EXPLICIT session scope DOES enter the production
    // driver (and its finder process), so neither witness is vacuous.
    const explicit = await port.listReferences({ kind: 'session', sessionId: 'session-live' }, 'src/')
    assert.ok(explicit.kind === 'ok' && explicit.items.length > 0, 'the explicit scope answers from the Host scanner')
    assert.ok(calls.some(entry => entry.startsWith('find:') || entry.startsWith('list:')),
      `the explicit scope enters the Host driver: ${JSON.stringify(calls)}`)
    assert.equal(existsSync(marker), false,
      'the explicit directory listing does not need the whole-tree finder process')
  } finally {
    restoreDirect()
  }
})

test('an EXPLICIT session path scope routes to the Host scanner ONLY — the official service is never entered', async (t) => {
  const life = testLifecycle(t)
  const { root } = nestedWorkspace(life)
  const calls: string[] = []
  const restoreDirect = spyDriver(DirectHostDiscoveryDriver.prototype, calls)
  try {
    const official = officialService([{ path: 'host-answer/only.ts', kind: 'file' }])
    const live = { session: { header: { cwd: root } } }
    // `null` pins the bounded Host fallback so the scan is deterministic.
    const port = new DirectHostFilePort(
      (sessionId) => sessionId === 'session-live' ? live : undefined,
      null,
      { get: (name: string) => name === 'fileReferences' ? official.service : undefined },
    )
    // A scoped listing reads ONLY the typed directory and keeps its prefix.
    assert.deepEqual(await port.listReferences({ kind: 'session', sessionId: 'session-live' }, 'src/'),
      { kind: 'ok', items: [{ path: 'src/deep-nested.ts', kind: 'file' }] })
    // A scoped recursive fuzzy query searches inside that scope.
    assert.ok((await port.listReferences({ kind: 'session', sessionId: 'session-live' }, 'src/deep'))
      .kind === 'ok')
    // An explicit parent scope resolves against the HOST session cwd and keeps
    // the `../` prefix the user typed.
    assert.deepEqual(await port.listReferences({ kind: 'session', sessionId: 'session-live' }, '../shared/fo'),
      { kind: 'ok', items: [{ path: '../shared/foo.txt', kind: 'file' }] })
    // The official capability is never consulted on the explicit route.
    assert.equal(official.calls.length, 0, 'no official Host list request for an explicit scope')
    assert.ok(calls.some(entry => entry.startsWith('list:') || entry.startsWith('find:')),
      `the explicit scope enters the Host driver: ${JSON.stringify(calls)}`)
    // An UNMOUNTED official capability is irrelevant on the explicit route.
    const unmounted = new DirectHostFilePort(() => live, null)
    const scoped = await unmounted.listReferences({ kind: 'session', sessionId: 'session-live' }, 'src/')
    assert.ok(scoped.kind === 'ok' && scoped.items.length > 0,
      'an explicit scope route works without the official capability')
  } finally {
    restoreDirect()
  }
})

test('the explicit session scope reaches excluded, symlinked and absolute Host directories through the port', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-hostfile-scopes-')
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'chunk.js'), 'x')
  const target = life.tempDir('dsh-hostfile-target-')
  writeFileSync(join(target, 'inside.ts'), 'x')
  symlinkSync(target, join(root, 'shared-link'))
  const outside = life.tempDir('dsh-hostfile-abs-')
  mkdirSync(join(outside, 'logs'))
  writeFileSync(join(outside, 'logs', 'a.log'), 'x')
  const port = new DirectHostFilePort(() => ({ session: { header: { cwd: root } } }), null)
  const scope = { kind: 'session', sessionId: 'session-live' } as const
  // An explicitly named directory the official workspace index excludes.
  assert.deepEqual(okItems(await port.listReferences(scope, 'dist/ch')),
    [{ path: 'dist/chunk.js', kind: 'file' }])
  // An explicitly named symlink scope: searchable, never recursively descended.
  assert.deepEqual(okItems(await port.listReferences(scope, 'shared-link/')),
    [{ path: 'shared-link/inside.ts', kind: 'file' }])
  // A Host-absolute scope outside the workspace, with no containment rule.
  assert.deepEqual(okItems(await port.listReferences(scope, `${outside}/logs/`)),
    [{ path: `${outside}/logs/a.log`, kind: 'file' }])
})

test('the Host-home shorthand returns an ABSOLUTE Host path, never a literal ~/... value', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = new DirectHostFilePort(() => ({ session: { header: { cwd: root } } }), null)
  const listed = await port.listReferences({ kind: 'session', sessionId: 's' }, '~/')
  assert.equal(listed.kind, 'ok')
  if (listed.kind === 'ok') {
    assert.ok(listed.items.length > 0, 'the Host HOME directory lists')
    for (const item of listed.items) {
      assert.ok(isAbsolute(item.path) && !item.path.startsWith('~'),
        `every home-shorthand candidate is an ABSOLUTE Host path: ${item.path}`)
      assert.ok(item.path.startsWith(homedir()), `the Host HOME scope drives discovery: ${item.path}`)
    }
  }
})

test('the provider-level Session @ path never falls back to the Client filesystem (port -> MentionProvider)', async (t) => {
  const life = testLifecycle(t)
  // `fixtureWorkspace` holds file-one.txt / file-two.ts / my file.txt / src, so
  // the local completion capability WOULD answer a `@file` query from the very
  // same Client cwd — a fallback is visible in the suggestions AND in the Client
  // witness below.
  const root = fixtureWorkspace(life)
  const finder = fakeFd(life, `printf 'file-one.txt\\0'`)
  // Both locality sinks are observed: the Direct WORKSPACE scanner (the Host
  // side) and the CLIENT filesystem capability. Neither may run for a session
  // scope, and neither witness may be vacuous (positive controls below).
  const directCalls: string[] = []
  const clientCalls: string[] = []
  const restoreDirect = spyDriver(DirectHostDiscoveryDriver.prototype, directCalls)
  const restoreClient = spyDriver(ClientLocalDiscoveryDriver.prototype, clientCalls)
  const restore = () => {
    restoreClient()
    restoreDirect()
  }
  try {
    const live = { session: { header: { cwd: root } } }
    const sessionScope = (): HostFileScope => ({ kind: 'session', sessionId: 'session-live' })
    // The `/image` command makes the Client path-argument chain reachable on the
    // SAME provider instance; `localFdPath = null` pins the Client finder to the
    // bounded fallback so every local row would come from `root` itself.
    const imageCommand = [{ name: 'image', description: 'Attach', getArgumentCompletions: () => null }]
    const providerOf = (fileReferences: DirectHostFilePort): MentionProvider =>
      new MentionProvider(imageCommand, root, fileReferences, undefined, sessionScope, null)
    // 1. A non-empty Host answer in an order a local ranking would change.
    const official = officialService([{ path: 'zeta.ts', kind: 'file' }, { path: 'alpha.ts', kind: 'file' }])
    const port = new DirectHostFilePort(() => live, finder, { get: () => official.service })
    const provider = providerOf(port)
    const ordered = await provider.getSuggestions(['@zeta'], 0, 5, { signal: abort })
    assert.ok(ordered !== null, 'the Host answer must complete through the provider')
    assert.deepEqual(ordered.items.map(item => item.value), ['@zeta.ts', '@alpha.ts'],
      'the Host order is preserved with no local row and no local ranking')
    // 2.-4. An EMPTY, UNMOUNTED and FAILING Host capability must never fall back
    // to the Client filesystem (nor to the Direct workspace scanner).
    const emptyService = new DirectHostFilePort(() => live, finder, { get: () => ({ list: async () => [] }) })
    assert.equal(await providerOf(emptyService).getSuggestions(['@file'], 0, 5, { signal: abort }), null,
      'an authoritative-empty Host answer stays empty — `@file-one.txt` must not appear')
    const unmounted = new DirectHostFilePort(() => live, finder)
    assert.equal(await providerOf(unmounted).getSuggestions(['@file'], 0, 5, { signal: abort }), null,
      'an unmounted Host capability stays unavailable — never a Client fallback')
    const failing = new DirectHostFilePort(() => live, finder, {
      get: () => ({ list: async () => { throw new Error('carrier down') } }),
    })
    assert.equal(await providerOf(failing).getSuggestions(['@file'], 0, 5, { signal: abort }), null,
      'a failing Host carrier stays empty — never a Client fallback')
    // THE FORBIDDEN SINKS: neither scanner was entered for ANY session-scope
    // request. (`deepEqual(x, [])` narrows x itself to `never[]`, so the
    // snapshots keep the positive-control reads below type-safe.)
    const sessionDirect = [...directCalls]
    const sessionClient = [...clientCalls]
    assert.deepEqual(sessionDirect, [], 'no Direct workspace scan for a session scope')
    assert.deepEqual(sessionClient, [], 'no Client filesystem scan for a session scope')
    // POSITIVE CONTROLS: each witness fires on its OWN legitimate chain.
    const image = await provider.getSuggestions(['/image file'], 0, 11, { signal: abort })
    assert.ok(image !== null && image.items.some(item => item.value === 'file-one.txt'),
      `the Client path-argument chain completes from the Client fixture: ${JSON.stringify(image)}`)
    assert.ok(clientCalls.some(entry => entry.startsWith('find:')),
      `the Client witness fires on the Client chain: ${JSON.stringify(clientCalls)}`)
    assert.ok(clientCalls.some(entry => entry.startsWith('list:')),
      `the Client witness observes the fallback listing too: ${JSON.stringify(clientCalls)}`)
    // The WORKSPACE scope uses the OFFICIAL search, so it does not touch the
    // Direct scanner at all (the scope no longer has a legacy scan path).
    const workspacePort = new DirectHostFilePort(() => undefined, finder, workspaceContext(root))
    const workspace = await workspacePort.listReferences(workspaceScope(), 'file')
    assert.ok(workspace.kind === 'ok' && workspace.items.length > 0, 'the workspace scope answers from the official search')
    assert.deepEqual(directCalls, [], 'the official workspace scope never enters the Direct scanner')
  } finally {
    restore()
  }
})

test('Direct and Remote resolve the SAME workspace query through the ONE shared bare + explicit Host semantics', async (t) => {
  const life = testLifecycle(t)
  const { parent, root } = nestedWorkspace(life)
  writeFileSync(join(root, 'my file.txt'), 'x')
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'dep.ts'), 'x')
  const direct = fallbackPort(root)
  const runtime = createPiTuiHostFileReferenceRuntime({
    agentFor: () => undefined,
    official: () => undefined,
    // Deterministic bounded fallback on BOTH sides so the parity compares the
    // shared policy, never a machine-specific fd availability.
    fdPath: null,
    workspaces: () => ({ get: id => id === WORKSPACE_ID ? { path: root } : undefined }),
  })
  const generation = createObservableGenerationHarness()
  const remote = new RemoteHostFilePort({
    list: async () => { throw new Error('the parity fixture never uses the session verb') },
    listWorkspace: async (workspaceId, query, signal) => ({
      ok: true,
      value: await runtime.listWorkspace(workspaceId, query, signal ?? new AbortController().signal),
    }),
  }, generation.source)
  try {
    // BARE fuzzy, a bare directory name, and EXPLICIT scopes (relative,
    // absolute, parent `..`) must all answer identically across the backends.
    for (const query of ['', 'file', 'my file', 'src', 'src/', 'deep', 'no-such-zzz/', './', 'src/de', '../shared/', `${parent}/shared/`]) {
      assert.deepEqual(
        await remote.listReferences(workspaceScope(1), query),
        await direct.listReferences(workspaceScope(1), query),
        `the two backends must return the same candidates for ${JSON.stringify(query)}`,
      )
    }
    // The official exclusions hold on both: the ONLY `hidden` match lives in
    // node_modules, so both backends answer an authoritative empty bare list.
    assert.deepEqual(await direct.listReferences(workspaceScope(), 'hidden'),
      { kind: 'ok', items: [] })
    assert.deepEqual(await remote.listReferences(workspaceScope(), 'hidden'),
      { kind: 'ok', items: [] })
  } finally {
    runtime.dispose()
  }
})

test('a Workspace replaced or removed during the Direct official scan retires the stale candidates', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const replacedRoot = life.tempDir('dsh-hostfile-replaced-')
  writeFileSync(join(replacedRoot, 'replaced.ts'), 'x')

  // The registry's SECOND read (the post-scan re-check) answers the
  // replacement root: the first scan's candidates belong to the old tree.
  const replaced = fallbackPort(root, { workspaceAfterFirst: { path: replacedRoot } })
  const result = await replaced.listReferences(workspaceScope(), 'file')
  assert.equal(result.kind, 'unavailable')
  assert.match(result.kind === 'unavailable' ? result.reason : '', /changed during discovery/u,
    `the replaced root must not present the old scan: ${JSON.stringify(result)}`)

  // A REMOVED registration during the scan is the same fence: no stale ok.
  const removed = fallbackPort(root, { workspaceAfterFirst: undefined })
  const gone = await removed.listReferences(workspaceScope(), 'file')
  assert.equal(gone.kind, 'unavailable')
  assert.match(gone.kind === 'unavailable' ? gone.reason : '', /changed during discovery/u)

  // POSITIVE CONTROL: an unchanged registry still answers from the scan.
  const stable = fallbackPort(root)
  const ok = await stable.listReferences(workspaceScope(), 'file')
  assert.ok(ok.kind === 'ok' && ok.items.length > 0, 'the unchanged registry keeps its answer')
})
