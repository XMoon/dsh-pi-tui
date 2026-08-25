/**
 * Headless integration tests for the shell editor mode (the
 * shell-editor-mode plan): `!` / `!!` are editor STATE, never document
 * text. Covers the mode transitions (typed `!`, Backspace, Esc), paste
 * normalization, submission serialization, history recall/draft restore,
 * completion (virtual prefix, path-vs-slash routing) and rendering
 * (prompt symbols, border colors, no duplicate prefix).
 * @module @xmoon76/dsh-pi-tui/shell-editor-mode.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TuiApp, type SubagentViewerTarget } from '../src/tui-app.ts'
import { EditorRegistry } from '../src/editor-registry.ts'
import { EditorSeatHolder } from '../src/editor-seat-holder.ts'
import { Text } from '@xmoon76/pi-tui'
import type { EditorHost, ExtensionEditor } from '../src/extension/public-types.ts'
import { runOwned, type OwnedTaskOptions } from '../src/detached.ts'
import { createDiag } from '../src/diag.ts'
import { resetCommandCacheForTest, setCompgenRunnerForTest } from '../src/shell-completion.ts'
import { MentionProvider } from '../src/mentions.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** The owned-task entry the runner wires in production (real runOwned,
 * silent capture diag). */
const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
const owned = <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void => {
  runOwned(label, task, { ...options, diag })
}

/** A never-aborted signal for direct provider calls. */
const abort = new AbortController().signal

/** A throwaway workspace (completion fixtures live under the cwd). */
function fixtureWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-shell-mode-'))
}

/** A workspace with one file (Tab completion dropdowns need candidates). */
function fixtureWithFiles(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shell-mode-files-'))
  writeFileSync(join(root, 'notes.txt'), 'x')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep.ts'), 'x')
  return root
}

function startApp(
  cwd: string,
  options: {
    onSubmit?: (text: string) => void
    onQueueSubmit?: (text: string) => void
    onSubagentSubmit?: (request: { parentSessionId: string; childSessionId: string; text: string }) => void
    commands?: { name: string; description: string }[]
  } = {},
): { vt: VirtualTerminal; app: TuiApp; submitted: string[]; queued: string[]; cancels: number } {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const queued: string[] = []
  let cancels = 0
  const app = new TuiApp(vt, {
    onSubmit: (text) => { submitted.push(text); options.onSubmit?.(text) },
    onQueueSubmit: (text) => { queued.push(text); options.onQueueSubmit?.(text) },
    onSubagentSubmit: options.onSubagentSubmit,
    onExit: () => {},
    onCancel: () => { cancels += 1 },
  })
  app.setCommandCompletions(options.commands ?? [], cwd, null)
  app.start()
  return { vt, app, submitted, queued, get cancels() { return cancels } }
}

/** A continuable subagent viewer target (the editor stays live). */
function continuableViewer(): SubagentViewerTarget {
  return {
    parentSessionId: 'session-main',
    childSessionId: 'child-1',
    label: 'research',
    mode: 'continuable',
    activity: 'inactive',
  }
}

/** A one-shot (read-only) subagent viewer target. */
function oneShotViewer(): SubagentViewerTarget {
  return {
    parentSessionId: 'session-main',
    childSessionId: 'child-1',
    label: 'research',
    mode: 'one-shot',
    activity: 'running',
  }
}

/** Poll until the predicate is true (asserts on failure). */
async function pollUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) {
      assert.fail(`${label}: condition never became true`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Poll the viewport until the dropdown row appears (asserts on failure). */
async function waitForDropdownRow(vt: VirtualTerminal, needle: string, label: string): Promise<string> {
  const deadline = Date.now() + 3000
  for (;;) {
    const view = vt.getViewport().join('\n')
    if (view.includes(needle)) return view
    if (Date.now() > deadline) {
      assert.fail(`${label}: dropdown row ${JSON.stringify(needle)} never appeared:\n${view}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Poll until the viewport has NO dropdown rows (asserts on failure). */
async function waitForNoDropdownRow(vt: VirtualTerminal, needle: string, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  for (;;) {
    const view = vt.getViewport().join('\n')
    if (!view.includes(needle)) return
    if (Date.now() > deadline) {
      assert.fail(`${label}: dropdown row ${JSON.stringify(needle)} never disappeared:\n${view}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// ── mode transitions (plan §4.1–4.4, §5.2) ───────────────────────────────

test('an empty prompt + ! enters shell-context; a second ! enters shell-local', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), '', 'the prefix must never enter the buffer')
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  assert.equal(app.seatTextForTest(), '', 'the second prefix must never enter the buffer')
  app.stop()
})

test('Backspace on an empty shell body steps the mode back: !! -> ! -> prompt', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), '')
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt')
  assert.equal(app.seatTextForTest(), '')
  app.stop()
})

test('Esc on an empty shell body returns directly to the prompt (no cancel)', async () => {
  const surface = startApp(fixtureWorkspace())
  const { vt, app } = surface
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt')
  assert.equal(app.seatTextForTest(), '')
  assert.equal(surface.cancels, 0, 'exiting the shell mode must not fire the host cancel')
  // Same from shell-local.
  vt.sendInput('!')
  vt.sendInput('!')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt')
  assert.equal(surface.cancels, 0)
  app.stop()
})

test('! after command text is an ordinary body character', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('ls')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), 'ls')
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'ls!', 'a ! after body text must be inserted literally')
  // shell-local: same rule.
  app.setEditorText('')
  vt.sendInput('!')
  vt.sendInput('!')
  vt.sendInput('ls')
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  assert.equal(app.seatTextForTest(), 'ls!')
  app.stop()
})

test('a ! typed in shell-local with an empty body is a literal body character', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('!')
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local', 'no fourth mode is invented')
  assert.equal(app.seatTextForTest(), '!', 'the third ! is ordinary body text')
  app.stop()
})

// ── paste normalization (plan §7.6, §12.4) ───────────────────────────────

test('pasting a ! line into an empty prompt enters shell-context', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!git status\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), 'git status')
  app.stop()
})

test('pasting a !! line into an empty prompt enters shell-local', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!!git status\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  assert.equal(app.seatTextForTest(), 'git status')
  app.stop()
})

test('pasting plain text into an empty prompt stays in prompt mode', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('\x1b[200~hello\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt')
  assert.equal(app.seatTextForTest(), 'hello')
  app.stop()
})

test('a paste beginning with ! into a NON-empty editor is never reinterpreted', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('echo ')
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!x\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt', 'a non-empty editor keeps prompt mode')
  assert.equal(app.seatTextForTest(), 'echo !x', 'the pasted ! stays literal text')
  app.stop()
})

test('a paste beginning with ! into an EMPTY shell mode is literal body text', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!') // shell-context, empty body
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!echo\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the shell mode is unchanged')
  assert.equal(app.seatTextForTest(), '!echo', 'the pasted ! is body text, never re-parsed as a prefix')
  // shell-local: same rule.
  app.setEditorText('')
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('!')
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!!echo\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  assert.equal(app.seatTextForTest(), '!!echo', 'the pasted !! is body text in shell-local')
  app.stop()
})

// ── submission serialization (plan §8.1, §8.3, §12.5) ─────────────────────

test('submission serializes the mode back into the exact wire form', async () => {
  const { vt, app, submitted } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('hello')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['hello'])
  assert.equal(app.inputModeForTest(), 'prompt', 'mode resets after an accepted submit')
  vt.sendInput('!')
  vt.sendInput('pwd')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['hello', '!pwd'])
  assert.equal(app.inputModeForTest(), 'prompt')
  vt.sendInput('!')
  vt.sendInput('!')
  vt.sendInput('pwd')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['hello', '!pwd', '!!pwd'])
  assert.equal(app.inputModeForTest(), 'prompt')
  app.stop()
})

test('a rejected submission restores the serialized text AND the mode', async () => {
  const { vt, app, submitted } = startApp(fixtureWorkspace(), {
    onSubmit: (text) => {
      // Simulate the runner's divergence-guard rejection: the draft comes
      // back through setEditorText with the serialized wire form.
      app.setEditorText(text)
    },
  })
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('pwd')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['!pwd'])
  assert.equal(app.inputModeForTest(), 'shell-context', 'the rejected shell draft keeps its mode')
  assert.equal(app.seatTextForTest(), 'pwd')
  app.stop()
})

