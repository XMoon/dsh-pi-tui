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
import { SaveLocationPrompt, type SaveLocationDeps, type SaveLocationResult } from '../../src/tui/interaction/save-location.ts'
import type { DirectoryCompletionCandidate } from '../../src/client/file-completion/directory-completion.ts'
import { Frame, TuiApp } from '../../src/tui-app.ts'
import { TuiAltScreen } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

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
        return [{ value: 'src/', displayPath: 'src' }]
      }
      if (raw === './src/') {
        return null
      }
      return null
    },
  }
  return { deps, cwd, out, target }
}

/** The visible column of `label` on one painted prompt line (ANSI-stripped). */
function paintedColumn(line: string, label: string): number {
  const plain = paintedText(line)
  const column = plain.indexOf(label)
  assert.ok(column >= 0, `${label} is not painted:\n${line}`)
  return column
}

/** One painted line with its SGR styling stripped. */
function paintedText(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/gu, '')
}

/** The painted `label` cell of the LAST (action) row. */
function actionPoint(rendered: readonly string[], label: string): { readonly row: number; readonly column: number } {
  const row = rendered.length - 1
  const line = rendered[row]
  assert.ok(line !== undefined, 'the prompt paints an action row')
  return { row, column: paintedColumn(line, label) }
}

/** One prompt-local pointer event at a painted cell (the frame passes its
 *  painted content height, and these tests must too). */
function pointerEvent(
  point: { readonly row: number; readonly column: number },
  type: 'press' | 'click',
  geometry: { readonly width: number; readonly height: number },
): {
  type: 'press' | 'click'
  button: 'left'
  x: number
  y: number
  screenX: number
  screenY: number
  width: number
  height: number
  shift: false
  alt: false
  ctrl: false
  clickCount?: number
} {
  return {
    type,
    button: 'left',
    x: point.column,
    y: point.row,
    screenX: point.column,
    screenY: point.row,
    width: geometry.width,
    height: geometry.height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

/** One complete press+click on a painted action label of the LAST row. */
function clickAction(
  prompt: SaveLocationPrompt,
  rendered: readonly string[],
  label: string,
  width = 60,
): void {
  const point = actionPoint(rendered, label)
  const geometry = { width, height: rendered.length }
  prompt.handleMouse(pointerEvent(point, 'press', geometry))
  prompt.handleMouse(pointerEvent(point, 'click', geometry))
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
  let resolveCompletion: ((items: DirectoryCompletionCandidate[] | null) => void) | undefined
  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: () => new Promise<DirectoryCompletionCandidate[] | null>((resolve) => { resolveCompletion = resolve }),
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
  resolveCompletion?.([{ value: 'late/', displayPath: 'late' }])
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
      return new Promise<DirectoryCompletionCandidate[] | null>(() => {})
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
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false,
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
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false,
  })
  prompt.handleMouse({
    type: 'click', button: 'left', x: 2, y: row, screenX: 2, screenY: row,
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.equal(prompt.getValue(), 'src/', 'the click must accept the suggestion like Tab')
})

test('mouse parity: a key between a suggestion press and release revokes the accept', async (t) => {
  const deps = {
    resolveDirectory: (input: string) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) =>
      raw === './' ? [{ value: 'src/', displayPath: 'src' }, { value: 'lib/', displayPath: 'lib' }] : null,
  }
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  const rendered = prompt.render(60)
  const srcRow = rendered.findIndex(line => line.includes('src/'))
  assert.ok(srcRow >= 0, `suggestion row missing:\n${rendered.join('\n')}`)
  const geometry = { width: 60, height: rendered.length }
  const point = { row: srcRow, column: 2 }
  prompt.handleMouse(pointerEvent(point, 'press', geometry))
  const state = prompt as unknown as { mousePressedValue: string | undefined }
  assert.equal(state.mousePressedValue, 'src/', 'precondition — the suggestion press is latched')
  // Right moves the Input cursor WITHOUT changing the value or the suggestion
  // list: the held identity must still die with the semantic frame.
  prompt.handleInput('\x1b[C')
  assert.equal(state.mousePressedValue, undefined, 'the key must revoke the held suggestion identity')
  prompt.handleMouse(pointerEvent(point, 'click', geometry))
  assert.equal(prompt.getValue(), './', 'the stale release must not accept the suggestion')
})

