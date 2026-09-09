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
  assert.deepEqual(result, { kind: 'selected', directory: cwd, overwrite: false })
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
  assert.deepEqual(result, { kind: 'selected', directory: out, overwrite: true })
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

test('a superseded refresh aborts the previous completion scan', async (t) => {
  const life = testLifecycle(t)
  const signals: AbortSignal[] = []
  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: (_raw, signal) => {
      signals.push(signal)
      // Never resolves: the scan stays live until aborted.
      return new Promise<DirectoryCompletionItem[] | null>(() => {})
    },
  }
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  // The initial refresh starts completion #1.
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  // Typing triggers refresh #2: completion #1's scan must be aborted (rapid
  // typing must not leave concurrent filesystem scans running).
  prompt.handleInput('x')
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(signals.length, 2)
  assert.equal(signals[0]?.aborted, true, 'the superseded completion is aborted')
  assert.equal(signals[1]?.aborted, false, 'the latest completion stays live')
  void life
  void result
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
    assert.deepEqual(result, { kind: 'selected', directory: cwd, overwrite: false })
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
  let completeCalls = 0
  const noSuggestions: SaveLocationDeps = { ...deps, complete: async () => { completeCalls += 1; return null } }
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const first = app.askSaveLocation(
      { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
      noSuggestions,
    )
    await vt.waitForRender()
    const callsAfterFirst = completeCalls
    await assert.rejects(
      app.askSaveLocation(
        { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
        noSuggestions,
      ),
      /already active/,
    )
    assert.equal(completeCalls, callsAfterFirst, 'a refused duplicate must not start completion work')
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

test('app: a Host approval settles an open Save Location prompt as cancelled', async (t) => {
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
    // A Host approval mounts while the prompt is active: the prompt settles
    // cancelled and the approval is answerable — it must never be left
    // unanswerable behind the prompt's input routing.
    const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
    assert.deepEqual(await promise, { kind: 'cancelled' })
    vt.sendInput('y')
    assert.equal(await approval, 'allowed-once')
  } finally {
    app.dispose()
  }
})

test('app: a capturing overlay mounting while Save Location is active is suspended, never left unanswerable', async (t) => {
  const life = testLifecycle(t)
  const { deps, cwd } = fixtureDeps(life)
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
    // A capturing picker mounts while the prompt is active: it is SUSPENDED
    // (hidden, state intact) — the prompt keeps owning the seat and is
    // never cancelled by the mount.
    const picker = app.openPicker([{ value: 'a', label: 'option a' }], () => {}, () => {})
    await vt.waitForRender()
    // The prompt is still answerable: Enter selects the valid ./ directory.
    vt.sendInput('\r')
    assert.deepEqual(await promise, { kind: 'selected', directory: cwd, overwrite: false })
    // The suspended picker is restored after the prompt settles.
    picker.close()
  } finally {
    app.dispose()
  }
})

test('app: an already-aborted signal rejects before any completion work starts', async (t) => {
  const life = testLifecycle(t)
  let completeCalls = 0
  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async () => { completeCalls += 1; return null },
  }
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      app.askSaveLocation(
        { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
        deps,
        controller.signal,
      ),
      /aborted/,
    )
    assert.equal(completeCalls, 0, 'a rejected request must never start completion work')
  } finally {
    app.dispose()
  }
})

test('app: a Save Location prompt survives a fullscreen swap with its frame focused', async (t) => {
  const life = testLifecycle(t)
  const { deps, cwd } = fixtureDeps(life)
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
    // A fullscreen swap must not cancel the prompt; its frame stays the
    // focused component on the new screen (the input routing is
    // screen-agnostic, but the visible focus contract must hold).
    app.setFullscreen(true)
    await vt.waitForRender()
    const internals = app as unknown as {
      activeScreen: { getFocusedComponent(): unknown }
      activeSaveLocation?: { frame: unknown }
    }
    assert.equal(
      internals.activeScreen.getFocusedComponent(),
      internals.activeSaveLocation?.frame,
      'the prompt frame is the focused component after the swap',
    )
    vt.sendInput('\r')
    assert.deepEqual(await promise, { kind: 'selected', directory: cwd, overwrite: false })
    app.setFullscreen(false)
    await vt.waitForRender()
  } finally {
    app.dispose()
  }
})

test('app: a Save Location request while a Host question is active is refused', async (t) => {
  const life = testLifecycle(t)
  const { deps } = fixtureDeps(life)
  const noSuggestions: SaveLocationDeps = { ...deps, complete: async () => null }
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
    await vt.waitForRender()
    // The Host question owns the seat: the Save request is refused and must
    // never replace the question's seat (which would leave it pending
    // behind the prompt's input routing).
    await assert.rejects(
      app.askSaveLocation(
        { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
        noSuggestions,
      ),
      /host question or approval/,
    )
    // The question is still answerable: select option 1, then submit.
    vt.sendInput('1')
    vt.sendInput('\r')
    const answers = await questions
    assert.deepEqual(answers[0]?.selected, ['yes'])
  } finally {
    app.dispose()
  }
})