// ── history (plan §8.4–8.6, §12.7) ────────────────────────────────────────

test('history recall decodes serialized entries into mode + body', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  app.seedInputHistory(['!!pwd', '!pwd', 'hello'])
  vt.sendInput('\x1b[A') // ↑: most recent entry
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  assert.equal(app.seatTextForTest(), 'pwd')
  vt.sendInput('\x1b[A') // ↑: older entry
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), 'pwd')
  vt.sendInput('\x1b[A') // ↑: oldest entry
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt')
  assert.equal(app.seatTextForTest(), 'hello')
  app.stop()
})

test('history draft restore returns the ORIGINAL mode with the draft', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  app.seedInputHistory(['!!pwd', '!pwd'])
  vt.sendInput('hello')
  await vt.waitForRender()
  // The fork's ↑ on a non-empty line first moves the cursor to the line
  // start; the second ↑ enters history browsing (kimi parity).
  vt.sendInput('\x1b[A')
  vt.sendInput('\x1b[A') // ↑: recall !!pwd
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  assert.equal(app.seatTextForTest(), 'pwd')
  vt.sendInput('\x1b[B') // ↓: back to the draft
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt', 'the prompt draft must not come back in shell mode')
  assert.equal(app.seatTextForTest(), 'hello')
  app.stop()
})

test('a shell draft restores its shell mode after history browsing', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  app.seedInputHistory(['!!pwd'])
  vt.sendInput('!')
  vt.sendInput('git st')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  vt.sendInput('\x1b[A')
  vt.sendInput('\x1b[A') // ↑: recall !!pwd
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  vt.sendInput('\x1b[B') // ↓: back to the shell draft
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the shell draft keeps its mode')
  assert.equal(app.seatTextForTest(), 'git st')
  app.stop()
})

// ── completion (plan §9, §12.8) ───────────────────────────────────────────

test('shell command completion works in both shell modes and never writes the prefix', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('gi')
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'git', 'command candidates in shell-context')
  vt.sendInput('\t') // accept the first item
  await vt.waitForRender()
  assert.ok(app.seatTextForTest().startsWith('git'), `the applied completion must be a git command:\n${app.seatTextForTest()}`)
  assert.ok(!app.seatTextForTest().includes('!'), 'the synthetic prefix must never enter the buffer')
  // shell-local: same completion path.
  app.setEditorText('')
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('!')
  vt.sendInput('gi')
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'git', 'command candidates in shell-local')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.ok(app.seatTextForTest().startsWith('git'))
  assert.ok(!app.seatTextForTest().includes('!'))
  app.stop()
})

test('a leading / in a shell mode is a PATH, never a slash command', async () => {
  const { vt, app } = startApp(fixtureWorkspace(), {
    commands: [{ name: 'image', description: 'Attach an image file' }],
  })
  await vt.waitForRender()
  vt.sendInput('!')
  // Natural typing of a path: the slash-command list must NOT appear
  // (polled — the natural trigger's async work settles within the
  // deadline, and the row must never show).
  vt.sendInput('/usr/lo')
  await vt.waitForRender()
  await waitForNoDropdownRow(vt, 'image', 'a shell-mode path must not open the slash-command list')
  // Tab completes the path instead.
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'local', 'path completion for /usr/lo in shell mode')
  app.stop()
})

test('prompt-mode slash completion is unchanged', async () => {
  const { vt, app } = startApp(fixtureWorkspace(), {
    commands: [{ name: 'image', description: 'Attach an image file' }],
  })
  await vt.waitForRender()
  vt.sendInput('/im')
  await waitForDropdownRow(vt, 'image', 'slash-command completion in prompt mode')
  app.stop()
})

// ── rendering (plan §10, §12.9) ───────────────────────────────────────────

/** The viewport row index of the editor's FIRST CONTENT row (the row the
 * mode prompt is painted on): the editor's top border row + 1. */
function editorContentRow(vt: VirtualTerminal): number {
  const lines = vt.getViewport()
  // The editor is the bottom-most bordered block: find its top border —
  // the last row of `─` that is followed by a non-border content row.
  for (let row = lines.length - 2; row >= 0; row -= 1) {
    const line = lines[row] ?? ''
    if (line.trim() === '' || !/^─+$/.test(line.trim())) continue
    const next = lines[row + 1] ?? ''
    if (next.trim() !== '' && !/^─+$/.test(next.trim())) return row + 1
  }
  assert.fail(`editor content row not found:\n${lines.join('\n')}`)
}

test('the mode prompt renders as ❯ / ! / !! with the right colors', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  const promptRow = editorContentRow(vt)
  let view = vt.getViewport()
  assert.ok(view[promptRow]!.startsWith('❯ '), `prompt mode must render ❯:\n${view.join('\n')}`)
  assert.equal(vt.getCellFgRgb(promptRow, 0), 0x679efe, 'the ❯ must be brand blue (roleUser)')
  vt.sendInput('!')
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view[promptRow]!.startsWith('! '), `shell-context must render !:\n${view.join('\n')}`)
  assert.equal(vt.getCellFgRgb(promptRow, 0), 0xbd93f9, 'the ! must use the shellMode color')
  vt.sendInput('!')
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view[promptRow]!.startsWith('!!'), `shell-local must render !!:\n${view.join('\n')}`)
  assert.equal(vt.getCellFgRgb(promptRow, 0), 0xbd93f9, 'the !! must use the shellMode color')
  app.stop()
})

test('the shell border uses the shellMode color; the prompt border the normal one', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  const promptRow = editorContentRow(vt)
  const borderRow = promptRow - 1
  assert.equal(vt.getCellFgRgb(borderRow, 0), 0x5a5a5a, 'prompt-mode border uses the normal border color')
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(vt.getCellFgRgb(borderRow, 0), 0xbd93f9, 'shell-mode border uses the shellMode color')
  app.stop()
})

test('no duplicate prefix is ever rendered', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('ls')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('! !ls'), `no duplicated prefix:\n${view}`)
  assert.ok(!view.includes('❯ !ls'), `no prompt-plus-shell marker:\n${view}`)
  app.stop()
})

// ── Esc / autocomplete priority (plan §4.4, §12.10) ───────────────────────

test('Esc closes the autocomplete menu first and keeps the shell mode', async () => {
  const surface = startApp(fixtureWorkspace())
  const { vt, app } = surface
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('gi')
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'git', 'command candidates before Esc')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  await waitForNoDropdownRow(vt, 'git', 'dropdown after Esc')
  assert.equal(app.inputModeForTest(), 'shell-context', 'Esc must not exit the shell mode while the menu was open')
  assert.equal(app.seatTextForTest(), 'gi', 'Esc must not alter the body')
  assert.equal(surface.cancels, 0, 'closing the dropdown must not fire the host cancel')
  app.stop()
})

// ── review round 1 regressions ────────────────────────────────────────────

test('a busy Esc keeps its Host-owned cancel priority over the shell-mode exit', async () => {
  const surface = startApp(fixtureWorkspace())
  const { vt, app } = surface
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()
  app.setBusy(true)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(surface.cancels, 1, 'a busy Esc must cancel the running activity')
  assert.equal(app.inputModeForTest(), 'shell-context', 'the busy cancel must not exit the shell mode')
  app.setBusy(false)
  app.stop()
})

test('a bare ! reaches the queue protocol via Ctrl+Enter', async () => {
  const { vt, app, queued } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()
  vt.sendInput('\x1b[13;5u') // kitty ctrl+enter: queue submit
  assert.deepEqual(queued, ['!'], 'a bare ! shell mode must queue its wire form')
  assert.equal(app.inputModeForTest(), 'prompt', 'mode resets after the queue submit')
  app.stop()
})

test('a bare ! reaches the submit protocol via submitDraft', async () => {
  const { vt, app, submitted } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()
  app.submitDraft(false)
  assert.deepEqual(submitted, ['!'], 'a bare ! shell mode must submit its wire form')
  assert.equal(app.inputModeForTest(), 'prompt')
  app.stop()
})

