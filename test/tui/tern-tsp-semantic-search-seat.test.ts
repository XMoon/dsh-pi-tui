/**
 * T3-B1: the ONE Session semantic-search SEAT, driven directly.
 *
 * This file owns the seat's OWN contract and nothing above it: the query key
 * table (every printable key is consumed here, never by the hidden Composer),
 * the representative-CARD grouping (one target per `match.id`, however many raw
 * occurrences it carries), the wrap-around navigation, the `N/M targets` count,
 * the closed-vocabulary `Source-only` label, the open/query identity fences that
 * refuse a stale intent, and the retire path.
 *
 * The binding is a NARROW scripted double: this file proves the SEAT's logic, not
 * the Folder→surface chain. That chain (real `SurfaceRuntime`, real selected
 * `TranscriptFolder`, Remote coverage currentness, same-id cold replacement) is
 * `test/app/tern-tsp-semantic-search-surface.test.ts`, and the canonical
 * owner→SDK-Tree→reveal chain is `test/tui/tern-tsp-semantic-reveal.test.ts`.
 *
 * MEASURED on the pinned client (B1-0): the client delivers no native
 * `EditEvent`, so the seat's own key route owns every printable key — exactly
 * the model the production Composer already uses. Every edit case below is
 * therefore a KEY case, and no case claims a native edit event exists.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-semantic-search-seat.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Key } from '@stencil-hq/tern'
import type {
  TspTranscriptSemanticSearchBinding,
  TspTranscriptSemanticSearchSnapshot,
} from '../../src/app/surface/runtime.ts'
import type { TranscriptSearchMatch, TranscriptSearchSource } from '../../src/domain/transcript/search.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import {
  createTspTranscriptSearch,
  groupTranscriptSearchTargets,
  transcriptSearchSourceLabel,
  type TspTranscriptSearchPorts,
} from '../../src/tui/tsp/transcript-search.ts'

const SOURCE = { token: 'source-1' }

function match(id: number, source: TranscriptSearchSource, occurrence = 0): TranscriptSearchMatch {
  return { id, turn: 1, occurrence, source, sourceOccurrence: occurrence }
}

/** A scripted binding: one Folder-like answer per query, with the SAME source
 *  token until a case replaces it. */
function scriptedBinding(matches: readonly TranscriptSearchMatch[], options: {
  readonly coverage?: TspTranscriptSemanticSearchSnapshot['coverage']
  readonly current?: boolean
} = {}): {
  readonly binding: TspTranscriptSemanticSearchBinding
  readonly calls: { query: string; refinement: unknown }[]
  readonly setMatches: (next: readonly TranscriptSearchMatch[]) => void
  readonly revoke: () => void
} {
  let current = options.current ?? true
  let live = matches
  const calls: { query: string; refinement: unknown }[] = []
  const binding: TspTranscriptSemanticSearchBinding = {
    snapshot(query, refinement) {
      calls.push({ query, refinement })
      if (!current) return undefined
      return {
        source: SOURCE,
        subjectKind: 'main',
        subjectId: 'session-1',
        revision: calls.length,
        matches: live,
        coverage: options.coverage ?? 'entire-session',
      }
    },
    resolve(source, candidate) {
      if (!current || source !== SOURCE) return undefined
      return { kind: 'tool', id: candidate.id } as unknown as TranscriptMessage
    },
    current: (source) => current && source === SOURCE,
  }
  return {
    binding,
    calls,
    setMatches: (next) => { live = next },
    revoke: () => { current = false },
  }
}

/** The mount-side ports a headless seat case provides. */
function ports(overrides: Partial<TspTranscriptSearchPorts> = {}): {
  readonly ports: TspTranscriptSearchPorts
  readonly renders: () => number
  readonly focuses: () => number
  readonly reveals: () => number
  readonly navigations: () => number
} {
  let renders = 0
  let focuses = 0
  let reveals = 0
  let navigations = 0
  const value: TspTranscriptSearchPorts = {
    admitted: () => true,
    requestRender: () => { renders += 1 },
    setFocus: () => { focuses += 1 },
    requestReveal: () => { reveals += 1; return true },
    navigationChanged: () => { navigations += 1 },
    reportFatal: () => {},
    ...overrides,
  }
  return {
    ports: value,
    renders: () => renders,
    focuses: () => focuses,
    reveals: () => reveals,
    navigations: () => navigations,
  }
}

