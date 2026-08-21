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