test('a bare ! reaches the child via the subagent submit path', async () => {
  const childSubmits: { parentSessionId: string; childSessionId: string; text: string }[] = []
  const { vt, app } = startApp(fixtureWorkspace(), {
    onSubagentSubmit: (request) => { childSubmits.push(request) },
  })
  await vt.waitForRender()
  app.setViewerMode(continuableViewer())
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.equal(childSubmits.length, 1, 'a bare ! in the viewer must submit to the child')
  assert.equal(childSubmits[0]!.text, '!', 'the child receives the serialized wire form')
  assert.equal(app.inputModeForTest(), 'prompt', 'mode resets after the child submit')
  app.stop()
})

// ── review round 3: plugin handoff (the wire form round-trips) ────────────

/** A minimal plugin editor (the editor-registry test shape). */
function pluginEditor(initial = ''): ExtensionEditor & {
  text: string
  cursor: number
  disposed: boolean
  setCursor: (offset: number) => void
} {
  const state = { text: initial, cursor: 0, disposed: false }
  return {
    get component() { return { kind: 'text' as const, spans: [{ text: state.text }] } },
    getText: () => state.text,
    setText: (text) => { state.text = text },
    getCursor: () => state.cursor,
    setCursor: (offset) => { state.cursor = offset },
    get focused() { return false },
    borderColor: (text) => text,
    dispose: () => { state.disposed = true },
    get text() { return state.text },
    get cursor() { return state.cursor },
    get disposed() { return state.disposed },
  }
}

test('a shell-mode draft round-trips through a plugin editor handoff with its mode', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('pwd')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  // The plugin editor wins the seat: the handoff transfers the WIRE form.
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'handoff-plugin',
    priority: 0,
    create: (_host: EditorHost) => {
      const editor = pluginEditor()
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(created.length, 1)
  assert.equal(created[0]!.getText(), '!pwd', 'the plugin document is the wire form')
  // Unload: the host restores and DECODES the wire form back into mode + body.
  handle.dispose()
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the shell mode survives the handoff round-trip')
  assert.equal(app.seatTextForTest(), 'pwd')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['!pwd'], 'the restored shell draft submits its wire form')
  app.stop()
})

test('a plugin draft without a shell prefix restores in PROMPT mode (no stale !)', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  // Enter shell mode, then let the plugin take over and REPLACE the draft
  // with plain prose.
  vt.sendInput('!')
  vt.sendInput('pwd')
  await vt.waitForRender()
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'handoff-plugin-2',
    priority: 0,
    create: (_host: EditorHost) => {
      const editor = pluginEditor()
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  created[0]!.setText('echo')
  // Unload: the host restores the plugin's text — WITHOUT the stale shell
  // mode, so `echo` submits as plain prose, never `!echo`.
  handle.dispose()
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt', 'a prefix-free plugin draft must not inherit the shell mode')
  assert.equal(app.seatTextForTest(), 'echo')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['echo'], 'the plugin draft submits as plain text')
  app.stop()
})

test('task-browser routing and the footer hint follow the VISIBLE seat editor, not the hidden host mode', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  let opened = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onOpenTasks: () => { opened += 1; app.requestRender() },
  }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  // Enter shell mode, then hand the seat to a plugin editor (the hidden
  // host keeps its shell mode).
  vt.sendInput('!')
  await vt.waitForRender()
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'hint-plugin',
    priority: 0,
    create: (_host: EditorHost) => {
      const editor = pluginEditor()
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // The plugin's document is the wire form; the user clears it — the
  // VISIBLE editor is now an empty prompt-mode editor.
  created[0]!.setText('')
  app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  await vt.waitForRender()
  // The footer advertises the ↓ trigger (the visible editor is prompt).
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('↓ view'), `the footer must advertise ↓ for the visible prompt editor:\n${view}`)
  // ↓ opens the browser despite the hidden host's stale shell mode.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened, 1, 'the visible prompt-mode editor must open the task browser')
  handle.dispose()
  app.reconcileEditorNow()
  app.stop()
})

// ── review round 5: sink steer serialization + adapter fallback ──────────

test('the plugin action sink steers the wire form and clears the editor', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  const steered: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSteer: (text) => steered.push(text),
  }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  // A plugin editor whose document is the wire form dispatches steer.
  let pluginHost: EditorHost | undefined
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'steer-plugin',
    priority: 0,
    create: (host: EditorHost) => {
      pluginHost = host
      const editor = pluginEditor()
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // The handoff transferred the (empty) host draft; the user then typed
  // a shell line into the plugin — its document is the wire form.
  created[0]!.setText('!pwd')
  assert.equal(pluginHost?.dispatch('steer').kind, 'accepted')
  assert.deepEqual(steered, ['!pwd'], 'the plugin document (the wire form) steers verbatim')
  assert.equal(created[0]!.getText(), '', 'the steer clears the plugin document')
  handle.dispose()
  app.reconcileEditorNow()
  app.stop()
})

