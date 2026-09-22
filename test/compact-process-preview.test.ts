/**
 * The shared compact process-preview authority (post-F6 plan §7/§8/§9):
 * Think latest-line selection, running right-edge follow, Tool status
 * prefix + active PTC child suffix + width degradation, the Preparing
 * summary, and Focus/Activity Think-slot equivalence.
 * @module @xmoon76/dsh-pi-tui/compact-process-preview.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  compactPreparingSummary,
  compactSlotLine,
  compactThinkSlotLine,
  compactToolSlotLine,
} from '../src/compact-process-preview.ts'
import { focusCollapsedBody } from '../src/focus-activity.ts'
import type { TurnActivity } from '../src/transcript.ts'

const WIDTH = 40

const think = (options: { text: string; running: boolean; width?: number }): string =>
  compactThinkSlotLine({ ...options, width: options.width ?? WIDTH })

test('Think: multiline running shows the LATEST line, not the frozen first line', () => {
  const line = think({ text: 'line 1\nline 2 streaming...\nline 3 streaming...', running: true })
  assert.ok(line.includes('line 3 streaming'), `the latest line is visible:\n${line}`)
  assert.ok(!line.includes('line 1'), `the first line is not frozen on:\n${line}`)
})

test('Think: a long running latest line follows its right edge', () => {
  const latest = `${'x'.repeat(80)}latest-token`
  const line = think({ text: `earlier line\n${latest}`, running: true })
  assert.ok(line.includes('latest-token'), `the window ends at the latest token:\n${line}`)
  assert.ok(!line.includes('earlier line'), `the previous line is not smuggled in:\n${line}`)
  // The whole row stays one physical row within the width.
  assert.ok(visibleWidth(line) <= WIDTH, `no wrap:\n${line}`)
})

test('Think: multiline settled keeps the latest line with head truncation', () => {
  const line = think({ text: 'first line\nsecond line\nthird conclusion', running: false })
  assert.ok(line.includes('third conclusion'), `settled reads the latest line:\n${line}`)
  assert.ok(!line.includes('first line'), 'the first line is not shown')
  const latest = `${'y'.repeat(60)}settled-tail-marker`
  const long = think({ text: `a\n${latest}`, running: false })
  assert.ok(long.startsWith('Think:'), `settled truncation starts at the HEAD of the line:\n${long}`)
  assert.ok(!long.includes('settled-tail-marker'), `the head-truncated line drops its far tail:\n${long}`)
  const runningSame = think({ text: `a\n${latest}`, running: true })
  assert.ok(runningSame.includes('settled-tail-marker'), `running follows the tail edge instead:\n${runningSame}`)
})

test('Think: a blank latest line falls back; an all-blank body has no fake placeholder', () => {
  const fallback = think({ text: 'real content\n\n', running: false })
  assert.ok(fallback.includes('real content'), `blank tail does not blank the row:\n${fallback}`)
  const blank = compactThinkSlotLine({ text: '\n \n\n', running: false, width: WIDTH })
  assert.equal(blank.trim(), 'Think:', `no fake placeholder content:\n${blank}`)
})

test('Think: CJK/wide content never wraps past the width', () => {
  const wide = '浏览器上下文的视口身份检查进行中'
  const line = compactThinkSlotLine({ text: `先前的推理\n${wide}${wide}`, running: true, width: 30 })
  assert.ok(visibleWidth(line) <= 30, `wide chars stay within the budget: ${visibleWidth(line)}`)
})

test('Tool: status prefix + active-child suffix semantics', () => {
  // root running, no child → no prefix.
  const running = compactToolSlotLine({ status: 'running', display: 'Code program', rootName: 'code', width: WIDTH })
  assert.ok(running.startsWith('Tool:'), 'running has no status prefix')
  assert.ok(running.includes('Code program'))
  // settled statuses keep their prefixes.
  assert.ok(compactToolSlotLine({ status: 'ok', display: 'Read a.ts', rootName: 'read', width: WIDTH }).includes('✓ Read a.ts'))
  assert.ok(compactToolSlotLine({ status: 'error', display: 'Read a.ts', rootName: 'read', width: WIDTH }).includes('✗ Read a.ts'))
  // one active child → `Bash running`.
  const one = compactToolSlotLine({ status: 'running', display: 'Code program', rootName: 'code', activeSubCalls: [{ name: 'bash', count: 1 }], width: WIDTH })
  assert.ok(one.includes('Bash running'), `one child:\n${one}`)
  // repeated same child type → `Bash ×2 running`.
  const repeated = compactToolSlotLine({ status: 'running', display: 'Code program', rootName: 'code', activeSubCalls: [{ name: 'bash', count: 2 }], width: WIDTH })
  assert.ok(repeated.includes('Bash ×2 running'), `repeated child:\n${repeated}`)
  // mixed types → first type + remaining count.
  const mixed = compactToolSlotLine({ status: 'running', display: 'Code program', rootName: 'code', activeSubCalls: [{ name: 'bash', count: 2 }, { name: 'read', count: 1 }], width: WIDTH })
  assert.ok(mixed.includes('Bash ×2 +1 running'), `mixed children:\n${mixed}`)
  // children settle → the suffix disappears.
  const settled = compactToolSlotLine({ status: 'ok', display: 'Code program', rootName: 'code', activeSubCalls: [], width: WIDTH })
  assert.ok(!settled.includes('running'), `no suffix after children settle:\n${settled}`)
})

test('Tool: narrow width keeps the active suffix before the root description', () => {
  const display = 'Code a-very-long-program-description-that-would-never-fit'
  const narrow = compactToolSlotLine({
    status: 'running',
    display,
    rootName: 'bash',
    activeSubCalls: [{ name: 'bash', count: 1 }],
    width: 30,
  })
  assert.ok(narrow.includes('Bash running'), `the active state survives degradation:\n${narrow}`)
  assert.ok(!narrow.includes(display), 'the long root description is degraded first')
  assert.ok(visibleWidth(narrow) <= 30, `no wrap:\n${narrow}`)
  const floor = compactToolSlotLine({ status: 'running', display, rootName: 'bash', activeSubCalls: [{ name: 'bash', count: 1 }], width: 10 })
  assert.ok(!floor.includes('running'), `below identity+suffix even the suffix yields:\n${floor}`)
})

test('Preparing: one shared summary authority', () => {
  assert.equal(compactPreparingSummary([]), undefined)
  assert.equal(compactPreparingSummary([{ index: 1, name: 'bash' }]), 'Preparing Bash…')
  assert.equal(compactPreparingSummary([{ index: 0 }, { index: 1, name: 'bash' }]), 'Preparing Bash +1')
  assert.equal(compactPreparingSummary([{ index: 0, name: 'unknown-tool' }, { index: 1, name: 'bash' }]), 'Preparing Bash +1')
})

test('Focus and Activity produce equivalent Think preview semantics', () => {
  const text = 'first line\nsecond line streaming tail'
  const activity = {
    think: { text, running: true },
    tool: { callId: 'c1', name: 'code', args: '{}', status: 'running' },
  } as unknown as TurnActivity
  const focusLines = focusCollapsedBody(activity, WIDTH, 'Code program')
  assert.ok(focusLines.length >= 2, `Focus renders the Think and Tool slots:\n${focusLines.join('\n')}`)
  const activityThink = compactThinkSlotLine({ text, running: true, width: WIDTH })
  assert.equal(focusLines[0], activityThink, 'the Focus Think slot consumes the SAME helper output')
  // The Tool slot shares the same geometry (status prefix, one row).
  const activityTool = compactToolSlotLine({ status: 'running', display: 'Code program', rootName: 'code', width: WIDTH })
  assert.equal(focusLines[1], activityTool, 'the Focus Tool slot matches the shared Tool slot line')
})

test('compactSlotLine keeps first-line normalization for non-Think slots', () => {
  const line = compactSlotLine('Tool:', 'first\nsecond', WIDTH)
  assert.ok(line.includes('first'))
  assert.ok(!line.includes('second'), 'non-Think slots never smuggle later lines')
})
