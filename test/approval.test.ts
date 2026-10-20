/**
 * Headless tests for the approval action sheet: the editor-seat placement,
 * the full scrollable request body, y/n/Esc/Ctrl+C decisions, FIFO queueing,
 * abort withdrawal, copy/expand, and the fullscreen-only pointer path.
 * @module @xmoon76/dsh-pi-tui/approval.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp, type ApprovalOutcome } from '../src/tui-app.ts'
import { parseUserKeybindings } from '../src/tui/keybindings/config.ts'
import { color, setTheme } from '../src/tui/theme/runtime.ts'
import { darkColors } from '../src/domain/display/theme.ts'
import { visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces,
 * so a test that starts an app must not leak the slot into the next test
 * (see src/tui/process-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  setTheme('dark')
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(columns = 80, rows = 24): { vt: VirtualTerminal; app: TuiApp; copied: string[] } {
  const vt = new VirtualTerminal(columns, rows)
  const copied: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (label, task, options) => {
      void Promise.resolve()
        .then(() => task())
        .then(result => options.onResult?.(result), error => options.onError?.(error))
    },
  }, {
    copySelection: async (text: string) => {
      copied.push(text)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  return { vt, app, copied }
}

/** The visible viewport joined for substring assertions. */
async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** The painted frame bounds (0-based viewport rows). */
function frameBounds(view: string): { top: number; bottom: number } | undefined {
  const lines = view.split('\n')
  const top = lines.findIndex(line => line.includes('╭'))
  const bottom = lines.findIndex(line => line.includes('╰'))
  return top >= 0 && bottom >= top ? { top, bottom } : undefined
}

/** The user-visible sheet invariant: the three decision actions and both
 * borders survive whatever content is shown. */
function assertSheetIntact(view: string): void {
  assert.ok(view.includes('Approve '), `title missing:\n${view}`)
  assert.ok(view.includes('[y] Allow once'), `allow action missing:\n${view}`)
  assert.ok(view.includes('[n] Reject'), `reject action missing:\n${view}`)
  assert.ok(view.includes('[Esc] Cancel'), `cancel action missing:\n${view}`)
  const bounds = frameBounds(view)
  assert.ok(bounds !== undefined, `frame borders missing:\n${view}`)
}

/** One 1-based SGR cell of a painted action label. */
function actionCell(view: string, label: string): { x: number; y: number } {
  const lines = view.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const column = lines[index]!.indexOf(label)
    if (column !== -1) return { x: column + 1, y: index + 1 }
  }
  throw new Error(`action label not painted: ${label}\n${view}`)
}

function press(vt: VirtualTerminal, cell: { x: number; y: number }): void {
  vt.sendInput(`\x1b[<0;${cell.x};${cell.y}M`)
}

function release(vt: VirtualTerminal, cell: { x: number; y: number }): void {
  vt.sendInput(`\x1b[<0;${cell.x};${cell.y}m`)
}

function click(vt: VirtualTerminal, cell: { x: number; y: number }): void {
  press(vt, cell)
  release(vt, cell)
}

function wheel(vt: VirtualTerminal, direction: 'up' | 'down', cell: { x: number; y: number }): void {
  vt.sendInput(`\x1b[<${direction === 'up' ? 64 : 65};${cell.x};${cell.y}M`)
}

const LONG_ARGUMENTS = Array.from({ length: 120 }, (_, index) => `arg-${String(index).padStart(3, '0')}`).join('\n')

