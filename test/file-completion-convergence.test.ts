/**
 * The file-completion convergence regression suite (the 2026-08-27 plan):
 * P1.1–P1.5, the §23 matrix, and the §24 headless A–E integration flows.
 * These tests pin the CONVERGED contract — file completion ONLY on `@...`
 * and `/image ...`, scoped `@` paths, shared fuzzy ranking, directory
 * continuation, fd/fdfind detection, stale-apply fencing, and the sessionless
 * scope walk. The engine modules are pure; the provider/port/app layers are
 * exercised through the real chain (TuiApp + VirtualTerminal + MentionProvider
 * + DirectHostFilePort).
 * @module @xmoon76/dsh-pi-tui/file-completion-convergence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, win32, sep } from 'node:path'
import { classifyFileCompletionContext, extractAtPrefix } from '../src/file-completion/context.ts'
import { resolvePathQuery } from '../src/file-completion/query.ts'
import { scorePathCandidate } from '../src/file-completion/ranking.ts'
import { presentPathCandidate } from '../src/file-completion/presentation.ts'
import { MentionProvider } from '../src/mentions.ts'
import { DirectHostFilePort, resolveFdPath } from '../src/runtime/direct/host-file-direct.ts'

const abort = new AbortController().signal

/** Poll until the predicate is true (asserts after a 3s deadline). */
async function pollUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) assert.fail(`${label}: condition never became true`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The LIVE autocomplete state of the app's host editor (the seat's
 * capability seam — the stable assertion, never a viewport needle). */
function isAutocompleteActive(app: import('../src/tui-app.ts').TuiApp): boolean {
  return (app.seatEditorForTest() as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() === true
}

/** A root with workspace + sibling for outside-cwd probes. */
function outsideCwdFixture(): { root: string; workspace: string; sibling: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-conv-out-'))
  const workspace = join(root, 'workspace')
  const sibling = join(root, 'sibling')
  mkdirSync(workspace)
  mkdirSync(sibling)
  writeFileSync(join(workspace, 'local.txt'), 'x')
  writeFileSync(join(sibling, 'sibling-file.ts'), 'x')
  return { root, workspace, sibling }
}

/** A workspace whose subtree holds MORE than the fallback scan bound, so a
 * root-level `src/` with a wanted file must still complete after accept. */
function largeWorkspaceFixture(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-conv-large-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'wanted.ts'), 'x')
  const filler = join(root, 'filler')
  mkdirSync(filler)
  for (let index = 0; index < 2200; index += 1) {
    writeFileSync(join(filler, `f-${index}.txt`), 'x')
  }
  return { root }
}

test('P1.1: ordinary prompt positions never open the HOST file dropdown', async () => {
  const { root } = largeWorkspaceFixture()
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  for (const [line, col] of [
    ['foo', 3],
    ['./foo', 5],
    ['../foo', 6],
    ['/tmp/foo', 8],
    ['hello foo', 9],
    ['hello ./foo', 11],
  ] as const) {
    const natural = await provider.getSuggestions([line], 0, col, { signal: abort, force: false })
    assert.equal(natural, null, `natural ${JSON.stringify(line)} must be null`)
    const forced = await provider.getSuggestions([line], 0, col, { signal: abort, force: true })
    assert.equal(forced, null, `forced Tab ${JSON.stringify(line)} must be null`)
  }
})

test('P1.1 headless: foo<Tab> opens no dropdown (isShowingAutocomplete stays false)', async () => {
  const { root } = largeWorkspaceFixture()
  const { startApp } = await import('./support/app-harness.ts')
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  vt.sendInput('foo')
  await vt.waitForRender()
  vt.sendInput('\t')
  // The STABLE assertion: the host editor's autocomplete state stays
  // closed — never a viewport-needle-only check. Poll the closed state
  // over the editor's whole debounce window (no fixed sleep): a late
  // request cannot slip by unnoticed.
  const deadline = Date.now() + 400
  for (;;) {
    assert.equal(isAutocompleteActive(app), false, 'foo<Tab> must never open a dropdown')
    if (Date.now() > deadline) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('wanted.ts'), `foo<Tab> must not list files:\n${view}`)
  assert.equal(app.seatTextForTest(), 'foo', 'the draft is untouched')
  app.stop()
})

test('P1.2: scoped @ paths search their OWN directory (outside the cwd)', async () => {
  const { root, workspace, sibling } = outsideCwdFixture()
  const provider = new MentionProvider([], workspace, new DirectHostFilePort(() => undefined, null))
  const result = await provider.getSuggestions(['@../sibling/sib'], 0, 15, { signal: abort })
  assert.ok(result !== null, `@../sibling/sib must suggest:\n${JSON.stringify(result)}`)
  assert.ok(
    result.items.some(item => item.value === '@../sibling/sibling-file.ts'),
    `scoped value missing:\n${JSON.stringify(result.items)}`,
  )
  void root
})