const key = (name: string, extra: Partial<Key> = {}): Key => ({ name, ...extra }) as Key

test('one representative card is ONE target, however many raw occurrences it carries', () => {
  const matches = [
    match(3, { kind: 'tool-field', field: 'result' }, 0),
    match(3, { kind: 'tool-field', field: 'result' }, 1),
    match(3, { kind: 'tool-field', field: 'args' }, 2),
    match(7, { kind: 'message' }),
    match(11, { kind: 'command-field', field: 'outcome' }),
  ]
  const targets = groupTranscriptSearchTargets(matches)
  assert.deepEqual(targets.map(target => target.representativeId), [3, 7, 11])
  assert.equal(targets[0]?.hitCount, 3, 'the card records how many raw hits it stands for')
  assert.equal(targets[0]?.sourceLabel, 'Tool result', 'the label comes from the FIRST hit source')
  assert.equal(targets[1]?.hitCount, 1)
})

test('the source label is a CLOSED vocabulary: no query, body, path or token can enter it', () => {
  const sources: TranscriptSearchSource[] = [
    { kind: 'message' },
    { kind: 'tool-field', field: 'name' },
    { kind: 'tool-field', field: 'args' },
    { kind: 'tool-field', field: 'result' },
    { kind: 'command-field', field: 'name' },
    { kind: 'command-field', field: 'args' },
    { kind: 'command-field', field: 'outcome' },
    { kind: 'subcall-field', subCallIds: ['a', 'b'], field: 'result' },
    { kind: 'workflow-run', field: 'name' },
    { kind: 'workflow-phase', phaseKey: 'phase-1' },
    { kind: 'workflow-member', phaseKey: 'p', seq: 2, field: 'status' },
    { kind: 'assistant-deliverable', index: 0, field: 'path' },
  ]
  for (const source of sources) {
    const label = transcriptSearchSourceLabel(source)
    assert.ok(label.length > 0, `every source kind has a label: ${source.kind}`)
    assert.match(label, /^[A-Za-z -]+$/u, `the label is plain words only: ${label}`)
    assert.ok(!label.includes('phase-1'), 'a phase key never reaches the label')
    assert.ok(!label.includes('a>b'), 'a sub-call id chain never reaches the label')
  }
})

test('open captures ONE snapshot with an empty query and paints the coverage header', () => {
  const { binding, calls } = scriptedBinding([match(1, { kind: 'message' })], { coverage: 'loaded-history-with-more' })
  const { ports: seatPorts, focuses } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  assert.equal(seat.supported(), true)
  seat.open()
  assert.equal(seat.isOpen(), true)
  assert.equal(calls.length, 1, 'open samples exactly one snapshot')
  assert.equal(calls[0]?.query, '', 'the first snapshot is the empty query')
  const state = seat.renderState()
  assert.ok(state !== undefined)
  assert.equal(state.query, '')
  assert.equal(state.countLabel, '0/0 targets')
  assert.match(state.header, /Loaded · Older not searched/u,
    'a Remote subject with more history never claims Entire')
  assert.equal(focuses(), 1, 'opening takes the caret')
})

test('a typed key edits the query and NEVER reaches the hidden Composer', () => {
  const { binding, calls } = scriptedBinding([])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  assert.equal(seat.handleKey(key('a', { text: 'a' })), true, 'a printable key is consumed by the seat')
  assert.equal(seat.handleKey(key('b', { text: 'b' })), true)
  const state = seat.renderState()
  assert.ok(state !== undefined)
  assert.equal(state.query, 'ab')
  assert.equal(state.queryCursor, 2)
  assert.deepEqual(calls.map(call => call.query), ['', 'a', 'ab'])
  // Backspace is a grapheme-aware deletion inside the seat.
  assert.equal(seat.handleKey(key('backspace')), true)
  assert.equal(seat.renderState()?.query, 'a')
})

test('CJK and emoji edit on grapheme boundaries (UTF-16 caret, no split surrogate)', () => {
  const { binding } = scriptedBinding([])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  seat.handleKey(key('paste', { text: '中文🙂' }))
  const state = seat.renderState()
  assert.ok(state !== undefined)
  assert.equal(state.query, '中文🙂')
  assert.equal(state.queryCursor, '中文🙂'.length, 'the caret is at the end of the pasted run')
  // One Backspace removes the whole emoji, never half of its surrogate pair.
  seat.handleKey(key('backspace'))
  assert.equal(seat.renderState()?.query, '中文')
})

