/**
 * Unit tests for @-file mention completion: prefix extraction, fd
 * resolution, and the bounded recursive fallback's ranking and quoting.
 * @module @xmoon76/dsh-pi-tui/mentions.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { extractAtPrefix, MentionProvider, resolveFdPath, resolvePathSearch, suggestPathArgument } from '../src/mentions.ts'

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

test('suggestPathArgument tolerates leading separator whitespace (multi-space / tab-expanded)', () => {
  const root = fixtureWorkspace()
  // The fork's argument branch passes everything after the FIRST space, so
  // a multi-space separator yields leading whitespace in the argument; the
  // completed VALUE keeps it so the fork's apply never glues the path to
  // the command.
  const multi = suggestPathArgument('  fi', root)
  assert.ok(multi !== null, `'  fi' must suggest:\n${JSON.stringify(multi)}`)
  assert.ok(multi.some(item => item.value === '  file-one.txt'), `leading whitespace must survive in the value:\n${JSON.stringify(multi)}`)
  // A tab-expanded directory continuation (tabs normalize to four spaces).
  const dir = suggestPathArgument('    src/', root)
  assert.ok(dir !== null, `'    src/' must suggest:\n${JSON.stringify(dir)}`)
  assert.ok(dir.some(item => item.value === '    src/deep-nested.ts'), `padded continuation missing:\n${JSON.stringify(dir)}`)
  // Pure separator (no token) stays quiet.
  assert.equal(suggestPathArgument('   ', root), null, 'separator-only arguments complete nothing')
})

test('POSIX and Windows ROOT partials keep their separator as the search dir', () => {
  // dirname leaves a trailing separator ONLY on roots, and a root must
  // stay a root: `/et` reads `/` (a stripped `/` would read `''`),
  // `C:\Wi` reads `C:\` (not the drive-relative `C:`), and the UNC share
  // root keeps its trailing separator. Pure — no filesystem involved.
  assert.deepEqual(resolvePathSearch('/et', '/ws', '/et'), { searchDir: '/', searchPrefix: 'et', winAbsolute: false })
  assert.deepEqual(resolvePathSearch('C:\\Wi', '/ws', 'C:\\Wi'), { searchDir: 'C:\\', searchPrefix: 'Wi', winAbsolute: true })
  assert.deepEqual(resolvePathSearch('\\\\server\\share\\fo', '/ws', '\\\\server\\share\\fo'), {
    searchDir: '\\\\server\\share\\',
    searchPrefix: 'fo',
    winAbsolute: true,
  })
  // Ordinary dirs carry no trailing separator anyway.
  assert.deepEqual(resolvePathSearch('C:\\Users\\sh', '/ws', 'C:\\Users\\sh'), { searchDir: 'C:\\Users', searchPrefix: 'sh', winAbsolute: true })
  assert.deepEqual(resolvePathSearch('/tmp/fi', '/ws', '/tmp/fi'), { searchDir: '/tmp', searchPrefix: 'fi', winAbsolute: false })
  assert.deepEqual(resolvePathSearch('sub/fi', '/ws', 'sub/fi'), { searchDir: join('/ws', 'sub'), searchPrefix: 'fi', winAbsolute: false })
})

test('a POSIX root partial completes from `/` (fs level, when /tmp exists)', () => {
  if (!existsSync('/tmp')) return // the machine has no /tmp to complete
  const root = fixtureWorkspace()
  const items = suggestPathArgument('/tm', root)
  assert.ok(items !== null && items.length > 0, `'/tm' must list root entries:\n${JSON.stringify(items)}`)
  assert.ok(items.some(item => item.value.startsWith('/tmp')), `the root completion stays absolute:\n${JSON.stringify(items)}`)
})

test('suggestPathArgument treats Windows drive and UNC tokens as absolute', () => {
  const root = fixtureWorkspace()
  const savedCwd = process.cwd()
  try {
    // win32-absolute tokens resolve against the process CWD on POSIX (a
    // backslash is an ordinary character there), so literal
    // backslash-named directories stand in for the Windows drive/share.
    // chdir is safe here: node --test runs each FILE in its own process
    // and this test restores the cwd in `finally`.
    process.chdir(root)
    mkdirSync(join(root, 'C:\\Users'))
    writeFileSync(join(root, 'C:\\Users', 'shot.png'), 'x')
    // The UNC share ROOT keeps its trailing separator (win32 root form):
    // readdirSync('\\server\share\') is legal on Windows, and the root
    // must not be stripped into a different path.
    mkdirSync(join(root, '\\\\server\\share\\'))
    writeFileSync(join(root, '\\\\server\\share\\', 'foo.png'), 'x')
    const drive = suggestPathArgument('C:\\Users\\sh', root)
    assert.ok(drive !== null, `a drive token must complete:\\n${JSON.stringify(drive)}`)
    assert.ok(drive.some(item => item.value === 'C:\\Users\\shot.png'), `drive value keeps the backslash dialect:\\n${JSON.stringify(drive)}`)
    const unc = suggestPathArgument('\\\\server\\share\\fo', root)
    assert.ok(unc !== null, `a UNC token must complete:\\n${JSON.stringify(unc)}`)
    assert.ok(unc.some(item => item.value === '\\\\server\\share\\foo.png'), `UNC value keeps the share form:\\n${JSON.stringify(unc)}`)
  } finally {
    process.chdir(savedCwd)
  }
})

test('a drive ROOT keeps `C:\\` — never degrades to the drive-relative `C:`', () => {
  // `C:\` is the drive root; `C:` is the drive-relative current directory
  // — different directories on Windows. win32.dirname('C:\\Wi') returns
  // `C:\\`, and the search target must stay `C:\\` (the earlier
  // unconditional strip turned it into `C:` and read the wrong place).
  assert.equal(win32.dirname('C:\\Wi'), 'C:\\', 'the win32 dirname root form')
  const root = fixtureWorkspace()
  const savedCwd = process.cwd()
  try {
    process.chdir(root)
    // A POSIX dir literally named `C:\` stands in for the drive root.
    mkdirSync(join(root, 'C:\\'))
    writeFileSync(join(root, 'C:\\', 'Win.exe'), 'x')
    const items = suggestPathArgument('C:\\Wi', root)
    assert.ok(items !== null, `the drive root must complete:\\n${JSON.stringify(items)}`)
    assert.ok(items.some(item => item.value === 'C:\\Win.exe'), `drive-root value stays rooted:\\n${JSON.stringify(items)}`)
  } finally {
    process.chdir(savedCwd)
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

test('MentionProvider lets Tab file-complete a trailing-space PATH argument only', () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider(
    [
      { name: 'image', description: 'Attach', getArgumentCompletions: () => null },
      { name: 'help', description: 'Help' },
    ],
    root,
    null,
  )
  assert.equal(provider.shouldTriggerFileCompletion(['/image'], 0, 6), false, 'a bare command name stays command completion')
  assert.equal(provider.shouldTriggerFileCompletion(['/image '], 0, 7), true, 'a trailing-space PATH argument is a file-completion site (the fork trims it away)')
  assert.equal(provider.shouldTriggerFileCompletion(['/image\t'], 0, 7), true, 'a trailing-TAB PATH argument is a file-completion site too (tab is a fork path delimiter)')
  assert.equal(provider.shouldTriggerFileCompletion(['/image\tfo'], 0, 9), true, 'a TAB-separated PATH argument completes files')
  assert.equal(provider.shouldTriggerFileCompletion(['/help '], 0, 6), false, 'a NON-path command keeps the fork judgment (a trailing space never lists files)')
  assert.equal(provider.shouldTriggerFileCompletion(['/help\t'], 0, 6), false, 'a NON-path command keeps the fork judgment for a trailing TAB too')
  assert.equal(provider.shouldTriggerFileCompletion(['/help foo'], 0, 9), true, 'non-path commands keep the fork behavior for real arguments')
  assert.equal(provider.shouldTriggerFileCompletion(['see /tmp/'], 0, 9), true, 'plain path lines keep the fork behavior')
})