test('a host adapter without setSerializedInput still receives the handoff draft (setText fallback)', () => {
  const host = {
    text: 'draft',
    getText: () => host.text,
    setText: (text: string) => { host.text = text },
    setTextAndCursor: (text: string) => { host.text = text },
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    borderColor: (text: string) => text,
    invalidate: () => {},
    addToHistory: () => {},
    clearHistory: () => {},
    component: new Text('host', 0, 0),
  }
  const holder = new EditorSeatHolder({
    hostAdapter: () => host,
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const plugin = pluginEditor('!pwd')
  holder.handoff({ id: 'plugin', create: () => plugin })
  assert.equal(holder.currentEditor().id, 'plugin')
  assert.equal(plugin.getText(), 'draft', 'the host draft transferred to the plugin')
  // The user edits in the plugin; the restore must land in the host even
  // though the bare adapter has no setSerializedInput (the setText
  // fallback — never a silently dropped draft).
  plugin.setText('!pwd')
  holder.handoff(undefined)
  assert.equal(holder.currentEditor().id, 'host')
  assert.equal(host.text, '!pwd', 'the draft must survive the restore through the setText fallback')
  holder.dispose()
})

// ── review round 6: busy-Esc vs plugin editors; cursor restoration ───────

test('a busy Esc cancels BEFORE a consuming plugin editor sees it', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let pluginEscs = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
  }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  // A plugin editor whose handleInput CONSUMES every event (vim-like).
  const handle = registry.register({
    id: 'esc-consuming-plugin',
    priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: '' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      get focused() { return false },
      borderColor: (text: string) => text,
      handleInput: () => { pluginEscs += 1; return true },
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  app.setBusy(true)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancels, 1, 'a busy Esc must cancel the running activity, never the plugin')
  assert.equal(pluginEscs, 0, 'the consuming plugin must not see a busy Esc')
  app.setBusy(false)
  // Idle: the plugin keeps its own Esc state machine.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(pluginEscs, 1, 'an idle Esc routes to the plugin editor')
  assert.equal(cancels, 1, 'an idle plugin Esc must not cancel')
  handle.dispose()
  app.reconcileEditorNow()
  app.stop()
})

test('a legacy host restore keeps the cursor in WIRE coordinates (raw ! stays in the text)', () => {
  const host = {
    text: '',
    cursor: 0,
    getText: () => host.text,
    setText: (text: string) => { host.text = text },
    setTextAndCursor: (text: string, cursor: number) => { host.text = text; host.cursor = cursor },
    getCursor: () => host.cursor,
    setCursor: (offset: number) => { host.cursor = offset },
    focused: true,
    borderColor: (text: string) => text,
    invalidate: () => {},
    addToHistory: () => {},
    clearHistory: () => {},
    component: new Text('host', 0, 0),
  }
  const holder = new EditorSeatHolder({
    hostAdapter: () => host,
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const plugin = pluginEditor()
  holder.handoff({ id: 'plugin', create: () => plugin })
  // The user typed a shell line in the plugin: the document is the wire
  // form `!pwd` with the cursor after `!pw` (offset 3).
  plugin.setText('!pwd')
  plugin.setCursor(3)
  holder.handoff(undefined)
  assert.equal(host.text, '!pwd', 'the wire draft survives the restore')
  assert.equal(host.cursor, 3,
    'a legacy RAW restore keeps the `!` in the document — the cursor stays in wire coordinates')
  holder.dispose()
})

test('a decoding host restore shifts the cursor by the actually stripped prefix', () => {
  const host = {
    text: '',
    cursor: 0,
    getText: () => host.text,
    setText: (text: string) => { host.text = text },
    setTextAndCursor: (text: string, cursor: number) => { host.text = text; host.cursor = cursor },
    getCursor: () => host.cursor,
    setCursor: (offset: number) => { host.cursor = offset },
    focused: true,
    borderColor: (text: string) => text,
    invalidate: () => {},
    addToHistory: () => {},
    clearHistory: () => {},
    // A full adapter decodes the wire form (mode + body).
    setSerializedInput: (text: string) => {
      host.text = text.startsWith('!!') ? text.slice(2) : text.startsWith('!') ? text.slice(1) : text
    },
    component: new Text('host', 0, 0),
  }
  const holder = new EditorSeatHolder({
    hostAdapter: () => host,
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const plugin = pluginEditor()
  holder.handoff({ id: 'plugin', create: () => plugin })
  plugin.setText('!pwd')
  plugin.setCursor(3)
  holder.handoff(undefined)
  assert.equal(host.text, 'pwd', 'the decode strips the wire prefix')
  assert.equal(host.cursor, 2, 'the cursor shifts back by the actually stripped prefix')
  holder.dispose()
})

test('a host prompt-mode literal ! is a document character (never shifted on handoff)', () => {
  const host = {
    text: '!literal',
    cursor: 4,
    getText: () => host.text,
    setText: (text: string) => { host.text = text },
    setTextAndCursor: (text: string, cursor: number) => { host.text = text; host.cursor = cursor },
    getCursor: () => host.cursor,
    setCursor: (offset: number) => { host.cursor = offset },
    focused: true,
    borderColor: (text: string) => text,
    invalidate: () => {},
    addToHistory: () => {},
    clearHistory: () => {},
    getInputMode: () => 'prompt' as const,
    component: new Text('host', 0, 0),
  }
  const holder = new EditorSeatHolder({
    hostAdapter: () => host,
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const created: ReturnType<typeof pluginEditor>[] = []
  holder.handoff({
    id: 'plugin',
    create: () => {
      const editor = pluginEditor()
      created.push(editor)
      return editor
    },
  })
  assert.equal(created[0]!.getText(), '!literal', 'a prompt-mode draft transfers verbatim')
  assert.equal(created[0]!.cursor, 4, 'a prompt-mode literal ! is a document character — the cursor never shifts')
  holder.dispose()
})

// ── review round 7: a DECLINED plugin Esc reaches the host fallback ───────

test('a plugin editor that DECLINES Esc still arms the host double-Esc cancel', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
  }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  // A vim-like plugin that DECLINES Esc (returns false — it has no modal
  // state to enter).
  const handle = registry.register({
    id: 'esc-declining-plugin',
    priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: '' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      get focused() { return false },
      borderColor: (text: string) => text,
      handleInput: () => false,
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // First Esc: the plugin declines, the host fallback arms the window.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancels, 0, 'one Esc only arms the double-Esc window')
  // Second Esc within the window: the host cancel fires.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancels, 1, 'a declined plugin Esc must not swallow the host cancel')
  handle.dispose()
  app.reconcileEditorNow()
  app.stop()
})

// ── review round 8: a CONSUMED Esc disarms the pending double-Esc window ──

test('a consumed plugin Esc disarms a window armed by a prior declined Esc', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
  }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  // A plugin that DECLINES the first Esc (arming the host window) and
  // CONSUMES every later one (vim entering normal mode).
  let escCount = 0
  const handle = registry.register({
    id: 'esc-mixed-plugin',
    priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: '' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      get focused() { return false },
      borderColor: (text: string) => text,
      handleInput: () => { escCount += 1; return escCount > 1 },
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  vt.sendInput('\x1b') // declined → the host window arms
  await vt.waitForRender()
  vt.sendInput('\x1b') // consumed → the window must disarm
  await vt.waitForRender()
  // The plugin is removed; a fresh host Esc must ARM, never cancel.
  handle.dispose()
  app.reconcileEditorNow()
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancels, 0, 'a consumed Esc must disarm the stale window')
  app.stop()
})

test('a consumed onSingleEscape disarms the pending double-Esc window', async () => {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  let escCount = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
    // The runner-owned mode consumes ONLY the second Esc (e.g. a viewer
    // that opened between the presses).
    onSingleEscape: () => { escCount += 1; return escCount === 2 },
  })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b') // not consumed → the host window arms
  await vt.waitForRender()
  vt.sendInput('\x1b') // consumed by onSingleEscape → the window must disarm
  await vt.waitForRender()
  vt.sendInput('\x1b') // not consumed again → must ARM, never cancel
  await vt.waitForRender()
  assert.equal(cancels, 0, 'a consumed onSingleEscape must disarm the stale window')
  app.stop()
})

// ── PR review round: external editor wire boundary ─────────────────────────

test('the external editor round-trips the WIRE form (shell modes switchable in $EDITOR)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  let seenDraft = ''
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    openExternalEditor: async (draft) => { seenDraft = draft; return '!!pwd' },
    runOwned: owned,
  })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('pwd')
  await vt.waitForRender()
  vt.sendInput('\x07') // ctrl+g
  await pollUntil(() => seenDraft !== '', 'external editor round-trip')
  assert.equal(seenDraft, '!pwd', 'the $EDITOR sees the WIRE form, never the bare body')
  // The user switched `!` → `!!` in $EDITOR: the decode follows.
  assert.equal(app.inputModeForTest(), 'shell-local', 'the saved wire form decodes back into the mode')
  assert.equal(app.seatTextForTest(), 'pwd')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['!!pwd'], 'the edited wire form submits with its new mode')
  app.stop()
})

test('a prompt-mode draft edited into a shell line in $EDITOR comes back as shell mode', async () => {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    openExternalEditor: async () => '!pwd',
    runOwned: owned,
  })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  vt.sendInput('hello')
  await vt.waitForRender()
  vt.sendInput('\x07') // ctrl+g → $EDITOR rewrites the draft into a shell line
  await pollUntil(() => app.seatTextForTest() !== 'hello', 'external editor round-trip')
  assert.equal(app.inputModeForTest(), 'shell-context', 'a ! line written in $EDITOR enters shell mode')
  assert.equal(app.seatTextForTest(), 'pwd')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['!pwd'], 'the shell line submits as a shell command')
  app.stop()
})

// ── PR review round: paste/undo invariant ─────────────────────────────────

test('undo after a normalized paste never resurrects the raw prefix in the document', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!!git status\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local')
  assert.equal(app.seatTextForTest(), 'git status')
  // Ctrl+-: the base editor's undo snapshots contain the NORMALIZED body
  // (the prefix was stripped before insertion), so undo restores the
  // pre-paste document — never `shell-local + "!!git status"`.
  vt.sendInput('\x1f')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'undo restores the pre-paste document')
  assert.ok(!app.seatTextForTest().includes('!!'), 'the raw prefix must never re-enter the document')
  app.stop()
})

test('a large shell paste (>10 lines) enters the shell mode through the paste registry', async () => {
  const { vt, app, submitted } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  const lines = Array.from({ length: 12 }, (_, index) => `git log ${index}`)
  vt.sendInput(`\x1b[200~!!${lines.join('\n')}\x1b[201~`)
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-local', 'a large !! paste enters shell-local BEFORE the registry marker')
  const body = app.seatTextForTest()
  assert.ok(!body.startsWith('!!'), 'the raw prefix must not survive in the document')
  assert.ok(body.startsWith('[paste #'), `large pastes keep the fork registry marker:\n${body}`)
  vt.sendInput('\r')
  assert.equal(submitted.length, 1)
  assert.ok(submitted[0]!.startsWith('!!'), 'the submitted wire form keeps the shell prefix')
  assert.ok(submitted[0]!.includes('git log 0'), 'the expanded paste body is the stripped command text')
  assert.ok(!submitted[0]!.includes('\n!!'), 'no raw prefix survives inside the expanded body')
  app.stop()
})

