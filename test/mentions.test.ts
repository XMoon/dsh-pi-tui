/**
 * Unit tests for @-file mention completion: prefix extraction, fd
 * resolution, and the bounded recursive fallback's ranking and quoting.
 * @module @xmoon76/dsh-pi-tui/mentions.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { expandFileMentionsForSubmit, extractAtPrefix, findFileMentions, MentionProvider, resolvePathSearch, suggestPathArgument } from '../src/mentions.ts'
import { DirectHostFilePort, resolveFdPath } from '../src/runtime/direct/host-file-direct.ts'

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

/** The fallback-only seam: the real Direct adapter with fd FORCED absent,
 * so the bounded recursive scan is what the completion exercises. */
function fallbackSeam(): DirectHostFilePort {
  return new DirectHostFilePort(() => undefined, null)
}

/** The stat-backed existence probe (the Direct adapter's own). */
const exists = (candidate: string): boolean => {
  try {
    statSync(candidate)
    return true
  } catch {
    return false
  }
}

test('extractAtPrefix finds @ tokens at token boundaries only', () => {
  assert.equal(extractAtPrefix('@'), '@')
  assert.equal(extractAtPrefix('see @fi'), '@fi')
  assert.equal(extractAtPrefix('see @fi more'), null, 'the cursor is past the @ token')
  assert.equal(extractAtPrefix('email@x'), null, 'a bare @ inside a word is not a mention')
  assert.equal(extractAtPrefix('plain text'), null)
  // `=` splits tokens, so `key=@x` starts a fresh mention (kimi semantics).
  assert.equal(extractAtPrefix('a=@x'), '@x')
  // Quoted mentions (`@"my file`) complete through the Host-file port
  // with the fork's quoted-prefix grammar (migration M1.10 parity).
  assert.equal(extractAtPrefix('see @"my file'), '@"my file')
  assert.equal(extractAtPrefix('@"closed" then @next'), '@next', 'a CLOSED quote is not an open quoted prefix')
  // CJK-glued mentions complete too (the findFileMentions grammar: a CJK
  // sentence glues the mention to the previous character).
  assert.equal(extractAtPrefix('看看@src/foo'), '@src/foo')
  assert.equal(extractAtPrefix('看@'), '@')
  assert.equal(extractAtPrefix('a@b.c'), null, 'an ASCII word never starts a mention (email parity)')
  assert.equal(extractAtPrefix('see @fi more'), null, 'the cursor is past the @ token')
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
  const provider = new MentionProvider([], root, fallbackSeam())
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

test('the provider completes the QUOTED @ form through the port (quoted values)', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, fallbackSeam())
  const result = await provider.getSuggestions(['@"my'], 0, 4, { signal: abort })
  assert.ok(result !== null, `@"my must suggest:\n${JSON.stringify(result)}`)
  assert.equal(result.prefix, '@"my')
  assert.ok(result.items.some(item => item.value === '@"my file.txt"'), `quoted value must stay quoted:\n${JSON.stringify(result.items)}`)
})

test('the provider completes a CJK-glued @ mention (the findFileMentions grammar)', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, fallbackSeam())
  const result = await provider.getSuggestions(['看看@file'], 0, 7, { signal: abort })
  assert.ok(result !== null, `看看@file must suggest:\n${JSON.stringify(result)}`)
  assert.equal(result.prefix, '@file')
  assert.ok(result.items.some(item => item.value === '@file-one.txt'), `CJK-glued completion missing:\n${JSON.stringify(result.items)}`)
})

