/**
 * Headless tests for the TuiEditor host subclass (kimi CustomEditor
 * parity): Tab-accepting an `@dir/` mention reopens the dropdown at its
 * children, Esc closes it WITHOUT re-triggering, and ordinary text is
 * unaffected (no reopen for non-mention slashes).
 * @module @xmoon76/dsh-pi-tui/tui-editor.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** A throwaway workspace with one directory + a file inside it. */
function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tui-editor-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep-nested.ts'), 'deep')
  return root
}

function startApp(cwd: string): { vt: VirtualTerminal; app: TuiApp; cancels: number } {
  const vt = new VirtualTerminal(100, 24)
  let cancels = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
  })
  app.setCommandCompletions([], cwd, null)
  app.start()
  return { vt, app, get cancels() { return cancels } }
}

/** Poll the viewport until the dropdown row appears (asserts on failure). */
async function waitForDropdownRow(vt: VirtualTerminal, needle: string, label: string): Promise<string> {
  const deadline = Date.now() + 2000
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

test('Tab-accepting a directory reopens the dropdown at its children', async () => {
  const root = fixtureWorkspace()
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  vt.sendInput('@src')
  await waitForDropdownRow(vt, 'src/', 'dropdown after typing @src')
  // Tab accepts the directory item: the text becomes `@src/` and the
  // dropdown closes, then the TuiEditor re-triggers it at the children.
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '@src/', 'Tab must accept the directory mention')
  await waitForDropdownRow(vt, 'deep-nested.ts', 'children after Tab accept')
  app.stop()
})

test('Esc while the dropdown is open closes it WITHOUT re-triggering', async () => {
  const root = fixtureWorkspace()
  const { vt, app, cancels } = startApp(root)
  await vt.waitForRender()
  vt.sendInput('@src/')
  await waitForDropdownRow(vt, 'deep-nested.ts', 'dropdown after typing @src/')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  await waitForNoDropdownRow(vt, 'deep-nested.ts', 'dropdown after Esc')
  // Longer than the autocomplete debounce: the closed dropdown must NOT
  // reopen even though the cursor still sits on an `@dir/` mention.
  await new Promise(resolve => setTimeout(resolve, 80))
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('deep-nested.ts'), `Esc must not re-trigger the dropdown:\n${view}`)
  assert.equal(app.seatTextForTest(), '@src/', 'Esc must not alter the draft')
  assert.equal(cancels, 0, 'closing the dropdown must not fire the app cancel')
  app.stop()
})

test('a non-mention trailing slash does not reopen the dropdown', async () => {
  const root = fixtureWorkspace()
  const { vt, app } = startApp(root)
  await vt.waitForRender()
  // Plain text with a trailing slash (e.g. a path): NOT an @ mention —
  // pressing Tab accepts nothing and the dropdown must stay closed.
  vt.sendInput('see /tmp/')
  await vt.waitForRender()
  vt.sendInput('\t')
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 80))
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('deep-nested.ts'), `plain path must not open the dropdown:\n${view}`)
  app.stop()
})
