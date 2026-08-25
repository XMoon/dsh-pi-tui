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

test('the fallback completes @ mentions from anywhere in the tree', async () => {
  const root = fixtureWorkspace()
  const port = fallbackPort(root)
  const file = await port.listReferences({ kind: 'workspace', cwd: root }, '@file')
  assert.ok(file.some(item => item.value === '@file-one.txt'), `file-one missing:\n${JSON.stringify(file)}`)
  assert.ok(file.some(item => item.value === '@file-two.ts'), `file-two missing:\n${JSON.stringify(file)}`)
  const nested = await port.listReferences({ kind: 'workspace', cwd: root }, '@nested')
  assert.ok(nested.some(item => item.value === '@src/deep-nested.ts'), `nested file missing:\n${JSON.stringify(nested)}`)
  const dirs = await port.listReferences({ kind: 'workspace', cwd: root }, '@src')
  assert.ok(dirs.some(item => item.value === '@src/' && item.label === 'src/' && item.kind === 'directory'),
    `directory item missing:\n${JSON.stringify(dirs)}`)
  assert.deepEqual(await port.listReferences({ kind: 'workspace', cwd: root }, '@zzz-nope'), [])
})

test('the fallback quotes mention values that contain spaces', async () => {
  const root = fixtureWorkspace()
  const result = await fallbackPort(root).listReferences({ kind: 'workspace', cwd: root }, '@my')
  assert.ok(result.some(item => item.value === '@"my file.txt"'), `spaced value must be quoted:\n${JSON.stringify(result)}`)
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
  assert.ok(viaSession.some(item => item.value === '@file-one.txt'), 'the session cwd drives discovery')
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

test('candidates are detached plain DTOs (value/label/description/kind)', async () => {
  const root = fixtureWorkspace()
  const [item] = await fallbackPort(root).listReferences({ kind: 'workspace', cwd: root }, '@file')
  assert.ok(item !== undefined)
  assert.deepEqual(Object.keys(item).sort(), ['description', 'kind', 'label', 'value'])
  assert.equal(typeof item.value, 'string')
  assert.equal(typeof item.label, 'string')
  assert.equal(typeof item.description, 'string')
  assert.ok(item.kind === 'file' || item.kind === 'directory')
})