test('P1.2: @../../scope resolves outside the cwd by the typed amount', async () => {
  // A REAL ../../ fixture: workspace = /root/alpha/beta/workspace; `../..`
  // resolves to /root/alpha, so `../../alpha` targets /root/alpha/alpha.
  // The file two levels up lives under alpha/alpha/deep.ts.
  const root = mkdtempSync(join(tmpdir(), 'dsh-conv-upup-'))
  const alpha = join(root, 'alpha')
  const beta = join(alpha, 'beta')
  const workspace = join(beta, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(alpha, 'alpha'), { recursive: true })
  writeFileSync(join(alpha, 'alpha', 'deep.ts'), 'x')
  mkdirSync(join(alpha, 'alpha', 'deep'), { recursive: true })
  writeFileSync(join(alpha, 'alpha', 'deep', 'nested.txt'), 'x')
  const provider = new MentionProvider([], workspace, new DirectHostFilePort(() => undefined, null))
  // /root/alpha/beta/workspace + ../../alpha = /root/alpha/alpha.
  const result = await provider.getSuggestions(['@../../alpha/de'], 0, 16, { signal: abort })
  assert.ok(result !== null, `@../../alpha/de must suggest:\n${JSON.stringify(result)}`)
  assert.ok(
    result.items.some(item => item.value === '@../../alpha/deep.ts'),
    `../../ scope value missing:\n${JSON.stringify(result.items)}`,
  )
  const nested = await provider.getSuggestions(['@../../alpha/deep/nes'], 0, 22, { signal: abort })
  assert.ok(nested !== null && nested.items.some(item => item.value === '@../../alpha/deep/nested.txt'),
    `nested ../../ value missing:\n${JSON.stringify(nested)}`)
})

test('P1.2: @~/ resolves through the homedir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-conv-home-'))
  mkdirSync(join(home, 'pics'))
  writeFileSync(join(home, 'pics', 'a.png'), 'x')
  const saved = process.env.HOME
  try {
    process.env.HOME = home
    const provider = new MentionProvider([], tmpdir(), new DirectHostFilePort(() => undefined, null))
    const result = await provider.getSuggestions(['@~/pics/a'], 0, 10, { signal: abort })
    assert.ok(result !== null, `@~/pics/a must suggest:\n${JSON.stringify(result)}`)
    assert.ok(result.items.some(item => item.value === '@~/pics/a.png'))
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
  }
})