test('mouse parity: a cursor move between a suggestion press and release revokes the accept', async (t) => {
  const deps = {
    resolveDirectory: (input: string) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) =>
      raw === './' ? [{ value: 'src/', displayPath: 'src' }, { value: 'lib/', displayPath: 'lib' }] : null,
  }
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  const rendered = prompt.render(60)
  const srcRow = rendered.findIndex(line => line.includes('src/'))
  assert.ok(srcRow >= 0, `suggestion row missing:\n${rendered.join('\n')}`)
  const geometry = { width: 60, height: rendered.length }
  const point = { row: srcRow, column: 2 }
  prompt.handleMouse(pointerEvent(point, 'press', geometry))
  // Down moves the suggestion cursor (Suggestion A stays listed under the same
  // cell): a release there may not accept the pre-move press.
  prompt.handleInput('\x1b[B')
  assert.equal(prompt.getSuggestionCursor(), 1, 'precondition — the cursor really moved')
  prompt.handleMouse(pointerEvent(point, 'click', geometry))
  assert.equal(prompt.getValue(), './', 'the pre-move suggestion press must not accept')
  // The next complete gesture still accepts the row it presses.
  prompt.handleMouse(pointerEvent(point, 'press', geometry))
  prompt.handleMouse(pointerEvent(point, 'click', geometry))
  assert.equal(prompt.getValue(), 'src/', 'a fresh complete gesture still accepts the suggestion')
})

test('mouse parity: title and file rows and the action-row gap cells are inert', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  const rendered = prompt.render(60)
  const titleRow = rendered.findIndex(line => line.includes('Save session archive'))
  const fileRow = rendered.findIndex(line => line.includes('dsh-session-session-abc.zip'))
  assert.ok(titleRow >= 0 && fileRow >= 0)
  const geometry = { width: 60, height: rendered.length }
  const event = (y: number, x: number) => pointerEvent({ row: y, column: x }, 'press', geometry)
  assert.equal(prompt.handleMouse(event(titleRow, 5)), undefined, 'title must be inert')
  assert.equal(prompt.handleMouse(event(fileRow, 5)), undefined, 'file row must be inert')
  // The separator cells between the complete verbs are inert: the visible
  // columns after `Save [Enter]` (12 cells) belong to ` · `.
  assert.match(paintedText(rendered.at(-1) ?? ''), /Save \[Enter\] · Cancel \[Esc\]/u)
  assert.equal(prompt.handleMouse(event(rendered.length - 1, 13)), undefined,
    'the gap between the verbs must not be a button')
})

// ── C1: the clickable action row (Save / Dismiss / Cancel / Yes / No) ──────

test('action row: Save runs the original confirm and selects a collision-free directory', (t) => {
  const { deps, cwd } = fixtureDeps(testLifecycle(t))
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  const rendered = prompt.render(60)
  assert.match(paintedText(rendered.at(-1) ?? ''), /Save \[Enter\] · Cancel \[Esc\]/u)
  clickAction(prompt, rendered, 'Save [Enter]')
  assert.deepEqual(results, [{ kind: 'selected', directory: cwd, overwrite: false }])
})

test('action row: Dismiss suggestions only closes the list and the next frame offers Cancel', async (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10)) // the initial suggestion lands
  assert.equal(prompt.getSuggestions().length, 1, 'precondition — suggestion visible')
  let rendered = prompt.render(60)
  assert.match(paintedText(rendered.at(-1) ?? ''), /Save \[Enter\] · Dismiss suggestions \[Esc\]/u)
  clickAction(prompt, rendered, 'Dismiss suggestions [Esc]')
  assert.equal(prompt.getSuggestions().length, 0, 'Dismiss only closes the suggestions')
  assert.deepEqual(results, [], 'Dismiss never settles the save')
  rendered = prompt.render(60)
  assert.match(paintedText(rendered.at(-1) ?? ''), /Save \[Enter\] · Cancel \[Esc\]/u,
    'the next frame advertises the real Cancel')
  clickAction(prompt, rendered, 'Cancel [Esc]')
  assert.deepEqual(results, [{ kind: 'cancelled' }])
})

