/**
 * The shared compact process-preview authority (post-F6 plan §7/§8/§9 +
 * presentation-convergence addendum v2): Think latest-line selection, running right-edge
 * follow, Action status prefix + active PTC child suffix + width
 * degradation, the Preparing summary, Focus/Activity Think-slot
 * equivalence, the shared Action classifier matrix, latest-candidate
 * chronology, the synthetic Action labels and the bounded cache signature.
 * @module @xmoon76/dsh-pi-tui/compact-process-preview.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  compactActionPresentation,
  compactActionSignature,
  compactActionStatParts,
  compactActionStatsOf,
  compactActionSlotLine,
  compactActionSourceOf,
  compactPreparingSummary,
  compactSlotLine,
  compactThinkSlotLine,
  latestCompactAction,
  type CompactActionPresentation,
} from '../src/compact-process-preview.ts'
import { focusCollapsedBody } from '../src/focus-activity.ts'
import type { TranscriptMessage, TranscriptToolMessage, TurnActivity } from '../src/transcript.ts'

const WIDTH = 40

const think = (options: { text: string; running: boolean; width?: number }): string =>
  compactThinkSlotLine({ ...options, width: options.width ?? WIDTH })

/** A minimal genuine tool row (origin absent → one call by definition). */
function toolMessage(overrides: Partial<TranscriptToolMessage> = {}): TranscriptToolMessage {
  return {
    kind: 'tool',
    turn: 1,
    name: 'read',
    args: '{"file_path":"src/a.ts"}',
    result: 'ok',
    status: 'ok',
    ...overrides,
  }
}

/** A minimal retry system row exactly as the fold produces it. */
function retryMessage(text = 'llm retry 2/6 in 3s — authentication failed'): Extract<TranscriptMessage, { kind: 'system' }> {
  return { kind: 'system', turn: 1, text, origin: 'llm-retry' }
}

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

test('Action: status prefix + active-child suffix semantics', () => {
  // root running, no child → no prefix.
  const running = compactActionSlotLine({ display: 'Code program', rootName: 'code', width: WIDTH })
  assert.ok(running.startsWith('Action:'), 'running has no status prefix')
  assert.ok(running.includes('Code program'))
  // settled statuses keep their prefixes.
  assert.ok(compactActionSlotLine({ status: 'ok', display: 'Read a.ts', rootName: 'read', width: WIDTH }).includes('✓ Read a.ts'))
  assert.ok(compactActionSlotLine({ status: 'error', display: 'Read a.ts', rootName: 'read', width: WIDTH }).includes('✗ Read a.ts'))
  // one active child → `Bash running`.
  const one = compactActionSlotLine({ display: 'Code program', rootName: 'code', activeSubCalls: [{ name: 'bash', count: 1 }], width: WIDTH })
  assert.ok(one.includes('Bash running'), `one child:\n${one}`)
  // repeated same child type → `Bash ×2 running`.
  const repeated = compactActionSlotLine({ display: 'Code program', rootName: 'code', activeSubCalls: [{ name: 'bash', count: 2 }], width: WIDTH })
  assert.ok(repeated.includes('Bash ×2 running'), `repeated child:\n${repeated}`)
  // mixed types → first type + remaining count.
  const mixed = compactActionSlotLine({ display: 'Code program', rootName: 'code', activeSubCalls: [{ name: 'bash', count: 2 }, { name: 'read', count: 1 }], width: WIDTH })
  assert.ok(mixed.includes('Bash ×2 +1 running'), `mixed children:\n${mixed}`)
  // children settle → the suffix disappears.
  const settled = compactActionSlotLine({ status: 'ok', display: 'Code program', rootName: 'code', activeSubCalls: [], width: WIDTH })
  assert.ok(!settled.includes('running'), `no suffix after children settle:\n${settled}`)
})

