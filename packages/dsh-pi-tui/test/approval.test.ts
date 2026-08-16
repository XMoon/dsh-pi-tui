/**
 * Headless tests for the approval dialog: overlay rendering, y/n/esc
 * decisions, FIFO queueing, and abort withdrawal.
 * @module @xmoon76/dsh-pi-tui/approval.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp, type ApprovalOutcome } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

/** The visible viewport joined for substring assertions. */
async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('approval prompt shows an overlay describing the tool', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  const view = await viewport(vt)
  assert.ok(view.includes('Approve bash?'), `dialog missing:\n${view}`)
  assert.ok(view.includes('run a command'), `reason missing:\n${view}`)
  assert.ok(view.includes('[y] allow once'), `key hints missing:\n${view}`)
  assert.ok(decision instanceof Promise)
})

test('y allows once and closes the dialog', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve bash'), `dialog still visible:\n${view}`)
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

test('ctrl+c cancels the prompt like escape', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  vt.sendInput('\x03') // ctrl+c
  assert.equal(await decision, 'cancelled')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve bash'), `dialog still visible:\n${view}`)
})

test('prompts queue FIFO and consume all keys while showing', async () => {
  const { vt, app } = startApp()
  const first = app.showApprovalPrompt({ toolName: 'bash' })
  const second = app.showApprovalPrompt({ toolName: 'fs' })
  await viewport(vt)
  vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  const secondView = await viewport(vt)
  assert.ok(secondView.includes('Approve fs'), `second dialog missing:\n${secondView}`)
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
  assert.ok(!view.includes('Approve bash'), `dialog still visible:\n${view}`)
  void vt
})

test('an already-aborted signal settles immediately without hanging', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  controller.abort()
  const decision = app.showApprovalPrompt({ toolName: 'bash', signal: controller.signal })
  // Must settle, never hang: a cancelled request needs no dialog at all.
  assert.equal(await decision, 'cancelled')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve bash'), `dialog must not appear:\n${view}`)
  void vt
})

test('a queued prompt aborted while waiting never reaches the screen', async () => {
  const { vt, app } = startApp()
  const first = app.showApprovalPrompt({ toolName: 'bash' })
  const secondController = new AbortController()
  const second = app.showApprovalPrompt({ toolName: 'fs', signal: secondController.signal })
  await viewport(vt)
  // The turn is cancelled while the fs prompt is still queued: its signal
  // aborts, but no stale dialog may pop after the first prompt settles.
  secondController.abort()
  vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  assert.equal(await second, 'cancelled')
  const view = await viewport(vt)
  assert.ok(!view.includes('Approve fs'), `stale queued dialog popped:\n${view}`)
})

test('editor input is blocked while a prompt is showing', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} })
  app.start()
  const decision = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  vt.sendInput('hello')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, [])
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
})

test('todo summary reflects active and completed items in the header', async () => {
  const { vt, app } = startApp()
  app.setTodoSummary([{ content: 'fix the tests', status: 'in_progress' }, { content: 'ship it', status: 'pending' }])
  let view = await viewport(vt)
  assert.ok(view.includes('2 active · fix the tests'), `header missing:
${view}`)
  app.setTodoSummary([{ content: 'fix the tests', status: 'completed' }])
  view = await viewport(vt)
  assert.ok(view.includes('1 todo done'), `header missing:
${view}`)
  app.setTodoSummary([])
  view = await viewport(vt)
  assert.ok(view.includes('dsh-pi-tui'), `header missing:
${view}`)
})

test('approval prompt previews arguments and flags dangerous commands', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({
    toolName: 'bash',
    arguments: 'rm -rf /home/user/backup',
    danger: true,
  })
  const view = await viewport(vt)
  assert.ok(view.includes('DANGEROUS'), `danger banner missing:\n${view}`)
  assert.ok(view.includes('rm -rf /home/user/backup'), `argument preview missing:\n${view}`)
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
})

test('approval prompt truncates long argument previews to six lines', async () => {
  const { vt, app } = startApp()
  const lines = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n')
  app.showApprovalPrompt({ toolName: 'bash', arguments: lines })
  const view = await viewport(vt)
  assert.ok(view.includes('line-0'), `preview start missing:\n${view}`)
  assert.ok(!view.includes('line-11'), `preview not truncated:\n${view}`)
})

