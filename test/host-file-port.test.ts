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
import { DirectHostFilePort, resolveFdPath } from '../src/runtime/direct/host-file-direct.ts'
import { DirectHostDiscoveryDriver } from '../src/runtime/direct/file-completion/host-discovery.ts'
import { ClientLocalDiscoveryDriver } from '../src/client/file-completion/local-discovery.ts'
import type { LocalDirectoryEntry } from '../src/domain/file-completion/discovery-policy.ts'
import type { PathCandidate } from '../src/domain/file-completion/types.ts'
import { MentionProvider } from '../src/tui/interaction/autocomplete/provider.ts'
import type { HostFileScope } from '../src/runtime/host-file-port.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

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
function okItems(result: import('../src/runtime/host-file-port.ts').HostFileListResult): readonly import('../src/runtime/host-file-port.ts').HostFileCandidate[] {
  assert.equal(result.kind, 'ok')
  return result.items
}

/** The fallback-only adapter (fd forced absent) over a workspace scope. */
function fallbackPort(root: string): DirectHostFilePort {
  return new DirectHostFilePort((sessionId) =>
    sessionId === 'session-live' ? { session: { header: { cwd: root } } } : undefined, null)
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

test('the fallback discovers paths from anywhere in the tree (path-only DTOs)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  const file = okItems(await port.listReferences({ kind: 'workspace', cwd: root }, 'file'))
  assert.ok(file.some(item => item.path === 'file-one.txt' && item.kind === 'file'),
    `file-one missing:\n${JSON.stringify(file)}`)
  assert.ok(file.some(item => item.path === 'file-two.ts' && item.kind === 'file'),
    `file-two missing:\n${JSON.stringify(file)}`)
  const nested = okItems(await port.listReferences({ kind: 'workspace', cwd: root }, 'nested'))
  assert.ok(nested.some(item => item.path === 'src/deep-nested.ts' && item.kind === 'file'),
    `nested file missing:\n${JSON.stringify(nested)}`)
  const dirs = okItems(await port.listReferences({ kind: 'workspace', cwd: root }, 'src'))
  assert.ok(dirs.some(item => item.path === 'src' && item.kind === 'directory'),
    `directory item missing:\n${JSON.stringify(dirs)}`)
  // A query into a nonexistent directory is an AUTHORITATIVE empty ok,
  // never an unavailable capability.
  assert.deepEqual(await port.listReferences({ kind: 'workspace', cwd: root }, 'no-such-dir-zzz/'),
    { kind: 'ok', items: [] })
})

test('the workspace compat path returns RAW paths — quoting is the official grammar, ranking is the adapter\'s', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  // The port answers "which Host files exist" in its own ranked order: no
  // `@`, no quotes, no trailing slash. (The SESSION path's ranking is the
  // official Host authority's; the WORKSPACE compatibility path ranks
  // inside its adapter — the client only presents either way.)
  const result = okItems(await port.listReferences({ kind: 'workspace', cwd: root }, 'my'))
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
    fallbackPort(root).resolveReference({ kind: 'workspace', cwd: root }, 'file-one.txt', { signal: controller.signal }),
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
    fallbackPort(root).listReferences({ kind: 'workspace', cwd: root }, '@file', { signal: controller.signal }),
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
  const scope = { kind: 'workspace', cwd: root } as const
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
  const scope = { kind: 'workspace', cwd: root } as const
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
  const [item] = okItems(await fallbackPort(root).listReferences({ kind: 'workspace', cwd: root }, 'file'))
  assert.ok(item !== undefined)
  assert.deepEqual(Object.keys(item).sort(), ['kind', 'path'])
  assert.equal(typeof item.path, 'string')
  assert.ok(item.kind === 'file' || item.kind === 'directory')
})

test('the workspace scanner exposes a symlinked directory but never descends it (TS8-A parity)', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-hostfile-symlink-')
  mkdirSync(join(root, 'real'))
  writeFileSync(join(root, 'real', 'inside.ts'), 'x')
  symlinkSync('real', join(root, 'linkdir'))
  mkdirSync(join(root, 'dir'))
  symlinkSync(join('..', 'real'), join(root, 'dir', 'nested-link'))
  const scope = { kind: 'workspace', cwd: root } as const
  const port = fallbackPort(root)
  // The symlink itself stays a DIRECTORY candidate: a `@linkdir/` accept still
  // continues into the link.
  const link = okItems(await port.listReferences(scope, 'lin'))
  assert.ok(link.some(item => item.path === 'linkdir' && item.kind === 'directory'),
    `the symlinked directory is still a candidate: ${JSON.stringify(link)}`)
  // Its target's children are never enumerated — at the root and below it alike
  // (a descended symlink would rank `linkdir/inside.ts` exactly like the real
  // `real/inside.ts`, so this assertion is discriminating).
  const inside = okItems(await port.listReferences(scope, 'inside'))
  const paths = inside.map(item => item.path)
  assert.ok(paths.includes('real/inside.ts'), `the real directory is traversed: ${JSON.stringify(paths)}`)
  assert.ok(!paths.some(path => path.startsWith('linkdir/')), `a root symlink must not be descended: ${JSON.stringify(paths)}`)
  assert.ok(!paths.some(path => path.startsWith('dir/nested-link/')), `a deeper symlink must not be descended: ${JSON.stringify(paths)}`)
  // A scoped listing still reads the directory the user EXPLICITLY named (the
  // readdir follows the link) — the non-descent rule governs only the automatic
  // bounded subtree scan, not an explicit scope.
  const listed = okItems(await port.listReferences(scope, 'linkdir/'))
  assert.deepEqual(listed.map(item => item.path), ['linkdir/inside.ts'])
})

