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
import { extractAtPrefix, MentionProvider, resolveFdPath, suggestPathArgument } from '../src/mentions.ts'

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

// ── slash-command path-argument completion (`/image <path>`) ──────────────

test('suggestPathArgument completes a bare prefix in the cwd', () => {
  const root = fixtureWorkspace()
  const items = suggestPathArgument('fi', root)
  assert.ok(items !== null, `'fi' must suggest:\n${JSON.stringify(items)}`)
  assert.ok(items.some(item => item.value === 'file-one.txt'), `file-one missing:\n${JSON.stringify(items)}`)
  assert.ok(items.some(item => item.value === 'file-two.ts'), `file-two missing:\n${JSON.stringify(items)}`)
  // Directories sort FIRST and keep the trailing slash so Tab continues.
  const dirs = suggestPathArgument('s', root)
  assert.ok(dirs !== null, `'s' must suggest:\n${JSON.stringify(dirs)}`)
  assert.equal(dirs[0]!.value, 'src/', 'directories lead the list')
  assert.equal(dirs[0]!.label, 'src/')
})

test('suggestPathArgument completes directory continuations', () => {
  const root = fixtureWorkspace()
  const contents = suggestPathArgument('src/', root)
  assert.ok(contents !== null, `'src/' must suggest:\n${JSON.stringify(contents)}`)
  assert.ok(contents.some(item => item.value === 'src/deep-nested.ts'), `nested file missing:\n${JSON.stringify(contents)}`)
  // A partial basename inside a directory keeps the directory prefix.
  const partial = suggestPathArgument('src/deep', root)
  assert.ok(partial !== null, `'src/deep' must suggest:\n${JSON.stringify(partial)}`)
  assert.ok(partial.some(item => item.value === 'src/deep-nested.ts'), `prefixed value missing:\n${JSON.stringify(partial)}`)
})

test('suggestPathArgument handles absolute and ~ forms', () => {
  const root = fixtureWorkspace()
  const absolute = suggestPathArgument(`${root}/file`, root)
  assert.ok(absolute !== null, `absolute must suggest:\n${JSON.stringify(absolute)}`)
  assert.ok(absolute.some(item => item.value === `${root}/file-one.txt`), `absolute value missing:\n${JSON.stringify(absolute)}`)
  const home = mkdtempSync(join(tmpdir(), 'dsh-mentions-home-'))
  const savedHome = process.env.HOME
  try {
    process.env.HOME = home
    mkdirSync(join(home, 'pics'))
    writeFileSync(join(home, 'pics', 'a.png'), 'x')
    const tilde = suggestPathArgument('~/p', root)
    assert.ok(tilde !== null, `'~/p' must suggest:\n${JSON.stringify(tilde)}`)
    assert.ok(tilde.some(item => item.value === '~/pics/'), `tilde value missing:\n${JSON.stringify(tilde)}`)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  }
})

test('suggestPathArgument quotes values with spaces and stays quiet otherwise', () => {
  const root = fixtureWorkspace()
  const spaced = suggestPathArgument('my', root)
  assert.ok(spaced !== null, `'my' must suggest:\n${JSON.stringify(spaced)}`)
  assert.ok(spaced.some(item => item.value === '"my file.txt"'), `spaced value must be quoted:\n${JSON.stringify(spaced)}`)
  assert.equal(suggestPathArgument('', root), null, 'an empty argument completes nothing')
  assert.equal(suggestPathArgument('a b', root), null, 'embedded spaces cannot complete (single-token only)')
  assert.equal(suggestPathArgument('no/such/dir', root), null, 'an unreadable directory stays quiet')
})

test('the provider completes /image arguments through the fork command branch', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider(
    [{ name: 'image', description: 'Attach', getArgumentCompletions: (arg) => suggestPathArgument(arg, root) }],
    root,
    null,
  )
  const result = await provider.getSuggestions(['/image fi'], 0, 9, { signal: abort })
  assert.ok(result !== null, `/image fi must suggest:\n${JSON.stringify(result)}`)
  assert.equal(result.prefix, 'fi', 'the argument prefix is the completion prefix')
  assert.ok(result.items.some(item => item.value === 'file-one.txt'), `file missing:\n${JSON.stringify(result.items)}`)
})

test('MentionProvider lets Tab file-complete a trailing-space slash argument', () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([{ name: 'image', description: 'Attach' }], root, null)
  assert.equal(provider.shouldTriggerFileCompletion(['/image'], 0, 6), false, 'a bare command name stays command completion')
  assert.equal(provider.shouldTriggerFileCompletion(['/image '], 0, 7), true, 'a trailing-space argument is a file-completion site (the fork trims it away)')
  assert.equal(provider.shouldTriggerFileCompletion(['see /tmp/'], 0, 9), true, 'plain path lines keep the fork behavior')
})