test('a bracketed paste projects to ONE line and arms no attachment intake', () => {
  const { binding } = scriptedBinding([])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  seat.handleKey(key('paste', { text: 'line one\nline two' }))
  const query = seat.renderState()?.query ?? ''
  assert.ok(!query.includes('\n'), `the query stays one line: ${JSON.stringify(query)}`)
  assert.match(query, /line one line two/u)
})

test('next/previous wrap across the representative cards and never count raw hits', () => {
  const { binding } = scriptedBinding([
    match(3, { kind: 'tool-field', field: 'result' }, 0),
    match(3, { kind: 'tool-field', field: 'result' }, 1),
    match(9, { kind: 'message' }),
  ])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  seat.handleKey(key('x', { text: 'x' }))
  const state = seat.renderState()
  assert.ok(state !== undefined)
  assert.equal(state.countLabel, '1/2 targets', 'M counts representative CARDS, not raw hits')
  assert.equal(seat.currentTarget()?.representativeId, 3)
  seat.handleKey(key('enter'))
  assert.equal(seat.currentTarget()?.representativeId, 9)
  assert.equal(seat.renderState()?.countLabel, '2/2 targets')
  seat.handleKey(key('enter'))
  assert.equal(seat.currentTarget()?.representativeId, 3, 'Next wraps to the first card')
  seat.handleKey(key('enter', { shift: true }))
  assert.equal(seat.currentTarget()?.representativeId, 9, 'Shift+Enter steps backward (wrapping)')
})

test('zero matches: no current target, Next sends NO reveal', () => {
  const { binding } = scriptedBinding([])
  const { ports: seatPorts, reveals } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  seat.handleKey(key('z', { text: 'z' }))
  assert.equal(seat.currentTarget(), undefined)
  const state = seat.renderState()
  assert.ok(state !== undefined)
  assert.equal(state.countLabel, '0/0 targets')
  assert.equal(state.navigable, false, 'the buttons are painted disabled')
  assert.equal(seat.currentTarget(), undefined)
  seat.handleKey(key('enter'))
  assert.equal(reveals(), 0, 'a navigation with no target never requests a reveal')
})

test('a stale intent (old serial or old revision) can never act on the new state', () => {
  const { binding } = scriptedBinding([match(1, { kind: 'message' }), match(2, { kind: 'message' })])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  seat.handleKey(key('x', { text: 'x' }))
  const first = seat.renderState()
  assert.ok(first !== undefined)
  // A query round bumps the revision: the OLD frame's Next must be refused.
  seat.handleKey(key('a', { text: 'a' }))
  const moved = seat.currentTarget()
  seat.handleIntent({ kind: 'next', serial: first.serial, revision: first.revision })
  assert.equal(seat.currentTarget(), moved, 'the stale-revision intent changed nothing')
  // The CURRENT frame's intent does act.
  const live = seat.renderState()!
  seat.handleIntent({ kind: 'next', serial: live.serial, revision: live.revision })
  assert.notEqual(seat.currentTarget(), moved, 'the current intent navigates')
})

test('retire withdraws everything and a second open gets a NEW serial', () => {
  const { binding } = scriptedBinding([match(1, { kind: 'message' })])
  const { ports: seatPorts, focuses } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  const first = seat.renderState()!.serial
  seat.retire()
  assert.equal(seat.isOpen(), false)
  assert.equal(seat.renderState(), undefined, 'a retired seat paints nothing')
  assert.equal(seat.currentTarget(), undefined)
  seat.open()
  assert.ok(seat.renderState()!.serial > first, 'a new open is a new identity')
  assert.equal(focuses(), 2)
})

test('a revoked source retires the card instead of painting a stale result', () => {
  const scripted = scriptedBinding([match(1, { kind: 'message' })])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, scripted.binding, () => true)
  seat.open()
  scripted.revoke()
  assert.equal(seat.isOpen(), false, 'a dead source is not an operable seat')
  assert.equal(seat.renderState(), undefined)
  // Any key on the dead card retires it and is NOT consumed as query text.
  seat.handleKey(key('a', { text: 'a' }))
  assert.equal(seat.renderState(), undefined)
})

test('Ctrl+C is NOT the seat\'s cancel: the key falls through to the cancel owner', () => {
  const { binding } = scriptedBinding([match(1, { kind: 'message' })])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  assert.equal(seat.handleKey(key('c', { ctrl: true })), false,
    'Ctrl+C must reach the original interrupt/cancel owner exactly once')
  assert.equal(seat.isOpen(), true, 'the card itself is not closed by Ctrl+C')
})

