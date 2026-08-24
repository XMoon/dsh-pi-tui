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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TuiApp, type SubagentViewerTarget } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** A throwaway workspace (completion fixtures live under the cwd). */
function fixtureWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-shell-mode-'))
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
  // Natural typing of a path: the slash-command list must NOT appear.
  vt.sendInput('/usr/lo')
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 80))
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('image'), `a shell-mode path must not open the slash-command list:\n${view}`)
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