test('action row: collision No returns to editing and Yes replaces exactly once', (t) => {
  const { deps, out } = fixtureDeps(testLifecycle(t))
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  prompt.handleInput('out')
  prompt.handleInput('\r')
  assert.equal(prompt.isConfirming(), true, 'precondition — collision confirmation')
  let rendered = prompt.render(60)
  assert.match(paintedText(rendered.at(-1) ?? ''), /Yes \[Y\] · No \[N\]/u)
  clickAction(prompt, rendered, 'No [N]')
  assert.equal(prompt.isConfirming(), false, 'No returns to directory editing')
  assert.deepEqual(results, [], 'No never settles the command')
  // The directory row is editable again; Save re-enters the same collision.
  rendered = prompt.render(60)
  clickAction(prompt, rendered, 'Save [Enter]')
  assert.equal(prompt.isConfirming(), true)
  rendered = prompt.render(60)
  clickAction(prompt, rendered, 'Yes [Y]')
  assert.deepEqual(results, [{ kind: 'selected', directory: out, overwrite: true }])
  // A settled prompt paints its last frame but can never settle a second time.
  clickAction(prompt, prompt.render(60), 'Yes [Y]')
  assert.equal(results.length, 1, 'the per-open settle latch wins')
})

test('action row: an invalid directory keeps the error and never settles', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  prompt.handleInput('nope')
  let rendered = prompt.render(60)
  clickAction(prompt, rendered, 'Save [Enter]')
  assert.deepEqual(results, [], 'an invalid directory must not settle')
  assert.match(prompt.getValidationError() ?? '', /not a directory/u)
  rendered = prompt.render(60)
  assert.ok(rendered.some(line => line.includes('directory does not exist')), 'the error stays visible')
  assert.match(paintedText(rendered.at(-1) ?? ''), /Save \[Enter\] · Cancel \[Esc\]/u)
  clickAction(prompt, rendered, 'Cancel [Esc]')
  assert.deepEqual(results, [{ kind: 'cancelled' }])
})

test('action row: a key, wheel or resize between press and click never saves', (t) => {
  const { deps, cwd } = fixtureDeps(testLifecycle(t))
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  // A semantic key between the press and the click refuses the gesture.
  let rendered = prompt.render(60)
  let point = actionPoint(rendered, 'Save [Enter]')
  let geometry = { width: 60, height: rendered.length }
  prompt.handleMouse(pointerEvent(point, 'press', geometry))
  prompt.handleInput('\x1b[C') // Right: cursor move, no value change
  prompt.handleMouse(pointerEvent(point, 'click', geometry))
  assert.deepEqual(results, [], 'a key between press and click must refuse')
  // A wheel between the press and the click refuses it even when it scrolls
  // nothing (no suggestion row under the pointer).
  rendered = prompt.render(60)
  point = actionPoint(rendered, 'Save [Enter]')
  geometry = { width: 60, height: rendered.length }
  prompt.handleMouse(pointerEvent(point, 'press', geometry))
  prompt.handleMouse({
    type: 'wheel', button: 'none', x: point.column, y: point.row,
    screenX: point.column, screenY: point.row,
    width: geometry.width, height: geometry.height, shift: false, alt: false, ctrl: false, wheelDelta: 1,
  })
  prompt.handleMouse(pointerEvent(point, 'click', geometry))
  assert.deepEqual(results, [], 'a wheel between press and click must refuse')
  // A resize between the press and the click refuses it (the frame grant moved).
  rendered = prompt.render(60)
  point = actionPoint(rendered, 'Save [Enter]')
  prompt.handleMouse(pointerEvent(point, 'press', { width: 60, height: rendered.length }))
  const narrowed = prompt.render(40)
  prompt.handleMouse(pointerEvent(actionPoint(narrowed, 'Save [Enter]'), 'click',
    { width: 40, height: narrowed.length }))
  assert.deepEqual(results, [], 'a resize between press and click must refuse')
  // A fresh complete gesture against the CURRENT frame still runs.
  clickAction(prompt, narrowed, 'Save [Enter]', 40)
  assert.deepEqual(results, [{ kind: 'selected', directory: cwd, overwrite: false }])
})