// ── PR review round: mode transitions cancel the open dropdown ────────────

test('a prompt-mode dropdown closes when ! enters shell mode', async () => {
  const { vt, app } = startApp(fixtureWithFiles())
  await vt.waitForRender()
  vt.sendInput('\t') // prompt-mode Tab: cwd file completion
  await waitForDropdownRow(vt, 'notes.txt', 'file completion in prompt mode')
  vt.sendInput('!')
  await vt.waitForRender()
  await waitForNoDropdownRow(vt, 'notes.txt', 'dropdown after entering shell mode')
  assert.equal(app.inputModeForTest(), 'shell-context', 'the mode still transitions')
  app.stop()
})

test('a shell-mode dropdown closes when Backspace returns to the prompt', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  // Deterministic command list (the empty-prefix list is capped at 50 and
  // locale-sorted — a fixed fake keeps the dropdown content stable).
  setCompgenRunnerForTest((_cwd, expression) => Promise.resolve({
    ok: true,
    lines: expression.includes('compgen -A command') ? ['git', 'gist', 'grep'] : [],
  }))
  try {
    vt.sendInput('!')
    await vt.waitForRender()
    vt.sendInput('\t') // shell Tab with an empty prefix: the command list
    await waitForDropdownRow(vt, 'git', 'shell command dropdown')
    vt.sendInput('\x7f') // backspace on the empty shell body
    await vt.waitForRender()
    await waitForNoDropdownRow(vt, 'git', 'dropdown after the mode step-back')
    assert.equal(app.inputModeForTest(), 'prompt', 'the mode steps back to the prompt')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  app.stop()
})

// ── PR review round: one-shot viewer mode ─────────────────────────────────

test('a one-shot viewer resets the host editor to prompt mode and restores the shell draft on exit', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('git status')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  app.setViewerMode(oneShotViewer())
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt', 'the read-only placeholder bar must not inherit the shell mode')
  assert.ok(app.seatTextForTest().includes('viewing subagent'), 'the placeholder bar shows')
  app.setViewerMode(undefined)
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the preserved serialized main draft restores the shell mode')
  assert.equal(app.seatTextForTest(), 'git status')
  app.stop()
})

// ── PR review round: Stable autocomplete query keeps the wire document ────

test('the Stable autocomplete extension query keeps the WIRE document in shell modes', async () => {
  const queries: { lines: readonly string[]; cursorCol: number }[] = []
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.setCommandCompletions([], fixtureWorkspace(), null, async (query) => {
    queries.push({ lines: [...query.lines], cursorCol: query.cursorCol })
    return null
  })
  app.start()
  await vt.waitForRender()
  // Force the host provider to return null (a failed compgen run), so the
  // plugin chain is consulted.
  setCompgenRunnerForTest(() => Promise.resolve({ ok: false, lines: [] }))
  try {
    // shell-context: the plugin must see the WIRE line `!gi`, never `gi`.
    vt.sendInput('!')
    vt.sendInput('gi')
    vt.sendInput('\t')
    await pollUntil(() => queries.length === 1, 'extension query in shell-context')
    assert.deepEqual([...queries[0]!.lines], ['!gi'], 'a shell-context body reaches the plugin as the wire line')
    assert.equal(queries[0]!.cursorCol, 3, 'the cursor shifts by the synthetic prefix')
    // shell-local: `!!gi`.
    app.setEditorText('')
    await vt.waitForRender()
    vt.sendInput('!')
    vt.sendInput('!')
    vt.sendInput('gi')
    vt.sendInput('\t')
    await pollUntil(() => queries.length === 2, 'shell query in shell-local')
    assert.deepEqual([...queries[1]!.lines], ['!!gi'])
    assert.equal(queries[1]!.cursorCol, 4)
    // prompt mode: the body is the wire document as-is.
    app.setEditorText('')
    await vt.waitForRender()
    vt.sendInput('gi')
    vt.sendInput('\t')
    await pollUntil(() => queries.length === 3, 'prompt-mode query')
    assert.deepEqual([...queries[2]!.lines], ['gi'])
    assert.equal(queries[2]!.cursorCol, 2)
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  app.stop()
})

// ── review round: paste chunk boundaries + autocomplete reopen ────────────

test('input before the opening marker in the same chunk enters the shell mode first', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  // `!` and the paste arrive in ONE chunk: the `!` must go through the
  // interception chain (enter shell-context) BEFORE the paste lands.
  vt.sendInput('!\x1b[200~cmd\x1b[201~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the leading ! must enter the shell mode')
  assert.equal(app.seatTextForTest(), 'cmd', 'the paste lands as the shell body')
  app.stop()
})

test('trailing keys after the closing marker go through the full interception chain', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!git status\x1b[201~x')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), 'git statusx', 'the trailing key appends as ordinary input')
  // A trailing `!` must NOT be swallowed or re-parsed — it is body text.
  app.setEditorText('')
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!echo\x1b[201~!')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), 'echo!', 'a trailing ! after the paste is a literal body character')
  app.stop()
})

test('a paste opening marker split across chunks is stitched back together', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('\x1b[20') // first half of \x1b[200~
  await vt.waitForRender()
  vt.sendInput('0~!git status\x1b[201~') // second half + the paste
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the split opening marker must still open the paste')
  assert.equal(app.seatTextForTest(), 'git status')
  app.stop()
})

test('a paste closing marker split across chunks is stitched back together', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!git status\x1b[201') // closing marker without its final ~
  await vt.waitForRender()
  vt.sendInput('~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the split closing marker must still close the paste')
  assert.equal(app.seatTextForTest(), 'git status')
  app.stop()
})

test('a pasted @dir/ path reopens the mention dropdown like ordinary input', async () => {
  const { vt, app } = startApp(fixtureWithFiles())
  await vt.waitForRender()
  // Paste `@src/`: the reopen runs AFTER the paste landed, so the
  // dropdown shows the directory children exactly like typed input.
  vt.sendInput('\x1b[200~@src/\x1b[201~')
  await waitForDropdownRow(vt, 'deep.ts', 'mention dropdown after a pasted @dir/')
  assert.equal(app.seatTextForTest(), '@src/')
  app.stop()
})

// ── review round: split markers at every boundary; iterative drain ────────

test('a paste marker split at ANY prefix boundary is stitched back together', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  // The marker `\x1b[200~` split after `\x1b[` / `\x1b[2` / `\x1b[20` /
  // `\x1b[200` — each boundary gets its own two-chunk paste with the
  // matching second half. (A lone `\x1b` tail is NOT buffered: it IS the
  // complete Esc key; real terminals write a paste marker atomically.)
  const boundaries: [string, string][] = [
    ['\x1b[', '200~'],
    ['\x1b[2', '00~'],
    ['\x1b[20', '0~'],
    ['\x1b[200', '~'],
  ]
  for (const [index, [head, tail]] of boundaries.entries()) {
    app.setEditorText('')
    await vt.waitForRender()
    vt.sendInput(head)
    await vt.waitForRender()
    vt.sendInput(`${tail}!git status ${index}\x1b[201~`)
    await vt.waitForRender()
    assert.equal(app.inputModeForTest(), 'shell-context', `split after ${JSON.stringify(head)} must open the paste`)
    assert.equal(app.seatTextForTest(), `git status ${index}`)
  }
  // The closing marker split after `\x1b[201`.
  app.setEditorText('')
  await vt.waitForRender()
  vt.sendInput('\x1b[200~!git status final\x1b[201')
  await vt.waitForRender()
  vt.sendInput('~')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), 'git status final')
  app.stop()
})

test('a chunk with MANY paste segments drains iteratively (no stack overflow)', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  const segments = Array.from({ length: 200 }, (_, index) => `\x1b[200~git ${index}\x1b[201~`)
  vt.sendInput(segments.join(''))
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), Array.from({ length: 200 }, (_, index) => `git ${index}`).join(''),
    'every segment lands, in order — the drain is iterative, never a stack overflow')
  app.stop()
})

// ── review round: multiline wire adaptation ───────────────────────────────