test('Action: narrow width keeps the active suffix before the root description', () => {
  const display = 'Code a-very-long-program-description-that-would-never-fit'
  const narrow = compactActionSlotLine({
    display,
    rootName: 'bash',
    activeSubCalls: [{ name: 'bash', count: 1 }],
    width: 30,
  })
  assert.ok(narrow.includes('Bash running'), `the active state survives degradation:\n${narrow}`)
  assert.ok(!narrow.includes(display), 'the long root description is degraded first')
  assert.ok(visibleWidth(narrow) <= 30, `no wrap:\n${narrow}`)
  const floor = compactActionSlotLine({ display, rootName: 'bash', activeSubCalls: [{ name: 'bash', count: 1 }], width: 10 })
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
  } as unknown as TurnActivity
  const action = compactActionPresentation({ kind: 'tool', message: toolMessage({ name: 'code', args: '{}', status: 'running' }) })
  const focusLines = focusCollapsedBody(activity, WIDTH, action)
  assert.ok(focusLines.length >= 2, `Focus renders the Think and Action slots:\n${focusLines.join('\n')}`)
  const activityThink = compactThinkSlotLine({ text, running: true, width: WIDTH })
  assert.equal(focusLines[0], activityThink, 'the Focus Think slot consumes the SAME helper output')
  // The Action slot shares the same geometry (status prefix, one row).
  const activityAction = compactActionSlotLine({ display: action.display, rootName: action.rootName, width: WIDTH })
  assert.equal(focusLines[1], activityAction, 'the Focus Action slot matches the shared Action slot line')
})

test('compactSlotLine keeps first-line normalization for non-Think slots', () => {
  const line = compactSlotLine('Action:', 'first\nsecond', WIDTH)
  assert.ok(line.includes('first'))
  assert.ok(!line.includes('second'), 'non-Think slots never smuggle later lines')
})

// ── Shared Action classifier matrix (addendum v2 §46) ────────────

test('classifier: genuine tool call -> tool', () => {
  assert.deepEqual(compactActionSourceOf(toolMessage())?.kind, 'tool')
})

test('classifier: grouped genuine tool card -> tool', () => {
  assert.deepEqual(compactActionSourceOf(toolMessage({ callCount: 3 }))?.kind, 'tool')
})

test('classifier: subagent-delegation -> subagent', () => {
  assert.deepEqual(compactActionSourceOf(toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'reviewer' }))?.kind, 'subagent')
})

test('classifier: command -> none (standalone session-level lifecycle)', () => {
  // DSH appends command/run + command/done as direct log-only events with NO
  // wrapping turn, and renders the settled result outside model history: a
  // command is never turn Process evidence, so it can never be an Action.
  assert.equal(compactActionSourceOf(toolMessage({ origin: 'command', name: '/compact' })), undefined)
})

test('classifier: llm-retry -> retry', () => {
  assert.deepEqual(compactActionSourceOf(retryMessage())?.kind, 'retry')
})

test('classifier: orphan result callCount=0 -> orphan-tool-result', () => {
  assert.deepEqual(compactActionSourceOf(toolMessage({ callCount: 0, args: '' }))?.kind, 'orphan-tool-result')
})

test('classifier: Thinking / Context / Workflow / Compaction -> none', () => {
  assert.equal(compactActionSourceOf({ kind: 'thinking', turn: 1, text: 'reasoning' }), undefined)
  assert.equal(compactActionSourceOf({ kind: 'system', turn: 1, text: 'reminder', context: true }), undefined)
  assert.equal(compactActionSourceOf({ kind: 'system', turn: 1, text: 'max tokens reached', origin: 'turn-max-tokens' }), undefined)
  assert.equal(compactActionSourceOf({ kind: 'assistant', turn: 1, text: 'narration' }), undefined)
  assert.equal(compactActionSourceOf({ kind: 'user', turn: 1, text: 'hi' }), undefined)
  assert.equal(compactActionSourceOf({ kind: 'compaction', turn: 1, text: 'summary', items: 1, tokens: 1 }), undefined)
  assert.equal(compactActionSourceOf(toolMessage({ origin: 'turn-error' })), undefined)
})

test('classifier: active/settled surfaced interaction -> none (externally owned)', () => {
  assert.equal(compactActionSourceOf(toolMessage({ name: 'ask_user_question', status: 'running' })), undefined)
  assert.equal(compactActionSourceOf(toolMessage({ name: 'exit_plan_mode', status: 'ok' })), undefined)
})