test('action row: a settled suggestion refresh refuses the pre-refresh press', async (t) => {
  let resolveCompletion: ((items: DirectoryCompletionCandidate[] | null) => void) | undefined
  const deps: SaveLocationDeps = {
    resolveDirectory: input => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: () => new Promise<DirectoryCompletionCandidate[] | null>((resolve) => { resolveCompletion = resolve }),
  }
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  const rendered = prompt.render(60)
  const point = actionPoint(rendered, 'Save [Enter]')
  const geometry = { width: 60, height: rendered.length }
  prompt.handleMouse(pointerEvent(point, 'press', geometry))
  resolveCompletion?.([{ value: 'src/', displayPath: 'src' }])
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  prompt.handleMouse(pointerEvent(point, 'click', geometry))
  assert.deepEqual(results, [], 'the async completion must refuse the old press')
  const next = prompt.render(60)
  assert.match(paintedText(next.at(-1) ?? ''), /Dismiss suggestions \[Esc\]/u,
    'the new frame really changed the action row')
  clickAction(prompt, next, 'Save [Enter]')
  assert.deepEqual(results, [{ kind: 'selected', directory: './', overwrite: false }])
})

test('action row: a settled prompt renders but never saves again', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  clickAction(prompt, prompt.render(60), 'Save [Enter]')
  assert.equal(results.length, 1, 'precondition — the first gesture settled')
  // The component can still render its last frame, but the per-open latch
  // rejects every later gesture.
  const rendered = prompt.render(60)
  const point = actionPoint(rendered, 'Save [Enter]')
  const geometry = { width: 60, height: rendered.length }
  assert.equal(prompt.handleMouse(pointerEvent(point, 'press', geometry)), undefined)
  assert.equal(prompt.handleMouse(pointerEvent(point, 'click', geometry)), undefined)
  assert.equal(results.length, 1, 'the settled prompt can never settle twice')
  prompt.dispose()
})

test('action row: narrow widths drop whole verbs and keep the safe exit', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { results.push(value) },
  )
  const wide = prompt.render(40)
  assert.match(paintedText(wide.at(-1) ?? ''), /Save \[Enter\] · Cancel \[Esc\]/u)
  const narrow = prompt.render(16)
  assert.match(paintedText(narrow.at(-1) ?? ''), /Cancel \[Esc\]/u, 'the safe exit survives')
  assert.doesNotMatch(paintedText(narrow.at(-1) ?? ''), /Save/u, 'the whole Save verb is dropped')
  // Nothing fits: the row paints no action and publishes no hit target.
  const tiny = prompt.render(10)
  const tinyPoint = { row: tiny.length - 1, column: 0 }
  assert.equal(prompt.handleMouse(pointerEvent(tinyPoint, 'press', { width: 10, height: tiny.length })), undefined)
  assert.deepEqual(results, [])
  // A narrow collision row keeps the safe No verb and drops Yes whole.
  prompt.handleInput('out')
  prompt.handleInput('\r')
  const collision = prompt.render(10)
  assert.match(paintedText(collision.at(-1) ?? ''), /No \[N\]/u)
  assert.doesNotMatch(paintedText(collision.at(-1) ?? ''), /Yes/u)
  clickAction(prompt, collision, 'No [N]', 10)
  assert.equal(prompt.isConfirming(), false)
  assert.deepEqual(results, [])
  // The 44x20 editor-seat grant (inner width 40) paints both collision verbs.
  prompt.handleInput('\r') // './out' is unchanged: the same collision returns
  assert.equal(prompt.isConfirming(), true)
  const roomy = prompt.render(40)
  assert.match(paintedText(roomy.at(-1) ?? ''), /Yes \[Y\] · No \[N\]/u)
  clickAction(prompt, roomy, 'Yes [Y]', 40)
  assert.equal(results.length, 1)
})