test('P1.2 absolute: @/tmp/ searches the absolute scope', async () => {
  const root = outsideCwdFixture().root
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const target = mkdtempSync(join(tmpdir(), 'dsh-conv-abs-'))
  writeFileSync(join(target, 'deep-abs.txt'), 'x')
  const result = await provider.getSuggestions([`@${target}/abs`], 0, `@${target}/abs`.length, { signal: abort })
  assert.ok(result !== null, `absolute must suggest:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value.startsWith(`@${target}`)))
})

test('§23 matrix: /image shares the scoped forms (../, ~/, absolute, directory continuation)', async () => {
  // ../../ fixture for /image: workspace = /root/alpha/beta/workspace;
  // ../../alpha targets /root/alpha/alpha/pics.
  const root = mkdtempSync(join(tmpdir(), 'dsh-conv-imgscope-'))
  const alpha = join(root, 'alpha')
  const beta = join(alpha, 'beta')
  const workspace = join(beta, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(alpha, 'alpha', 'pics'), { recursive: true })
  writeFileSync(join(alpha, 'alpha', 'pics', 'a.png'), 'x')
  writeFileSync(join(alpha, 'alpha', 'pics', 'note.txt'), 'x')
  mkdirSync(join(workspace, 'subdir'))
  writeFileSync(join(workspace, 'subdir', 'deep.png'), 'x')
  const provider = new MentionProvider(
    [{ name: 'image', description: 'Attach', getArgumentCompletions: () => null }],
    workspace,
    new DirectHostFilePort(() => undefined, null),
  )
  // ../.. scope.
  const up = await provider.getSuggestions(['/image ../../alpha/pics/a'], 0, 28, { signal: abort })
  assert.ok(up !== null, `/image ../../ must suggest:\n${JSON.stringify(up)}`)
  assert.ok(up.items.some(item => item.value === '../../alpha/pics/a.png'), `../../ image missing:\n${JSON.stringify(up.items)}`)
  // Directory continuation.
  const cont = await provider.getSuggestions(['/image subdir/'], 0, 14, { signal: abort })
  assert.ok(cont !== null && cont.items.some(item => item.value === 'subdir/deep.png'),
    `image dir continuation missing:\n${JSON.stringify(cont)}`)
  // ~/ scope (homedir has a stable entry).
  const saved = process.env.HOME
  try {
    const home = mkdtempSync(join(tmpdir(), 'dsh-conv-imghome-'))
    mkdirSync(join(home, 'pix'))
    writeFileSync(join(home, 'pix', 'h.png'), 'x')
    process.env.HOME = home
    const tilde = await provider.getSuggestions(['/image ~/pix/h'], 0, 14, { signal: abort })
    assert.ok(tilde !== null && tilde.items.some(item => item.value === '~/pix/h.png'),
      `~/ image missing:\n${JSON.stringify(tilde)}`)
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
  }
})

test('Host @ and Client /image completion keep separate cwd ownership', async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'dsh-conv-host-cwd-'))
  const localRoot = mkdtempSync(join(tmpdir(), 'dsh-conv-local-cwd-'))
  writeFileSync(join(hostRoot, 'host-only.txt'), 'x')
  writeFileSync(join(localRoot, 'local-only.png'), 'x')
  const provider = new MentionProvider(
    [],
    hostRoot,
    new DirectHostFilePort(() => undefined, null),
    undefined,
    { kind: 'workspace', cwd: hostRoot },
    null,
    localRoot,
  )
  const mention = await provider.getSuggestions(['@host-only'], 0, 10, { signal: abort })
  assert.ok(mention !== null && mention.items.some(item => item.value === '@host-only.txt'))
  const image = await provider.getSuggestions(['/image local-only'], 0, '/image local-only'.length, { signal: abort })
  assert.ok(image !== null && image.items.some(item => item.value === 'local-only.png'))
  assert.ok(!image.items.some(item => item.value.includes('host-only')), 'image completion must not read Host cwd')
})

test('P1.3: a >2000-entry workspace keeps directory continuation working', async () => {
  const { root } = largeWorkspaceFixture()
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  // First: @src finds the directory.
  const dirs = await provider.getSuggestions(['@src'], 0, 4, { signal: abort })
  assert.ok(dirs !== null, `@src must suggest:\n${JSON.stringify(dirs)}`)
  assert.ok(dirs.items.some(item => item.value === '@src/'), 'the directory item must appear')
  // Then: @src/ lists the children (the scoped listing never scans the
  // whole tree — the bound applies only to the whole-tree fallback).
  const children = await provider.getSuggestions(['@src/'], 0, 5, { signal: abort })
  assert.ok(children !== null, `@src/ must list children:\n${JSON.stringify(children)}`)
  assert.ok(children.items.some(item => item.value === '@src/wanted.ts'), 'the wanted child must appear')
})

test('P1.4: substring ranking is shared between @ and /image', async () => {
  const root = outsideCwdFixture().workspace
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep-nested.ts'), 'x')
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const at = await provider.getSuggestions(['@nested'], 0, 7, { signal: abort })
  assert.ok(at !== null, `@nested must suggest:\n${JSON.stringify(at)}`)
  assert.ok(at.items.some(item => item.value === '@src/deep-nested.ts'), `nested missing:\n${JSON.stringify(at.items)}`)
  // The engine is shared: verify the same ranking in the pure layer.
  const scored = scorePathCandidate({ path: 'src/deep-nested.ts', kind: 'file' }, 'nested')
  assert.equal(scored, 50, 'a basename substring scores 50')
  const imageProvider = new MentionProvider(
    [],
    root,
    new DirectHostFilePort(() => undefined, null),
    undefined,
    undefined,
    null,
  )
  const image = await imageProvider.getSuggestions(['/image nested'], 0, 13, { signal: abort })
  assert.ok(image !== null && image.items.some(item => item.value === 'src/deep-nested.ts'),
    `/image nested must share subtree fuzzy discovery:\n${JSON.stringify(image)}`)
})

test('P1.5: a stale prefix accept never deletes @-preceding text', () => {
  const root = outsideCwdFixture().workspace
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  // Old request prefix `@abcdef`; the draft has since been edited to
  // `hello @ab`. Accepting the old item must leave the draft UNCHANGED.
  const applied = provider.applyCompletion(['hello @ab'], 0, 9, { value: '@abcdef-gh', label: 'abcdef-gh' }, '@abcdef')
  assert.deepEqual(applied.lines, ['hello @ab'], 'a stale accept must not delete text')
  // The image-argument shape: the same fence protects the argument path.
  const appliedArg = provider.applyCompletion(
    ['/image sub'],
    0,
    11,
    { value: 'subdir/', label: 'subdir/' },
    'subdir/',
  )
  assert.deepEqual(appliedArg.lines, ['/image sub'], 'a stale argument accept must not rewrite the draft')
})

test('P1.5 headless D: a quick Backspace over a mention leaves the draft intact', async () => {
  const { startApp } = await import('./support/app-harness.ts')
  const root = outsideCwdFixture().workspace
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  // Type a mention, then Backspace quickly — no crash, draft keeps the text.
  vt.sendInput('@abcdef')
  await vt.waitForRender()
  vt.sendInput('\x7f')
  await vt.waitForRender()
  vt.sendInput('\x7f')
  await vt.waitForRender()
  vt.sendInput('\x7f')
  await vt.waitForRender()
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '@ab', 'backspace edits the draft')
  app.stop()
})

test('§23 matrix: the classifier gates @ and /image only', () => {
  const set = new Set(['image'])
  assert.equal(classifyFileCompletionContext('@foo', set).kind, 'mention')
  assert.equal(classifyFileCompletionContext('text @foo', set).kind, 'mention')
  assert.equal(classifyFileCompletionContext('看看@foo', set).kind, 'mention')
  assert.equal(classifyFileCompletionContext('email@foo', set).kind, 'none')
  assert.equal(classifyFileCompletionContext('pkg@1.0', set).kind, 'none')
  assert.equal(classifyFileCompletionContext('/image foo', set).kind, 'image-argument')
  assert.equal(classifyFileCompletionContext('/image    foo', set).kind, 'image-argument')
  assert.equal(classifyFileCompletionContext('/im foo', set).kind, 'none')
  assert.equal(classifyFileCompletionContext('/other foo', set).kind, 'none')
  assert.equal(classifyFileCompletionContext('ordinary text', set).kind, 'none')
  assert.equal(classifyFileCompletionContext('ordinary ./path', set).kind, 'none')
})

test('§23 matrix: quoted @ completes and stays quoted', async () => {
  const { workspace } = outsideCwdFixture()
  const root = workspace
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const result = await provider.getSuggestions(['@"loc'], 0, 5, { signal: abort })
  assert.ok(result !== null)
  assert.equal(result.prefix, '@"loc')
  assert.ok(result.items.some(item => item.value === '@"local.txt"'))
})

test('§23 matrix: symlink directories keep the trailing slash', async () => {
  const { workspace } = outsideCwdFixture()
  const root = workspace
  const link = join(root, 'linkdir')
  const target = join(root, 'real')
  mkdirSync(target)
  writeFileSync(join(target, 'inside.ts'), 'x')
  symlinkSync('real', link)
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const result = await provider.getSuggestions(['@lin'], 0, 4, { signal: abort })
  assert.ok(result !== null)
  assert.ok(result.items.some(item => item.value === '@linkdir/'), 'a symlinked dir must complete with /')
})

test('§22: fd/fdfind detection prefers fd then fdfind', () => {
  const saved = process.env.PATH
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-conv-fd-'))
    const fd = join(dir, 'fd')
    const fdfind = join(dir, 'fdfind')
    writeFileSync(fd, '#!/bin/sh\nexit 0\n')
    writeFileSync(fdfind, '#!/bin/sh\nexit 0\n')
    chmodSync(fd, 0o755)
    chmodSync(fdfind, 0o755)
    process.env.PATH = dir
    assert.equal(resolveFdPath(), fd, 'fd wins over fdfind')
    // Only fdfind present:
    const only = mkdtempSync(join(tmpdir(), 'dsh-conv-fdfind-'))
    const justFdfind = join(only, 'fdfind')
    writeFileSync(justFdfind, '#!/bin/sh\nexit 0\n')
    chmodSync(justFdfind, 0o755)
    process.env.PATH = only
    assert.equal(resolveFdPath(), justFdfind, 'fdfind is the Debian fallback')
    // Neither:
    process.env.PATH = '/nonexistent-dir'
    assert.equal(resolveFdPath(), null)
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
})

test('fd discovery uses full-path matching, NUL records and preserves filename whitespace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-conv-fd-output-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep-nested.png'), 'x')
  writeFileSync(join(root, ' leading file.txt'), 'x')
  const argsFile = join(root, 'fd-args.txt')
  const fakeFd = join(root, 'fd')
  writeFileSync(fakeFd, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\\0' './src/deep-nested.png' './ leading file.txt'
`)
  chmodSync(fakeFd, 0o755)
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, fakeFd))
  const nested = await provider.getSuggestions(['@nested'], 0, 7, { signal: abort })
  assert.ok(nested !== null, `full-path fd matching must find nested files:\n${JSON.stringify(nested)}`)
  assert.ok(nested.items.some(item => item.value === '@src/deep-nested.png'))
  const spaced = await provider.getSuggestions(['@leading'], 0, 8, { signal: abort })
  assert.ok(spaced !== null, `NUL output with spaces must survive:\n${JSON.stringify(spaced)}`)
  assert.ok(spaced.items.some(item => item.value === '@" leading file.txt"'))
  const args = readFileSync(argsFile, 'utf8').split(/\r?\n/)
  assert.ok(args.includes('--full-path'), 'fd must match the full relative path')
  assert.ok(args.includes('--print0'), 'fd must emit NUL-delimited records')
})

