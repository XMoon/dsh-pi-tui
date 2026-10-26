/**
 * The Assistant visual-projection sidecar: presentation-only caching keyed by
 * the exact display subject, Session instance, committed revision and the
 * Assistant row's own body identity.
 * @module @xmoon76/dsh-pi-tui/domain/visual-presentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import {
  assistantVisualPresentation,
  assistantVisualPresentationRevision,
  clearAssistantVisualPresentation,
  setAssistantVisualPresentation,
  type VisualPresentationKey,
} from '../../src/domain/visual/presentation.ts'

function publication(ref: string): PublishedVisual {
  return {
    ref,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: 'call-present',
    source: {
      ref,
      type: 'chart',
      title: 'Request latency',
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: 'call-chart',
      chart: { version: 1, type: 'chart', kind: 'bars', title: 'Request latency', series: [{ label: 'p50', value: 42 }] },
      svg: undefined,
      svgSource: undefined,
      svgAdmissionWidth: undefined,
    },
  }
}

function baseKey(): VisualPresentationKey {
  return {
    subjectKind: 'main',
    subjectId: 'session-1',
    sourceIdentity: {},
    session: {},
    sessionId: 'session-1',
    seq: 12,
    turn: 0,
    step: 1,
    text: 'answer',
    content: undefined,
    assistantRevision: 3,
  }
}

const REF_A = `sv1_${'a'.repeat(20)}`
const REF_B = `sv1_${'b'.repeat(20)}`

test('a first committed projection starts at revision 1 and exposes its publications', () => {
  const message = {}
  assert.equal(assistantVisualPresentationRevision(message), 0)
  assert.equal(setAssistantVisualPresentation(message, baseKey(), [publication(REF_A)]), true)
  assert.equal(assistantVisualPresentationRevision(message), 1)
  assert.deepEqual(assistantVisualPresentation(message)?.publications.map(entry => entry.ref), [REF_A])
})

test('an equivalent re-derivation keeps the same revision and array identity', () => {
  const message = {}
  const key = baseKey()
  setAssistantVisualPresentation(message, key, [publication(REF_A)])
  const before = assistantVisualPresentation(message)
  const result = setAssistantVisualPresentation(message, { ...key }, before!.publications.slice())
  assert.equal(result, false)
  assert.equal(assistantVisualPresentationRevision(message), 1)
  assert.equal(assistantVisualPresentation(message), before)
})

test('a different publication advances the revision', () => {
  const message = {}
  setAssistantVisualPresentation(message, baseKey(), [publication(REF_A)])
  assert.equal(setAssistantVisualPresentation(message, baseKey(), [publication(REF_B)]), true)
  assert.equal(assistantVisualPresentationRevision(message), 2)
  assert.deepEqual(assistantVisualPresentation(message)?.publications.map(entry => entry.ref), [REF_B])
})

const KEY_CHANGES: readonly { readonly field: string; readonly apply: (key: VisualPresentationKey) => VisualPresentationKey }[] = [
  { field: 'subjectKind', apply: key => ({ ...key, subjectKind: 'viewed-child' }) },
  { field: 'subjectId', apply: key => ({ ...key, subjectId: 'session-2' }) },
  { field: 'sourceIdentity', apply: key => ({ ...key, sourceIdentity: {} }) },
  { field: 'session', apply: key => ({ ...key, session: {} }) },
  { field: 'sessionId', apply: key => ({ ...key, sessionId: 'session-2' }) },
  { field: 'seq', apply: key => ({ ...key, seq: 13 }) },
  { field: 'turn', apply: key => ({ ...key, turn: 1 }) },
  { field: 'step', apply: key => ({ ...key, step: 2 }) },
  { field: 'text', apply: key => ({ ...key, text: 'changed' }) },
  { field: 'content', apply: key => ({ ...key, content: [{ type: 'text', text: 'changed' }] }) },
  { field: 'assistantRevision', apply: key => ({ ...key, assistantRevision: 4 }) },
]

for (const change of KEY_CHANGES) {
  test(`changing ${change.field} invalidates the cached projection`, () => {
    const message = {}
    setAssistantVisualPresentation(message, baseKey(), [publication(REF_A)])
    assert.equal(setAssistantVisualPresentation(message, change.apply(baseKey()), [publication(REF_A)]), true)
    assert.equal(assistantVisualPresentationRevision(message), 2)
  })
}

test('clearing a projection removes it and a later equivalent set starts a new revision', () => {
  const message = {}
  setAssistantVisualPresentation(message, baseKey(), [publication(REF_A)])
  assert.equal(clearAssistantVisualPresentation(message), true)
  assert.equal(assistantVisualPresentation(message), undefined)
  assert.equal(assistantVisualPresentationRevision(message), 0)
  assert.equal(clearAssistantVisualPresentation(message), false)
  setAssistantVisualPresentation(message, baseKey(), [publication(REF_A)])
  assert.equal(assistantVisualPresentationRevision(message), 1)
})

test('the committed publication array is a copy and cannot be mutated by a caller', () => {
  const message = {}
  const publications = [publication(REF_A)]
  setAssistantVisualPresentation(message, baseKey(), publications)
  publications.length = 0
  assert.equal(assistantVisualPresentation(message)?.publications.length, 1)
})

test('two Assistant rows keep independent projections', () => {
  const first = {}
  const second = {}
  setAssistantVisualPresentation(first, baseKey(), [publication(REF_A)])
  setAssistantVisualPresentation(second, { ...baseKey(), turn: 1, text: 'other' }, [publication(REF_B)])
  assert.deepEqual(assistantVisualPresentation(first)?.publications.map(entry => entry.ref), [REF_A])
  assert.deepEqual(assistantVisualPresentation(second)?.publications.map(entry => entry.ref), [REF_B])
  clearAssistantVisualPresentation(first)
  assert.equal(assistantVisualPresentation(first), undefined)
  assert.equal(assistantVisualPresentation(second)?.publications[0]?.ref, REF_B)
})
