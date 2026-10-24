/**
 * The Work Details Reader's pure document projection.
 *
 * `buildWorkDetails` is the ONLY producer of the temporary Screen's node tree,
 * so these cases pin what the Reader can and cannot ever say: sanitized
 * untrusted text, the stable row identity, real facts only, and no fabricated
 * activity/output/transcript or business control.
 *
 * Evidence level: pure node projection (no surface, no client). The rendered
 * page is observed through the real SDK wire in the Reader lifecycle suite.
 *
 * @module @xmoon76/dsh-pi-tui/work-details.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { View, type Node } from '@stencil-hq/tern'
import {
  WORK_DETAILS_REGION,
  buildWorkDetails,
  workDetailsBackKey,
  type WorkDetailsIdentity,
} from '../../src/tui/tsp/work-details.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'

const IDENTITY: WorkDetailsIdentity = { panelSerial: 7, readingEpoch: 3, targetValue: 'job:j1' }

/** The hostile label/id payload: an OSC 52 clipboard write, a CSI clear and BEL. */
const HOSTILE = '\x1b]52;c;UFdORUQ=\x07echo ok\x1b[2J\x9b31m'

/** Every text value of one built document, in node order. */
function texts(node: Node): string[] {
  const out: string[] = []
  const visit = (current: Node): void => {
    const text = current.props['text']
    if (typeof text === 'string') out.push(text)
    const spans = current.props['spans']
    if (Array.isArray(spans)) {
      out.push(spans.map(entry => {
        if (typeof entry === 'string') return entry
        const value = (entry as { readonly t?: unknown }).t
        return typeof value === 'string' ? value : ''
      }).join(''))
    }
    for (const child of current.children) visit(child)
  }
  visit(node)
  return out
}

/** The document's node ids, derived exactly the way a surface would. */
function ids(node: Node): string[] {
  const out: string[] = []
  for (const root of View.from({ [WORK_DETAILS_REGION]: node }).regions) {
    const visit = (current: typeof root): void => {
      if (current === undefined) return
      out.push(current.id)
      for (const child of current.children) visit(child)
    }
    visit(root)
  }
  return out
}

function item(overrides: Partial<TaskPanelItem> = {}): TaskPanelItem {
  return {
    value: 'job:j1',
    label: 'build',
    status: 'running',
    source: 'job',
    type: 'bash',
    active: true,
    ...overrides,
  }
}

test('the document leads with the ONE native Back row bound to the caller callback', () => {
  let backs = 0
  const document = buildWorkDetails(item(), IDENTITY, () => { backs += 1 })
  const backKey = workDetailsBackKey(IDENTITY)
  assert.equal(backKey, 'work-back-7-3', 'the Back key carries the panel serial and the reading epoch')
  const [root] = View.from({ [WORK_DETAILS_REGION]: document }).regions
  assert.equal(root?.kind, 'col')
  const back = root?.children[0]
  assert.equal(back?.kind, 'row', 'the Back row is the first child of the document root')
  assert.equal(back?.props['key'], backKey)
  const backText = (back?.children[0]?.props ?? {}) as Record<string, unknown>
  assert.deepEqual(backText['spans'], [{ t: '← Work', s: 'accent' }], 'the row reads `← Work` in the accent role')
  assert.equal(typeof back?.node.handlers?.onClick, 'function', 'the row carries the ACTUAL onClick handler')
  back?.node.handlers?.onClick?.({ ev: 'action', act: 'click', raw: {} } as never)
  assert.equal(backs, 1, 'clicking the registered node id runs the bound callback once')
})

test('the document states the label, one derived description and the real facts in order', () => {
  const document = buildWorkDetails(item({
    label: 'build the release bundle',
    type: 'bash',
    mode: 'continuable',
    access: 'interactive-direct-child',
    parentId: 'agent:main',
    parentLabel: 'main agent',
    depth: 2,
    detail: 'compiling 42 modules',
    startedAt: 1_000,
    finishedAt: 2_000,
  }), IDENTITY, () => {})
  const content = texts(document)
  assert.equal(content[1], 'build the release bundle', 'the full label is the first body line')
  assert.equal(content[2], 'Job · running', 'the description is classification + the row status word')
  assert.ok(content.includes('Stable ID job:j1'), 'the stable raw row id is stated')
  assert.ok(content.includes('Type      bash'))
  assert.ok(content.includes('Mode      continuable'))
  assert.ok(content.includes('Access    interactive-direct-child'))
  assert.ok(content.includes('Parent    main agent'), 'the parent LABEL wins over the raw id')
  assert.ok(content.includes('Depth     2'))
  assert.equal(content.includes('Details'), true, 'an existing detail gets its own label')
  assert.ok(content.includes('compiling 42 modules'))
  assert.ok(content.includes('Started   1970-01-01T00:00:01.000Z'), 'a real timestamp is UTC ISO 8601')
  assert.ok(content.includes('Finished  1970-01-01T00:00:02.000Z'))
  // Order is the frozen projection order: label → description → stable id …
  assert.ok(content.indexOf('Stable ID job:j1') > content.indexOf('Job · running'))
  assert.ok(content.indexOf('Details') < content.indexOf('Started   1970-01-01T00:00:01.000Z'),
    'timestamps come last')
})

test('a Question row is never presented as work and offers no answer control', () => {
  const document = buildWorkDetails(item({
    value: 'question:sess-a:call-a',
    label: 'Choose a deployment region',
    status: 'awaiting answer',
    source: 'question',
    type: undefined,
    active: false,
    canStop: false,
  }), { ...IDENTITY, targetValue: 'question:sess-a:call-a' }, () => {})
  const content = texts(document)
  assert.equal(content[2], 'Question · awaiting answer')
  const wire = JSON.stringify(document.toJSON())
  for (const forbidden of ['Answer', 'Respond', 'Skip', 'Cancel question', 'Stop', 'Interrupt']) {
    assert.ok(!wire.includes(forbidden), `the Question Reader never paints "${forbidden}"`)
  }
})