test('mouse parity: clicking the Directory row positions the private Input cursor', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  prompt.handleInput('a')
  prompt.handleInput('b')
  prompt.handleInput('c') // value = './abc'
  const rendered = prompt.render(60)
  const row = rendered.findIndex(line => line.includes('Directory:'))
  assert.ok(row >= 0, `directory row missing:\n${rendered.join('\n')}`)
  // 'Directory: ' occupies 11 columns; the Input's value starts at row
  // col 11 ('.' at col 11, '/' at col 12, 'a' at col 13, 'b' at col 14).
  // Input-local x = row x - 9; Input subtracts its '> ' prompt, so
  // clicking col 14 places the cursor after 'a' (cursor 3).
  prompt.handleMouse({
    type: 'press', button: 'left', x: 14, y: row, screenX: 14, screenY: row,
    width: 60, height: 24, shift: false, alt: false, ctrl: false,
  })
  prompt.handleInput('X')
  assert.equal(prompt.getValue(), './aXbc', 'the click must position the Input cursor')
})

test('mouse parity: a suggestion press selects and a click accepts it (Tab semantic)', async (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(prompt.getSuggestions().length, 1, 'precondition — suggestion landed')
  const rendered = prompt.render(60)
  const row = rendered.findIndex(line => line.includes('src/'))
  assert.ok(row >= 0, `suggestion row missing:\n${rendered.join('\n')}`)
  prompt.handleMouse({
    type: 'press', button: 'left', x: 2, y: row, screenX: 2, screenY: row,
    width: 60, height: 24, shift: false, alt: false, ctrl: false,
  })
  prompt.handleMouse({
    type: 'click', button: 'left', x: 2, y: row, screenX: 2, screenY: row,
    width: 60, height: 24, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.equal(prompt.getValue(), 'src/', 'the click must accept the suggestion like Tab')
})

test('mouse parity: title, file, error, and hint rows are inert', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  const rendered = prompt.render(60)
  const titleRow = rendered.findIndex(line => line.includes('Save session archive'))
  const fileRow = rendered.findIndex(line => line.includes('dsh-session-session-abc.zip'))
  const hintRow = rendered.findIndex(line => line.includes('esc cancel'))
  assert.ok(titleRow >= 0 && fileRow >= 0 && hintRow >= 0)
  const event = (y: number) => ({
    type: 'press' as const, button: 'left' as const, x: 5, y, screenX: 5, screenY: y,
    width: 60, height: 24, shift: false, alt: false, ctrl: false,
  })
  assert.equal(prompt.handleMouse(event(titleRow)), undefined, 'title must be inert')
  assert.equal(prompt.handleMouse(event(fileRow)), undefined, 'file row must be inert')
  assert.equal(prompt.handleMouse(event(hintRow)), undefined, 'hint must be inert')
})

test('mouse parity: a stale pressed VALUE is released on click mismatch (no ghost accept)', async (t) => {
  const deps = {
    resolveDirectory: (input: string) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) =>
      raw === './' ? [{ value: 'src/', label: 'src/' }, { value: 'lib/', label: 'lib/' }] : null,
  }
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  let rendered = prompt.render(60)
  const srcRow = rendered.findIndex(line => line.includes('src/'))
  const libRow = rendered.findIndex(line => line.includes('lib/'))
  assert.ok(srcRow >= 0 && libRow >= 0, `suggestion rows missing:\n${rendered.join('\n')}`)
  const press = (y: number) => ({
    type: 'press' as const, button: 'left' as const, x: 2, y, screenX: 2, screenY: y,
    width: 60, height: 24, shift: false, alt: false, ctrl: false,
  })
  const click = (y: number) => ({
    type: 'click' as const, button: 'left' as const, x: 2, y, screenX: 2, screenY: y,
    width: 60, height: 24, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  prompt.handleMouse(press(srcRow)) // pressed identity = 'src/'
  const p = prompt as unknown as { suggestions: Array<{ value: string; label: string }>; mousePressedValue: string | undefined }
  assert.equal(p.mousePressedValue, 'src/', 'precondition — pressed identity latched')
  // An async completion refresh reorders the list WITHOUT a repaint.
  p.suggestions = [{ value: 'lib/', label: 'lib/' }]
  // The release click lands on a DIFFERENT row: the mismatch must
  // RELEASE the pressed identity (no stale latch for a later click).
  prompt.handleMouse(click(libRow))
  assert.equal(p.mousePressedValue, undefined, 'the pressed identity must be released on click mismatch')
  assert.equal(prompt.getValue(), './', 'the mismatched click must not accept anything')
  // The pressed suggestion returns; a click WITHOUT a fresh press must NOT accept.
  p.suggestions = [{ value: 'src/', label: 'src/' }, { value: 'lib/', label: 'lib/' }]
  rendered = prompt.render(60)
  const srcRow2 = rendered.findIndex(line => line.includes('src/'))
  assert.ok(srcRow2 >= 0)
  prompt.handleMouse(click(srcRow2))
  assert.equal(prompt.getValue(), './', 'a click without a fresh press must not accept')
})
