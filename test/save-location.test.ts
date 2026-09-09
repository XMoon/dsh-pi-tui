/**
 * Save Location prompt tests (Pre-Stage-D export convergence): the
 * Client-local directory chooser — fixed non-editable filename, directory
 * editing, directory-only suggestions, Tab accept, Enter validation,
 * Esc-close-then-cancel, collision confirmation (No returns to directory
 * selection, never cancels the whole command), late-completion fencing, and
 * the app-level editor-seat mount/restore behavior. The prompt is filesystem
 * UI, NOT an agent question: it never goes through TuiQuestion /
 * QuestionFlow / askQuestions.
 * @module @xmoon76/dsh-pi-tui/save-location.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SaveLocationPrompt, type SaveLocationDeps, type SaveLocationResult } from '../src/save-location.ts'
import type { DirectoryCompletionItem } from '../src/file-completion/directory-completion.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** A fake deps set over a real temp fixture (directories + files). The out
 * directory lives INSIDE cwd so typing its name appends to the initial `./`
 * and resolves through the fake resolver. */
function fixtureDeps(life: ReturnType<typeof testLifecycle>): {
  deps: SaveLocationDeps
  cwd: string
  out: string
  target: string
} {
  const root = life.tempDir('dsh-save-loc-')
  const cwd = join(root, 'cwd')
  const out = join(cwd, 'out')
  mkdirSync(cwd)
  mkdirSync(out)
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'notes.txt'), 'x')
  const target = join(out, 'dsh-session-session-abc.zip')
  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input === './' ? cwd : join(cwd, input),
    isDirectory: (path) => path === cwd || path === out || path === join(cwd, 'src'),
    targetExists: (directory, filename) => join(directory, filename) === target,
    complete: async (raw) => {
      if (raw === './') {
        return [{ value: 'src/', label: 'src/' }]
      }
      if (raw === './src/') {
        return null
      }
      return null
    },
  }
  return { deps, cwd, out, target }
}

test('initial directory is ./ and the filename row is fixed', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  assert.equal(prompt.getValue(), './')
  const lines = prompt.render(60)
  assert.ok(lines.some(line => line.includes('Save session archive')))
  assert.ok(lines.some(line => line.includes('dsh-session-session-abc.zip')))
  assert.ok(lines.some(line => line.includes('Directory:')))
  assert.equal(result, undefined)
})

test('suggestions are directory-only and Tab accepts one', async (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  // The initial refresh is async; wait for the suggestion to land.
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  const suggestions = prompt.getSuggestions()
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0]?.value, 'src/')
  prompt.handleInput('\t')
  assert.equal(prompt.getValue(), 'src/')
  assert.equal(result, undefined)
})

test('Enter validates: nonexistent directory stays open with an error', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  prompt.handleInput('x') // type a nonexistent path suffix
  prompt.handleInput('\r')
  assert.equal(result, undefined, 'invalid directory must not settle')
  assert.ok(prompt.getValidationError() !== undefined, 'a validation error is shown')
})

test('Enter validates: a file path is rejected', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  // Type a path that resolves to the notes.txt file (not a directory).
  prompt.handleInput('notes.txt')
  prompt.handleInput('\r')
  assert.equal(result, undefined)
  assert.ok(prompt.getValidationError() !== undefined)
})

test('Enter on a valid directory selects it', (t) => {
  const { deps, cwd } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  prompt.handleInput('\r')
  assert.deepEqual(result, { kind: 'selected', directory: cwd })
})

test('Esc closes the suggestions first, then cancels', async (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(prompt.getSuggestions().length, 1)
  prompt.handleInput('\x1b') // first Esc closes the suggestions
  assert.equal(prompt.getSuggestions().length, 0)
  assert.equal(result, undefined, 'first Esc must not cancel')
  prompt.handleInput('\x1b') // second Esc cancels
  assert.deepEqual(result, { kind: 'cancelled' })
})