test('fd discovery ignores noisy stderr and settles without a pipe deadlock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-conv-fd-stderr-'))
  writeFileSync(join(root, 'visible.txt'), 'x')
  const fakeFd = join(root, 'fd')
  writeFileSync(fakeFd, `#!/bin/sh
dd if=/dev/zero bs=1024 count=128 >&2 2>/dev/null
printf '%s\\0' './visible.txt'
`)
  chmodSync(fakeFd, 0o755)
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, fakeFd))
  const result = await provider.getSuggestions(['@visible'], 0, 8, { signal: abort })
  assert.ok(result !== null, `noisy fd stderr must not block completion:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value === '@visible.txt'))
})

test('§23 matrix: Windows drive and UNC tokens keep their dialect (pure)', () => {
  const query = resolvePathQuery('C:\\Users\\sh', '/ws')
  assert.equal(query.searchBase, win32.dirname('C:\\Users\\sh'))
  assert.equal(query.displayBase, 'C:\\Users\\')
  assert.equal(query.winAbsolute, true)
  const unc = resolvePathQuery('\\\\server\\share\\fo', '/ws')
  assert.equal(unc.searchBase, '\\\\server\\share\\')
  assert.equal(unc.displayBase, '\\\\server\\share\\')
  assert.equal(unc.winAbsolute, true)
})

test('Windows candidates rank and present basename labels independently of host path dialect', () => {
  assert.equal(scorePathCandidate({ path: 'C:\\Users\\Foo.txt', kind: 'file' }, 'foo.txt'), 100)
  assert.equal(scorePathCandidate({ path: 'C:\\Users\\deep\\Foo.txt', kind: 'file' }, 'foo.txt'), 100)
  const directory = presentPathCandidate(
    { path: 'C:\\Users\\Pictures', kind: 'directory' },
    { at: false, quoted: false, sep: '\\' },
  )
  assert.equal(directory.value, 'C:\\Users\\Pictures\\')
  assert.equal(directory.label, 'Pictures/')
  assert.equal(directory.description, 'C:\\Users\\Pictures')
  const mixed = presentPathCandidate(
    { path: 'C:/Users\\Pictures', kind: 'directory' },
    { at: true, quoted: false, sep: '\\' },
  )
  assert.equal(mixed.value, '@C:/Users\\Pictures\\')
  assert.equal(mixed.label, 'Pictures/')
})

test('the presentation layer quotes spaced values for /image and keeps @ quoting', () => {
  const item = presentPathCandidate({ path: 'my file.txt', kind: 'file' }, { at: false, quoted: false })
  assert.equal(item.value, '"my file.txt"')
  const atItem = presentPathCandidate({ path: 'my file.txt', kind: 'file' }, { at: true, quoted: false })
  assert.equal(atItem.value, '@"my file.txt"')
  const atQuoted = presentPathCandidate({ path: 'my file.txt', kind: 'file' }, { at: true, quoted: true })
  assert.equal(atQuoted.value, '@"my file.txt"')
})

test('review finding 1: a quoted /image argument completes inside the quotes', async () => {
  const { workspace } = outsideCwdFixture()
  const root = workspace
  writeFileSync(join(root, 'my file.txt'), 'x')
  const provider = new MentionProvider(
    [{ name: 'image', description: 'Attach', getArgumentCompletions: () => null }],
    root,
    new DirectHostFilePort(() => undefined, null),
  )
  const result = await provider.getSuggestions(['/image "my'], 0, 10, { signal: abort })
  assert.ok(result !== null, `/image "my must suggest:\n${JSON.stringify(result)}`)
  assert.ok(
    result.items.some(item => item.value === '"my file.txt"'),
    `the quoted value must keep its quotes:\n${JSON.stringify(result.items)}`,
  )
  // Round-2: spaces INSIDE the quotes are part of the token.
  const spaced = await provider.getSuggestions(['/image "my f'], 0, 12, { signal: abort })
  assert.ok(spaced !== null, `/image "my f must suggest:\n${JSON.stringify(spaced)}`)
  assert.ok(spaced.items.some(item => item.value === '"my file.txt"'), `spaced quoted value missing:\n${JSON.stringify(spaced.items)}`)
})