test('latest-selection: chronology owns selection, no type priority', () => {
  const messages: TranscriptMessage[] = [
    toolMessage({ name: 'read' }),
    toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'helper' }),
    retryMessage(),
    // A command row in the same stream is skipped: it is standalone evidence,
    // not a candidate.
    toolMessage({ origin: 'command', name: '/compact' }),
  ]
  assert.equal(latestCompactAction(messages)?.kind, 'retry')
  // The same rows in a different order select a different latest…
  assert.equal(latestCompactAction([messages[0]!, messages[1]!])?.kind, 'subagent')
  // …and a stream holding ONLY a command row has no candidate at all.
  assert.equal(latestCompactAction([messages[3]!]), undefined)
  // No eligible evidence -> undefined.
  assert.equal(latestCompactAction([{ kind: 'thinking', turn: 1, text: 'reasoning' }]), undefined)
  assert.equal(latestCompactAction([]), undefined)
})

// ── Shared Action presentations (addendum v2 §11) ─────────────────

test('presentation: genuine tool keeps presenter-first display and PTC suffix facts', () => {
  const message = toolMessage({ name: 'read', status: 'running' })
  const presentation = compactActionPresentation({ kind: 'tool', message })
  assert.equal(presentation.status, undefined, 'a running tool carries no prefix')
  assert.ok(presentation.display.includes('src/a.ts'), `fallback display renders the args:\n${presentation.display}`)
  assert.equal(presentation.rootName, 'read')
  const settled = compactActionPresentation({ kind: 'tool', message: toolMessage({ status: 'error' }) })
  assert.equal(settled.status, 'error')
})

test('presentation: subagent renders the durable label without a ✓ prefix', () => {
  const presentation = compactActionPresentation({
    kind: 'subagent',
    message: toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'Update command runner fixtures' }),
  })
  assert.equal(presentation.status, undefined, 'a descriptor record is a launch fact, never a completion')
  assert.equal(presentation.display, 'Subagent · Update command runner fixtures')
  const fallback = compactActionPresentation({
    kind: 'subagent',
    message: toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: '' }),
  })
  assert.equal(fallback.display, 'Subagent')
})

test('presentation: a command row has no Action presentation (standalone)', () => {
  const source = compactActionSourceOf(toolMessage({ origin: 'command', name: '/compact', status: 'ok' }))
  assert.equal(source, undefined, 'a command never becomes an Action source')
})

test('presentation: retry transforms the known producer label only', () => {
  const presentation = compactActionPresentation({ kind: 'retry', message: retryMessage() })
  assert.equal(presentation.status, undefined)
  assert.equal(presentation.display, 'Retry 2/6 in 3s · authentication failed')
  assert.equal(
    compactActionPresentation({ kind: 'retry', message: retryMessage('llm retry 4 in 9s — provider unavailable') }).display,
    'Retry 4 in 9s · provider unavailable',
  )
  // An upstream format change renders verbatim instead of being parsed.
  assert.equal(
    compactActionPresentation({ kind: 'retry', message: retryMessage('retry scheduled soon') }).display,
    'retry scheduled soon',
  )
})

test('presentation: orphan result renders the honest diagnostic', () => {
  assert.equal(
    compactActionPresentation({ kind: 'orphan-tool-result', message: toolMessage({ name: 'read', callCount: 0 }) }).display,
    'Unpaired Read result',
  )
  assert.equal(
    compactActionPresentation({ kind: 'orphan-tool-result', message: toolMessage({ name: '', callCount: 0 }) }).display,
    'Unpaired tool result',
  )
})

test('signature: bounded cache identity separates synthetic Action changes', () => {
  const base = compactActionPresentation({ kind: 'subagent', message: toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'scout' }) })
  const same = compactActionPresentation({ kind: 'subagent', message: toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'scout' }) })
  assert.equal(compactActionSignature(base), compactActionSignature(same))
  const changed = compactActionPresentation({ kind: 'subagent', message: toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'reviewer' }) })
  assert.notEqual(compactActionSignature(base), compactActionSignature(changed))
  assert.notEqual(compactActionSignature(base), compactActionSignature(undefined))
  const ptc = compactActionPresentation({
    kind: 'tool',
    message: toolMessage({ name: 'code', status: 'running' }),
  })
  const ptcSame = compactActionPresentation({
    kind: 'tool',
    message: toolMessage({ name: 'code', status: 'running' }),
  })
  assert.equal(compactActionSignature(ptc), compactActionSignature(ptcSame))
})

// ── ActionStats matrix (addendum v2 §47) ───────────────────────────────────