test('the fallback quotes mention values that contain spaces', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, fallbackSeam())
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
    fallbackSeam(),
  )
  const result = await provider.getSuggestions(['/ex'], 0, 3, { signal: abort })
  assert.ok(result !== null, `/ex must suggest:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value === 'exit'), `the exit command missing:\n${JSON.stringify(result.items)}`)
})

// ── slash-command path-argument completion (`/image <path>`) ──────────────

test('a late port result is dropped when the request was aborted; a port rejection degrades to null', async () => {
  const root = fixtureWorkspace()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const controller = new AbortController()
  const seam: import('../src/runtime/host-file-port.ts').HostFilePort = {
    listReferences: async (_scope, _query, options) => {
      await gate
      options?.signal?.throwIfAborted()
      return [{ path: 'file-one.txt', kind: 'file' }]
    },
    resolveReference: async () => ({ kind: 'missing' }),
    canonicalizeMentions: async (_scope, text) => text,
  }
  const provider = new MentionProvider([], root, seam)
  const pending = provider.getSuggestions(['@file'], 0, 5, { signal: controller.signal })
  controller.abort() // the request is cancelled while discovery is in flight
  release!()
  assert.equal(await pending, null, 'an aborted request must never commit a late result')
  const throwing: import('../src/runtime/host-file-port.ts').HostFilePort = {
    listReferences: async () => { throw new Error('discovery exploded') },
    resolveReference: async () => ({ kind: 'missing' }),
    canonicalizeMentions: async (_scope, text) => text,
  }
  const resilient = new MentionProvider([], root, throwing)
  assert.equal(
    await resilient.getSuggestions(['@file'], 0, 5, { signal: abort }),
    null,
    'a discovery rejection degrades to no suggestions, never a crash',
  )
})

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
    fallbackSeam(),
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
    fallbackSeam(),
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

// ── send-time mention canonicalization (the 2026-08-22 plan, item 7) ─────

test('findFileMentions finds boundary @ tokens in both bare and quoted forms', () => {
  const text = 'see @src/foo.ts and @"my file.txt" plus user@example.com'
  const mentions = findFileMentions(text)
  assert.equal(mentions.length, 2, `email @ must not parse:\n${JSON.stringify(mentions)}`)
  assert.deepEqual(mentions[0], { start: 4, end: 15, path: 'src/foo.ts', quoted: false })
  assert.deepEqual(mentions[1], { start: 20, end: 34, path: 'my file.txt', quoted: true })
})

test('a quoted mention immediately followed by another mention is not swallowed', () => {
  // Round-2 review finding: `@"a.txt"@b.txt` — the scanner advanced past
  // the char right after the closing quote, silently dropping the second
  // mention.
  const mentions = findFileMentions('@"a.txt"@b.txt')
  assert.equal(mentions.length, 2, `the second mention must parse:\n${JSON.stringify(mentions)}`)
  assert.deepEqual(mentions[0], { start: 0, end: 8, path: 'a.txt', quoted: true })
  assert.deepEqual(mentions[1], { start: 8, end: 14, path: 'b.txt', quoted: false })
})

test('findFileMentions stops at CJK sentence punctuation and strips ASCII trailing punctuation', () => {
  // No space before the mention: the CJK boundary rule accepts it.
  const mentions = findFileMentions('看看@src/deep-nested.ts，然后…')
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0]!.path, 'src/deep-nested.ts', 'a CJK comma must end the token, not join the path')
  // The token range excludes the comma (the rewrite keeps it as text).
  assert.equal('看看@src/deep-nested.ts，然后…'.slice(mentions[0]!.start, mentions[0]!.end), '@src/deep-nested.ts')
  // ASCII trailing punctuation is stripped from the PATH; the span ends
  // BEFORE the punctuation so the rewrite never swallows it.
  const ascii = findFileMentions('see @file-one.txt, ok')
  assert.equal(ascii.length, 1)
  assert.equal(ascii[0]!.path, 'file-one.txt')
  assert.equal('see @file-one.txt, ok'.slice(ascii[0]!.start, ascii[0]!.end), '@file-one.txt',
    'the punctuation must stay OUTSIDE the replaced span')
})

test('expandFileMentionsForSubmit keeps stripped ASCII punctuation as text', async () => {
  // Round-1 review finding: `@file.ts,` must become `@/abs/file.ts,` — the
  // trailing comma is sentence punctuation, never part of the path, and the
  // rewrite must not eat it.
  const root = fixtureWorkspace()
  assert.equal(
    await expandFileMentionsForSubmit('see @file-one.txt, then do X', root, exists),
    `see @${join(root, 'file-one.txt')}, then do X`,
  )
  assert.equal(
    await expandFileMentionsForSubmit('see @file-one.txt.', root, exists),
    `see @${join(root, 'file-one.txt')}.`,
  )
})

test('expandFileMentionsForSubmit canonicalizes a mention inside a CJK sentence', async () => {
  const root = fixtureWorkspace()
  assert.equal(
    await expandFileMentionsForSubmit('看看@src/deep-nested.ts，然后继续', root, exists),
    `看看@${join(root, 'src', 'deep-nested.ts')}，然后继续`,
    'the CJK punctuation stays as text after the absolute path',
  )
})

test('expandFileMentionsForSubmit canonicalizes relative, ./ and ../ mentions', async () => {
  const root = fixtureWorkspace()
  assert.equal(
    await expandFileMentionsForSubmit(`please look at @file-one.txt`, root, exists),
    `please look at @${join(root, 'file-one.txt')}`,
  )
  assert.equal(
    await expandFileMentionsForSubmit('see @./file-one.txt', root, exists),
    `see @${join(root, 'file-one.txt')}`,
  )
  // A ../ mention resolves OUTSIDE the workspace root: build a dedicated
  // parent/child pair so the parent file really exists.
  const parent = mkdtempSync(join(tmpdir(), 'dsh-mentions-parent-'))
  const child = join(parent, 'child')
  mkdirSync(child)
  writeFileSync(join(parent, 'sibling.txt'), 'sib')
  assert.equal(
    await expandFileMentionsForSubmit('up @../sibling.txt', child, exists),
    `up @${join(parent, 'sibling.txt')}`,
  )
})

test('expandFileMentionsForSubmit keeps absolute forms and expands ~ to the homedir', async () => {
  const root = fixtureWorkspace()
  const absolute = join(root, 'file-one.txt')
  // Absolute: unchanged (already canonical).
  assert.equal(await expandFileMentionsForSubmit(`abs @${absolute}`, root, exists), `abs @${absolute}`)
  // `@~/` resolves to the homedir itself (always exists — no fixture
  // needed under $HOME).
  assert.equal(await expandFileMentionsForSubmit('home @~/', root, exists), `home @${homedir()}`)
  // A home-relative path under a real home entry: use the homedir itself
  // as the mention target through the `~` prefix only when the home has a
  // stable entry; otherwise the bare `~/` case above already pins the
  // grammar.
  const candidates = ['.bashrc', '.gitconfig', '.zshrc', '.profile', '.dsh']
  const homeTarget = candidates.find(name => existsSync(join(homedir(), name)))
  if (homeTarget !== undefined) {
    assert.equal(
      await expandFileMentionsForSubmit(`home @~/${homeTarget}`, root, exists),
      `home @${join(homedir(), homeTarget)}`,
      'a real home-relative mention must expand through the homedir',
    )
  }
})

test('expandFileMentionsForSubmit leaves nonexistent paths verbatim', async () => {
  const root = fixtureWorkspace()
  assert.equal(
    await expandFileMentionsForSubmit('see @missing-file.ts and @src/missing.ts', root, exists),
    'see @missing-file.ts and @src/missing.ts',
    'nonexistent mentions must never be rewritten',
  )
  // A typo with punctuation stays untouched too.
  assert.equal(await expandFileMentionsForSubmit('see @missin.ts, ok', root, exists), 'see @missin.ts, ok')
})

test('expandFileMentionsForSubmit absolutizes a symlink without realpath-ing it', async () => {
  const root = fixtureWorkspace()
  const link = join(root, 'link.ts')
  symlinkSync('file-one.txt', link)
  const out = await expandFileMentionsForSubmit('see @link.ts', root, exists)
  assert.equal(out, `see @${link}`, 'the link path itself is the canonical form (never the target)')
})

test('expandFileMentionsForSubmit keeps quotes for spaced paths and never touches emails', async () => {
  const root = fixtureWorkspace()
  assert.equal(
    await expandFileMentionsForSubmit(`see @"my file.txt"`, root, exists),
    `see @"${join(root, 'my file.txt')}"`,
    'quoted mentions keep their quotes around the absolute path',
  )
  assert.equal(
    await expandFileMentionsForSubmit('mail user@example.com and pkg@1.0.0 stay', root, exists),
    'mail user@example.com and pkg@1.0.0 stay',
    'non-boundary @ tokens are never mentions',
  )
})

test('expandFileMentionsForSubmit rewrites MULTIPLE mentions in one line', async () => {
  const root = fixtureWorkspace()
  const out = await expandFileMentionsForSubmit('a @file-one.txt b @src/deep-nested.ts c', root, exists)
  assert.equal(out, `a @${join(root, 'file-one.txt')} b @${join(root, 'src', 'deep-nested.ts')} c`)
})

test('findFileMentions stops at an unterminated quote and keeps later text safe', async () => {
  const text = 'see @"unclosed and then @file-one.txt'
  assert.deepEqual(findFileMentions(text), [], 'an unterminated quote must not fabricate mentions')
  // The expander therefore leaves the line untouched (safe for the submit).
  assert.equal(await expandFileMentionsForSubmit(text, '/ws', exists), text)
})

test('the completion scope is resolved at SUGGESTION time, so a session switch needs no reinstall', async () => {
  // The reviewer repro (rebase review round 1): the provider is installed
  // while session A is live, then the runner switches to session B. A
  // scope captured at INSTALL time would keep resolving A (stale session,
  // fail-closed empty discovery after the switch); a LIVE scope source
  // resolves the CURRENT session on the very next suggestion.
  const root = fixtureWorkspace()
  const scopes: import('../src/runtime/host-file-port.ts').HostFileScope[] = []
  const seam: import('../src/runtime/host-file-port.ts').HostFilePort = {
    listReferences: async (scope) => {
      scopes.push(scope)
      return [{ path: 'file-one.txt', kind: 'file' }]
    },
    resolveReference: async () => ({ kind: 'missing' }),
    canonicalizeMentions: async (_scope, text) => text,
  }
  // The runner's live agent — the scope source reads it at suggestion time.
  let liveAgent: { session: { id: string } } | undefined = { session: { id: 'session-a' } }
  const provider = new MentionProvider([], root, seam, undefined, () =>
    liveAgent === undefined
      ? { kind: 'workspace', cwd: root }
      : { kind: 'session', sessionId: liveAgent.session.id })
  await provider.getSuggestions(['@file'], 0, 5, { signal: abort })
  assert.deepEqual(scopes[0], { kind: 'session', sessionId: 'session-a' }, 'the first suggestion resolves session A')
  // The session switch: the SAME provider instance is queried again (no
  // reinstall — the editor keeps the installed provider across the switch).
  liveAgent = { session: { id: 'session-b' } }
  await provider.getSuggestions(['@file'], 0, 5, { signal: abort })
  assert.deepEqual(scopes[1], { kind: 'session', sessionId: 'session-b' }, 'the switch is picked up without a reinstall')
  // And a sessionless install (deferred start) resolves the workspace.
  liveAgent = undefined
  await provider.getSuggestions(['@file'], 0, 5, { signal: abort })
  assert.deepEqual(scopes[2], { kind: 'workspace', cwd: root }, 'the sessionless fallback resolves the workspace')
})

test('a scope switch MID-FLIGHT drops the in-flight candidate list (no cross-session commit)', async () => {
  // The reviewer repro (rebase review round 3): a discovery started under
  // session A settles AFTER the live agent moved to B. The request is NOT
  // aborted (a session switch does not cancel editor completion), so the
  // port's own abort check cannot help — the provider must re-verify the
  // scope identity after the await and drop A's candidates.
  const root = fixtureWorkspace()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const seam: import('../src/runtime/host-file-port.ts').HostFilePort = {
    listReferences: async () => {
      await gate
      return [{ path: 'file-one.txt', kind: 'file' }]
    },
    resolveReference: async () => ({ kind: 'missing' }),
    canonicalizeMentions: async (_scope, text) => text,
  }
  let liveAgent: { session: { id: string } } | undefined = { session: { id: 'session-a' } }
  const provider = new MentionProvider([], root, seam, undefined, () =>
    liveAgent === undefined
      ? { kind: 'workspace', cwd: root }
      : { kind: 'session', sessionId: liveAgent.session.id })
  const pending = provider.getSuggestions(['@file'], 0, 5, { signal: abort })
  // The switch lands while the discovery is in flight (no abort).
  liveAgent = { session: { id: 'session-b' } }
  release!()
  assert.equal(await pending, null, 'a result resolved for the OLD session must never commit')
})