test('review finding 3: an indented /image command still classifies its argument', async () => {
  const { workspace } = outsideCwdFixture()
  const root = workspace
  writeFileSync(join(root, 'file-one.txt'), 'x')
  const provider = new MentionProvider(
    [{ name: 'image', description: 'Attach', getArgumentCompletions: () => null }],
    root,
    new DirectHostFilePort(() => undefined, null),
  )
  const result = await provider.getSuggestions(['  /image file'], 0, 14, { signal: abort })
  assert.ok(result !== null, `an indented /image must complete its argument:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value === 'file-one.txt'), `indented value missing:\n${JSON.stringify(result.items)}`)
})

test('review finding (round 4): a regex-special filename still completes (fd literal match)', async () => {
  const root = outsideCwdFixture().workspace
  writeFileSync(join(root, 'file[1].ts'), 'x')
  writeFileSync(join(root, 'a+b.ts'), 'x')
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const bracketed = await provider.getSuggestions(['@file[1'], 0, 7, { signal: abort })
  assert.ok(bracketed !== null, `@file[1 must suggest:\n${JSON.stringify(bracketed)}`)
  assert.ok(bracketed.items.some(item => item.value.includes('file[1].ts')), `bracketed missing:\n${JSON.stringify(bracketed.items)}`)
  const plus = await provider.getSuggestions(['@a+b'], 0, 4, { signal: abort })
  assert.ok(plus !== null && plus.items.some(item => item.value.includes('a+b.ts')), `plus missing:\n${JSON.stringify(plus)}`)
})

test('review finding (round 5): fd matches case-insensitively (aligned with the ranking contract)', async (t) => {
  const root = outsideCwdFixture().workspace
  writeFileSync(join(root, 'Foo.txt'), 'x')
  writeFileSync(join(root, 'foo.txt'), 'x')
  // The ranking contract is case-INSENSITIVE (always runs, no fd needed):
  // the engine lowercases the QUERY before scoring, so an uppercase query
  // signs the lowercase basename as a prefix match (80).
  assert.equal(scorePathCandidate({ path: 'foo.txt', kind: 'file' }, 'FOO'.toLowerCase()), 80,
    'the shared ranking must be case-insensitive')
  // REAL fd-backed path: the default DirectHostFilePort probes PATH (fd
  // then fdfind — this machine has /usr/bin/fdfind), so the -i flag is
  // what produces both matches. A fallback-only null would pass even
  // without -i. SKIP when no finder is installed (CI without fd/fdfind
  // must not fail the suite — the fallback path is tested separately).
  const port = new DirectHostFilePort(() => undefined)
  if (port.fdPathAvailableForTest() === null) {
    t.skip('no fd/fdfind on PATH: the real-fd case test cannot run')
    return
  }
  const provider = new MentionProvider([], root, port)
  // fd's smart-case default (case-SENSITIVE for an uppercase query) would
  // return only @Foo.txt; the -i flag returns both.
  const upper = await provider.getSuggestions(['@FOO'], 0, 4, { signal: abort })
  assert.ok(upper !== null, `@FOO must suggest:\n${JSON.stringify(upper)}`)
  assert.ok(
    upper.items.some(item => item.value === '@Foo.txt') && upper.items.some(item => item.value === '@foo.txt'),
    `both case forms must match (real fd -i):\n${JSON.stringify(upper.items)}`,
  )
})

test('review finding (round 4): failed fd falls back to the bounded scan', async () => {
  const { workspace, sibling } = outsideCwdFixture()
  const root = workspace
  writeFileSync(join(sibling, 'fallback-scan.ts'), 'x')
  // A fake fd that always FAILS (non-zero exit): discovery must fall back
  // to the bounded recursive scan, never report a false "no match".
  const fakeFd = join(tmpdir(), 'dsh-conv-fdcrash')
  writeFileSync(fakeFd, '#!/bin/sh\nexit 1\n')
  chmodSync(fakeFd, 0o755)
  const port = new DirectHostFilePort(() => undefined, fakeFd)
  const provider = new MentionProvider([], root, port)
  const result = await provider.getSuggestions(['@../sibling/fallback'], 0, 21, { signal: abort })
  assert.ok(result !== null, `a failed fd must fall back:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value.includes('fallback-scan.ts')), `fallback missing:\n${JSON.stringify(result.items)}`)
})