test('action stats: cardinality per source kind (v2 §47 example)', () => {
  const stats = compactActionStatsOf([
    toolMessage({ name: 'read', callCount: 2 }),
    toolMessage({ name: 'bash' }),
    toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'x' }),
    retryMessage(),
    toolMessage({ origin: 'command', name: '/compact', status: 'ok' }),
  ])
  assert.equal(stats.total, 5, 'a command row contributes nothing')
  assert.deepEqual(
    [...stats.types.entries()].sort(),
    [['bash', 1], ['read', 2], ['retry', 1], ['subagent', 1]].sort(),
  )
})

test('action stats: orphan, Preparing and surfaced interactions never increment', () => {
  assert.equal(compactActionStatsOf([toolMessage({ callCount: 0, args: '' })]).total, 0, 'an orphan result is diagnostic evidence')
  // Preparing never reaches the classifier at all (live-only rows are not
  // transcript messages) — the surfaced interaction is filtered by name.
  assert.equal(compactActionStatsOf([toolMessage({ name: 'ask_user_question', status: 'running' })]).total, 0)
  assert.equal(compactActionStatsOf([toolMessage({ name: 'exit_plan_mode', status: 'ok' })]).total, 0)
  assert.equal(compactActionStatsOf([{ kind: 'thinking', turn: 1, text: 'r' }]).total, 0)
})

test('action stats: subtype parts keep the shared sort/cap and +N counts kinds', () => {
  const stats = compactActionStatsOf([
    toolMessage({ name: 'read', callCount: 3 }),
    toolMessage({ name: 'bash', callCount: 2 }),
    retryMessage(),
    toolMessage({ origin: 'command', name: '/compact', status: 'ok' }),
    toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'x' }),
  ])
  assert.deepEqual(compactActionStatParts(stats), ['7 actions', 'read ×3', 'bash ×2', 'retry ×1', '+1'],
    'the command contributes no action; +1 counts the hidden subagent kind')
})

test('signature: an over-cap display stays bounded AND sensitive past the cap', () => {
  const failure = 'x'.repeat(200)
  const tailA = compactActionPresentation({
    kind: 'retry',
    message: retryMessage(`llm retry 2/6 in 3s — ${failure}-TAIL-A`),
  })
  const tailB = compactActionPresentation({
    kind: 'retry',
    message: retryMessage(`llm retry 2/6 in 3s — ${failure}-TAIL-B`),
  })
  assert.ok(tailA.display.startsWith('Retry 2/6 in 3s · '), 'fixture: the producer-shaped retry is transformed')
  assert.ok(tailA.display.length > 120, 'fixture: the display is over the signature cap')
  // A change AFTER the cap with the SAME total length must still invalidate —
  // a truncated prefix would silently collide here.
  assert.equal(tailA.display.length, tailB.display.length, 'fixture: same length')
  assert.notEqual(compactActionSignature(tailA), compactActionSignature(tailB),
    'a tail-only change past the cap must repaint')
  // The signature itself stays bounded (digest, not the raw long display).
  assert.ok(compactActionSignature(tailA).length < 200, `signature stays bounded: ${compactActionSignature(tailA).length}`)
  // A short display keeps joining verbatim (exact, not digested).
  const short = compactActionPresentation({ kind: 'subagent', message: toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'scout' }) })
  assert.ok(compactActionSignature(short).includes('scout'))
  // The exact cap boundary: AT the cap the display joins verbatim, ONE over it
  // is digested (`>` comparison) — locks the boundary against an off-by-one.
  // The subagent label is `Subagent · <args>`, so the args length shifts it.
  const labelDisplay = (total: number): CompactActionPresentation =>
    compactActionPresentation({ kind: 'subagent', message: toolMessage({ origin: 'subagent-delegation', name: 'subagent', args: 'x'.repeat(total - 'Subagent · '.length) }) })
  const atCap = labelDisplay(120)
  const overCap = labelDisplay(121)
  assert.equal(atCap.display.length, 120, 'fixture: exactly at the cap')
  assert.equal(overCap.display.length, 121, 'fixture: one over the cap')
  assert.ok(compactActionSignature(atCap).includes(atCap.display), 'at the cap the display joins verbatim')
  assert.ok(!compactActionSignature(overCap).includes(overCap.display), 'one over the cap the display is digested')
})
