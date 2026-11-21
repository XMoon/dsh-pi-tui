import assert from 'node:assert/strict'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import test from 'node:test'
import { TranscriptSearchComponent, formatCompactSourceNotice } from '../../src/tui/interaction/transcript-search.ts'
import type { FullSearchSourceNotice, TranscriptSearchScope } from '../../src/tui/interaction/transcript-search.ts'
import type { TuiMouseEvent } from '@xmoon76/pi-tui'

function mouse(
  type: TuiMouseEvent['type'],
  x: number,
  y: number,
  options: { readonly button?: TuiMouseEvent['button']; readonly width?: number; readonly height?: number } = {},
): TuiMouseEvent {
  return {
    type,
    button: options.button ?? 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: options.width ?? 60,
    height: options.height ?? 3,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

function component(options: {
  onScopeRequest?: (scope: TranscriptSearchScope) => void
  readViewResult?: () => { currentIndex: number; count: number } | undefined
  readTemporaryReader?: () => boolean
  readCoverage?: () => 'entire-session' | 'loaded-history' | 'loaded-history-with-more'
  readSourceNotice?: () => FullSearchSourceNotice | undefined
  readTerminalRows?: () => number
  initialScope?: TranscriptSearchScope
} = {}): TranscriptSearchComponent {
  return new TranscriptSearchComponent({
    onQueryChange: () => {},
    onScopeRequest: options.onScopeRequest ?? (() => {}),
    readViewResult: options.readViewResult ?? (() => undefined),
    readTemporaryReader: options.readTemporaryReader ?? (() => false),
    readCoverage: options.readCoverage ?? (() => 'entire-session'),
    readSourceNotice: options.readSourceNotice ?? (() => undefined),
    readTerminalRows: options.readTerminalRows ?? (() => 24),
    initialScope: options.initialScope ?? 'view',
  })
}

test('transcript search: clicking the query row positions the private Input cursor', () => {
  const queries: string[] = []
  const search = new TranscriptSearchComponent({
    onQueryChange: query => queries.push(query),
    onScopeRequest: () => {},
    readViewResult: () => ({ currentIndex: -1, count: 0 }),
    readTemporaryReader: () => false,
    readCoverage: () => 'entire-session',
    readSourceNotice: () => undefined,
    readTerminalRows: () => 24,
    initialScope: 'view',
  })
  search.handleInput('a')
  search.handleInput('b')
  search.handleInput('c')
  const rendered = search.render(60)
  assert.ok(rendered[1]!.includes('>'), `input row missing:\n${rendered.join('\n')}`)
  const press = search.handleMouse(mouse('press', 3, 1))
  assert.ok(press?.handled)
  search.handleInput('X')
  assert.equal(queries.at(-1), 'aXbc')
})

test('transcript search: only the active scope is marked and each result authority owns its count', () => {
  const search = component({ readViewResult: () => ({ currentIndex: 0, count: 2 }) })
  search.handleInput('needle')
  let title = stripTerminalSequences(search.render(60)[0]!)
  assert.match(title, /\[View\] \| Full/u)
  assert.match(title, /1\/2/u)

  search.setScope('full')
  search.setResult(1, 7)
  title = stripTerminalSequences(search.render(60)[0]!)
  assert.match(title, /View \| \[Full\]/u)
  assert.match(title, /1\/7/u)

  search.setResult(0, 0)
  assert.match(stripTerminalSequences(search.render(60)[0]!), /No matches/u)
})

test('transcript search: narrow titles preserve scope identities and result status', () => {
  const search = component({ readViewResult: () => ({ currentIndex: 11, count: 12 }) })
  search.handleInput('needle')
  const title = stripTerminalSequences(search.render(18)[0]!)
  assert.match(title, /\[V\]\|F/u)
  assert.match(title, /12\/12/u)
  assert.ok(!title.includes('Find transcript'))
})

test('transcript search: coverage and temporary-reader labels remain explicit', () => {
  const search = component({
    readTemporaryReader: () => true,
    readCoverage: () => 'loaded-history-with-more',
  })
  search.setScope('full')
  const lines = search.render(240).map(stripTerminalSequences)
  assert.ok(lines[2]!.includes('Loaded history; earlier history not searched'))
  assert.ok(lines[2]!.includes('esc/ctrl+c returns inline'))

  const narrow = component({
    readCoverage: () => 'loaded-history-with-more',
  })
  narrow.setScope('full')
  assert.ok(narrow.render(60).map(stripTerminalSequences)[2]!.includes('Older not searched'),
    'the short hint retains an honest bound when the full wording does not fit')

  const complete = component({ readCoverage: () => 'entire-session' })
  complete.setScope('full')
  assert.ok(complete.render(240).map(stripTerminalSequences)[2]!.includes('Entire session'))
})

test('transcript search: changing scope cancels an in-flight title click before repaint', () => {
  const scopes: TranscriptSearchScope[] = []
  const search = component({ onScopeRequest: scope => scopes.push(scope) })
  search.render(60)
  search.handleMouse(mouse('press', 18, 0))

  search.setScope('full')
  search.handleMouse(mouse('release', 18, 0))
  search.handleMouse(mouse('click', 18, 0))

  assert.deepEqual(scopes, [], 'the stale View press cannot request a View switch after Full was committed')
})

test('transcript search: a same-layout repaint preserves a scope click press', () => {
  const scopes: TranscriptSearchScope[] = []
  const search = component({ onScopeRequest: scope => scopes.push(scope) })
  search.render(60)
  const fullColumn = 26
  search.handleMouse(mouse('press', fullColumn, 0))
  search.render(60)
  search.handleMouse(mouse('release', fullColumn, 0))
  search.handleMouse(mouse('click', fullColumn, 0))
  assert.deepEqual(scopes, ['full'], 'a repaint with the same painted scope geometry keeps the press live')
})

test('transcript search: a changed title layout invalidates a scope click press', () => {
  const scopes: TranscriptSearchScope[] = []
  const search = component({ onScopeRequest: scope => scopes.push(scope) })
  search.render(60)
  const fullColumn = 26
  search.handleMouse(mouse('press', fullColumn, 0))
  search.render(24)
  search.handleMouse(mouse('release', fullColumn, 0, { width: 24 }))
  search.handleMouse(mouse('click', fullColumn, 0, { width: 24 }))
  assert.deepEqual(scopes, [], 'a press cannot activate stale scope geometry after the title moves')
})

test('transcript search: a title click changes scope only after a same-target click', () => {
  const scopes: TranscriptSearchScope[] = []
  const search = component({ onScopeRequest: scope => scopes.push(scope) })
  search.render(60)
  const viewColumn = 18
  search.handleMouse(mouse('press', viewColumn, 0))
  search.handleMouse(mouse('release', viewColumn, 0))
  search.handleMouse(mouse('click', viewColumn, 0))
  assert.deepEqual(scopes, ['view'])

  search.render(60)
  search.handleMouse(mouse('press', viewColumn, 0))
  search.handleMouse(mouse('release', viewColumn + 10, 0))
  search.handleMouse(mouse('click', viewColumn + 10, 0))
  assert.deepEqual(scopes, ['view'], 'release on a different title segment cancels the click')
})

test('transcript search: non-left and stale-geometry title gestures never switch scope', () => {
  const scopes: TranscriptSearchScope[] = []
  const search = component({ onScopeRequest: scope => scopes.push(scope) })
  search.render(60)
  search.handleMouse(mouse('press', 18, 0, { button: 'right' }))
  search.handleMouse(mouse('click', 18, 0, { button: 'right' }))
  search.handleMouse(mouse('press', 18, 0))
  search.render(61)
  search.handleMouse(mouse('click', 18, 0))
  assert.deepEqual(scopes, [])
})

test('transcript search: title and hint rows outside a scope target stay inert', () => {
  const search = component()
  search.render(60)
  assert.equal(search.handleMouse(mouse('press', 2, 0)), undefined, 'the label is not a scope control')
  assert.equal(search.handleMouse(mouse('press', 2, 2)), undefined, 'the hint row is inert')
})

test('transcript search: the compact Source-only row keeps whole required segments at the real box width', () => {
  // The plan's documented 24-column floor example: loaded history + Esc.
  assert.equal(formatCompactSourceNotice({
    kind: 'unproven',
    coverage: 'loaded-history',
    closeKey: 'Esc',
    width: 24,
  }), 'Source-only Loaded Esc')
  // "Older not searched" collapses to the real "Loaded" truth before the
  // close key is ever touched.
  assert.equal(formatCompactSourceNotice({
    kind: 'unproven',
    coverage: 'loaded-history-with-more',
    closeKey: 'Esc',
    width: 24,
  }), 'Source-only Loaded Esc')
  // A wider compact box keeps the status word and the separators.
  assert.equal(formatCompactSourceNotice({
    kind: 'not-painted',
    coverage: 'loaded-history',
    closeKey: 'Esc',
    width: 40,
  }), 'Source-only · No cell · Loaded · Esc')
  // A long effective close binding: the layout budgets the REAL key width and
  // drops the coverage instead of truncating `Source-only` or the key.
  const longKey = formatCompactSourceNotice({
    kind: 'unproven',
    coverage: 'loaded-history',
    closeKey: 'Ctrl+Shift+E',
    width: 24,
  })
  assert.equal(longKey, 'Source-only Ctrl+Shift+E')
  assert.equal(visibleWidth(longKey), 24)
  // At 32 columns the same key still fits beside the loaded-history truth.
  assert.equal(formatCompactSourceNotice({
    kind: 'unproven',
    coverage: 'loaded-history',
    closeKey: 'Ctrl+Shift+E',
    width: 32,
  }), 'Source-only Loaded Ctrl+Shift+E')
  // `Entire` is the only permitted omission for the entire-session scope.
  assert.equal(formatCompactSourceNotice({
    kind: 'unproven',
    coverage: 'entire-session',
    closeKey: 'Esc',
    width: 22,
  }), 'Source-only Entire Esc')
  assert.equal(formatCompactSourceNotice({
    kind: 'unproven',
    coverage: 'entire-session',
    closeKey: 'Esc',
    width: 18,
  }), 'Source-only Esc')
  // A key that cannot share the box with even the required facts is returned
  // WHOLE: the component never emits a partial close key or `Source-only`.
  const impossible = formatCompactSourceNotice({
    kind: 'unproven',
    coverage: 'loaded-history',
    closeKey: 'Ctrl+Shift+Alt+Escape',
    width: 24,
  })
  assert.equal(impossible, 'Source-only Ctrl+Shift+Alt+Escape')
  for (const row of [longKey, impossible]) {
    assert.ok(row.startsWith('Source-only'), 'the Source-only fact is never dropped')
    assert.ok(!row.includes('…'), 'required segments are never partially truncated')
  }
})