test('review finding (round 4): scoped listings never present .git', async () => {
  const root = outsideCwdFixture().workspace
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), 'x')
  writeFileSync(join(root, 'visible.txt'), 'x')
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const result = await provider.getSuggestions(['@'], 0, 1, { signal: abort })
  assert.ok(result !== null)
  assert.ok(!result.items.some(item => item.value.includes('.git')), `.git must not be listed:\n${JSON.stringify(result.items)}`)
  assert.ok(result.items.some(item => item.value === '@visible.txt'))
})

test('review finding (round 4): null pins the fallback /image source; undefined probes PATH', async () => {
  const root = outsideCwdFixture().workspace
  writeFileSync(join(root, 'shot.png'), 'x')
  // null → forced fallback (never fd), regardless of PATH.
  const fallbackProvider = new MentionProvider(
    [{ name: 'image', description: 'Attach', getArgumentCompletions: () => null }],
    root,
    new DirectHostFilePort(() => undefined, null),
    undefined,
    { kind: 'workspace', cwd: root },
    null,
  )
  const result = await fallbackProvider.getSuggestions(['/image shot'], 0, 11, { signal: abort })
  assert.ok(result !== null && result.items.length > 0, `a null-pinned fallback must complete:\n${JSON.stringify(result)}`)
})

test('review finding (verified): multi-space /image separator applies without duplication', async () => {
  const { workspace } = outsideCwdFixture()
  const root = workspace
  writeFileSync(join(root, 'file-one.txt'), 'x')
  const provider = new MentionProvider(
    [{ name: 'image', description: 'Attach', getArgumentCompletions: () => null }],
    root,
    new DirectHostFilePort(() => undefined, null),
  )
  // imageArgumentOf slices AFTER the first separator; completeImageArgument
  // re-prefixes the value with the REMAINING separator whitespace. The
  // fork's apply consumes the first separator in beforePrefix, so the
  // total separator count is preserved — never duplicated.
  const line = '/image    file'
  const result = await provider.getSuggestions([line], 0, line.length, { signal: abort })
  assert.ok(result !== null)
  assert.equal(result.prefix, '   file', 'the classifier slice matches the fork slice (after the first space)')
  const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix)
  assert.equal(applied.lines[0], '/image    file-one.txt', 'the separator count is preserved')
})