test('approval dialog fits narrow terminals: hints and bottom border survive', async () => {
  // The reported bug: on a ~62-col terminal the fixed 60-wide box left
  // base-content slivers glued to the border AND the maxHeight slice cut
  // the key hints and the bottom border. The dialog now spans the full
  // width and budgets its height so the hints always render.
  const vt = new VirtualTerminal(62, 17)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const args = '{"content":"# dsh-pi-tui documentation\\n\\nThis directory is the home for everything that needs more than a paragraph:\\ndesign rationale, hard-won contracts, operational procedures, and measured\\ndata. The root `AGENTS.md` stays the *operati…'
  const decision = app.showApprovalPrompt({
    toolName: 'write',
    arguments: args,
    reason: 'escalate sandbox to workspace-write: 用户要求整理重构 docs/ 与 AGENTS.md\n需要写入新文档和改写现有文档',
  })
  const view = await viewport(vt)
  const lines = view.split('\n')
  const top = lines.findIndex(line => line.includes('╭'))
  assert.ok(top >= 0, `dialog top border missing:\n${view}`)
  assert.ok(lines[top]!.startsWith('╭'), `border must start at column 0 (no base-content sliver):\n${view}`)
  assert.ok(view.includes('[y] allow once   [n] reject   [esc/ctrl+c] cancel'), `key hints sliced off:\n${view}`)
  assert.ok(view.includes('╰'), `bottom border sliced off:\n${view}`)
  assert.ok(view.includes('Approve write?'), `title missing:\n${view}`)
  assert.ok(view.includes('escalate sandbox to workspace-write'), `reason missing:\n${view}`)
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
})

test('approval dialog degrades gracefully on very small terminals', async () => {
  const vt = new VirtualTerminal(40, 12)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const decision = app.showApprovalPrompt({
    toolName: 'bash',
    arguments: 'rm -rf /tmp/whatever --force --recursive',
    reason: 'a reason that should still fit',
  })
  const view = await viewport(vt)
  assert.ok(view.includes('[y] allow once'), `key hints sliced off:\n${view}`)
  assert.ok(view.includes('╰'), `bottom border sliced off:\n${view}`)
  assert.ok(view.includes('Approve bash?'), `title missing:\n${view}`)
  assert.ok(view.includes('a reason that should still fit'), `reason missing:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('a long approval reason is capped so the key hints survive', async () => {
  const vt = new VirtualTerminal(62, 17)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const reason = Array.from({ length: 12 }, (_, i) => `reason line ${i}`).join('\n')
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason })
  const view = await viewport(vt)
  assert.ok(view.includes('[y] allow once'), `key hints sliced off:\n${view}`)
  assert.ok(view.includes('╰'), `bottom border sliced off:\n${view}`)
  assert.ok(view.includes('reason line 0'), `reason start missing:\n${view}`)
  assert.ok(!view.includes('reason line 11'), `reason must be capped:\n${view}`)
  vt.sendInput('\x1b') // escape
  assert.equal(await decision, 'cancelled')
})

test('long single-line arguments cannot push the hints off a small terminal', async () => {
  // The height budget must count WRAPPED rows: three 70-char argument
  // lines at a 32-col content width wrap to ~9 display rows, so a raw-line
  // budget would silently slice the hints and the bottom border.
  const vt = new VirtualTerminal(40, 12)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const lines = Array.from({ length: 3 }, () => 'x'.repeat(70)).join('\n')
  const decision = app.showApprovalPrompt({ toolName: 'bash', arguments: lines })
  const view = await viewport(vt)
  assert.ok(view.includes('[y] allow once'), `key hints sliced off:\n${view}`)
  assert.ok(view.includes('╰'), `bottom border sliced off:\n${view}`)
  assert.ok(view.includes('Approve bash?'), `title missing:\n${view}`)
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
})

test('a long single-line reason is wrap-cropped so the hints survive', async () => {
  // One 200-char reason line wraps to ~7 rows at a 32-col content width —
  // the budget must crop it (with an ellipsis) instead of losing the hints.
  const vt = new VirtualTerminal(40, 12)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const reason = 'y'.repeat(200)
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason })
  const view = await viewport(vt)
  assert.ok(view.includes('[y] allow once'), `key hints sliced off:\n${view}`)
  assert.ok(view.includes('╰'), `bottom border sliced off:\n${view}`)
  assert.ok(view.includes('…'), `truncation marker missing:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})

test('danger on a tiny terminal drops the reason, never the hints', async () => {
  // rows=10 -> maxHeight = max(8, min(16, 8)) = 8; the danger banner fills
  // the fixed chrome (7 + 1), leaving ZERO rows for the reason — it must be
  // skipped entirely (a stray '…' row would overflow and slice the border).
  const vt = new VirtualTerminal(40, 10)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'dangerous thing', danger: true })
  const view = await viewport(vt)
  assert.ok(view.includes('DANGEROUS'), `danger banner missing:\n${view}`)
  assert.ok(view.includes('[y] allow once'), `key hints sliced off:\n${view}`)
  assert.ok(view.includes('╰'), `bottom border sliced off:\n${view}`)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
})
