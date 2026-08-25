/**
 * Adapter contract tests for the Direct Host-file port
 * (runtime/direct/host-file-direct.ts, migration M1.10): the port is the
 * locality boundary — `@`-reference discovery and canonicalization run
 * against the HOST filesystem through the port, never a client fs
 * assumption. These tests pin the pre-migration behavior (fd whole-tree
 * fuzzy via the fork when fd is present, the bounded recursive fallback
 * otherwise, stat existence checks, the canonicalization rules) with the
 * Direct adapter: detached path-only DTOs, abort propagation, session
 * scope resolution, and fail-closed degradation.
 * @module @xmoon76/dsh-pi-tui/host-file-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectHostFilePort, resolveFdPath } from '../src/runtime/direct/host-file-direct.ts'

/** A throwaway workspace with known files. */
function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hostfile-'))
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

/** The fallback-only adapter (fd forced absent) over a workspace scope. */
function fallbackPort(root: string): DirectHostFilePort {
  return new DirectHostFilePort((sessionId) =>
    sessionId === 'session-live' ? { session: { header: { cwd: root } } } : undefined, null)
}

test('resolveFdPath finds an executable fd on PATH and returns null otherwise', () => {
  const saved = process.env.PATH
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fd-'))
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

test('the fallback discovers paths from anywhere in the tree (path-only DTOs)', async () => {
  const root = fixtureWorkspace()
  const port = fallbackPort(root)
  const file = await port.listReferences({ kind: 'workspace', cwd: root }, '@file')
  assert.ok(file.some(item => item.path === 'file-one.txt' && item.kind === 'file'),
    `file-one missing:\n${JSON.stringify(file)}`)
  assert.ok(file.some(item => item.path === 'file-two.ts' && item.kind === 'file'),
    `file-two missing:\n${JSON.stringify(file)}`)
  const nested = await port.listReferences({ kind: 'workspace', cwd: root }, '@nested')
  assert.ok(nested.some(item => item.path === 'src/deep-nested.ts' && item.kind === 'file'),
    `nested file missing:\n${JSON.stringify(nested)}`)
  const dirs = await port.listReferences({ kind: 'workspace', cwd: root }, '@src')
  assert.ok(dirs.some(item => item.path === 'src' && item.kind === 'directory'),
    `directory item missing:\n${JSON.stringify(dirs)}`)
})

test('the fallback returns RAW paths — quoting and filtering are client-side', async () => {
  const root = fixtureWorkspace()
  const port = fallbackPort(root)
  // The port answers "which Host files exist": no `@`, no quotes, no
  // trailing slash, no query filtering (the client ranks and presents).
  const result = await port.listReferences({ kind: 'workspace', cwd: root }, '@my')
  assert.ok(result.some(item => item.path === 'my file.txt' && item.kind === 'file'),
    `the spaced path flows through raw:\n${JSON.stringify(result)}`)
  assert.ok(result.every(item => !item.path.startsWith('@') && !item.path.includes('"') && !item.path.endsWith('/')),
    `paths must be bare:\n${JSON.stringify(result.map(item => item.path))}`)
})

test('resolveReference honors an already-aborted request (fail closed, no filesystem access)', async () => {
  const root = fixtureWorkspace()
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(
    await fallbackPort(root).resolveReference({ kind: 'workspace', cwd: root }, 'file-one.txt', { signal: controller.signal }),
    { kind: 'missing' },
  )
})

test('an abort mid-scan cancels the fallback discovery', async () => {
  const root = fixtureWorkspace()
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(
    await fallbackPort(root).listReferences({ kind: 'workspace', cwd: root }, '@file', { signal: controller.signal }),
    [],
  )
})

test('the session scope resolves through the live-agent resolver; unresolvable scopes fail closed', async () => {
  const root = fixtureWorkspace()
  const port = fallbackPort(root)
  const viaSession = await port.listReferences({ kind: 'session', sessionId: 'session-live' }, '@file')
  assert.ok(viaSession.some(item => item.path === 'file-one.txt'), 'the session cwd drives discovery')
  assert.deepEqual(await port.listReferences({ kind: 'session', sessionId: 'session-other' }, '@file'), [])
  assert.deepEqual(await port.resolveReference({ kind: 'session', sessionId: 'session-other' }, 'file-one.txt'), { kind: 'missing' })
  assert.equal(await port.canonicalizeMentions({ kind: 'session', sessionId: 'session-other' }, '@file-one.txt'), '@file-one.txt')
})

test('resolveReference probes existence with the mention resolution rules', async () => {
  const root = fixtureWorkspace()
  const port = fallbackPort(root)
  const scope = { kind: 'workspace', cwd: root } as const
  assert.deepEqual(await port.resolveReference(scope, 'file-one.txt'), { kind: 'found', path: join(root, 'file-one.txt') })
  assert.deepEqual(await port.resolveReference(scope, './file-one.txt'), { kind: 'found', path: join(root, 'file-one.txt') })
  assert.deepEqual(await port.resolveReference(scope, 'missing.txt'), { kind: 'missing' })
  // ~ expands through the homedir (a nonexistent home path stays missing).
  assert.deepEqual(await port.resolveReference(scope, '~/definitely-not-a-dir-xyz'), { kind: 'missing' })
})

test('canonicalizeMentions rewrites relative, ~ and absolute mentions; missing paths stay verbatim', async () => {
  const root = fixtureWorkspace()
  const port = fallbackPort(root)
  const scope = { kind: 'workspace', cwd: root } as const
  assert.equal(
    await port.canonicalizeMentions(scope, 'look at @file-one.txt'),
    `look at @${join(root, 'file-one.txt')}`,
  )
  assert.equal(
    await port.canonicalizeMentions(scope, 'see @missing-file.ts and @src/missing.ts'),
    'see @missing-file.ts and @src/missing.ts',
  )
  assert.equal(
    await port.canonicalizeMentions(scope, 'mail user@example.com and pkg@1.0.0 stay'),
    'mail user@example.com and pkg@1.0.0 stay',
    'non-mention @ words are never touched',
  )
})

test('canonicalizeMentions absolutizes a symlink without realpath-ing it', async () => {
  const root = fixtureWorkspace()
  const target = join(root, 'file-one.txt')
  const link = join(root, 'link.ts')
  symlinkSync(target, link)
  const port = fallbackPort(root)
  const out = await port.canonicalizeMentions({ kind: 'workspace', cwd: root }, 'see @link.ts')
  assert.equal(out, `see @${link}`, 'the LINK path is the intent, never the realpath')
})

test('candidates are detached PATH-ONLY DTOs (path/kind — the official FileReferenceCandidate shape)', async () => {
  const root = fixtureWorkspace()
  const [item] = await fallbackPort(root).listReferences({ kind: 'workspace', cwd: root }, '@file')
  assert.ok(item !== undefined)
  assert.deepEqual(Object.keys(item).sort(), ['kind', 'path'])
  assert.equal(typeof item.path, 'string')
  assert.ok(item.kind === 'file' || item.kind === 'directory')
})

// ── the fd-backed branch (the fork's whole-tree fuzzy search) ─────────────

/** A fake `fd` executable: a script that prints the fixture's RELATIVE
 * paths the way real fd does (directories with a trailing `/`). The fork
 * spawns it with `--base-directory <root>` and parses stdout. */
function fakeFd(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fakefd-'))
  const script = join(dir, 'fd')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o755)
  return script
}

test('the fd branch delegates to the fork fuzzy search and returns path-only candidates', async () => {
  const root = fixtureWorkspace()
  const port = new DirectHostFilePort(() => undefined, fakeFd(
    `printf 'file-one.txt\\nfile-two.ts\\nsrc/\\nsrc/deep-nested.ts\\n'`))
  const scope = { kind: 'workspace', cwd: root } as const
  const hits = await port.listReferences(scope, '@file')
  const paths = hits.map(candidate => candidate.path)
  assert.ok(paths.includes('file-one.txt') || paths.includes('file-two.ts'),
    `the fd candidates flow through as path-only DTOs:\n${JSON.stringify(paths)}`)
  const [item] = hits
  assert.ok(item !== undefined)
  assert.deepEqual(Object.keys(item).sort(), ['kind', 'path'])
})

test('the fd branch returns RAW paths — quoting is client-side', async () => {
  const root = fixtureWorkspace()
  const port = new DirectHostFilePort(() => undefined, fakeFd(
    `printf 'my file.txt\\nsrc/\\nsrc/deep-nested.ts\\n'`))
  const hits = await port.listReferences({ kind: 'workspace', cwd: root } as const, '@"my file')
  assert.ok(hits.some(candidate => candidate.path === 'my file.txt' && candidate.kind === 'file'),
    `a spaced fd candidate must flow through as a RAW path:\n${JSON.stringify(hits.map(h => h.path))}`)
})

test('an abort mid-fd-query fails closed (the port re-checks AFTER the await)', async () => {
  const root = fixtureWorkspace()
  // A fake fd that would answer eventually but sleeps past the abort.
  const port = new DirectHostFilePort(() => undefined, fakeFd('sleep 30'))
  const controller = new AbortController()
  const pending = port.listReferences({ kind: 'workspace', cwd: root } as const, '@file', { signal: controller.signal })
  controller.abort()
  assert.deepEqual(await pending, [], 'a cancelled fd query must never serve a late result')
})

test('a failing fd yields NO candidates (fail closed, pre-migration parity)', async () => {
  const root = fixtureWorkspace()
  // Non-zero exit: real fd would have failed (e.g. a broken query); the
  // adapter returns empty rather than partial or wrong data.
  const port = new DirectHostFilePort(() => undefined, fakeFd('exit 3'))
  assert.deepEqual(
    await port.listReferences({ kind: 'workspace', cwd: root } as const, '@file'),
    [],
    'a failed fd spawn must not fabricate candidates',
  )
})