test('review finding: a CLOSED quoted /image token never completes further (no trailing-text deletion)', async () => {
  const { workspace } = outsideCwdFixture()
  const root = workspace
  writeFileSync(join(root, 'my file.txt'), 'x')
  const provider = new MentionProvider(
    [{ name: 'image', description: 'Attach', getArgumentCompletions: () => null }],
    root,
    new DirectHostFilePort(() => undefined, null),
  )
  // A closed quote with trailing text: completing would replace the whole
  // argument range and DELETE the trailing text — stay quiet.
  const closed = await provider.getSuggestions(['/image "my"foo'], 0, 15, { signal: abort })
  assert.equal(closed, null, 'a closed quoted token with trailing text must stay quiet')
  // A closed quote alone (no trailing text): also quiet — the token is done.
  const bare = await provider.getSuggestions(['/image "my"'], 0, 11, { signal: abort })
  assert.equal(bare, null, 'a closed quoted token must stay quiet')
})

test('review finding 2: a stale accept never applies after an unrelated edit', async () => {
  const root = outsideCwdFixture().workspace
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  // The request produced a dropdown for `hello @foo` (snapshot captured);
  // the user then edited the LINE START (`hello` → `world`) — the prefix
  // @foo is intact but the document differs. The full-snapshot fence must
  // reject the accept: the editor passes the CURRENT document to apply.
  const request = await provider.getSuggestions(['hello @foo'], 0, 10, { signal: abort })
  assert.equal(request, null, 'no @foo file exists in the fixture — the snapshot stays null for the empty result')
  // Force a snapshot the way the editor does: a non-null result binds the
  // state. Use an existing file so the suggestion list is non-null.
  const bound = await provider.getSuggestions(['see @local'], 0, 11, { signal: abort })
  assert.ok(bound !== null, 'the fixture file must produce a dropdown')
  // The editor state changed on an unrelated part: `see` → `look`.
  const applied = provider.applyCompletion(['look @local'], 0, 12, { value: '@local.txt', label: 'local.txt' }, '@local')
  assert.deepEqual(applied.lines, ['look @local'], 'an unrelated edit must also fence the accept')
})

test('extension suggestion snapshots fence unrelated edits even with the same prefix', () => {
  const root = outsideCwdFixture().workspace
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const generation = provider.mintRequestGeneration()
  const suggestion = { items: [{ value: 'world', label: 'world' }], prefix: 'world' }
  provider.captureRequestSnapshot(generation, { kind: 'workspace', cwd: root }, ['hello world'], 0, 11, suggestion)
  const applied = provider.applyCompletion(
    ['changed world'],
    0,
    13,
    suggestion.items[0]!,
    suggestion.prefix,
  )
  assert.deepEqual(applied.lines, ['changed world'], 'an extension result must not apply after an unrelated edit')
})

test('review finding (round 8): a fallback scan is async and abort-responsive (never a sync block)', async () => {
  const root = largeWorkspaceFixture().root
  const controller = new AbortController()
  const port = new DirectHostFilePort(() => undefined, null) // forced fallback
  const provider = new MentionProvider([], root, port)
  // Abort mid-request: the async scan stops promptly (the old sync scan
  // could not be interrupted once it started).
  const started = Date.now()
  const pending = provider.getSuggestions(['@wanted'], 0, 7, { signal: controller.signal })
  controller.abort()
  const result = await pending
  assert.equal(result, null, 'an aborted fallback scan must never commit a late result')
  assert.ok(Date.now() - started < 1000, 'the scan must stop promptly on abort')
})

test('review finding (round 6/8): overlapping delegated requests keep their own snapshots', async () => {
  const root = outsideCwdFixture().workspace
  writeFileSync(join(root, 'item-a.txt'), 'x')
  writeFileSync(join(root, 'item-b.txt'), 'x')
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  // Two requests mint distinct generations; the OLDER result is dropped by
  // the generation check (it cannot bind a snapshot), so the NEWER
  // request's snapshot stays the only one the apply fence honors.
  const g1 = provider.mintRequestGeneration()
  provider.mintRequestGeneration() // a NEWER request starts
  const staleBind = provider.captureRequestSnapshot(
    g1,
    { kind: 'workspace', cwd: root },
    ['@item-a'],
    0,
    7,
    { items: [{ value: '@item-a.txt', label: 'item-a.txt' }], prefix: '@item-a' },
  )
  // The OLD result does not become the snapshot (the fresh request below
  // still applies); captureRequestSnapshot returns its argument unchanged.
  assert.ok(staleBind !== null, 'capture returns the result value unchanged')
  const fresh = await provider.getSuggestions(['@item-b'], 0, 7, { signal: abort })
  assert.ok(fresh !== null, 'the NEWER request still completes normally')
  const applied = provider.applyCompletion(['@item-b'], 0, 7, { value: '@item-b.txt', label: 'item-b.txt' }, '@item-b')
  assert.equal(applied.lines[0], '@item-b.txt ', 'the fresh request applies normally (the older bind did not fence it)')
})