test('approval sheet shows the tool, danger fact, complete reason/arguments and pinned actions', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({
    toolName: 'bash',
    reason: 'update the deployment config',
    arguments: '{"command":"deploy --prod"}',
    danger: true,
  })
  const view = await viewport(vt)
  assertSheetIntact(view)
  assert.ok(view.includes('Approve bash?'), `title missing:\n${view}`)
  assert.ok(view.includes('Dangerous command'), `danger fact missing:\n${view}`)
  assert.ok(view.includes('update the deployment config'), `reason missing:\n${view}`)
  assert.ok(view.includes('Run command') && view.includes('Command'), `semantic argument sections missing:\n${view}`)
  assert.ok(view.includes('deploy --prod'), `arguments missing:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('y allows once and closes the sheet', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve bash'), `sheet still visible:\n${view}`)
})

test('n rejects and escape cancels', async () => {
  const { vt, app } = startApp()
  const rejected = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  vt.sendInput('n')
  assert.equal(await rejected, 'rejected')

  const cancelled = app.showApprovalPrompt({ toolName: 'fs' })
  await viewport(vt)
  vt.sendInput('\x1b') // escape
  assert.equal(await cancelled, 'cancelled')
})

test('Focus approval keeps ownership while the remapped fold key precedes every decision', async () => {
  const { vt, app } = startApp()
  app.setFocusMode(true)
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': 'ctrl+x' }))
  for (const [key, expected] of [['y', 'allowed-once'], ['n', 'rejected'], ['\x1b', 'cancelled']] as const) {
    const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
    await viewport(vt)
    vt.sendInput('\x18')
    await vt.waitForRender()
    assert.ok(vt.getViewport().join('\n').includes('Approve bash?'), 'fold inspection must not dismiss Approval')
    vt.sendInput(key)
    assert.equal(await decision, expected)
  }
})

test('Approval decision keys beat a conflicting inspection remap', async () => {
  const { vt, app } = startApp()
  app.setFocusMode(true)
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    'app.exit.request': false,
    'app.transcript.toggleExpand': 'ctrl+c',
  }))
  assert.deepEqual(app.keybindingsManager().keysFor('app.transcript.toggleExpand'), ['ctrl+c'],
    'the conflicting inspection remap must be effective')
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await viewport(vt)
  vt.sendInput('\x03') // Ctrl+C
  assert.equal(await decision, 'cancelled', 'Approval fixed Ctrl+C must win over the conflicting transcript inspection remap')
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the conflicting inspection action must not run')
})

test('ctrl+c cancels the prompt like escape', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  vt.sendInput('\x03') // ctrl+c
  assert.equal(await decision, 'cancelled')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve bash'), `sheet still visible:\n${view}`)
})

test('prompts queue FIFO and consume all keys while showing', async () => {
  const { vt, app } = startApp()
  const first = app.showApprovalPrompt({ toolName: 'bash' })
  const second = app.showApprovalPrompt({ toolName: 'fs' })
  await viewport(vt)
  vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  const secondView = await viewport(vt)
  assert.ok(secondView.includes('Approve fs'), `second sheet missing:\n${secondView}`)
  vt.sendInput('n')
  assert.equal(await second, 'rejected')
})

test('an aborted signal withdraws the prompt as cancelled', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  const decision = app.showApprovalPrompt({ toolName: 'bash', signal: controller.signal })
  controller.abort()
  assert.equal(await decision, 'cancelled')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve bash'), `sheet still visible:\n${view}`)
})

test('an already-aborted signal settles immediately without hanging', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  controller.abort()
  const decision = app.showApprovalPrompt({ toolName: 'bash', signal: controller.signal })
  assert.equal(await decision, 'cancelled')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve bash'), `sheet must not appear:\n${view}`)
})

test('a queued prompt aborted while waiting never reaches the screen', async () => {
  const { vt, app } = startApp()
  const first = app.showApprovalPrompt({ toolName: 'bash' })
  const secondController = new AbortController()
  const second = app.showApprovalPrompt({ toolName: 'fs', signal: secondController.signal })
  await viewport(vt)
  secondController.abort()
  vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  assert.equal(await second, 'cancelled')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve fs'), `stale queued sheet popped:\n${view}`)
})

test('editor input is blocked while a prompt is showing', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} })
  app.start()
  startedApps.add(app)
  const decision = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  vt.sendInput('hello')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, [])
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
})

test('the whole argument body is reachable: End reaches the real tail (no six-line preview cap)', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  let view = await viewport(vt)
  assert.ok(view.includes('arg-000'), `head missing:\n${view}`)
  assert.ok(!view.includes('arg-119'), `the tail must not start in view:\n${view}`)
  vt.sendInput('\x1b[F') // End
  view = await viewport(vt)
  assert.ok(view.includes('arg-119'), `End must reach the real tail:\n${view}`)
  assert.ok(view.includes('rows '), `a scroll fact must be shown:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('long CJK and unbroken words keep a reachable tail', async () => {
  const { vt, app } = startApp()
  const cjk = app.showApprovalPrompt({
    toolName: 'bash',
    arguments: `${'超长中文参数'.repeat(120)}CJK_TAIL_MARKER`,
  })
  let view = await viewport(vt)
  assert.ok(!view.includes('CJK_TAIL_MARKER'), `the CJK tail must not start in view:\n${view}`)
  vt.sendInput('\x1b[F')
  view = await viewport(vt)
  assert.ok(view.includes('CJK_TAIL_MARKER'), `End must reach the CJK tail:\n${view}`)
  vt.sendInput('n')
  assert.equal(await cjk, 'rejected')

  const word = app.showApprovalPrompt({
    toolName: 'bash',
    arguments: `${'W'.repeat(2000)}WORD_TAIL_MARKER`,
  })
  view = await viewport(vt)
  assert.ok(!view.includes('WORD_TAIL_MARKER'), `the unbroken-word tail must not start in view:\n${view}`)
  vt.sendInput('\x1b[F')
  view = await viewport(vt)
  assert.ok(view.includes('WORD_TAIL_MARKER'), `End must reach the unbroken-word tail:\n${view}`)
  vt.sendInput('n')
  assert.equal(await word, 'rejected')
})

test('PgDn/Home and the expanded reading size adjust the unified body viewport', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  let view = await viewport(vt)
  const collapsed = frameBounds(view)
  assert.ok(collapsed !== undefined)
  vt.sendInput('\x1b[6~') // PageDown
  view = await viewport(vt)
  assert.ok(!view.includes('arg-000'), `PageDown must leave the head:\n${view}`)
  vt.sendInput('\x1b[H') // Home
  view = await viewport(vt)
  assert.ok(view.includes('arg-000'), `Home must return to the head:\n${view}`)
  vt.sendInput('e')
  view = await viewport(vt)
  const expanded = frameBounds(view)
  assert.ok(expanded !== undefined)
  assert.ok(expanded.bottom - expanded.top > collapsed.bottom - collapsed.top,
    `'e' must grow the reading region:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('c copies the exact received argument bytes and empty arguments advertise no Copy', async () => {
  const { vt, app, copied } = startApp()
  const raw = '{"command":"rm -rf /tmp/x"}\nline\t<an\u001b[31mred\u001b]0;pwned\u0007>'
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: raw })
  const view = await viewport(vt)
  assert.ok(view.includes('[c] Copy args'), `copy action missing:\n${view}`)
  vt.sendInput('c')
  await vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(copied, [raw], 'Copy must carry the original bytes, not the display projection')
  assert.ok(!view.includes('pwned'), `display leaked the OSC payload:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')

  const noArguments = app.showApprovalPrompt({ toolName: 'bash' })
  const noArgumentsView = await viewport(vt)
  assert.ok(!noArgumentsView.includes('[c] Copy'), `an empty request must not advertise Copy:\n${noArgumentsView}`)
  vt.sendInput('c')
  await vt.waitForRender()
  await Promise.resolve()
  assert.equal(copied.length, 1, 'no Copy delivery without arguments')
  vt.sendInput('y')
  assert.equal(await noArguments, 'allowed-once')
})

test('responsive layouts keep the title, reading row and pinned actions visible', async () => {
  for (const [columns, rows] of [[44, 24], [80, 24], [120, 40], [200, 60]] as const) {
    const { vt, app } = startApp(columns, rows)
    const decision = app.showApprovalPrompt({
      toolName: 'bash',
      reason: 'review the request',
      arguments: LONG_ARGUMENTS,
      danger: true,
    })
    const view = await viewport(vt)
    assertSheetIntact(view)
    assert.ok(view.includes('review the request'), `${columns}x${rows} reason missing:\n${view}`)
    assert.ok(view.includes('arg-'), `${columns}x${rows} argument reading row missing:\n${view}`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
})

test('a live width reflow keeps the same request and a reachable tail', async () => {
  const { vt, app } = startApp(120, 40)
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  let view = await viewport(vt)
  assert.ok(view.includes('arg-000'), `wide head missing:\n${view}`)
  vt.resize(44, 24)
  view = await viewport(vt)
  assertSheetIntact(view)
  assert.ok(view.includes('arg-0'), `narrow reflow must keep the body:\n${view}`)
  vt.sendInput('\x1b[F') // End
  view = await viewport(vt)
  assert.ok(view.includes('arg-119'), `the narrowed sheet must still reach the tail:\n${view}`)
  vt.resize(120, 40)
  view = await viewport(vt)
  assertSheetIntact(view)
  assert.ok(view.includes('arg-119'), `the widened reflow must keep the scrolled tail:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('short surfaces keep the title/danger, one reading row, actions and a resize fact', async () => {
  for (const [columns, rows] of [[80, 8], [44, 10]] as const) {
    const { vt, app } = startApp(columns, rows)
    const decision = app.showApprovalPrompt({
      toolName: 'bash',
      reason: 'line one\nline two',
      arguments: LONG_ARGUMENTS,
      danger: true,
    })
    const view = await viewport(vt)
    assertSheetIntact(view)
    assert.ok(view.includes('Dangerous command'), `${columns}x${rows} danger fact missing:\n${view}`)
    assert.ok(view.includes('Arguments:') && view.includes('arg-'),
      `${columns}x${rows} one real payload row missing:\n${view}`)
    assert.ok(view.includes('Resize to inspect more'), `${columns}x${rows} resize fact missing:\n${view}`)
    assert.ok(vt.writes.join('').includes(color.error('⚠ Dangerous command')),
      `${columns}x${rows} compact danger must use the error token`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
})

test('a surface below 24 columns still paints all three decisions', async () => {
  const { vt, app } = startApp(20, 10)
  const decision = app.showApprovalPrompt({
    toolName: 'bash',
    reason: 'narrow decision',
    arguments: LONG_ARGUMENTS,
  })
  const view = await viewport(vt)
  assert.ok(view.includes('bash'), `the compact tool identity must stay identifiable:\n${view}`)
  assert.ok(view.includes('[y] Allow once'), `allow decision missing:\n${view}`)
  assert.ok(view.includes('[n] Reject'), `reject decision missing:\n${view}`)
  assert.ok(view.includes('[Esc] Cancel'), `cancel decision missing:\n${view}`)
  assert.ok(view.includes('Resize'), `narrow surface must advertise the resize cue:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a long dangerous tool keeps the warning fact in a narrow title', async () => {
  const { vt, app } = startApp(20, 10)
  const decision = app.showApprovalPrompt({
    toolName: 'very-long-tool-name-abcdefghijk',
    reason: 'danger body',
    arguments: LONG_ARGUMENTS,
    danger: true,
  })
  const view = await viewport(vt)
  assert.ok(view.includes('⚠'), `the danger glyph must survive the narrow title fallback:\n${view}`)
  assert.ok(vt.writes.join('').includes(color.error('⚠')),
    'the compact fallback warning glyph must use the error token')
  assert.ok(view.includes('very'), `the tool identity must stay partially identifiable:\n${view}`)
  assert.ok(view.includes('Resize'), `the resize cue must stay visible:\n${view}`)
  assert.ok(view.includes('Arguments:') && view.includes('arg'),
    `the actual payload row must stay visible:\n${view}`)
  assert.ok(view.includes('[y] Allow once') && view.includes('[n] Reject') && view.includes('[Esc] Cancel'),
    `all three decisions must stay painted:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a grant below the minimum sheet paints one truthful resize row, never a clipped action', async () => {
  const { vt, app } = startApp(10, 4)
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'too small', danger: true })
  const view = await viewport(vt)
  assert.ok(view.includes('Resize'), `the resize fact must survive an impossible grant:\n${view}`)
  assert.ok(view.includes('⚠'), `the danger fact must survive an impossible grant:\n${view}`)
  assert.ok(vt.writes.join('').includes(color.error('⚠')),
    'the resize-only danger glyph must use the error token')
  assert.ok(!view.includes('[y] Allow once'), `no action cell may survive an impossible grant:\n${view}`)
  assert.ok(!view.includes('╭'), `the tiny grant must not paint a clipped box:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a narrow short grant with no room for title and body degrades to the resize row', async () => {
  for (const [columns, rows] of [[16, 8], [30, 8]] as const) {
    const { vt, app } = startApp(columns, rows)
    const decision = app.showApprovalPrompt({
      toolName: 'bash',
      reason: 'narrow short body',
      arguments: LONG_ARGUMENTS,
      danger: true,
    })
    const view = await viewport(vt)
    assert.ok(view.includes('Resize'), `${columns}x${rows} must advertise resizing:\n${view}`)
    assert.ok(view.includes('⚠'), `${columns}x${rows} must keep the danger fact:\n${view}`)
    assert.ok(!view.includes('[y] Allow once'),
      `${columns}x${rows} must not paint a decision without the title/reading row:\n${view}`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
})

test('a narrow but tall grant keeps the compact readable sheet', async () => {
  const { vt, app } = startApp(16, 24)
  const decision = app.showApprovalPrompt({
    toolName: 'bash',
    reason: 'readable reason',
    arguments: 'first\nsecond',
    danger: true,
  })
  const view = await viewport(vt)
  assert.ok(view.includes('Approve'), `the title must stay readable in a tall narrow sheet:\n${view}`)
  assert.ok(view.includes('Dangero') || view.includes('⚠'), `the danger fact must stay readable:\n${view}`)
  assert.ok(view.includes('Reason') && view.includes('readable'), `the reading section must stay readable:\n${view}`)
  assert.ok(view.includes('[y] Allow'), `allow decision missing:\n${view}`)
  assert.ok(view.includes('[n] Reject'), `reject decision missing:\n${view}`)
  assert.ok(view.includes('[Esc] Cancel'), `cancel decision missing:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a tall ultra-narrow grant degrades instead of painting cropped action labels', async () => {
  for (const [columns, rows] of [[10, 24], [12, 24]] as const) {
    const { vt, app } = startApp(columns, rows)
    const decision = app.showApprovalPrompt({
      toolName: 'bash',
      reason: 'readable reason',
      arguments: 'first\nsecond',
      danger: true,
    })
    const view = await viewport(vt)
    assert.ok(view.includes('Resize'), `${columns}x${rows} must advertise resizing:\n${view}`)
    assert.ok(!view.includes('[y]'), `${columns}x${rows} must not paint a partial allow label:\n${view}`)
    assert.ok(!view.includes('[n]'), `${columns}x${rows} must not paint a partial reject label:\n${view}`)
    assert.ok(!view.includes('[Esc]'), `${columns}x${rows} must not paint a partial cancel label:\n${view}`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
})

test('fullscreen 80x8 paints a real decision cell and keeps the resize fact', async () => {
  const { vt, app } = startApp(80, 8)
  app.setFullscreen(true)
  await vt.waitForRender()
  const decision = app.showApprovalPrompt({
    toolName: 'bash',
    reason: 'tiny pointer decision',
    arguments: LONG_ARGUMENTS,
    danger: true,
  })
  const view = await viewport(vt)
  assertSheetIntact(view)
  assert.ok(view.includes('Dangerous command'), `danger fact missing:\n${view}`)
  assert.ok(view.includes('Resize to inspect more'), `resize fact missing:\n${view}`)
  click(vt, actionCell(view, '[y] Allow once'))
  assert.equal(await decision, 'allowed-once')
})

test('hostile approval content cannot inject terminal control or fake an action row', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({
    toolName: 'ba\u001b[31msh\u001b]0;PWNED\u0007',
    reason: 'oops\r[y] Allow once\u009b2J',
    arguments: 'arg\u001b[2Jone\narg\u001b]52;c;YXR0YWNr\u0007two',
  })
  const view = await viewport(vt)
  assertSheetIntact(view)
  const stream = vt.writes.join('')
  assert.ok(!stream.includes('PWNED'), 'the tool-name OSC payload never reaches the terminal stream')
  assert.ok(!stream.includes('YXR0YWNr'), 'the argument OSC payload never reaches the terminal stream')
  assert.ok(!stream.includes('\u009b'), 'no raw C1 byte reaches the terminal stream')
  assert.ok(!view.includes('\u001b'), 'the painted view carries no raw ESC')
  const reasonRow = view.split('\n').find(line => line.includes('oops'))
  assert.ok(reasonRow !== undefined, `the reason row is painted:\n${view}`)
  assert.ok(reasonRow!.includes('[y] Allow once'), 'the CR folded into the SAME row and could not impersonate an action')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('fullscreen action buttons settle through the real press/release path', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  for (const [label, expected] of [
    ['[y] Allow once', 'allowed-once'],
    ['[n] Reject', 'rejected'],
    ['[Esc] Cancel', 'cancelled'],
  ] as const) {
    const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'pointer decision' })
    const view = await viewport(vt)
    click(vt, actionCell(view, label))
    assert.equal(await decision, expected)
  }
})

test('fullscreen clicks are fenced: wrong release, blank press and A→B cannot settle', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()

  // Press Allow, release Reject: no decision may run.
  let decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'press mismatch' })
  let view = await viewport(vt)
  const allow = actionCell(view, '[y] Allow once')
  const reject = actionCell(view, '[n] Reject')
  press(vt, allow)
  release(vt, reject)
  await vt.waitForRender()
  let settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'a press on Allow + release on Reject must not settle')
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')

  // Press a blank title cell, release Allow: inert.
  decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'blank press' })
  view = await viewport(vt)
  const blank = { x: 5, y: (frameBounds(view)?.top ?? 0) + 2 }
  const allow2 = actionCell(view, '[y] Allow once')
  press(vt, blank)
  release(vt, allow2)
  await vt.waitForRender()
  settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'a blank-cell press must not transfer to Allow')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')

  // Press Allow on A, abort A, B takes the seat, release the A coordinates.
  const controller = new AbortController()
  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'A', signal: controller.signal })
  const second = app.showApprovalPrompt({ toolName: 'fs', reason: 'B' })
  view = await viewport(vt)
  const allowA = actionCell(view, '[y] Allow once')
  press(vt, allowA)
  controller.abort()
  assert.equal(await first, 'cancelled')
  await vt.waitForRender()
  release(vt, allowA)
  await vt.waitForRender()
  settled = false
  void second.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'an A press released after B took the seat must not approve B')
  const secondView = await viewport(vt)
  click(vt, actionCell(secondView, '[n] Reject'))
  assert.equal(await second, 'rejected')
})

test('a fullscreen press is invalidated by an expand or a resize before release', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()

  // Expand between press and release.
  let decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  let view = await viewport(vt)
  let allow = actionCell(view, '[y] Allow once')
  press(vt, allow)
  vt.sendInput('e')
  await vt.waitForRender()
  view = await viewport(vt)
  allow = actionCell(view, '[y] Allow once')
  release(vt, allow)
  await vt.waitForRender()
  let settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'an expand between press and release must invalidate the click')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')

  // Resize + repaint between press and release.
  decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  view = await viewport(vt)
  press(vt, actionCell(view, '[y] Allow once'))
  vt.resize(100, 32)
  await vt.waitForRender()
  view = await vt.getViewport().join('\n')
  release(vt, actionCell(view, '[y] Allow once'))
  await vt.waitForRender()
  settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'a resize between press and release must invalidate the click')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')

  // A body scroll between press and release also changes the painted layout.
  decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  view = await viewport(vt)
  const allowCell = actionCell(view, '[y] Allow once')
  const body = frameBounds(view)
  assert.ok(body !== undefined)
  press(vt, allowCell)
  wheel(vt, 'down', { x: 5, y: body.top + 4 })
  await vt.waitForRender()
  release(vt, allowCell)
  await vt.waitForRender()
  settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'a scroll between press and release must invalidate the click')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('narrow fullscreen action rows keep real painted decision cells', async () => {
  const { vt, app } = startApp(44, 24)
  app.setFullscreen(true)
  await vt.waitForRender()
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  const view = await viewport(vt)
  assertSheetIntact(view)
  click(vt, actionCell(view, '[n] Reject'))
  assert.equal(await decision, 'rejected')
})

test('regular mode has no approval mouse action path; the terminal still keeps its own behavior', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'regular is keyboard only' })
  const view = await viewport(vt)
  click(vt, actionCell(view, '[y] Allow once'))
  await vt.waitForRender()
  let settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'a regular-surface SGR click must not approve')
  wheel(vt, 'down', { x: 5, y: (frameBounds(view)?.top ?? 0) + 3 })
  await vt.waitForRender()
  assert.equal(settled, false)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('fullscreen wheel scrolls the painted body only', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  let view = await viewport(vt)
  assert.ok(view.includes('arg-000'), `head missing:\n${view}`)
  const bounds = frameBounds(view)
  assert.ok(bounds !== undefined)
  const bodyCell = { x: 5, y: bounds.top + 4 }
  for (let index = 0; index < 3; index += 1) wheel(vt, 'down', bodyCell)
  view = await viewport(vt)
  assert.ok(!view.includes('arg-000'), `wheel over the body must scroll it:\n${view}`)
  const afterScroll = frameBounds(view)
  assert.ok(afterScroll !== undefined)
  // A wheel over the action bar does not scroll the approval body.
  const beforeActionWheel = view
  wheel(vt, 'down', { x: 5, y: afterScroll.bottom })
  view = await viewport(vt)
  assert.equal(view, beforeActionWheel, 'a wheel outside the body must not scroll the sheet')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a hidden Approval behind a Question does not consume the wheel', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const approval = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS })
  await viewport(vt)
  const question = app.askQuestions([{ id: 'q-hidden', question: 'hidden wheel?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  for (let index = 0; index < 3; index += 1) wheel(vt, 'down', { x: 5, y: 15 })
  await vt.waitForRender()
  vt.sendInput('\r')
  vt.sendInput('\r')
  await question
  const view = await viewport(vt)
  assert.ok(view.includes('arg-000'), `the hidden Approval must not scroll behind the Question:\n${view}`)
  vt.sendInput('n')
  assert.equal(await approval, 'rejected')
})

test('fullscreen Copy/Expand actions are clickable and use the painted target', async () => {
  const { vt, app, copied } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const raw = 'line one\nline two'
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: LONG_ARGUMENTS + '\n' + raw })
  let view = await viewport(vt)
  click(vt, actionCell(view, '[c] Copy args'))
  await vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(copied.length, 1, 'the painted Copy action delivers the raw arguments')
  assert.ok(copied[0]!.endsWith(raw), 'Copy carries the exact received tail')
  const before = frameBounds(view)
  assert.ok(before !== undefined)
  view = await viewport(vt)
  click(vt, actionCell(view, '[e] Expand'))
  view = await viewport(vt)
  const after = frameBounds(view)
  assert.ok(after !== undefined)
  assert.ok(after.bottom - after.top > before.bottom - before.top,
    `the painted Expand action must grow the reading region:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('settling an approval restores the editor draft, cursor and focus', async () => {
  const { vt, app } = startApp()
  app.setEditorText('keep this draft')
  app.seatEditorForTest().setCursor?.(5)
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'draft safety' })
  await viewport(vt)
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
  await viewport(vt)
  assert.equal(app.hostEditorTextForTest(), 'keep this draft')
  assert.equal(app.seatEditorForTest().getCursor?.(), 5, 'the editor cursor survives the seat projection')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'with nothing restored, the editor owns the keyboard again')
})

test('queued A→B keeps the optional History tenant parked until the last approval settles', async () => {
  // The optional-tenant owner's own suite covers the full History panel; this
  // asserts the approval-specific queue-drain predicate through the public
  // frame/lifecycle hooks.
  const { vt, app } = startApp()
  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'A' })
  const second = app.showApprovalPrompt({ toolName: 'fs', reason: 'B' })
  await viewport(vt)
  assert.ok(app.approvalFrameForTest() !== undefined)
  vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  const view = await viewport(vt)
  assert.ok(view.includes('Approve fs?'), `B must take the seat:\n${view}`)
  assert.ok(app.approvalFrameForTest() !== undefined)
  vt.sendInput('n')
  assert.equal(await second, 'rejected')
  assert.equal(app.approvalFrameForTest(), undefined)
})

test('a settled approval leaves no frame behind and the surface stays usable', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'frame lifecycle' })
  const frame = app.approvalFrameForTest()
  assert.notEqual(frame, undefined)
  await viewport(vt)
  vt.sendInput('\x1b')
  assert.equal(await decision, 'cancelled')
  assert.equal(app.approvalFrameForTest(), undefined, 'the settled approval releases its seat frame')
  const healthy = app.showApprovalPrompt({ toolName: 'fs', reason: 'healthy after cancel' })
  await viewport(vt)
  vt.sendInput('y')
  assert.equal(await healthy, 'allowed-once')
})

/** The viewport with presentation ANSI stripped, for structural row checks. */
function plainLines(vt: VirtualTerminal): string[] {
  return vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, ''))
}

/** The painted frame's physical row count. */
function frameHeight(view: string): number {
  const bounds = frameBounds(view)
  assert.ok(bounds !== undefined, `frame borders missing:\n${view}`)
  return bounds.bottom - bounds.top + 1
}

test('a structured edit approval paints semantic sections, a readable floor and exact Copy', async () => {
  const { vt, app, copied } = startApp(80, 24)
  const raw = JSON.stringify({
    file_path: 'src/config.ts',
    old_string: 'const timeout = 30',
    new_string: 'const timeout = 60',
  })
  const decision = app.showApprovalPrompt({
    toolName: 'edit',
    reason: 'Update the connection timeout',
    arguments: raw,
  })
  const view = await viewport(vt)
  assertSheetIntact(view)
  assert.ok(frameHeight(view) >= 12, `80x24 keeps a readable minimum:\n${view}`)
  const grant = (app as unknown as { approvalSeatRows(expanded: boolean): number }).approvalSeatRows(false)
  assert.ok(frameHeight(view) <= grant,
    `the readable minimum never exceeds the live seat grant (${frameHeight(view)} > ${grant}):\n${view}`)
  assert.match(view, /Action[\s\S]*Replace text/u)
  assert.match(view, /Target[\s\S]*src\/config\.ts/u)
  assert.match(view, /Reason[\s\S]*Update the connection timeout/u)
  assert.ok(!view.includes('{"file_path"'), `no raw JSON blob:\n${view}`)
  vt.sendInput('\x1b[F') // End
  const tail = await viewport(vt)
  assert.match(tail, /Before[\s\S]*const timeout = 30/u)
  assert.match(tail, /After[\s\S]*const timeout = 60/u)
  assert.match(tail, /Intended input · not verified against disk/u)
  vt.sendInput('c')
  await vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(copied, [raw], 'Copy carries the exact received bytes')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a short write at 120x40 gets the 16-row reading floor with inert padding', async () => {
  const { vt, app } = startApp(120, 40)
  const decision = app.showApprovalPrompt({
    toolName: 'write',
    reason: 'Persist the new timeout',
    arguments: JSON.stringify({ file_path: 'src/config.ts', content: 'export const timeout = 60' }),
  })
  const view = await viewport(vt)
  assertSheetIntact(view)
  assert.equal(frameHeight(view), 16, `120x40 short content keeps the 16-row floor:\n${view}`)
  assert.ok(!view.includes('rows '), `a short body must not invent a scroll fact:\n${view}`)
  assert.match(view, /Action[\s\S]*Write file/u)
  assert.match(view, /Target[\s\S]*src\/config\.ts/u)
  assert.match(view, /New content[\s\S]*export const timeout = 60/u)
  const lines = plainLines(vt)
  const valueRow = lines.findIndex(line => line.includes('export const timeout = 60'))
  const actionRow = lines.findIndex(line => line.includes('[y] Allow once'))
  assert.ok(valueRow >= 0 && actionRow > valueRow)
  const blankRows = lines.slice(valueRow + 1, actionRow).filter(line => /^│\s+│$/u.test(line))
  assert.ok(blankRows.length >= 2, `the frame is padded before the pinned action bar:\n${lines.join('\n')}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a long structured edit at 200x50 reaches the real tail with one body and a pinned bar', async () => {
  const { vt, app } = startApp(200, 50)
  const oldText = Array.from({ length: 80 }, (_, index) => `old-line-${String(index).padStart(3, '0')}`).join('\n')
  const newText = Array.from({ length: 80 }, (_, index) => `new-line-${String(index).padStart(3, '0')}`).join('\n')
  const decision = app.showApprovalPrompt({
    toolName: 'edit',
    reason: 'Rewrite the generated block',
    arguments: JSON.stringify({ file_path: 'src/generated.ts', old_string: oldText, new_string: newText }),
  })
  let view = await viewport(vt)
  assertSheetIntact(view)
  assert.ok(view.includes('old-line-000'), `the head is painted:\n${view}`)
  vt.sendInput('\x1b[F') // End
  view = await viewport(vt)
  assert.ok(view.includes('new-line-079'), `End reaches the real tail:\n${view}`)
  assert.ok(view.includes('rows '), `a real scroll fact is shown:\n${view}`)
  assert.ok(view.includes('[y] Allow once'), `the decision bar stays pinned:\n${view}`)
  const frameLines = plainLines(vt)
  assert.equal(frameLines.filter(line => line.includes('╭')).length, 1, 'one body, no second column')
  assert.equal(frameLines.filter(line => line.includes('╰')).length, 1)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('structured long paths and CJK wrap inside the grant and keep decisions reachable', async () => {
  for (const [columns, rows] of [[72, 24], [44, 20]] as const) {
    const { vt, app } = startApp(columns, rows)
    const path = `src/${'very-long-directory-segment/'.repeat(6)}配置文件.ts`
    const decision = app.showApprovalPrompt({
      toolName: 'write',
      reason: '记录超长的配置路径与中文内容，确认换行不会越过真实边框',
      arguments: JSON.stringify({ file_path: path, content: '旧内容'.repeat(40) + '\n' + '新内容'.repeat(40) }),
    })
    let view = await viewport(vt)
    assertSheetIntact(view)
    for (const line of plainLines(vt)) {
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows} overflows (${visibleWidth(line)}):\n${line}`)
    }
    assert.match(view, /Target/u)
    vt.sendInput('\x1b[F')
    view = await viewport(vt)
    assert.ok(view.includes('新内容'), `${columns}x${rows} End reaches the CJK tail:\n${view}`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
  // Below 24 terminal rows the sheet keeps its natural height instead of the floor.
  const { vt, app } = startApp(44, 20)
  const decision = app.showApprovalPrompt({ toolName: 'write', reason: 'short' })
  const view = await viewport(vt)
  assert.ok(frameHeight(view) < 12, `44x20 must not force the 12-row floor:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('short terminals keep the danger fact, a real reading row and honest structured degradation', async () => {
  for (const [columns, rows] of [[80, 10], [44, 10]] as const) {
    const { vt, app } = startApp(columns, rows)
    const decision = app.showApprovalPrompt({
      toolName: 'bash',
      reason: 'clean the workspace',
      arguments: JSON.stringify({ command: 'rm -rf /tmp/build-cache\nrm -rf ./dist\nnpm run build' }),
      danger: true,
    })
    const view = await viewport(vt)
    assertSheetIntact(view)
    assert.ok(view.includes('Dangerous command'), `${columns}x${rows} danger missing:\n${view}`)
    assert.ok(view.includes('Command') && view.includes('rm -rf /tmp/build-cache'),
      `${columns}x${rows} must show the real command text, not only its label:\n${view}`)
    assert.ok(view.includes('Resize') || view.includes('rows '), `${columns}x${rows} must state the reading limit:\n${view}`)
    assert.ok(!view.includes('…'), `${columns}x${rows} must not crop an action label:\n${view}`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
})

test('a short structured edit shows the proposed Before content before its metadata', async () => {
  const { vt, app } = startApp(80, 10)
  const decision = app.showApprovalPrompt({
    toolName: 'edit',
    reason: 'Update the timeout',
    arguments: JSON.stringify({ file_path: 'src/config.ts', old_string: 'const timeout = 30', new_string: 'const timeout = 60' }),
  })
  const view = await viewport(vt)
  assertSheetIntact(view)
  assert.ok(view.includes('Before') && view.includes('const timeout = 30'),
    `a short viewport must show the proposed content, not only its labels:\n${view}`)
  assert.match(view, /Intended input · not verified against disk/u)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})


test('generated approval summary values use the body text token under dark/light/custom', async () => {
  const cases = [
    ['dark', undefined],
    ['light', undefined],
    ['custom', { ...darkColors, text: '#123456' }],
  ] as const
  for (const [theme, custom] of cases) {
    setTheme(theme, custom)
    const { vt, app } = startApp(80, 24)
    const decision = app.showApprovalPrompt({
      toolName: 'edit',
      reason: 'token check',
      arguments: JSON.stringify({
        file_path: 'src/config.ts',
        old_string: 'old-value',
        new_string: 'new-value',
        replace_all: true,
      }),
    })
    await viewport(vt)
    vt.sendInput('\x1b[F') // End: paint the After / Replace all tail
    await vt.waitForRender()
    const stream = vt.writes.join('')
    assert.ok(stream.includes(color.text('Replace text')),
      `${theme}: the generated Action summary must use color.text`)
    assert.ok(stream.includes(color.text('Yes')),
      `${theme}: the generated Replace all value must use color.text`)
    assert.ok(!stream.includes(color.text('src/config.ts')),
      `${theme}: the raw Target must keep the default ink`)
    assert.ok(!stream.includes(color.text('old-value')) && !stream.includes(color.text('new-value')),
      `${theme}: the raw Before/After must keep the default ink`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
  setTheme('dark')
})

test('compact inline labels are dim and generated compact values use color.text', async () => {
  setTheme('dark')
  const { vt, app } = startApp(80, 10)
  const decision = app.showApprovalPrompt({
    toolName: 'bash',
    arguments: JSON.stringify({ command: 'ls' }),
  })
  const view = await viewport(vt)
  assert.ok(view.includes('Command: ls') && view.includes('Action: Run command'),
    `compact sections missing:\n${view}`)
  const stream = vt.writes.join('')
  assert.ok(stream.includes(color.textDim('Command: ')),
    'the compact raw-payload label is painted with the heading role')
  assert.ok(stream.includes(color.text('Run command')),
    'the compact generated Action value uses color.text')
  assert.ok(!stream.includes(color.text('ls')),
    'the compact raw command keeps the default ink')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a compact generic or raw argument payload outranks the reason at 44x10', async () => {
  const cases = [
    {
      name: 'generic object',
      tool: 'custom_tool',
      raw: JSON.stringify({ alpha: 'VALUE-A', beta: 'VALUE-B', gamma: 'VALUE-C' }),
      marker: 'VALUE-A',
    },
    { name: 'raw fallback', tool: 'bash', raw: 'raw line one\nraw line two\nRAW-TAIL', marker: 'raw line one' },
  ] as const
  for (const entry of cases) {
    const { vt, app } = startApp(44, 10)
    const decision = app.showApprovalPrompt({
      toolName: entry.tool,
      reason: 'read carefully',
      arguments: entry.raw,
    })
    const view = await viewport(vt)
    assertSheetIntact(view)
    assert.ok(view.includes('Arguments:') && view.includes(entry.marker),
      `${entry.name}: the compact body must show the actual payload before the reason:\n${view}`)
    assert.ok(view.includes('Resize'), `${entry.name}: the honest resize fact stays visible:\n${view}`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
})

test('hostile structured arguments never reach the terminal and Copy stays byte-exact', async () => {
  const { vt, app, copied } = startApp(80, 24)
  const raw = JSON.stringify({
    file_path: 'src/config.ts',
    old_string: 'safe',
    new_string: 'evil\u001b[31mred\u001b]0;pwned\u0007text',
  })
  const decision = app.showApprovalPrompt({
    toolName: 'edit',
    reason: 'hostile body',
    arguments: raw,
    danger: true,
  })
  const view = await viewport(vt)
  const stream = vt.writes.join('')
  assert.ok(!stream.includes('pwned'), 'the OSC payload never reaches the terminal stream')
  assert.ok(!stream.includes('\u009b'), 'no raw C1 byte reaches the terminal stream')
  assert.ok(!view.includes('\u001b'), 'the painted view carries no raw ESC')
  assert.match(view, /Target[\s\S]*src\/config\.ts/u)
  vt.sendInput('c')
  await vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(copied, [raw], 'Copy returns the exact received JSON bytes')
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('fullscreen padding rows are inert and a padding change fences the press', async () => {
  const { vt, app } = startApp(120, 40)
  app.setFullscreen(true)
  await vt.waitForRender()
  const decision = app.showApprovalPrompt({
    toolName: 'write',
    reason: 'padded',
    arguments: JSON.stringify({ file_path: 'src/config.ts', content: 'export const timeout = 60' }),
  })
  let view = await viewport(vt)
  assert.equal(frameHeight(view), 16, `the 120x40 floor is painted:\n${view}`)
  const allow = actionCell(view, '[y] Allow once')
  // A blank padding row two rows above the pinned bar is inert.
  press(vt, { x: 3, y: allow.y - 2 })
  release(vt, { x: 3, y: allow.y - 2 })
  await vt.waitForRender()
  let settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'a padding row is not a decision target')
  // A real press, then a resize that changes the padding/layout, then release.
  press(vt, allow)
  vt.resize(100, 32)
  await vt.waitForRender()
  view = await viewport(vt)
  release(vt, actionCell(view, '[y] Allow once'))
  await vt.waitForRender()
  settled = false
  void decision.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'a padding/layout change between press and release invalidates the click')
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
})

test('tiny hostile identities keep the truthful resize row and never paint an invisible action', async () => {
  for (const [columns, rows] of [[16, 8], [10, 24]] as const) {
    const { vt, app } = startApp(columns, rows)
    const decision = app.showApprovalPrompt({
      toolName: `ba\u001b[31msh\u001b]0;pwned\u0007${'x'.repeat(40)}`,
      reason: 'hostile tiny',
      arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }),
      danger: true,
    })
    const view = await viewport(vt)
    assert.ok(view.includes('Resize'), `${columns}x${rows} must advertise the honest resize fact:\n${view}`)
    assert.ok(view.includes('⚠'), `${columns}x${rows} must keep the danger fact:\n${view}`)
    assert.ok(!view.includes('[y]'), `${columns}x${rows} must not paint a decision it cannot show:\n${view}`)
    const stream = vt.writes.join('')
    assert.ok(!stream.includes('pwned'), `${columns}x${rows} leaked the OSC payload:\n${stream}`)
    assert.ok(!view.includes('\u001b'), `${columns}x${rows} painted a raw ESC:\n${view}`)
    vt.sendInput('n')
    assert.equal(await decision, 'rejected')
    app.dispose()
    startedApps.delete(app)
  }
})