// ── the fd-backed branch (the fork's whole-tree fuzzy search) ─────────────

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

test('the fd branch delegates to the fork fuzzy search and returns path-only candidates', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = new DirectHostFilePort(() => undefined, fakeFd(life,
    `printf 'file-one.txt\\nfile-two.ts\\nsrc/\\nsrc/deep-nested.ts\\n'`))
  const scope = { kind: 'workspace', cwd: root } as const
  const hits = okItems(await port.listReferences(scope, 'file'))
  const paths = hits.map(candidate => candidate.path)
  assert.ok(paths.includes('file-one.txt') || paths.includes('file-two.ts'),
    `the fd candidates flow through as path-only DTOs:\n${JSON.stringify(paths)}`)
  const [item] = hits
  assert.ok(item !== undefined)
  assert.deepEqual(Object.keys(item).sort(), ['kind', 'path'])
})

test('the fd branch returns RAW paths — quoting is client-side', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = new DirectHostFilePort(() => undefined, fakeFd(life,
    `printf 'my file.txt\\nsrc/\\nsrc/deep-nested.ts\\n'`))
  const hits = okItems(await port.listReferences({ kind: 'workspace', cwd: root } as const, 'my file'))
  assert.ok(hits.some(candidate => candidate.path === 'my file.txt' && candidate.kind === 'file'),
    `a spaced fd candidate must flow through as a RAW path:\n${JSON.stringify(hits.map(h => h.path))}`)
})

test('an abort mid-fd-query cancels as a REJECTION (the port re-checks AFTER the await)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  // A fake fd that would answer eventually but sleeps past the abort.
  const port = new DirectHostFilePort(() => undefined, fakeFd(life, 'sleep 30'))
  const controller = new AbortController()
  const pending = port.listReferences({ kind: 'workspace', cwd: root } as const, '@file', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /aborted/u, 'a cancelled fd query never serves a late result and never reports unavailable')
})

test('a failing fd falls back to the bounded scan (plan §6.2 fd-first-fallback)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  // Non-zero exit: fd failed (a broken invocation). The plan's §6.2
  // contract is fd-FIRST, BOUNDED-FALLBACK — a failure is NOT a valid
  // empty result, so the recursive scan answers.
  const port = new DirectHostFilePort(() => undefined, fakeFd(life, 'exit 3'))
  const candidates = okItems(await port.listReferences({ kind: 'workspace', cwd: root } as const, 'file'))
  assert.ok(candidates.length > 0, 'a failed fd must fall back to the bounded scan')
  assert.ok(
    candidates.some(candidate => candidate.path.includes('file-one.txt')),
    `the fallback must find the fixture file:\n${JSON.stringify(candidates)}`,
  )
})

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
    // POSITIVE CONTROL: the WORKSPACE scope DOES enter the production driver (the
    // finder method AND the direct-child merge listing), so neither witness is
    // vacuous.
    const workspace = await port.listReferences({ kind: 'workspace', cwd: root }, 'file')
    assert.ok(workspace.kind === 'ok' && workspace.items.length > 0, 'the workspace scope answers locally')
    assert.ok(calls.some(entry => entry.startsWith('find:')), `the workspace scope enters find(): ${JSON.stringify(calls)}`)
    assert.ok(calls.some(entry => entry.startsWith('list:')), `the workspace merge lists children: ${JSON.stringify(calls)}`)
    assert.equal(existsSync(marker), true, 'the workspace scope runs the finder process')
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
    const workspace = await port.listReferences({ kind: 'workspace', cwd: root }, 'file')
    assert.ok(workspace.kind === 'ok' && workspace.items.length > 0, 'the workspace scope answers locally')
    assert.ok(directCalls.length > 0, `the Direct witness fires on the workspace scope: ${JSON.stringify(directCalls)}`)
  } finally {
    restore()
  }
})