test('mouse parity: a stale pressed VALUE is released on click mismatch (no ghost accept)', async (t) => {
  const deps = {
    resolveDirectory: (input: string) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) =>
      raw === './' ? [{ value: 'src/', displayPath: 'src' }, { value: 'lib/', displayPath: 'lib' }] : null,
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
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false,
  })
  const click = (y: number) => ({
    type: 'click' as const, button: 'left' as const, x: 2, y, screenX: 2, screenY: y,
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  prompt.handleMouse(press(srcRow)) // pressed identity = 'src/'
  const p = prompt as unknown as { suggestions: Array<{ value: string; displayPath: string }>; mousePressedValue: string | undefined }
  assert.equal(p.mousePressedValue, 'src/', 'precondition — pressed identity latched')
  // An async completion refresh reorders the list WITHOUT a repaint.
  p.suggestions = [{ value: 'lib/', displayPath: 'lib' }]
  // The release click lands on a DIFFERENT row: the mismatch must
  // RELEASE the pressed identity (no stale latch for a later click).
  prompt.handleMouse(click(libRow))
  assert.equal(p.mousePressedValue, undefined, 'the pressed identity must be released on click mismatch')
  assert.equal(prompt.getValue(), './', 'the mismatched click must not accept anything')
  // The pressed suggestion returns; a click WITHOUT a fresh press must NOT accept.
  p.suggestions = [{ value: 'src/', displayPath: 'src' }, { value: 'lib/', displayPath: 'lib' }]
  rendered = prompt.render(60)
  const srcRow2 = rendered.findIndex(line => line.includes('src/'))
  assert.ok(srcRow2 >= 0)
  prompt.handleMouse(click(srcRow2))
  assert.equal(prompt.getValue(), './', 'a click without a fresh press must not accept')
})

test('mouse parity: the collision confirmation blocks directory-row editing (inert while confirming)', (t) => {
  const { deps } = fixtureDeps(testLifecycle(t))
  let result: SaveLocationResult | undefined
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    (value) => { result = value },
  )
  prompt.handleInput('out')
  prompt.handleInput('\r') // target exists → confirmation state
  assert.equal(prompt.isConfirming(), true, 'precondition — confirmation state')
  const rendered = prompt.render(60)
  const directoryRow = rendered.findIndex(line => line.includes('Directory:'))
  assert.ok(directoryRow >= 0)
  const before = prompt.getValue()
  const handled = prompt.handleMouse({
    type: 'press', button: 'left', x: 14, y: directoryRow, screenX: 14, screenY: directoryRow,
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(handled, undefined, 'the confirmation must be inert to mouse input')
  assert.equal(prompt.getValue(), before, 'the directory value must not change')
  assert.equal(result, undefined, 'the confirmation must not settle')
})

test('mouse parity: a REAL wheel event (button "none") moves the suggestion selection', async (t) => {
  const deps = {
    resolveDirectory: (input: string) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) =>
      raw === './' ? [{ value: 'src/', displayPath: 'src' }, { value: 'lib/', displayPath: 'lib' }] : null,
  }
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  const rendered = prompt.render(60)
  const libRow = rendered.findIndex(line => line.includes('lib/'))
  assert.ok(libRow >= 0, `suggestion rows missing:\n${rendered.join('\n')}`)
  // The TUI normalizes wheel events with button "none" — the wheel must
  // move the suggestion cursor despite the left-button gate.
  const result = prompt.handleMouse({
    type: 'wheel', button: 'none', x: 2, y: libRow, screenX: 2, screenY: libRow,
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false, wheelDelta: 1,
  })
  assert.ok(result?.handled, 'the wheel over a suggestion must be handled')
  const state = prompt as unknown as { suggestionCursor: number }
  assert.strictEqual(state.suggestionCursor, 1, 'the wheel must move the suggestion selection')
})

test('alt-screen integration: a real SGR wheel reaches the prompt through the frame (button "none")', async (t) => {
  const deps = {
    resolveDirectory: (input: string) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) =>
      raw === './' ? [{ value: 'src/', displayPath: 'src' }, { value: 'lib/', displayPath: 'lib' }] : null,
  }
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  const frame = new Frame(prompt, true)
  const vt = new VirtualTerminal(100, 24)
  const tui = new TuiAltScreen(vt)
  tui.start()
  try {
    tui.showOverlay(frame)
    await vt.waitForRender()
    await new Promise<void>(resolve => setTimeout(resolve, 10)) // suggestions land
    await vt.waitForRender()
    const viewport = vt.getViewport()
    const srcRow = viewport.findIndex(line => line.includes('src/'))
    assert.ok(srcRow >= 0, `suggestion row missing:\n${viewport.join('\n')}`)
    const state = prompt as unknown as { suggestionCursor: number }
    assert.strictEqual(state.suggestionCursor, 0, 'precondition — first suggestion selected')
    // SGR wheel down (button 65) over the suggestion row INSIDE the
    // overlay (the overlay starts at col 10): the alt screen normalizes
    // it to { type: 'wheel', button: 'none' } and the frame forwards it
    // to the prompt.
    vt.sendInput(`\x1b[<65;13;${srcRow + 1}M`)
    await vt.waitForRender()
    assert.strictEqual(state.suggestionCursor, 1, 'the real SGR wheel must move the suggestion selection')
  } finally {
    tui.stop()
  }
})