test('review finding (round 6): a scope switch mid-flight fences the old session accept', async () => {
  const rootA = outsideCwdFixture().workspace
  const rootB = outsideCwdFixture().workspace
  writeFileSync(join(rootA, 'session-a.txt'), 'x')
  writeFileSync(join(rootB, 'session-b.txt'), 'x')
  let scope: { kind: 'workspace'; cwd: string } = { kind: 'workspace', cwd: rootA }
  const provider = new MentionProvider(
    [],
    rootA,
    new DirectHostFilePort(() => undefined, null),
    undefined,
    () => scope,
  )
  const bound = await provider.getSuggestions(['@session-a'], 0, 11, { signal: abort })
  assert.ok(bound !== null && bound.items.length > 0, 'session A must produce candidates')
  // The session/workspace switches while the draft is UNCHANGED: the old
  // snapshot's scope no longer matches, so accepting the OLD dropdown item
  // must leave the draft untouched (never insert a Host candidate from the
  // previous session under the new one).
  scope = { kind: 'workspace', cwd: rootB }
  const applied = provider.applyCompletion(
    ['@session-a'],
    0,
    11,
    { value: '@session-a.txt', label: 'session-a.txt' },
    '@session-a',
  )
  assert.deepEqual(applied.lines, ['@session-a'], 'a scope switch must fence the stale accept')
})

test('review finding 2: a Windows-dialect directory keeps the backslash separator', () => {
  const item = presentPathCandidate({ path: 'C:\\Users\\foo', kind: 'directory' }, { at: false, quoted: false, sep: '\\' })
  assert.equal(item.value, 'C:\\Users\\foo\\', 'a Windows directory completes with \\ — never a mixed /')
  const posix = presentPathCandidate({ path: 'src/foo', kind: 'directory' }, { at: false, quoted: false, sep: '/' })
  assert.equal(posix.value, 'src/foo/')
})

test('extractAtPrefix keeps the CJK-glue rule and rejects emails', () => {
  assert.equal(extractAtPrefix('看看@foo'), '@foo')
  assert.equal(extractAtPrefix('a@b.c'), null)
  assert.equal(extractAtPrefix('plain'), null)
})

test('a sessionless @dir/ lists children (direct children listing)', async () => {
  const { root } = largeWorkspaceFixture()
  const port = new DirectHostFilePort(() => undefined, null)
  const provider = new MentionProvider([], root, port)
  // No live agent: workspace scope (sessionless).
  const result = await provider.getSuggestions(['@src/'], 0, 5, { signal: abort })
  assert.ok(result !== null, `@src/ must list children sessionless:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value === '@src/wanted.ts'))
})

// ── §24 headless integration: TuiApp + TuiEditor + MentionProvider ─────────

test('§24 A: @src → dropdown → Tab → @src/ → children dropdown', async () => {
  const { startApp } = await import('./support/app-harness.ts')
  const root = largeWorkspaceFixture().root
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  vt.sendInput('@src')
  await pollUntil(() => vt.getViewport().join('\n').includes('src/'), 'the src directory item must appear')
  assert.equal(isAutocompleteActive(app), true, '@src must open the dropdown')
  vt.sendInput('\t')
  await pollUntil(() => app.seatTextForTest() === '@src/', 'Tab accepts the directory')
  assert.equal(app.seatTextForTest(), '@src/', 'Tab accepts the directory')
  await pollUntil(() => vt.getViewport().join('\n').includes('wanted.ts'), 'children must appear after accept')
  app.stop()
})

test('§24 B: /image src → dropdown → Tab → /image src/ → children dropdown', async () => {
  const { startImageApp } = await import('./support/app-harness.ts')
  const root = largeWorkspaceFixture().root
  const { vt, app } = startImageApp(root)
  await vt.waitForRender()
  vt.sendInput('/image src')
  await pollUntil(() => vt.getViewport().join('\n').includes('src/'), 'the src argument candidate must appear')
  assert.equal(isAutocompleteActive(app), true, '/image src must open the dropdown')
  vt.sendInput('\t')
  await pollUntil(() => app.seatTextForTest() === '/image src/', 'Tab accepts the directory')
  assert.equal(app.seatTextForTest(), '/image src/', 'Tab accepts the directory')
  await pollUntil(() => vt.getViewport().join('\n').includes('wanted.ts'), 'children must appear after accept')
  app.stop()
})

test('§24 C: hello ./src<Tab> opens no dropdown', async () => {
  const { startApp } = await import('./support/app-harness.ts')
  const root = largeWorkspaceFixture().root
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  vt.sendInput('hello ./src')
  await vt.waitForRender()
  vt.sendInput('\t')
  // Poll the dropdown CLOSED state over the editor's whole debounce
  // window (no fixed sleep): the state must stay closed the entire time —
  // a late async request cannot slip a dropdown in unnoticed.
  const deadline = Date.now() + 400
  for (;;) {
    assert.equal(isAutocompleteActive(app), false, 'hello ./src<Tab> must never open a dropdown')
    if (Date.now() > deadline) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('wanted.ts'), `hello ./src<Tab> must not list files:\n${view}`)
  assert.equal(app.seatTextForTest(), 'hello ./src', 'the draft is untouched')
  app.stop()
})

test('§24 E: sessionless @dir/ lists children through the app chain', async () => {
  const { startApp } = await import('./support/app-harness.ts')
  const root = largeWorkspaceFixture().root
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  // No session was ever created: the workspace scope answers.
  vt.sendInput('@src/')
  await pollUntil(() => vt.getViewport().join('\n').includes('wanted.ts'), 'sessionless children must appear')
  app.stop()
})