test('the Stable autocomplete extension query keeps the wire document on MULTILINE drafts', async () => {
  const queries: { lines: readonly string[]; cursorLine: number; cursorCol: number }[] = []
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.setCommandCompletions([], fixtureWorkspace(), null, async (query) => {
    queries.push({ lines: [...query.lines], cursorLine: query.cursorLine, cursorCol: query.cursorCol })
    return null
  })
  app.start()
  await vt.waitForRender()
  setCompgenRunnerForTest(() => Promise.resolve({ ok: false, lines: [] }))
  try {
    // A multiline shell draft: wire line 0 carries the prefix, later
    // lines are ordinary text.
    vt.sendInput('!')
    vt.sendInput('git status')
    vt.sendInput('\n')
    vt.sendInput('more')
    await vt.waitForRender()
    vt.sendInput('\t')
    await pollUntil(() => queries.length === 1, 'multiline shell query on line 1')
    assert.deepEqual([...queries[0]!.lines], ['!git status', 'more'],
      'line 0 carries the wire prefix, later lines stay plain')
    assert.equal(queries[0]!.cursorLine, 1)
    assert.equal(queries[0]!.cursorCol, 4, 'a non-first-line cursor never shifts by the prefix')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  app.stop()
})

test('MentionProvider completes a multiline shell draft with the wire line-0 prefix only', async () => {
  const root = fixtureWorkspace()
  let mode: 'prompt' | 'shell-context' | 'shell-local' = 'shell-context'
  const source = (): 'prompt' | 'shell-context' | 'shell-local' => mode
  const provider = new MentionProvider([], root, null, source)
  // Cursor on line 0: the virtual prefix applies.
  const first = await provider.getSuggestions(['gi', 'more'], 0, 2, { signal: abort })
  assert.ok(first !== null && first.items.some(item => item.value === 'git'), 'line 0 completes as a shell command')
  // Cursor on line 1: the wire document has NO prefix there — plain path
  // completion semantics (a non-`!` line is not a shell line).
  const second = await provider.getSuggestions(['git', 'more'], 1, 4, { signal: abort, force: true })
  assert.equal(second, null, 'a later body line never gets a synthetic prefix')
  // applyCompletion on a later line must not strip anything either: the
  // inner provider's plain word replacement (no shell trailing space).
  const applied = provider.applyCompletion(['git', 'more'], 1, 4, { value: 'x', label: 'x' }, 'more')
  assert.deepEqual(applied, { lines: ['git', 'x'], cursorLine: 1, cursorCol: 1 })
})

// ── review round: Ctrl+C clears the shell mode with the body ──────────────

test('Ctrl+C clears BOTH the shell body and the mode (prompt returns)', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('pwd')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  vt.sendInput('\x03') // ctrl+c: first press clears
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'the body clears')
  assert.equal(app.inputModeForTest(), 'prompt', 'the shell mode clears with the body — no stale `! ` prompt')
  app.stop()
})

test('Ctrl+C on a BARE ! (empty body, shell mode) clears the mode and arms the exit window', async () => {
  const vt = new VirtualTerminal(100, 24)
  let exits = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => { exits += 1 },
  })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  vt.sendInput('\x03') // ctrl+c: the serialized draft is non-empty (the `!` prefix)
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt', 'the first press clears the bare shell mode')
  assert.equal(exits, 0, 'the first press only arms the exit window')
  vt.sendInput('\x03') // second press within the window: exit
  await vt.waitForRender()
  assert.equal(exits, 1, 'the second press exits')
  app.stop()
})

// ── PR review round 2: declined-input fallback wire coordinate ────────────

test('a plugin DECLINED ! round-trips through the host shell mode into the wire document', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'decline-all',
    priority: 0,
    create: () => {
      const editor = pluginEditor()
      // A plugin that DECLINES every key: the host fallback owns the
      // editing semantics.
      editor.handleInput = () => false
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  const plugin = created[0]!
  // 1. Declined `!` on an empty plugin: the host consumes it into the
  //    shell mode and the WIRE document reflects it.
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(plugin.getText(), '!', 'a declined ! must reach the plugin as the wire prefix')
  // 2. Declined second `!`: shell-local.
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(plugin.getText(), '!!', 'a declined second ! reaches the plugin as !!')
  // 3. Declined Backspace on `!!`: steps back to `!`.
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(plugin.getText(), '!', 'a declined Backspace steps the wire form back to !')
  // 4. Declined Backspace on `!`: back to the empty prompt.
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(plugin.getText(), '', 'a declined Backspace on ! returns the empty wire document')
  handle.dispose()
  app.reconcileEditorNow()
  app.stop()
})

// ── PR review round 2: symmetric wire apply ───────────────────────────────

test('accepting an absolute-path completion in a shell mode never doubles the slash', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  // shell-context: `/u` → Tab → accept `/usr/` — the fork's line-start
  // judgment runs on the VIRTUAL wire line (`!/u`), so the absolute path
  // is never mistaken for a slash command (`//usr/ ` must not happen).
  vt.sendInput('!')
  vt.sendInput('/u')
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'usr', 'path completion for /u in shell-context')
  vt.sendInput('\t') // accept /usr/
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '/usr/', 'the accepted absolute path must not double the slash')
  // shell-local: same rule.
  app.setEditorText('')
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('!')
  vt.sendInput('/u')
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'usr', 'path completion for /u in shell-local')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '/usr/', 'shell-local accepts the absolute path without a doubled slash')
  app.stop()
})

test('a Stable extension suggestion applies through the wire adapter symmetrically', async () => {
  const vt = new VirtualTerminal(100, 24)
  let queries = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.setCommandCompletions([], fixtureWorkspace(), null, async () => {
    queries += 1
    // TWO suggestions: a single one would be auto-applied by the fork on
    // the first Tab, so the dropdown opens and the accept path runs.
    return {
      items: [
        { value: '/zzz-no-such-dir/', label: 'zzz-no-such-dir' },
        { value: '/zzz-no-such-file', label: 'zzz-no-such-file' },
      ],
      prefix: '/zzz-no-such',
    }
  })
  app.start()
  await vt.waitForRender()
  // Natural typing of the path must NOT consult the plugin chain (the
  // shell-mode leading-/ suppression stays host-owned): no dropdown may
  // open mid-typing, or the next Tab would double-apply.
  vt.sendInput('!')
  vt.sendInput('/zzz-no-such')
  await vt.waitForRender()
  await waitForNoDropdownRow(vt, 'zzz-no-such-dir', 'no extension dropdown during natural typing')
  assert.equal(queries, 0, 'a natural trigger on a shell-mode path never consults the plugin chain')
  // Tab (force) consults the plugin chain with the WIRE document, and
  // the accepted suggestion applies symmetrically into the bare body.
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'zzz-no-such-dir', 'extension suggestion in shell mode')
  vt.sendInput('\t') // accept
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '/zzz-no-such-dir/', 'the extension apply lands in the bare body without a doubled slash')
  app.stop()
})

// ── review round: capability-gated mode setter in the fallback ────────────

test('a host adapter with setSerializedInput but WITHOUT setInputMode falls back to the raw path (declined ! preserved)', () => {
  const host = {
    text: '',
    cursor: 0,
    getText: () => host.text,
    setText: (text: string) => { host.text = text },
    setTextAndCursor: (text: string, cursor: number) => { host.text = text; host.cursor = cursor },
    getCursor: () => host.cursor,
    setCursor: (offset: number) => { host.cursor = offset },
    // Decodes like the real adapter, but deliberately NO setInputMode —
    // the wire round-trip must not silently discard the decoded mode.
    setSerializedInput: (text: string) => {
      host.text = text.startsWith('!!') ? text.slice(2) : text.startsWith('!') ? text.slice(1) : text
    },
    handleInput: (data: string) => {
      if (data === '\x7f') host.text = host.text.slice(0, -1)
      else if (data.length === 1 && data.charCodeAt(0) >= 32) host.text += data
    },
    focused: true,
    borderColor: (text: string) => text,
    invalidate: () => {},
    addToHistory: () => {},
    clearHistory: () => {},
    component: new Text('host', 0, 0),
  }
  const holder = new EditorSeatHolder({
    hostAdapter: () => host,
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const plugin = pluginEditor()
  plugin.handleInput = () => false
  holder.handoff({ id: 'plugin', create: () => plugin })
  // A declined `!` must be preserved in the plugin document even when the
  // adapter is only half-capable (the raw path keeps the bytes).
  holder.handleHostFallbackInput('!')
  assert.equal(plugin.getText(), '!', 'a declined ! must not vanish with a partial adapter')
  holder.dispose()
})

// ── review round: getDraft/setDraft wire symmetry ─────────────────────────

test('getDraft returns the WIRE form, symmetric with setDraft (shell mode survives read/merge/restore)', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  app.setDraft('!pwd')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  assert.equal(app.seatTextForTest(), 'pwd')
  assert.equal(app.getDraft(), '!pwd', 'getDraft must read back the wire form — never the bare body')
  // A read → merge → restore round-trip keeps the shell mode: the merged
  // wire text decodes back into shell mode + body.
  const merged = `${app.getDraft()}\n\nhello`
  app.setDraft(merged)
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'the restored merged draft keeps the shell mode')
  assert.equal(app.seatTextForTest(), 'pwd\n\nhello')
  assert.equal(app.getDraft(), '!pwd\n\nhello')
  // Prompt-mode drafts stay byte-identical (the wire form IS the body).
  app.setDraft('plain text')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'plain text')
  app.stop()
})