test('alt-screen integration: a real SGR press/click on the painted Save action selects', async (t) => {
  const { deps, cwd } = fixtureDeps(testLifecycle(t))
  const noSuggestions: SaveLocationDeps = { ...deps, complete: async () => null }
  const results: SaveLocationResult[] = []
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    noSuggestions,
    (value) => { results.push(value) },
  )
  const frame = new Frame(prompt, true)
  const vt = new VirtualTerminal(100, 24)
  const tui = new TuiAltScreen(vt)
  tui.start()
  try {
    tui.showOverlay(frame)
    await vt.waitForRender()
    const viewport = vt.getViewport()
    const row = viewport.findIndex(line => line.includes('Save [Enter]'))
    assert.ok(row >= 0, `the Save action row is painted:\n${viewport.join('\n')}`)
    const column = paintedColumn(viewport[row]!, 'Save [Enter]')
    // A REAL left press/release: the alt screen synthesizes the click, the
    // frame translates it into the prompt's content cells.
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
    await vt.waitForRender()
    assert.deepEqual(results, [{ kind: 'selected', directory: cwd, overwrite: false }])
  } finally {
    tui.stop()
  }
})

test('app: a real SGR click on the Save action in the fullscreen editor seat selects', async (t) => {
  const life = testLifecycle(t)
  const { deps, cwd } = fixtureDeps(life)
  const noSuggestions: SaveLocationDeps = { ...deps, complete: async () => null }
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    app.setFullscreen(true)
    await vt.waitForRender()
    const promise = app.askSaveLocation(
      { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
      noSuggestions,
    )
    await vt.waitForRender()
    const viewport = vt.getViewport()
    const row = viewport.findIndex(line => line.includes('Save [Enter]'))
    assert.ok(row >= 0, `the Save action row is painted in the seat:\n${viewport.join('\n')}`)
    const column = paintedColumn(viewport[row]!, 'Save [Enter]')
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
    assert.deepEqual(await promise, { kind: 'selected', directory: cwd, overwrite: false })
    await vt.waitForRender()
  } finally {
    app.dispose()
  }
})

test('mouse parity: a click on an inert row releases the pressed identity (no stale accept)', async (t) => {
  const deps = {
    resolveDirectory: (input: string) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) =>
      raw === './' ? [{ value: 'src/', displayPath: 'src' }, { value: 'lib/', displayPath: 'lib' }] : null,
  }
  const prompt = new SaveLocationPrompt(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
    () => {},
  )
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  const rendered = prompt.render(60)
  const srcRow = rendered.findIndex(line => line.includes('src/'))
  assert.ok(srcRow >= 0, `suggestion row missing:\n${rendered.join('\n')}`)
  const press = (y: number) => ({
    type: 'press' as const, button: 'left' as const, x: 2, y, screenX: 2, screenY: y,
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false,
  })
  const click = (y: number) => ({
    type: 'click' as const, button: 'left' as const, x: 2, y, screenX: 2, screenY: y,
    width: 60, height: rendered.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  prompt.handleMouse(press(srcRow))
  const state = prompt as unknown as { mousePressedValue: string | undefined }
  assert.strictEqual(state.mousePressedValue, 'src/', 'precondition — pressed identity latched')
  // A click on an INERT row (the title) must release the pressed identity.
  prompt.handleMouse(click(0))
  assert.strictEqual(state.mousePressedValue, undefined, 'the pressed identity must be released on an inert click')
  // A later click on the suggestion WITHOUT a fresh press must not accept.
  prompt.handleMouse(click(srcRow))
  assert.strictEqual(prompt.getValue(), './', 'a click without a fresh press must not accept')
})
