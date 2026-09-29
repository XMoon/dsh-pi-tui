/**
 * Adapter contract tests for the Direct Host-file port
 * (runtime/direct/host-file-direct.ts, migration M1.10): the port is the
 * locality boundary — `@`-reference DISCOVERY runs against the HOST
 * filesystem through the port, never a client fs assumption. These tests
 * pin the behavior (fd whole-tree fuzzy via the fork when fd is present,
 * the bounded recursive fallback otherwise, stat existence checks on the
 * Direct-only seam, and the M3-3A official literal mention semantics)
 * with the Direct adapter: detached path-only DTOs, cancellation
 * semantics, session scope resolution, and fail-closed degradation.
 * @module @xmoon76/dsh-pi-tui/host-file-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DirectHostFilePort, resolveFdPath } from '../src/runtime/direct/host-file-direct.ts'
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

test('the fallback returns RAW paths — quoting and filtering are client-side', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fallbackPort(root)
  // The port answers "which Host files exist": no `@`, no quotes, no
  // trailing slash, no query filtering (the client ranks and presents).
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

test('the session scope maps the OFFICIAL service: exact agent, official query form, detached result', async () => {
  const { port, calls } = officialPort([{ path: 'src/a.ts', kind: 'file' }, { path: 'src', kind: 'directory' }])
  const result = await port.listReferences({ kind: 'session', sessionId: 'session-live' }, 'src/fo')
  assert.deepEqual(result, { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }, { path: 'src', kind: 'directory' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.query, 'src/fo', 'the port carries the OFFICIAL query form — path text after `@`, no prefix/quotes')
  assert.ok(calls[0]!.agent !== undefined, 'the exact live Agent crosses, never a cwd string')
})

test('the session scope fails closed without the official service or a live agent', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const { port } = officialPort()
  const noAgent = await port.listReferences({ kind: 'session', sessionId: 'no-such' }, 'src/fo')
  assert.equal(noAgent.kind, 'unavailable', 'no live Agent for the session identity')
  const ctxLess = new DirectHostFilePort(() => ({ session: { header: { cwd: root } } }), null)
  const noService = await ctxLess.listReferences({ kind: 'session', sessionId: 's' }, 'src/fo')
  assert.equal(noService.kind, 'unavailable', 'the official service must be mounted')
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
