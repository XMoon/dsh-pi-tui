/**
 * Tests for the `!`/`!!` bash completion bridge (docs/input-and-card-polish.md
 * §1): the cursor-context parser, the compgen-backed suggestion paths
 * (command names, `$VAR` names, git subcommands) against a REAL bash, the
 * degradation when bash is unavailable, and the MentionProvider integration
 * (shell words complete, path positions still reach the fork's provider).
 * @module @xmoon76/dsh-pi-tui/shell-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MentionProvider } from '../src/mentions.ts'
import { shellCompletionContext, suggestShellCompletion } from '../src/shell-completion.ts'

const abort = new AbortController().signal
const cwd = tmpdir()

// --- shellCompletionContext: cursor parsing ---

test('shellCompletionContext parses command, subcommand, variable and path positions', () => {
  // Command name: first word after `!` (or `!!`).
  assert.deepEqual(shellCompletionContext('!gi', 3), { kind: 'command', prefix: 'gi', priorWords: [] })
  assert.deepEqual(shellCompletionContext('!!gi', 4), { kind: 'command', prefix: 'gi', priorWords: [] })
  assert.deepEqual(shellCompletionContext('!', 1), { kind: 'command', prefix: '', priorWords: [] })
  // A later word of a known listable command: subcommand.
  assert.deepEqual(shellCompletionContext('!git che', 8), { kind: 'subcommand', prefix: 'che', priorWords: ['git'] })
  // A `$VAR` word anywhere after the first word.
  assert.deepEqual(shellCompletionContext('!echo $HO', 10), { kind: 'variable', prefix: '$HO', priorWords: ['echo'] })
  // Path positions are NOT the bridge's job.
  assert.equal(shellCompletionContext('!ls /u', 6), undefined)
  assert.equal(shellCompletionContext('!cat src/de', 11), undefined)
  assert.equal(shellCompletionContext('!./run.sh', 9), undefined)
  assert.equal(shellCompletionContext('!~/bin', 6), undefined)
  // A later word of an unknown command is a path position too.
  assert.equal(shellCompletionContext('!unknowncmd foo', 15), undefined)
  // Non-shell lines never produce a context.
  assert.equal(shellCompletionContext('plain text', 10), undefined)
  assert.equal(shellCompletionContext('/cmd', 4), undefined)
})

// --- suggestShellCompletion: real bash ---

test('command-name completion returns cached PATH commands matching the prefix', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: abort })
  assert.ok(suggestions !== null, 'git must be on PATH in the test environment')
  assert.ok(suggestions.items.some(item => item.value === 'git'), `git missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
  assert.equal(suggestions.prefix, 'gi')
})

test('an empty command prefix stays quiet on natural triggers and lists on Tab', async () => {
  const context = { kind: 'command' as const, prefix: '', priorWords: [] as readonly string[] }
  const natural = await suggestShellCompletion(context, cwd, { signal: abort, force: false })
  assert.equal(natural, null, 'a natural trigger with an empty prefix must not flash the list')
  const forced = await suggestShellCompletion(context, cwd, { signal: abort, force: true })
  assert.ok(forced !== null && forced.items.length > 0, 'explicit Tab with an empty prefix lists commands')
})

test('variable completion returns $VAR names for the word after the dollar', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'variable', prefix: '$HO', priorWords: ['echo'] }, cwd, { signal: abort })
  assert.ok(suggestions !== null, 'HOME must be a variable')
  assert.ok(suggestions.items.some(item => item.value === '$HOME'), `$HOME missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
  assert.equal(suggestions.prefix, '$HO')
})

test('git subcommand completion lists git subcommands', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'subcommand', prefix: 'che', priorWords: ['git'] }, cwd, { signal: abort })
  assert.ok(suggestions !== null, 'git --list-cmds must produce subcommands')
  assert.ok(suggestions.items.some(item => item.value === 'checkout'), `checkout missing from ${JSON.stringify(suggestions.items.slice(0, 8))}`)
  assert.equal(suggestions.prefix, 'che')
})

test('no matches yield null, never an error', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'zzz-no-such-command-xyz', priorWords: [] }, cwd, { signal: abort })
  assert.equal(suggestions, null)
})

test('an aborted request never spawns a shell', async () => {
  const controller = new AbortController()
  controller.abort()
  const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: controller.signal })
  assert.equal(suggestions, null)
})

test('a PATH without bash degrades to null (missing shell)', async () => {
  const saved = process.env.PATH
  try {
    process.env.PATH = join(tmpdir(), 'dsh-no-bash')
    const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: abort })
    assert.equal(suggestions, null, 'a missing bash must yield no suggestions, never a throw')
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
})

// --- MentionProvider integration ---

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shell-completion-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep-nested.ts'), 'deep')
  writeFileSync(join(root, 'top.txt'), 'top')
  return root
}

test('MentionProvider completes shell command words on ! lines', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, null)
  const suggestions = await provider.getSuggestions(['!gi'], 0, 3, { signal: abort })
  assert.ok(suggestions !== null, 'command-name completion must run through the provider')
  assert.ok(suggestions.items.some(item => item.value === 'git'), 'git must be suggested')
})

test('MentionProvider still completes paths on ! lines (path positions reach the fork)', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, null)
  const suggestions = await provider.getSuggestions(['!cat src/de'], 0, 11, { signal: abort })
  assert.ok(suggestions !== null, 'a path position on a ! line must reach the fork provider')
  assert.ok(suggestions.items.some(item => item.value.includes('deep-nested.ts')), `deep-nested.ts missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
})

test('MentionProvider applies a shell item as a plain word replacement', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, null)
  const applied = provider.applyCompletion(['!gi'], 0, 3, { value: 'git', label: 'git' }, 'gi')
  assert.deepEqual(applied, { lines: ['!git '], cursorLine: 0, cursorCol: 5 })
  const appliedVar = provider.applyCompletion(['!echo $HO'], 0, 9, { value: '$HOME', label: '$HOME' }, '$HO')
  assert.deepEqual(appliedVar, { lines: ['!echo $HOME '], cursorLine: 0, cursorCol: 12 })
})

// --- shell-editor-mode virtual prefix (the editor buffer no longer holds
// the `!` / `!!` prefix; the provider synthesizes it at the boundary) ---

/** A mutable mode source (the app wires it to the live editor mode). */
function modeSource(initial: 'prompt' | 'shell-context' | 'shell-local'): {
  source: () => 'prompt' | 'shell-context' | 'shell-local'
  set: (mode: 'prompt' | 'shell-context' | 'shell-local') => void
} {
  let mode = initial
  return { source: () => mode, set: (next) => { mode = next } }
}

