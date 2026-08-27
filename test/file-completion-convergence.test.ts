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
import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, win32, sep } from 'node:path'
import { classifyFileCompletionContext, extractAtPrefix } from '../src/file-completion/context.ts'
import { resolvePathQuery } from '../src/file-completion/query.ts'
import { scorePathCandidate } from '../src/file-completion/ranking.ts'
import { presentPathCandidate } from '../src/file-completion/presentation.ts'
import { MentionProvider } from '../src/mentions.ts'
import { DirectHostFilePort, resolveFdPath } from '../src/runtime/direct/host-file-direct.ts'

const abort = new AbortController().signal

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
  await new Promise(resolve => setTimeout(resolve, 200))
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
  const { root, workspace } = outsideCwdFixture()
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const query = resolvePathQuery('workspace/loc', root)
  assert.equal(query.searchBase, join(root, 'workspace'))
  const result = await provider.getSuggestions(['@workspace/loc'], 0, 15, { signal: abort })
  assert.ok(result !== null, `@workspace/loc must suggest:\n${JSON.stringify(result)}`)
  assert.ok(result.items.some(item => item.value === '@workspace/local.txt'))
  void workspace
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

test('the presentation layer quotes spaced values for /image and keeps @ quoting', () => {
  const item = presentPathCandidate({ path: 'my file.txt', kind: 'file' }, { at: false, quoted: false })
  assert.equal(item.value, '"my file.txt"')
  const atItem = presentPathCandidate({ path: 'my file.txt', kind: 'file' }, { at: true, quoted: false })
  assert.equal(atItem.value, '@"my file.txt"')
  const atQuoted = presentPathCandidate({ path: 'my file.txt', kind: 'file' }, { at: true, quoted: true })
  assert.equal(atQuoted.value, '@"my file.txt"')
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
  const { startApp, startImageApp } = await import('./support/app-harness.ts')
  const root = largeWorkspaceFixture().root
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  vt.sendInput('@src')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(vt.getViewport().join('\n').includes('src/'), 'the src directory item must appear')
  vt.sendInput('\t')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(app.seatTextForTest(), '@src/', 'Tab accepts the directory')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(vt.getViewport().join('\n').includes('wanted.ts'), 'children must appear after accept')
  app.stop()
})

test('§24 B: /image src → dropdown → Tab → /image src/ → children dropdown', async () => {
  const { startImageApp } = await import('./support/app-harness.ts')
  const root = largeWorkspaceFixture().root
  const { vt, app } = startImageApp(root)
  await vt.waitForRender()
  vt.sendInput('/image src')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(vt.getViewport().join('\n').includes('src/'), 'the src argument candidate must appear')
  vt.sendInput('\t')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(app.seatTextForTest(), '/image src/', 'Tab accepts the directory')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(vt.getViewport().join('\n').includes('wanted.ts'), 'children must appear after accept')
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
  await new Promise(resolve => setTimeout(resolve, 200))
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
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(vt.getViewport().join('\n').includes('wanted.ts'), 'sessionless children must appear')
  app.stop()
})