test('an external leaf keeps its durable classification and never borrows local access', () => {
  const document = buildWorkDetails(item({
    value: 'agent:ext-1',
    label: 'external · remote run',
    status: 'External',
    source: 'subagent',
    type: 'subagent',
    mode: 'external',
    suffix: 'external',
    depth: 1,
    active: false,
    access: undefined,
  }), { ...IDENTITY, targetValue: 'agent:ext-1' }, () => {})
  const content = texts(document)
  assert.equal(content[2], 'External', 'the classification word is stated once, not invented')
  assert.ok(content.includes('Mode      external'), 'the durable external mode is shown as a fact')
  assert.ok(!content.some(line => line.startsWith('Access')), 'no access is fabricated for an external leaf')
  assert.ok(!JSON.stringify(document.toJSON()).includes('interactive'), 'no local-child authority is implied')
})

test('a nested subagent row shows its real parent/depth without inventing a driver', () => {
  const document = buildWorkDetails(item({
    value: 'agent:child-2',
    label: 'subagent · check saturation',
    status: 'running',
    source: 'subagent',
    type: 'subagent',
    mode: 'continuable',
    depth: 2,
    parentId: 'agent:child-1',
    access: 'readonly-nested',
  }), { ...IDENTITY, targetValue: 'agent:child-2' }, () => {})
  const content = texts(document)
  assert.equal(content[2], 'Subagent · running')
  assert.ok(content.includes('Parent    agent:child-1'), 'the raw parent id is shown when no label exists')
  assert.ok(content.includes('Depth     2'))
  assert.ok(content.includes('Access    readonly-nested'))
})

test('a job without real timestamps omits both fields instead of fabricating them', () => {
  const document = buildWorkDetails(item({ startedAt: undefined, finishedAt: undefined }), IDENTITY, () => {})
  const content = texts(document)
  assert.ok(!content.some(line => line.startsWith('Started')), 'no fabricated start time')
  assert.ok(!content.some(line => line.startsWith('Finished')), 'no fabricated finish time')
  // An out-of-range value is a display boundary, so the field is omitted too.
  const outOfRange = texts(buildWorkDetails(item({ startedAt: Number.MAX_VALUE, finishedAt: Number.NaN }), IDENTITY, () => {}))
  assert.ok(!outOfRange.some(line => line.startsWith('Started')), 'an unrepresentable timestamp is omitted')
  assert.ok(!outOfRange.some(line => line.startsWith('Finished')), 'a NaN timestamp is omitted')
})

test('hostile CJK/ANSI/OSC52 label and stable id reach the wire sanitized with no control byte', () => {
  const document = buildWorkDetails(item({
    value: `job:${HOSTILE}`,
    label: `构建 ${HOSTILE} ${'长'.repeat(200)}`,
    detail: HOSTILE,
  }), { ...IDENTITY, targetValue: `job:${HOSTILE}` }, () => {})
  const wire = JSON.stringify(document.toJSON())
  for (const marker of ['UFdORUQ=', '\\u001b', '\\u0007', '\\u009b', '\\u001b]52']) {
    assert.ok(!wire.includes(marker), `the wire carries no ${marker} payload`)
  }
  assert.ok(wire.includes('echo ok'), 'the readable content survives the projection')
  assert.ok(wire.includes('构建'), 'the CJK label reaches the wire')
  assert.ok(wire.includes('长'.repeat(200)), 'the long label is emitted whole for the client to wrap')
  const labelNode = texts(document)[1]!
  assert.ok(labelNode.includes('长'.repeat(200)), 'the builder never truncates the wrapped label')
  // Word wrapping is the node's own prop, so the client (not this projection)
  // decides the line breaks at the real width.
  const labelProps = (document.children[1]?.props ?? {}) as Record<string, unknown>
  assert.equal(labelProps['wrap'], 'word')
})

test('the document ids are stable for a reading and never embed data or revision', () => {
  const first = buildWorkDetails(item({ status: 'running' }), IDENTITY, () => {})
  const second = buildWorkDetails(item({ status: 'failed', label: 'a different label' }), IDENTITY, () => {})
  assert.deepEqual(ids(second), ids(first), 'a status/label repaint keeps the SAME keyed node ids')
  const all = ids(first)
  assert.ok(all.includes('main.work-back-7-3'), `the Back target is the panel/epoch identity: ${all.join(', ')}`)
  assert.ok(all.includes('main.col') || all.includes('main'), 'the document root is the main region root')
  for (const id of all) {
    assert.ok(!id.includes('job:j1'), `no node id embeds the row value: ${id}`)
    assert.ok(!id.includes('running'), `no node id embeds the status: ${id}`)
  }
  const other = ids(buildWorkDetails(item(), { ...IDENTITY, readingEpoch: 4 }, () => {}))
  assert.notDeepEqual(other, all, 'a NEW reading takes a NEW identity')
})

test('an empty detail and an empty status never paint empty fact lines', () => {
  const document = buildWorkDetails(item({ status: '', detail: '', type: '', mode: '', access: '' }), IDENTITY, () => {})
  const content = texts(document)
  assert.ok(!content.includes('Details'), 'an empty detail gets no label and no empty body')
  assert.ok(!content.some(line => line === 'Type      '), 'an empty type paints no fact line')
  assert.ok(!content.some(line => line === 'Mode      '), 'an empty mode paints no fact line')
  assert.ok(!content.some(line => line === 'Access    '), 'an empty access paints no fact line')
  assert.equal(content[2], 'Job', 'a status-free row still states its classification')
})