test('collision: target exists enters confirmation; No returns to selection', (t) => {
  const { deps, out } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  // Type the out directory (whose target file exists): `./` + `out`.
  prompt.handleInput('out')
  prompt.handleInput('\r')
  assert.equal(result, undefined, 'collision must not settle yet')
  assert.equal(prompt.isConfirming(), true)
  const lines = prompt.render(60)
  assert.ok(lines.some(line => line.includes('File already exists:')))
  assert.ok(lines.some(line => line.includes('Replace existing file?')))
  prompt.handleInput('n') // No → back to directory selection
  assert.equal(prompt.isConfirming(), false)
  assert.equal(result, undefined, 'No must not cancel the whole command')
  // The prompt is back in the editing state: Esc now cancels.
  prompt.handleInput('\x1b')
  assert.deepEqual(result, { kind: 'cancelled' })
})

test('collision: Yes replaces and selects the directory', (t) => {
  const { deps, out } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  prompt.handleInput('out')
  prompt.handleInput('\r')
  assert.equal(prompt.isConfirming(), true)
  prompt.handleInput('y')
  assert.deepEqual(result, { kind: 'selected', directory: out })
})

test('left/right editing moves the text cursor', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  prompt.handleInput('\x1b[D') // Left: cursor 2 -> 1
  prompt.handleInput('x') // insert at the cursor
  assert.equal(prompt.getValue(), '.x/')
  prompt.handleInput('\x1b[C') // Right: cursor 2 -> 3
  prompt.handleInput('y')
  assert.equal(prompt.getValue(), '.x/y')
  assert.equal(result, undefined)
})

test('late completion after cancel is ignored', async (t) => {
  const life = testLifecycle(t)
  let resolveCompletion: ((items: DirectoryCompletionItem[] | null) => void) | undefined
  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: () => new Promise<DirectoryCompletionItem[] | null>((resolve) => { resolveCompletion = resolve }),
  }
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  prompt.handleInput('\x1b') // cancel (no suggestions open)
  assert.deepEqual(result, { kind: 'cancelled' })
  // The in-flight completion resolves AFTER the cancel: it must be fenced.
  resolveCompletion?.([{ value: 'late/', label: 'late/' }])
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(prompt.getSuggestions().length, 0, 'late completion must be ignored')
  void life
})

test('app: askSaveLocation mounts the prompt in the editor seat and restores it', async (t) => {
  const life = testLifecycle(t)
  const { deps, cwd } = fixtureDeps(life)
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const promise = app.askSaveLocation(
      { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
      deps,
    )
    await vt.waitForRender()
    // The prompt owns the seat: Enter selects the valid ./ directory.
    vt.sendInput('\r')
    const result = await promise
    assert.deepEqual(result, { kind: 'selected', directory: cwd })
    await vt.waitForRender()
    // The editor seat is restored (the app is still interactive).
    assert.equal(app.isDisposed(), false)
  } finally {
    app.dispose()
  }
})

test('app: askSaveLocation cancel restores the editor seat', async (t) => {
  const life = testLifecycle(t)
  // No suggestions: a single Esc cancels the prompt (the suggestion-close
  // stage is exercised by the component tests).
  const { deps } = fixtureDeps(life)
  const noSuggestions: SaveLocationDeps = { ...deps, complete: async () => null }
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const promise = app.askSaveLocation(
      { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
      noSuggestions,
    )
    await vt.waitForRender()
    vt.sendInput('\x1b')
    const result = await promise
    assert.deepEqual(result, { kind: 'cancelled' })
  } finally {
    app.dispose()
  }
})

test('app: a second askSaveLocation while one is active is refused', async (t) => {
  const life = testLifecycle(t)
  const { deps } = fixtureDeps(life)
  const noSuggestions: SaveLocationDeps = { ...deps, complete: async () => null }
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const first = app.askSaveLocation(
      { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
      noSuggestions,
    )
    await vt.waitForRender()
    await assert.rejects(
      app.askSaveLocation(
        { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
        noSuggestions,
      ),
      /already active/,
    )
    vt.sendInput('\x1b')
    assert.deepEqual(await first, { kind: 'cancelled' })
  } finally {
    app.dispose()
  }
})

test('app: surface stop settles an open prompt as cancelled', async (t) => {
  const life = testLifecycle(t)
  const { deps } = fixtureDeps(life)
  const noSuggestions: SaveLocationDeps = { ...deps, complete: async () => null }
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const promise = app.askSaveLocation(
      { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
      noSuggestions,
    )
    await vt.waitForRender()
    app.stop()
    assert.deepEqual(await promise, { kind: 'cancelled' })
  } finally {
    app.dispose()
  }
})
