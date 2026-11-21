/**
 * Local-shell card display policy: strict identity, the compact folded card
 * (header + `$ command` + one settled outcome row), the existing Ctrl+O
 * expansion to the retained bounded body, Alt+K dismissal, and the
 * terminal-text projection.
 * @module @xmoon76/dsh-pi-tui/local-shell-card.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { isLocalShellCard } from '../../src/tui/components/transcript/local-shell-card.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

test('isLocalShellCard recognizes only the unbounded-turn shell card', () => {
  assert.equal(isLocalShellCard({ kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell', args: 'ls', result: '', status: 'running' }), true)
  // A session tool card carries a real turn number.
  assert.equal(isLocalShellCard({ kind: 'tool', turn: 3, name: 'shell', args: 'ls', result: '', status: 'running' }), false)
  assert.equal(isLocalShellCard({ kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'bash', args: 'ls', result: '', status: 'running' }), false)
  assert.equal(isLocalShellCard({ kind: 'assistant', turn: 0, text: 'hi' }), false)
})

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

function startApp(width = 80, height = 40): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

test('a settled shell card folds to three physical rows: header, command, one outcome', async () => {
  const { vt, app } = startApp()
  const long = Array.from({ length: 30 }, (_, index) => `output line ${index}`).join('\n')
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: long, status: 'ok',
  })
  const view = await viewport(vt)
  assert.ok(view.includes('ls -la'), `the command row must show:\n${view}`)
  assert.ok(view.includes('output line 29'), `the newest outcome fact must show:\n${view}`)
  assert.ok(!view.includes('output line 28'), `only ONE retained outcome row may paint:\n${view}`)
  assert.ok(!view.includes('output line 0'), `the long body stays folded:\n${view}`)
})

test('a running shell card paints no output and no fake terminal rows', async () => {
  const { vt, app } = startApp()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'sleep 30', result: 'stale streamed bytes', status: 'running',
  })
  const view = await viewport(vt)
  assert.ok(view.includes('sleep 30'), `the command row must show while running:\n${view}`)
  assert.ok(!view.includes('stale streamed bytes'), `a running card must not paint fake output:\n${view}`)
})

test('Ctrl+O expands the retained bounded body and collapses it again', async () => {
  const { vt, app } = startApp(80, 60)
  const long = Array.from({ length: 30 }, (_, index) => `output line ${index}`).join('\n')
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: long, status: 'ok',
  })
  let view = await viewport(vt)
  assert.ok(!view.includes('output line 0'), `precondition: the card starts folded:\n${view}`)
  vt.sendInput('\x0f')
  view = await viewport(vt)
  assert.ok(view.includes('output line 0'), `Ctrl+O must reveal the retained body:\n${view}`)
  vt.sendInput('\x0f')
  view = await viewport(vt)
  assert.ok(!view.includes('output line 0'), `Ctrl+O must fold it again:\n${view}`)
})

test('40 and 80 columns keep every compact row inside the width', async () => {
  const { vt, app } = startApp(40, 40)
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo 中文结果 and a long trailing command', result: 'first\n[exit 0]', status: 'ok',
  })
  for (const width of [40, 80]) {
    vt.resize(width, 40)
    const view = await viewport(vt)
    for (const row of view.split('\n')) {
      if (!row.includes('echo') && !row.includes('[exit 0]')) continue
      assert.ok(visibleWidth(row) <= width, `row overflows ${width} columns: ${JSON.stringify(row)}`)
    }
  }
  app.stop()
})

test('Alt+K dismisses settled shell cards but never a running one', async () => {
  const { vt, app } = startApp()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'done', result: '[exit 0]', status: 'ok',
  })
  const running = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'live', result: '', status: 'running',
  })
  await viewport(vt)
  vt.sendInput('\x1bk') // Alt+K (ESC k)
  const view = await viewport(vt)
  assert.ok(!view.includes('[exit 0]'), `the settled card must be dismissed:\n${view}`)
  assert.ok(view.includes('live'), `the running card must survive dismiss:\n${view}`)
  // The running card later settles; the next Alt+K takes it too.
  app.updateLocalMessage(running, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'live', result: '[exit 0]', status: 'ok',
  })
  vt.sendInput('\x1bk')
  const after = await viewport(vt)
  assert.ok(!after.includes('live'), `the newly settled card must dismiss on the next Alt+K:\n${after}`)
  app.stop()
})

test('a hostile local shell result reaches the TTY as safe text, keeping only whitelisted SGR', async () => {
  const { vt, app } = startApp(80, 60)
  const hostile = 'ok '
    + '\u001b]52;c;YXR0YWNr\u0007' // clipboard OSC 52
    + '\u001b[?1049h' // alternate screen
    + '\u001b[2J' // clear
    + '\u001b[38;2;999;1;1m' // malformed SGR
    + '\u001b[38;5;196mred\u001b[0m' // whitelisted SGR
    + '\r10%\r100%\n'
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'run', result: hostile, status: 'ok',
  })
  await viewport(vt)
  // The retained body is reachable through the card's own expansion.
  vt.sendInput('\x0f')
  const view = await viewport(vt)
  const stream = vt.writes.join('')
  assert.ok(!stream.includes('YXR0YWNr'), 'no OSC 52 clipboard payload reaches the terminal stream')
  assert.ok(!stream.includes('\u001b[38;2;999;1;1m'), 'the malformed SGR is never forwarded')
  assert.ok(stream.includes('\u001b[38;5;196m'), 'the whitelisted 256-color SGR survives the log projection')
  assert.ok(view.includes('10%') && view.includes('100%'), `CR frames read as distinct records:\n${view}`)
  assert.ok(view.includes('red'), 'the readable text survives')
  app.stop()
})

test('the 32-card settled retention evicts only the oldest settled cards', async () => {
  const { vt, app } = startApp()
  for (let index = 0; index < 33; index += 1) {
    app.pushLocalMessage({
      kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
      args: `card-${index}`, result: `[exit ${index}]`, status: 'ok',
    })
  }
  const running = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'still-running', result: '', status: 'running',
  })
  await viewport(vt)
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('card-0'), `the oldest settled card is evicted:\n${view}`)
  assert.ok(view.includes('[exit 32]'), 'the newest settled card survives')
  assert.ok(view.includes('still-running'), 'a running card is never evicted')
  app.updateLocalMessage(running, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'still-running', result: '[exit 99]', status: 'ok',
  })
  // Settling after eviction must not resurrect card-0.
  assert.ok(!(await viewport(vt)).includes('card-0'), 'an evicted card never revives')
  app.stop()
})

test('two shell cards keep their accepted order even when the Host settles them in reverse', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'main answer' }])
  await viewport(vt)
  const first = app.captureLocalShellPlacement()
  const cardA = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo A', result: '', status: 'running',
  }, first)
  const second = app.captureLocalShellPlacement()
  const cardB = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo B', result: '', status: 'running',
  }, second)
  // B settles first, then A: the DISPLAY order stays acceptance order.
  app.updateLocalMessage(cardB, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo B', result: '[exit 0]', status: 'ok',
  })
  app.updateLocalMessage(cardA, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo A', result: '[exit 0]', status: 'ok',
  })
  const view = await viewport(vt)
  const rowA = view.split('\n').findIndex(line => line.includes('Shell echo A'))
  const rowB = view.split('\n').findIndex(line => line.includes('Shell echo B'))
  assert.ok(rowA >= 0 && rowB >= 0, `both cards must render:\n${view}`)
  assert.ok(rowA < rowB, `accepted order A → B must survive reverse settlement:\n${view}`)
  app.stop()
})

test('settling a shell card while browsing history never jumps the fullscreen viewport to the end', async () => {
  const { vt, app } = startApp(80, 20)
  app.setFullscreen(true)
  app.setTranscript(Array.from({ length: 40 }, (_, index) => ({
    kind: 'assistant' as const, turn: index, text: `history row ${index}`,
  })))
  await viewport(vt)
  app.scrollToTop({ disableFollow: true })
  await viewport(vt)
  const history = app.fullscreenScrollForTest()
  assert.ok(history !== undefined && history.isFollowingEnd === false, 'precondition: history browsing')
  const placement = app.captureLocalShellPlacement()
  const card = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo history', result: '', status: 'running',
  }, placement)
  app.updateLocalMessage(card, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo history', result: '[exit 0]', status: 'ok',
  })
  await viewport(vt)
  const settled = app.fullscreenScrollForTest()!
  assert.equal(settled.isFollowingEnd, false, 'history browsing must not be re-armed by a settle')
  assert.ok(settled.scrollTop < settled.maxScrollTop, 'the viewport must not jump to the end')

  // A viewer that is following the live tail keeps following it.
  app.scrollToBottom()
  await viewport(vt)
  assert.equal(app.fullscreenScrollForTest()?.isFollowingEnd, true)
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo tail', result: '[exit 0]', status: 'ok',
  })
  await viewport(vt)
  assert.equal(app.fullscreenScrollForTest()?.isFollowingEnd, true, 'follow-end stays armed')
  app.stop()
})

test('a regroup that replaces the captured source row keeps the card before the held-back final', async () => {
  const folder = new TranscriptFolder()
  const time = Date.now() - 60_000
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: time + seq, data }) as SessionEvent
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('regroup-user'), role: 'user',
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }, 1),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('regroup-first'), role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 2),
    event('assistant/message', {
      turn: 0, step: 1,
      message: {
        id: MessageId('regroup-final'), role: 'assistant',
        content: [{ type: 'text', text: 'FINAL_AFTER_REGROUP' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 3),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4),
  ])
  const { vt, app } = startApp(80, 40)
  // The captured anchor is a DIFFERENT object from the folder's source row:
  // this models a regroup/tombstone that replaced the original identity.
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'first answer' }])
  await viewport(vt)
  const placement = app.captureLocalShellPlacement()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo regrouped', result: '[exit 0]', status: 'ok',
  }, placement)
  app.setTranscript(folder.messages(), folder.turnActivities())
  const view = await viewport(vt)
  const shellRow = view.split('\n').findIndex(line => line.includes('echo regrouped'))
  const finalRow = view.split('\n').findIndex(line => line.includes('FINAL_AFTER_REGROUP'))
  assert.ok(shellRow >= 0 && finalRow >= 0, `rows missing:\n${view}`)
  assert.ok(shellRow < finalRow, `the fallback must not attach the card after the final:\n${view}`)
  app.stop()
})

test('a shell accepted while browsing history waits for the latest window and anchors once', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'assistant', turn: 1, text: 'old history' },
    { kind: 'assistant', turn: 2, text: 'last history row' },
  ], undefined, { mode: 'history', endTurn: 1, firstTurn: 1, lastTurn: 2, hasNewer: true })
  await viewport(vt)
  const placement = app.captureLocalShellPlacement()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo deferred', result: '[exit 0]', status: 'ok',
  }, placement)
  assert.ok(!(await viewport(vt)).includes('echo deferred'), 'the history page must not show the deferred card')

  const latest = [{ kind: 'assistant', turn: 3, text: 'latest answer' } as const]
  app.setTranscript([...latest], undefined, { mode: 'latest' })
  let view = await viewport(vt)
  assert.ok(view.includes('Shell echo deferred'), `the card must materialize in the latest window:\n${view}`)
  // The anchor is frozen ONCE: later content appends after it, never before.
  app.setTranscript([...latest, { kind: 'assistant', turn: 4, text: 'after anchor' }])
  view = await viewport(vt)
  const shellRow = view.split('\n').findIndex(line => line.includes('Shell echo deferred'))
  const afterRow = view.split('\n').findIndex(line => line.includes('after anchor'))
  assert.ok(shellRow >= 0 && afterRow >= 0, `rows missing:\n${view}`)
  assert.ok(shellRow < afterRow, `the frozen anchor must not follow the tail:\n${view}`)
  app.stop()
})

test('a shell accepted before any source message renders at the session beginning', async () => {
  const { vt, app } = startApp()
  app.setTranscript([])
  await viewport(vt)
  const placement = app.captureLocalShellPlacement()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo first', result: '[exit 0]', status: 'ok',
  }, placement)
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'later answer' }])
  const view = await viewport(vt)
  const shellRow = view.split('\n').findIndex(line => line.includes('Shell echo first'))
  const answerRow = view.split('\n').findIndex(line => line.includes('later answer'))
  assert.ok(shellRow >= 0 && answerRow >= 0, `rows missing:\n${view}`)
  assert.ok(shellRow < answerRow, `a no-source shell stays at the beginning:\n${view}`)
  app.stop()
})

test('a long failed summary with the expand hint stays exactly three rows at 40 columns', async () => {
  const { vt, app } = startApp(40, 30)
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'make very-long-diagnostic',
    // Two body records make the retained body genuinely larger than the
    // single summary row, so the expand hint is actually attempted.
    result: `failed: ${'x'.repeat(300)}\nsecond diagnostic record`,
    status: 'error',
  })
  const view = await viewport(vt)
  const lines = view.split('\n')
  const header = lines.findIndex(line => line.includes('Shell make very-long'))
  assert.ok(header >= 0, `shell header missing:\n${view}`)
  const block = lines.slice(header, header + 3)
  assert.ok(block[1]?.includes('$ make very-long-diagnostic'), `command row missing:\n${view}`)
  assert.ok(block[2]?.includes('failed:'), `summary row missing:\n${view}`)
  assert.ok(block[2]?.includes('to expand'), `the expand hint must share the summary row:\n${view}`)
  for (const row of block) assert.ok(visibleWidth(row) <= 40, `folded row exceeds 40 columns: ${JSON.stringify(row)}`)
  assert.ok(!lines[header + 3]?.includes('xxxx') && !lines[header + 3]?.includes('to expand'),
    `the summary + hint must not wrap into a fourth row:\n${view}`)
  app.stop()
})

test('two shell cards with different anchors folded into one Work keep accepted order', async () => {
  const { vt, app } = startApp(80, 40)
  const tool1 = {
    kind: 'tool' as const, turn: 0, name: 'bash',
    args: JSON.stringify({ command: 'first-tool' }), result: 'FIRST', status: 'ok' as const,
  }
  const tool2 = {
    kind: 'tool' as const, turn: 0, name: 'bash',
    args: JSON.stringify({ command: 'second-tool' }), result: 'SECOND', status: 'ok' as const,
  }
  app.setTranscript([tool1])
  await viewport(vt)
  const first = app.captureLocalShellPlacement()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo A', result: '[exit 0]', status: 'ok',
  }, first)
  app.setTranscript([tool1, tool2])
  await viewport(vt)
  const second = app.captureLocalShellPlacement()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo B', result: '[exit 0]', status: 'ok',
  }, second)

  app.setDisplayPreset('compact')
  await viewport(vt)
  const collapsed = vt.getViewport().join('\n')
  assert.ok(collapsed.includes('Activity'), `precondition: collapsed Work header:\n${collapsed}`)
  const rowA = collapsed.split('\n').findIndex(line => line.includes('Shell echo A'))
  const rowB = collapsed.split('\n').findIndex(line => line.includes('Shell echo B'))
  assert.ok(rowA >= 0 && rowB >= 0 && rowA < rowB,
    `different anchors in one collapsed Work must keep acceptance order:\n${collapsed}`)

  vt.sendInput('\x0f')
  await vt.waitForRender()
  const expanded = vt.getViewport().join('\n')
  const expandedA = expanded.split('\n').findIndex(line => line.includes('Shell echo A'))
  const expandedB = expanded.split('\n').findIndex(line => line.includes('Shell echo B'))
  assert.ok(expandedA >= 0 && expandedB >= 0 && expandedA < expandedB,
    `the same order must hold when the Work expands:\n${expanded}`)
  app.stop()
})

test('a long command keeps the status pill visible on the folded and expanded shell header', async () => {
  const { vt, app } = startApp(40, 30)
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: `echo ${'z'.repeat(200)}`,
    result: 'failed: boom\nsecond diagnostic record',
    status: 'error',
  })
  const folded = await viewport(vt)
  const foldedLines = folded.split('\n')
  const foldedHeader = foldedLines.findIndex(line => line.includes('Shell echo'))
  assert.ok(foldedHeader >= 0, `folded header missing:\n${folded}`)
  assert.ok(foldedLines[foldedHeader]!.includes('[error]'),
    `the status pill must survive a long command in the folded header:\n${folded}`)
  assert.ok(visibleWidth(foldedLines[foldedHeader]!) <= 40, `folded header exceeds 40 columns:\n${folded}`)

  vt.sendInput('\x0f')
  await vt.waitForRender()
  const expanded = vt.getViewport()
  const expandedHeader = expanded.findIndex(line => line.includes('Shell echo'))
  assert.ok(expandedHeader >= 0, `expanded header missing:\n${expanded.join('\n')}`)
  assert.ok(expanded[expandedHeader]!.includes('[error]'),
    `the status pill must survive a long command in the expanded header:\n${expanded.join('\n')}`)
  assert.ok(visibleWidth(expanded[expandedHeader]!) <= 40,
    `expanded header exceeds 40 columns:\n${expanded.join('\n')}`)
  app.stop()
})

test('a beginning shell card materializes only on the window that contains the Session start', async () => {
  const { vt, app } = startApp()
  app.setTranscript([])
  await viewport(vt)
  const placement = app.captureLocalShellPlacement()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo beginning', result: '[exit 0]', status: 'ok',
  }, placement)

  // A mid-history page does NOT contain the Session beginning.
  app.setTranscript([{ kind: 'assistant', turn: 5, text: 'middle page' }], undefined, {
    mode: 'history', firstTurn: 5, lastTurn: 5, hasOlder: true, hasNewer: false,
  })
  assert.ok(!(await viewport(vt)).includes('echo beginning'), 'a non-start history page must not materialize the beginning card')

  // The oldest page really starts at the Session beginning: materialize.
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'oldest page' }], undefined, {
    mode: 'history', firstTurn: 1, lastTurn: 1, hasOlder: false, hasNewer: true,
  })
  assert.ok((await viewport(vt)).includes('Shell echo beginning'), 'the oldest page restores the beginning card')

  // Leaving and returning to the oldest page keeps the fixed beginning spot.
  app.setTranscript([{ kind: 'assistant', turn: 6, text: 'later page' }], undefined, {
    mode: 'history', firstTurn: 6, lastTurn: 6, hasOlder: true, hasNewer: false,
  })
  assert.ok(!(await viewport(vt)).includes('echo beginning'), 'the beginning card stays absent on later pages')
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'oldest page' }], undefined, {
    mode: 'history', firstTurn: 1, lastTurn: 1, hasOlder: false, hasNewer: true,
  })
  assert.ok((await viewport(vt)).includes('Shell echo beginning'), 'returning to the oldest page restores it exactly once')
  app.stop()
})

test('a retained card records a failed Session submission without falsifying the Host result', async () => {
  const { vt, app } = startApp(40, 30)
  const card = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo hello', result: 'hello\n[exit 0]', status: 'ok',
  })
  app.setLocalShellSubmissionState(card, {
    kind: 'uncertain',
    reason: 'shell session write result is indeterminate — do not retry automatically',
  })
  const folded = await viewport(vt)
  const foldedLines = folded.split('\n')
  const header = foldedLines.findIndex(line => line.includes('Shell echo hello'))
  assert.ok(header >= 0, `folded shell header missing:\n${folded}`)
  assert.ok(foldedLines[header]!.includes('[ok]'), `the Host execution result stays truthful:\n${folded}`)
  assert.ok(foldedLines[header + 2]!.includes('submission uncertain'),
    `the folded card must carry the persistent submission state:\n${folded}`)
  assert.ok(!foldedLines[header + 2]!.includes('do not retry'), 'the full reason belongs to the expanded body')
  assert.ok(visibleWidth(foldedLines[header + 2]!) <= 40, `the marker row must stay inside 40 columns:\n${folded}`)

  vt.sendInput('\x0f')
  await vt.waitForRender()
  const expanded = vt.getViewport().join('\n')
  const expandedText = expanded.replace(/\s+/gu, ' ')
  assert.ok(expandedText.includes('Session submission uncertain — do not retry automatically'),
    `the expanded card must state the uncertainty and no-retry rule:\n${expanded}`)
  assert.ok(expandedText.includes('shell session write result is indeterminate'),
    `the expanded card must keep the writer reason:\n${expanded}`)

  // A committed / not-attempted card has no failure marker.
  const plain = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'echo plain', result: 'plain\n[exit 0]', status: 'ok',
  })
  assert.equal(app.removeLocalMessage(plain), true)
  app.stop()
})