test('MentionProvider completes shell words on the bare body via the virtual prefix', async () => {
  const root = fixtureWorkspace()
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([], root, null, source)
  // The buffer holds `gi` (no `!`); the provider synthesizes `!gi`.
  const suggestions = await provider.getSuggestions(['gi'], 0, 2, { signal: abort })
  assert.ok(suggestions !== null, 'command completion must run through the virtual prefix')
  assert.ok(suggestions.items.some(item => item.value === 'git'), 'git must be suggested')
  assert.equal(suggestions.prefix, 'gi', 'the suggestion prefix must be the REAL word (no synthetic !)')
})

test('MentionProvider applies a shell item without ever writing the synthetic prefix', async () => {
  const root = fixtureWorkspace()
  const { source } = modeSource('shell-local')
  const provider = new MentionProvider([], root, null, source)
  const applied = provider.applyCompletion(['git che'], 0, 7, { value: 'checkout', label: 'checkout' }, 'che')
  assert.deepEqual(applied, { lines: ['git checkout '], cursorLine: 0, cursorCol: 13 },
    'the applied line must be the bare body — the !! prefix never enters the buffer')
})

test('MentionProvider still completes paths on a shell-mode body (path positions reach the fork)', async () => {
  const root = fixtureWorkspace()
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([], root, null, source)
  const suggestions = await provider.getSuggestions(['cat src/de'], 0, 10, { signal: abort })
  assert.ok(suggestions !== null, 'a path position on a shell-mode body must reach the fork provider')
  assert.ok(suggestions.items.some(item => item.value.includes('deep-nested.ts')), `deep-nested.ts missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
})

test('a natural trigger on a leading / in a shell mode stays quiet (never slash commands)', async () => {
  const root = fixtureWorkspace()
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([{ name: 'image', description: 'Attach an image file' }], root, null, source)
  // The fork's slash-command branch would list `image` for a natural
  // trigger on `/`; the shell-mode routing must suppress it (a path, not
  // a command). Tab (force) still completes the path.
  const natural = await provider.getSuggestions(['/usr/lo'], 0, 7, { signal: abort, force: false })
  assert.equal(natural, null, 'a natural trigger on a shell-mode path must stay quiet')
  const forced = await provider.getSuggestions(['/usr/lo'], 0, 7, { signal: abort, force: true })
  assert.ok(forced !== null && forced.items.length > 0, 'Tab on a shell-mode path must complete the path')
})

test('shouldTriggerFileCompletion allows Tab on a leading / in a shell mode', async () => {
  const root = fixtureWorkspace()
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([], root, null, source)
  // The fork's bare-slash-command block would return false for `/usr/lo`
  // (no space); the virtual prefix keeps the fork's judgment on the
  // serialized line, where `/usr/lo` is a path.
  assert.equal(provider.shouldTriggerFileCompletion(['/usr/lo'], 0, 7), true)
  // Prompt mode keeps the fork's judgment (a bare slash command blocks Tab).
  const { source: promptSource } = modeSource('prompt')
  const promptProvider = new MentionProvider([], root, null, promptSource)
  assert.equal(promptProvider.shouldTriggerFileCompletion(['/usr/lo'], 0, 7), false)
})

// --- injected-runner determinism (review finding 4/5: failed runs must not
// be cached, and the spawn/cache must be testable without real bash) ---

import { resetCommandCacheForTest, setCompgenRunnerForTest, type CompgenRun } from '../src/shell-completion.ts'

function fakeRunner(script: (expression: string, prefix: string) => CompgenRun): {
  calls: { expression: string; prefix: string }[]
} {
  const calls: { expression: string; prefix: string }[] = []
  setCompgenRunnerForTest((_cwd, expression, prefix) => {
    calls.push({ expression, prefix })
    return Promise.resolve(script(expression, prefix))
  })
  return { calls }
}

test('successful command lists are cached; failed runs are never cached', async () => {
  resetCommandCacheForTest()
  try {
    const runner = fakeRunner(() => ({ ok: true, lines: ['git', 'gist'] }))
    const first = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: abort })
    assert.ok(first !== null && first.items.some(item => item.value === 'git'))
    assert.equal(runner.calls.length, 1, 'the first request spawns once')
    // Cache hit: a second request must not spawn again.
    const second = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: abort })
    assert.ok(second !== null)
    assert.equal(runner.calls.length, 1, 'a cache hit must not re-run compgen')
    // A FAILED run (timeout/abort/spawn error) must not create a cache
    // entry: the next request retries the spawn instead of seeing an empty
    // command set for the whole TTL.
    resetCommandCacheForTest()
    const failedRunner = fakeRunner(() => ({ ok: false, lines: [] }))
    const failed = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: abort })
    assert.equal(failed, null)
    assert.equal(failedRunner.calls.length, 1, 'the failed run happened once')
    const retried = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: abort })
    assert.equal(retried, null)
    assert.equal(failedRunner.calls.length, 2, 'a failed run must NOT be cached — the retry must spawn again')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
})

test('an aborted request never spawns and variable/subcommand failures degrade', async () => {
  resetCommandCacheForTest()
  try {
    const controller = new AbortController()
    const calls: string[] = []
    setCompgenRunnerForTest((_cwd, expression) => {
      calls.push(expression)
      return Promise.resolve({ ok: false, lines: [] })
    })
    controller.abort()
    const aborted = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, cwd, { signal: controller.signal })
    assert.equal(aborted, null)
    assert.equal(calls.length, 0, 'an already-aborted request must not spawn')
    // Variable failure: null, no cache side effects.
    const vars = await suggestShellCompletion({ kind: 'variable', prefix: '$HO', priorWords: ['echo'] }, cwd, { signal: abort })
    assert.equal(vars, null)
    // Subcommand lister failure: the static fallback wins (never treated as
    // a valid empty list).
    const subs = await suggestShellCompletion({ kind: 'subcommand', prefix: 'che', priorWords: ['git'] }, cwd, { signal: abort })
    assert.ok(subs !== null && subs.items.some(item => item.value === 'checkout'),
      'a failed lister must fall back to the static subcommand table')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
})
