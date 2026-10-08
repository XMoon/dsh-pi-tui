/**
 * Unit tests for the child-viewer subject bar (viewer UX plan §4.1/§7):
 * the pure renderer is a width-aware, single-line projection of the
 * committed status subject and composition — main renders nothing, child
 * renders its own identity/activity/model and degrades in the frozen order.
 * @module @xmoon76/dsh-pi-tui/viewer-subject-bar.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { renderViewerSubjectBar } from '../src/tui/presentation/viewer-subject-bar.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

/** Strip ANSI SGR sequences for text-level assertions. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, '')
}

function childSnapshot(overrides: {
  label?: string
  activity?: 'running' | 'inactive'
  mode?: 'one-shot' | 'continuable'
  model?: { provider?: string; id: string; reasoningEffort?: string } | undefined
  clearModel?: boolean
} = {}): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.view.subject = {
    kind: 'subagent',
    id: 'child-1',
    ...overrides.label === undefined ? { label: 'reviewer' } : { label: overrides.label },
    mode: overrides.mode ?? 'continuable',
    activity: overrides.activity ?? 'running',
  }
  snap.composition = overrides.clearModel === true
    ? {}
    : {
        model: {
          provider: overrides.model?.provider ?? 'deepseek',
          id: overrides.model?.id ?? 'v4',
          displayName: overrides.model?.id ?? 'v4',
          ...overrides.model?.reasoningEffort === undefined ? { reasoningEffort: 'high' } : { reasoningEffort: overrides.model.reasoningEffort },
        },
      }
  return snap
}

test('the main subject renders no bar at all', () => {
  assert.equal(renderViewerSubjectBar({ snapshot: emptyStatusSnapshot(), width: 120 }), '')
})

test('a child renders one line with its own identity, activity and model', () => {
  const line = renderViewerSubjectBar({
    snapshot: childSnapshot(),
    childTitle: 'Audit ownership',
    width: 140,
  })
  assert.ok(!line.includes('\n'), `the bar must never wrap:\n${line}`)
  assert.ok(visibleWidth(line) <= 140, `the bar must fit 140 cells (got ${visibleWidth(line)})`)
  const text = plain(line)
  assert.ok(text.includes('‹ parent'), `the navigation affordance is required:\n${text}`)
  assert.ok(text.includes('reviewer'), `the child label is required:\n${text}`)
  assert.ok(text.includes('Audit ownership'), `the committed child title must render when it fits:\n${text}`)
  assert.ok(text.includes('● running'), `the running activity is required:\n${text}`)
  assert.ok(text.includes('deepseek/v4'), `the child provider/model is required:\n${text}`)
  assert.ok(text.includes('@high'), `the child reasoning effort is required when it fits:\n${text}`)
})

test('the bar fits every expected width without wrapping (140/100/80/60/40/20)', () => {
  const snapshot = childSnapshot()
  for (const width of [1, 2, 3, 20, 40, 60, 80, 100, 140]) {
    const line = renderViewerSubjectBar({ snapshot, childTitle: 'Audit ownership', width })
    assert.ok(!line.includes('\n'), `width ${width}: the bar must never wrap`)
    assert.ok(visibleWidth(line) <= width, `width ${width}: the bar must fit (got ${visibleWidth(line)})`)
  }
})

test('80 columns keep the full provider/model for the example data', () => {
  const line = plain(renderViewerSubjectBar({
    snapshot: childSnapshot({ model: { provider: 'deepseek', id: 'v4', reasoningEffort: 'high' } }),
    width: 80,
  }))
  assert.ok(line.includes('deepseek/v4'), `the full provider/model must survive 80 columns:\n${line}`)
  assert.ok(line.includes('@high'), `the effort survives 80 columns for this data:\n${line}`)
})

test('an absent child model renders the explicit unknown token, never a parent value', () => {
  const line = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ clearModel: true }), width: 100 }))
  assert.ok(line.includes('model ?'), `the unknown-model stand-in is required:\n${line}`)
  assert.ok(!line.includes('deepseek'), `no model identity may be fabricated:\n${line}`)
})

test('a provider-less child model renders the id only (no fabricated provider)', () => {
  const line = plain(renderViewerSubjectBar({
    snapshot: childSnapshot({ model: { provider: '', id: 'solo', reasoningEffort: 'low' } }),
    width: 120,
  }))
  assert.ok(line.includes('solo'), `the model id must render:\n${line}`)
  assert.ok(line.includes('@low'), `the effort must render:\n${line}`)
  assert.ok(!line.includes('/'), `no provider separator may be fabricated:\n${line}`)
})

test('only running/inactive ever render — never a fabricated task outcome', () => {
  for (const activity of ['running', 'inactive'] as const) {
    const line = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ activity }), width: 120 }))
    assert.ok(!/completed|failed|unread/.test(line), `no task outcome may be inferred (${activity}):\n${line}`)
  }
  const running = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ activity: 'running' }), width: 120 }))
  assert.ok(running.includes('● running'), `running renders its marker + word:\n${running}`)
  const inactive = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ activity: 'inactive' }), width: 120 }))
  assert.ok(inactive.includes('○ inactive'), `inactive renders its marker + word:\n${inactive}`)
})

test('the degradation order is title → label → status words → parent word → effort → provider → model tail', () => {
  const snapshot = childSnapshot({ label: 'a-very-long-child-label-name', activity: 'running', model: { provider: 'deepseek', id: 'v4', reasoningEffort: 'high' } })
  const title = 'a-very-long-title'
  const at = (width: number): string => plain(renderViewerSubjectBar({ snapshot, childTitle: title, width }))

  // Roomy: everything including the title.
  const roomy = at(90)
  assert.ok(roomy.includes(title), `title present when roomy:\n${roomy}`)
  assert.ok(roomy.includes('a-very-long-child-label-name'), `label intact when roomy:\n${roomy}`)
  assert.ok(roomy.includes('● running'), `activity words intact when roomy:\n${roomy}`)
  assert.ok(roomy.includes('@high'), `effort intact when roomy:\n${roomy}`)

  // 1. the title drops first, the label stays intact.
  const noTitle = at(80)
  assert.ok(!noTitle.includes(title), `title drops before the label:\n${noTitle}`)
  assert.ok(noTitle.includes('a-very-long-child-label-name'), `label intact after the title drops:\n${noTitle}`)
  assert.ok(noTitle.includes('● running'), `activity words survive the title drop:\n${noTitle}`)

  // 2. the label trims before the activity words collapse.
  const trimmedLabel = at(60)
  assert.ok(!trimmedLabel.includes('a-very-long-child-label-name'), `label trimmed next:\n${trimmedLabel}`)
  assert.ok(trimmedLabel.includes('● running'), `activity words still intact:\n${trimmedLabel}`)
  assert.ok(trimmedLabel.includes('deepseek/v4'), `provider survives the label trim:\n${trimmedLabel}`)

  // 3. the activity collapses to its marker before the parent word drops.
  const markerOnly = at(45)
  assert.ok(!markerOnly.includes('running'), `activity words collapse next:\n${markerOnly}`)
  assert.ok(markerOnly.includes('●'), `the activity marker survives:\n${markerOnly}`)
  assert.ok(markerOnly.includes('‹ parent'), `the parent word survives the activity collapse:\n${markerOnly}`)

  // 4. the parent word drops before the effort.
  const navShort = at(38)
  assert.ok(!navShort.includes('parent'), `the parent word drops next:\n${navShort}`)
  assert.ok(navShort.includes('‹'), `the navigation marker survives:\n${navShort}`)
  assert.ok(navShort.includes('@high'), `the effort survives the parent word:\n${navShort}`)

  // 5. the effort drops before the provider.
  const noEffort = at(31)
  assert.ok(!noEffort.includes('@high'), `the effort drops next:\n${noEffort}`)
  assert.ok(noEffort.includes('deepseek/v4'), `the provider survives the effort:\n${noEffort}`)

  // 6. the provider drops last, leaving the model id.
  const idOnly = at(25)
  assert.ok(!idOnly.includes('deepseek'), `the provider drops before the model id:\n${idOnly}`)
  assert.ok(idOnly.includes('v4'), `the model id survives:\n${idOnly}`)
})

test('the child title is only repeated when it differs from the label', () => {
  const repeated = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ label: 'reviewer' }), childTitle: 'reviewer', width: 120 }))
  assert.ok(!repeated.includes(' · '), `a title equal to the label is not repeated:\n${repeated}`)
  const empty = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ label: 'reviewer' }), childTitle: '', width: 120 }))
  assert.ok(!empty.includes(' · '), `an empty title adds no description:\n${empty}`)
  const absent = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ label: 'reviewer' }), width: 120 }))
  assert.ok(!absent.includes(' · '), `no title adds no description:\n${absent}`)
})

test('a child with no label still renders the navigation, activity and model', () => {
  const line = plain(renderViewerSubjectBar({ snapshot: childSnapshot({ label: '' }), width: 100 }))
  assert.ok(line.includes('‹ parent'), `the navigation affordance survives:\n${line}`)
  assert.ok(line.includes('● running'), `the activity survives:\n${line}`)
  assert.ok(line.includes('deepseek/v4'), `the model survives:\n${line}`)
})

test('wide glyphs (CJK / emoji / combining) stay within the cell budget without wrapping', () => {
  const labels = ['研究子代理很长的名字', '🔍 reviewer with emoji', 'e\u0301 combining review']
  for (const label of labels) {
    for (const width of [1, 3, 20, 40, 80]) {
      const line = renderViewerSubjectBar({ snapshot: childSnapshot({ label }), childTitle: '研究', width })
      assert.ok(!line.includes('\n'), `label ${JSON.stringify(label)} width ${width}: no wrap`)
      assert.ok(visibleWidth(line) <= width,
        `label ${JSON.stringify(label)} width ${width}: fits (got ${visibleWidth(line)})`)
    }
  }
})
