/**
 * Unit tests for @-file mention completion: prefix extraction, fd
 * resolution, and the bounded recursive fallback's ranking and quoting.
 * @module @xmoon76/dsh-pi-tui/mentions.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractAtPrefix, MentionProvider, resolveFdPath } from '../src/mentions.ts'

/** A throwaway workspace with known files. */
function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mentions-'))
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

test('extractAtPrefix finds @ tokens at token boundaries only', () => {
  assert.equal(extractAtPrefix('@'), '@')
  assert.equal(extractAtPrefix('see @fi'), '@fi')
  assert.equal(extractAtPrefix('see @fi more'), null, 'the cursor is past the @ token')
  assert.equal(extractAtPrefix('email@x'), null, 'a bare @ inside a word is not a mention')
  assert.equal(extractAtPrefix('plain text'), null)
  // `=` splits tokens, so `key=@x` starts a fresh mention (kimi semantics).
  assert.equal(extractAtPrefix('a=@x'), '@x')
  // Quoted mentions (`@"my file`) are NOT a bare @ token: the wrapper
  // delegates those to the fork's quoted-prefix completion (kimi parity).
  assert.equal(extractAtPrefix('see @"my file'), null)
})

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
  const provider = new MentionProvider([], root, null)
  // Prefix match on the basename (cursor at the end of '@file').
  const file = await provider.getSuggestions(['look at @file'], 0, 13, { signal: abort })
  assert.ok(file !== null, `@file must suggest:\n${JSON.stringify(file)}`)
  assert.equal(file.prefix, '@file')
  assert.ok(file.items.some(item => item.value === '@file-one.txt'), `file-one missing:\n${JSON.stringify(file.items)}`)
  assert.ok(file.items.some(item => item.value === '@file-two.ts'), `file-two missing:\n${JSON.stringify(file.items)}`)
  // Substring match reaches nested files too (the recursive scan).
  const nested = await provider.getSuggestions(['@nested'], 0, 7, { signal: abort })
  assert.ok(nested !== null, `@nested must suggest:\n${JSON.stringify(nested)}`)
  assert.ok(nested.items.some(item => item.value === '@src/deep-nested.ts'), `nested file missing:\n${JSON.stringify(nested.items)}`)
  // Directories rank with a trailing slash so @dir/ continues completion.
  const dirs = await provider.getSuggestions(['@src'], 0, 5, { signal: abort })
  assert.ok(dirs !== null, `@src must suggest:\n${JSON.stringify(dirs)}`)
  assert.ok(dirs.items.some(item => item.value === '@src/' && item.label === 'src/'), `directory item missing:\n${JSON.stringify(dirs.items)}`)
  // No matches: null.
  const none = await provider.getSuggestions(['@zzz-nope'], 0, 9, { signal: abort })
  assert.equal(none, null, 'no match must return null')
})

test('the fallback quotes mention values that contain spaces', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, null)
  // A space-free query matching a file whose NAME has a space must produce a
  // quoted value (`@"my file.txt"`) so the submitted mention stays one token.
  const result = await provider.getSuggestions(['@my'], 0, 3, { signal: abort })
  assert.ok(result !== null, `@my must suggest:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value === '@"my file.txt"'), `spaced value must be quoted:\n${JSON.stringify(result.items)}`)
})

test('the provider delegates slash-command completion to the inner provider', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider(
    [{ name: 'exit', description: 'Quit' }, { name: 'settings', description: 'Panel' }],
    root,
    null,
  )
  const result = await provider.getSuggestions(['/ex'], 0, 3, { signal: abort })
  assert.ok(result !== null, `/ex must suggest:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value === 'exit'), `the exit command missing:\n${JSON.stringify(result.items)}`)
})