test('Escape closes the card and returns the caret to the Composer', () => {
  const { binding } = scriptedBinding([match(1, { kind: 'message' })])
  const { ports: seatPorts, focuses } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  const before = focuses()
  assert.equal(seat.handleKey(key('escape')), true)
  assert.equal(seat.isOpen(), false)
  assert.equal(focuses(), before + 1, 'the ONE focus owner is re-evaluated after the close')
})

test('a second Alt+Shift+S re-focuses the query and keeps the current card', () => {
  const { binding } = scriptedBinding([match(1, { kind: 'message' }), match(2, { kind: 'message' })])
  const { ports: seatPorts, focuses } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  seat.handleKey(key('enter'))
  const current = seat.currentTarget()
  const before = focuses()
  assert.equal(seat.handleKey(key('s', { alt: true, shift: true })), true)
  assert.equal(seat.currentTarget(), current, 'the current card is preserved')
  assert.equal(focuses(), before + 1, 'only the caret is re-taken')
})

test('a scripted mount with no binding reports unsupported and never opens', () => {
  const { ports: seatPorts, renders } = ports()
  const seat = createTspTranscriptSearch(seatPorts, undefined, () => true)
  assert.equal(seat.supported(), false)
  seat.open()
  assert.equal(seat.isOpen(), false, 'no binding means no card, never an empty result')
  assert.equal(seat.renderState(), undefined)
  assert.equal(renders(), 1, 'the refusal still owes the frame that shows no card')
})

test('a pane without the negotiated capability reports unsupported', () => {
  const { binding } = scriptedBinding([])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => false)
  assert.equal(seat.supported(), false)
})

test('refresh keeps the same representative card when it still exists', () => {
  const scripted = scriptedBinding([match(1, { kind: 'message' }), match(2, { kind: 'message' })])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, scripted.binding, () => true)
  seat.open()
  seat.handleKey(key('x', { text: 'x' }))
  seat.handleKey(key('enter'))
  assert.equal(seat.currentTarget()?.representativeId, 2)
  // An official revision adds a card BEFORE the current one: the identity, not
  // the position, is what the refresh restores.
  scripted.setMatches([match(0, { kind: 'message' }), match(1, { kind: 'message' }), match(2, { kind: 'message' })])
  seat.refresh()
  assert.equal(seat.currentTarget()?.representativeId, 2, 'the same card stays current')
  assert.equal(seat.renderState()?.countLabel, '3/3 targets')
})

test('refresh falls back to the first card when the current one vanished', () => {
  const scripted = scriptedBinding([match(1, { kind: 'message' }), match(2, { kind: 'message' })])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, scripted.binding, () => true)
  seat.open()
  seat.handleKey(key('x', { text: 'x' }))
  seat.handleKey(key('enter'))
  assert.equal(seat.currentTarget()?.representativeId, 2)
  scripted.setMatches([match(5, { kind: 'message' })])
  seat.refresh()
  assert.equal(seat.currentTarget()?.representativeId, 5, 'a vanished card falls back, never invents one')
})

test('the render projection refuses to paint a card the mount no longer admits', () => {
  const { binding } = scriptedBinding([match(1, { kind: 'message' })])
  let admitted = true
  const { ports: seatPorts } = ports({ admitted: () => admitted })
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  assert.ok(seat.renderState() !== undefined)
  admitted = false
  assert.equal(seat.renderState(), undefined,
    'a hidden-but-clickable card is the forbidden state: no frame, no action')
  assert.equal(seat.isOpen(), false)
})

test('the seat diagnostics count the real work it did', () => {
  const { binding } = scriptedBinding([match(1, { kind: 'message' })])
  const { ports: seatPorts } = ports()
  const seat = createTspTranscriptSearch(seatPorts, binding, () => true)
  seat.open()
  seat.handleKey(key('a', { text: 'a' }))
  seat.handleKey(key('enter'))
  seat.refresh()
  seat.retire()
  const diagnostics = seat.diagnosticsForTest()
  assert.equal(diagnostics.opens, 1)
  assert.equal(diagnostics.queries, 1, 'one query round from the typed key')
  assert.equal(diagnostics.refreshes, 1)
  assert.equal(diagnostics.retired, 1)
})