// ── review round: wire-prefixed extension prefixes ────────────────────────

test('a Stable extension prefix computed on the WIRE line applies without corruption', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.setCommandCompletions([], fixtureWorkspace(), null, async () => ({
    // The plugin computed this prefix on the WIRE line `!ch` — it
    // legitimately includes the synthetic `!`.
    items: [{ value: 'checkout', label: 'checkout' }],
    prefix: '!ch',
  }))
  app.start()
  await vt.waitForRender()
  // Force the host provider to return null (a failed compgen run) so the
  // plugin chain is consulted. ONE item is auto-applied by the fork on
  // the first forced Tab — the exact path that must not corrupt.
  setCompgenRunnerForTest(() => Promise.resolve({ ok: false, lines: [] }))
  try {
    vt.sendInput('!')
    vt.sendInput('ch')
    vt.sendInput('\t')
    await vt.waitForRender()
    assert.equal(app.seatTextForTest(), 'checkout ', 'a wire-prefixed extension prefix must apply cleanly')
    assert.ok(!app.seatTextForTest().startsWith('heckout'), 'the prefix must never be doubled or stripped twice')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  app.stop()
})

// ── review round: prefix normalization never strips a mid-body ! ──────────

test('a mid-body ! completion token (echo !ch) keeps its literal !', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.setCommandCompletions([], fixtureWorkspace(), null, async () => ({
    // The word being completed is `!ch` — the `!` is a LITERAL body
    // character (the synthetic prefix sits at the wire line start), so
    // the extension prefix includes it and it must survive the apply.
    items: [{ value: '!checkout', label: '!checkout' }],
    prefix: '!ch',
  }))
  app.start()
  await vt.waitForRender()
  setCompgenRunnerForTest(() => Promise.resolve({ ok: false, lines: [] }))
  try {
    vt.sendInput('!')
    vt.sendInput('echo !ch')
    vt.sendInput('\t')
    await vt.waitForRender()
    assert.equal(app.seatTextForTest(), 'echo !checkout',
      'a mid-body literal ! must never be stripped by the prefix normalization')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  app.stop()
})

test('an incomplete CSI tail buffers without loss and stitches a split sequence', async () => {
  const { vt, app } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  // A lone incomplete CSI tail: buffered, never rendered, never crashes.
  vt.sendInput('\x1b[')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'an incomplete CSI tail must not enter the document')
  // The continuation stitches it into a complete sequence (a split up
  // arrow): processed as the key, not inserted as text.
  vt.sendInput('A')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'a stitched split CSI is handled as the key, never as text')
  app.stop()
})

// ── PR review round 3: multiline shell continuation lines are shell-owned ─

test('a continuation-line /u in shell-context is a PATH (no slash commands, no doubled slash)', async () => {
  const { vt, app } = startApp(fixtureWorkspace(), {
    commands: [{ name: 'image', description: 'Attach an image file' }],
  })
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('git status')
  vt.sendInput('\n') // continuation line
  vt.sendInput('/u')
  await vt.waitForRender()
  // Natural typing on line 1 must NOT open the slash-command list.
  await waitForNoDropdownRow(vt, 'image', 'no slash commands on a shell continuation line')
  assert.equal(app.inputModeForTest(), 'shell-context')
  // Tab completes the PATH on line 1.
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'usr', 'path completion for /u on line 1')
  vt.sendInput('\t') // accept /usr/
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'git status\n/usr/',
    'the accepted path must not double the slash on a continuation line')
  app.stop()
})

test('a continuation-line /u in shell-local is a PATH (no slash commands, no doubled slash)', async () => {
  const { vt, app } = startApp(fixtureWorkspace(), {
    commands: [{ name: 'image', description: 'Attach an image file' }],
  })
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('!')
  vt.sendInput('git status')
  vt.sendInput('\n')
  vt.sendInput('/u')
  await vt.waitForRender()
  await waitForNoDropdownRow(vt, 'image', 'no slash commands on a shell-local continuation line')
  assert.equal(app.inputModeForTest(), 'shell-local')
  vt.sendInput('\t')
  await waitForDropdownRow(vt, 'usr', 'path completion for /u on line 1 in shell-local')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'git status\n/usr/', 'shell-local accepts the path without a doubled slash')
  app.stop()
})

test('provider-level: a continuation-line /u applies as a path on any shell line', async () => {
  const root = fixtureWorkspace()
  const provider = new MentionProvider([], root, null, () => 'shell-context' as const)
  const applied = provider.applyCompletion(['git status', '/u'], 1, 2, { value: '/usr/', label: 'usr' }, '/u')
  assert.deepEqual(applied, { lines: ['git status', '/usr/'], cursorLine: 1, cursorCol: 5 },
    'the synthetic prefix never enters a continuation line and the slash is never doubled')
  // shouldTriggerFileCompletion allows Tab on the continuation line.
  assert.equal(provider.shouldTriggerFileCompletion(['git status', '/u'], 1, 2), true)
  // Natural triggers on the continuation line stay quiet (path semantics).
  const natural = await provider.getSuggestions(['git status', '/u'], 1, 2, { signal: abort })
  assert.equal(natural, null)
})

// ── review round: extension suppression covers continuation lines ─────────

test('the extension chain is NOT consulted on a continuation-line natural / trigger (only Tab)', async () => {
  const vt = new VirtualTerminal(100, 24)
  let queries = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.setCommandCompletions([], fixtureWorkspace(), null, async () => {
    queries += 1
    return {
      items: [
        { value: '/zzz-no-such-dir/', label: 'zzz-no-such-dir' },
        { value: '/zzz-no-such-file', label: 'zzz-no-such-file' },
      ],
      prefix: '/zzz-no-such',
    }
  })
  app.start()
  await vt.waitForRender()
  setCompgenRunnerForTest(() => Promise.resolve({ ok: false, lines: [] }))
  try {
    // A multiline shell draft: natural typing of a path on the
    // CONTINUATION line must not consult the plugin chain.
    vt.sendInput('!')
    vt.sendInput('git status')
    vt.sendInput('\n')
    vt.sendInput('/zzz-no-such')
    await vt.waitForRender()
    await waitForNoDropdownRow(vt, 'zzz-no-such-dir', 'no extension dropdown during continuation-line typing')
    assert.equal(queries, 0, 'a continuation-line natural / trigger never consults the plugin chain')
    // Tab (force) still consults it with the wire document.
    vt.sendInput('\t')
    await waitForDropdownRow(vt, 'zzz-no-such-dir', 'extension suggestion on the continuation line via Tab')
    assert.equal(queries, 1, 'Tab consults the plugin chain exactly once')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  app.stop()
})

// ── review round: plugin-consumed input notifies seat subscribers ─────────

test('a plugin editor consuming input notifies seat subscribers (fresh snapshot)', () => {
  const holder = new EditorSeatHolder({
    hostAdapter: () => {
      const h = {
        text: '',
        getText: () => h.text,
        setText: (text: string) => { h.text = text },
        setTextAndCursor: (text: string) => { h.text = text },
        getCursor: () => 0,
        setCursor: () => {},
        focused: true,
        borderColor: (text: string) => text,
        invalidate: () => {},
        addToHistory: () => {},
        clearHistory: () => {},
        component: new Text('host', 0, 0),
      }
      return h
    },
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const snapshots: string[] = []
  const plugin = pluginEditor()
  // A plugin that CONSUMES the event and mutates its document.
  plugin.handleInput = () => { plugin.setText('mutated'); return true }
  holder.handoff({
    id: 'plugin',
    create: (host) => {
      host.subscribe(snapshot => snapshots.push(snapshot.text))
      return plugin
    },
  })
  // Dispatch a semantic event through the seat's input channel.
  const seat = holder.currentEditor() as { handleInput?(event: unknown): boolean }
  assert.equal(typeof seat.handleInput, 'function', 'the plugin seat exposes its input channel')
  seat.handleInput!({ kind: 'text', text: 'x' })
  assert.deepEqual(snapshots, ['mutated'],
    'a consumed key must push the FRESH document snapshot to seat subscribers — a stale snapshot would lose edits')
  holder.dispose()
})

// ── review round: completion mode reads the VISIBLE seat, not the hidden host ──

test('completion uses the VISIBLE seat mode — a hidden host shell mode never leaks', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  const queries: { lines: readonly string[] }[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null, async (query) => {
    queries.push({ lines: [...query.lines] })
    return null
  })
  app.start()
  await vt.waitForRender()
  setCompgenRunnerForTest(() => Promise.resolve({ ok: false, lines: [] }))
  let handle: { dispose(): void } | undefined
  try {
    // The HOST enters shell mode, then a plugin editor takes the seat —
    // the hidden host keeps its shell mode, but the VISIBLE editor is a
    // prompt-semantics plugin.
    vt.sendInput('!')
    await vt.waitForRender()
    const created: ReturnType<typeof pluginEditor>[] = []
    handle = registry.register({
      id: 'completion-plugin',
      priority: 0,
      create: () => {
        const editor = pluginEditor()
        editor.handleInput = () => false // decline: host fallback owns editing
        created.push(editor)
        return editor
      },
    }, 'plugin')
    app.reconcileEditorNow()
    await vt.waitForRender()
    created[0]!.setText('ch')
    vt.sendInput('\t')
    await pollUntil(() => queries.length === 1, 'extension query through the plugin seat')
    assert.deepEqual([...queries[0]!.lines], ['ch'],
      'a prompt-semantics plugin seat must never get the hidden host\'s synthetic ! prefix')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  handle?.dispose()
  app.reconcileEditorNow()
  app.stop()
})

// ── review round: advanced editor controls honor the shell boundary ───────

test('advanced editor controls replace a shell-mode draft through the wire boundary', async () => {
  const { vt, app, submitted } = startApp(fixtureWorkspace())
  await vt.waitForRender()
  vt.sendInput('!')
  vt.sendInput('pwd')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context')
  // A plugin replaces the draft with PLAIN text: the serialized decode
  // must clear the shell mode, so the replacement submits as prose.
  app.advancedEditorControls().setEditorText('plain prose')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'prompt', 'a raw replacement must not keep the stale shell mode')
  assert.equal(app.seatTextForTest(), 'plain prose')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['plain prose'], 'the replacement submits as plain text, never as a shell command')
  // Replacing with a SERIALIZED draft re-enters the shell mode.
  app.advancedEditorControls().setEditorText('!pwd')
  await vt.waitForRender()
  assert.equal(app.inputModeForTest(), 'shell-context', 'a serialized replacement decodes into the shell mode')
  assert.equal(app.seatTextForTest(), 'pwd')
  vt.sendInput('\r')
  assert.deepEqual(submitted, ['plain prose', '!pwd'])
  app.stop()
})

// ── review round: replacement-editor HOST EXECUTION MODE ───────────────────
// A replacement editor in the seat has NO mode — its document IS the wire
// form. The declined-key fallback decodes that wire document into the
// HIDDEN host editor (mode + body) before every forwarded key, so the
// host editor's OWN state is the authoritative execution mode for its
// callbacks (onSubmit, the autocomplete provider). Serializing a fallback
// submit by the VISIBLE seat mode would collapse `!!pwd` into a plain
// `pwd` — a local-only command degrading into a model prompt.

test('a replacement editor submit keeps the shell wire form through the host fallback', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null)
  app.start()
  await vt.waitForRender()
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'submit-fallback-plugin',
    priority: 0,
    create: () => {
      const editor = pluginEditor()
      // Decline every key: the plugin STAYS in the seat and Enter is
      // host-owned (P1-10) — the hidden host editor submits.
      editor.handleInput = () => false
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  const plugin = created[0]!
  // shell-context: `!pwd` must submit as `!pwd`. The fallback decoded the
  // wire document into the hidden host editor (shell-context + `pwd`)
  // BEFORE Enter, and the host onSubmit must serialize from that HOST
  // mode — never from the visible seat (which is a mode-less plugin).
  plugin.setText('!pwd')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual([...submitted], ['!pwd'], 'a replacement !pwd submit keeps the shell-context wire form')
  // shell-local: `!!pwd` is LOCAL-ONLY — degrading it to a plain `pwd`
  // would leak the local command into the session/model.
  plugin.setText('!!pwd')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual([...submitted], ['!pwd', '!!pwd'], 'a replacement !!pwd submit keeps the local-only wire form')
  // prompt-mode wire: unchanged (identity — a plugin document is raw).
  plugin.setText('plain prose')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual([...submitted], ['!pwd', '!!pwd', 'plain prose'])
  handle.dispose()
  app.reconcileEditorNow()
  app.stop()
})

test('a replacement plugin Tab runs the shell completion grammar of the wire document', async () => {
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(100, 24)
  const queries: { lines: readonly string[]; cursorCol: number }[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.setCommandCompletions([], fixtureWorkspace(), null, async (query) => {
    queries.push({ lines: [...query.lines], cursorCol: query.cursorCol })
    return null
  })
  app.start()
  await vt.waitForRender()
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'completion-fallback-plugin',
    priority: 0,
    create: () => {
      const editor = pluginEditor()
      // Decline: the host fallback owns Tab (and every editing key).
      editor.handleInput = () => false
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  const plugin = created[0]!
  let compgenCalls = 0
  try {
    // The plugin document is the WIRE form: `!gi` is a shell-context
    // document, so a declined Tab must run the SHELL command grammar
    // (compgen) — the prompt-mode grammar would never invoke compgen.
    setCompgenRunnerForTest((_cwd, expression) => {
      compgenCalls += 1
      return Promise.resolve({
        ok: true,
        lines: expression.includes('compgen -A command') ? ['git', 'gist'] : [],
      })
    })
    plugin.setText('!gi')
    plugin.setCursor(plugin.getText().length)
    vt.sendInput('\t')
    await pollUntil(() => compgenCalls === 1, 'the shell compgen ran through the plugin seat')
    // The dropdown opens asynchronously inside the hidden host editor;
    // the second Tab applies its selection synchronously and the fallback
    // syncs the completed command back into the plugin wire document.
    await new Promise(resolve => setTimeout(resolve, 50))
    vt.sendInput('\t')
    await pollUntil(() => plugin.getText() === '!git ',
      'the shell completion applies into the plugin wire document')
    // The extension chain (host provider returns null) sees the WIRE line
    // with the synthetic prefix and the shifted cursor — the shell
    // semantics must survive the plugin seat. (The compgen result cache
    // must drop Phase A's command list, or the host provider still wins.)
    resetCommandCacheForTest()
    setCompgenRunnerForTest(() => Promise.resolve({ ok: false, lines: [] }))
    plugin.setText('!gi')
    plugin.setCursor(3)
    vt.sendInput('\t')
    await pollUntil(() => queries.length === 1, 'extension query through the shell wire plugin seat')
    assert.deepEqual([...queries[0]!.lines], ['!gi'], 'the extension query sees the wire line through the plugin seat')
    assert.equal(queries[0]!.cursorCol, 3, 'the wire cursor shifts by the synthetic prefix')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
  handle.dispose()
  app.reconcileEditorNow()
  app.stop()
})
