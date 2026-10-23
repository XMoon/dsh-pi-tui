/**
 * The About status DTO/projection tests (Phase 3C / C3): the pure
 * `aboutFactRows`/`serializeAboutStatus` contract — stable ids, source-grouped
 * facts, absent vs true zero, exact copy payloads, deterministic Copy All.
 * One captured revision supplies BOTH the visible and the copied values.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aboutFactRows,
  serializeAboutStatus,
  ABOUT_NO_ACTIVE_SESSION,
  type AboutStatusView,
} from '../../src/domain/status/about.ts'

/** A ready view with every group present (distinct values per source group). */
type ReadySession = Extract<AboutStatusView['session'], { readonly kind: 'ready' | 'unavailable' }>
function readyView(overrides: Partial<ReadySession> = {}): AboutStatusView {
  return {
    runtime: { tui: '0.5.3', dsh: '0.2.1-rc.2', backend: 'direct' },
    session: {
      kind: 'ready',
      sessionId: 'sess-main-0001',
      title: 'fix the flux',
      provider: 'deepseek',
      model: 'deepseek-chat',
      effort: 'high',
      preset: 'pi-tui',
      cwd: '/home/u/project/alpha',
      stats: {
        lifetime: { turns: 12, steps: 30, llmMs: 1678900 },
        tokens: { input: 1234, output: 567, cacheRead: 890, cacheWrite: 12, cacheHitPct: 41.6 },
        recent: { firstTokenMsAvg: 812.4, tokensPerSec: 33.3 },
        sessionPerformance: { tokensPerSec: 29.97 },
      },
      contextUsed: 45000,
      contextWindow: 128000,
      context: 'fresh' as const,
      ...overrides,
    } as ReadySession,
    epoch: 3,
  }
}

const ids = (view: AboutStatusView): string[] => aboutFactRows(view).map(row => row.id)

test('the sessionless view shows the runtime trio plus the one No-active-session state word', () => {
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: undefined, backend: 'remote' },
    session: { kind: 'none' },
    epoch: 1,
  }
  const rows = aboutFactRows(view)
  assert.deepEqual(ids(view), ['runtime.tui', 'runtime.dsh', 'runtime.backend', 'status.unavailable'])
  const dsh = rows.find(row => row.id === 'runtime.dsh')!
  assert.equal(dsh.displayValue, 'Unknown', 'an unreadable DSH version reads Unknown')
  assert.equal(dsh.copyValue, 'Unknown')
  const backend = rows.find(row => row.id === 'runtime.backend')!
  assert.equal(backend.displayValue, 'Remote')
  const none = rows.find(row => row.id === 'status.unavailable')!
  assert.equal(none.displayValue, ABOUT_NO_ACTIVE_SESSION)
  assert.equal(none.copyValue, ABOUT_NO_ACTIVE_SESSION)
})

test('a ready view renders every section in the frozen order with distinct source groups', () => {
  const order = ids(readyView())
  assert.deepEqual(order, [
    'runtime.tui', 'runtime.dsh', 'runtime.backend',
    'session.id', 'session.title', 'session.provider', 'session.model', 'session.effort', 'session.preset', 'session.cwd',
    'stats.turns', 'stats.steps', 'stats.llmMs',
    'tokens.input', 'tokens.output', 'tokens.cacheRead', 'tokens.cacheWrite', 'tokens.cacheHitPct',
    'performance.recentTTFB', 'performance.R5', 'performance.All',
    'context.used', 'context.window', 'context.percent', 'context.observation',
  ])
})

test('an absent authority group is omitted from the ROWS and worded Unavailable in Copy All — never a zero', () => {
  const view = readyView({
    stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHitPct: 0 } },
  })
  const rows = aboutFactRows(view)
  // The lifetime and performance groups are ABSENT: no rows, no zeros.
  assert.ok(!rows.some(row => row.id === 'stats.turns'))
  assert.ok(!rows.some(row => row.id === 'stats.llmMs'))
  assert.ok(!rows.some(row => row.id.startsWith('performance.')))
  // The token group is PRESENT and its authoritative zeros stay visible.
  const input = rows.find(row => row.id === 'tokens.input')!
  assert.equal(input.displayValue, '0')
  assert.equal(input.copyValue, '0')
  const report = serializeAboutStatus(view)
  assert.match(report, /Turns: Unavailable/u)
  assert.match(report, /Input tokens: 0/u)
  assert.match(report, /TTFB \(recent\): Unavailable/u)
})

test('the Context percent only exists when both numbers exist and the window is positive', () => {
  const withWindow = aboutFactRows(readyView())
  assert.ok(withWindow.some(row => row.id === 'context.percent'))
  const noWindow = aboutFactRows(readyView({ contextWindow: undefined }))
  assert.ok(!noWindow.some(row => row.id === 'context.percent'))
  assert.ok(noWindow.some(row => row.id === 'context.used'))
  const zeroWindow = aboutFactRows(readyView({ contextUsed: 10, contextWindow: 0 }))
  assert.ok(!zeroWindow.some(row => row.id === 'context.percent'))
  const noMeasurement = aboutFactRows(readyView({ contextUsed: undefined, context: 'unavailable' }))
  const observation = noMeasurement.find(row => row.id === 'context.observation')!
  assert.equal(observation.displayValue, 'Unavailable')
})

test('the observation words are exactly Fresh / Last-known / Unavailable', () => {
  for (const [observation, word] of [
    ['fresh', 'Fresh'],
    ['last-known', 'Last-known'],
    ['unavailable', 'Unavailable'],
  ] as const) {
    const rows = aboutFactRows(readyView({ context: observation }))
    assert.equal(rows.find(row => row.id === 'context.observation')!.displayValue, word)
  }
})

test('the LLM wall displays a readable duration AND keeps the exact ms in both row and report', () => {
  const rows = aboutFactRows(readyView())
  const wall = rows.find(row => row.id === 'stats.llmMs')!
  assert.equal(wall.displayValue, '27m58s (1678900 ms)')
  assert.equal(wall.copyValue, '1678900', 'the per-field copy is the exact raw value, not the display abbreviation')
  const report = serializeAboutStatus(readyView())
  assert.match(report, /LLM wall: 27m58s \(1678900 ms\)/u)
})

test('per-field copy uses exact numeric representation, never a rounded display abbreviation', () => {
  const rows = aboutFactRows(readyView())
  const r5 = rows.find(row => row.id === 'performance.R5')!
  assert.equal(r5.displayValue, '33.3 tok/s')
  assert.equal(r5.copyValue, '33.3', 'the raw rate, not the rounded display string')
  const all = rows.find(row => row.id === 'performance.All')!
  assert.equal(all.displayValue, '30 tok/s')
  assert.equal(all.copyValue, '29.97', '29.97 is never rounded to 30 for the copy')
  const cache = rows.find(row => row.id === 'tokens.cacheHitPct')!
  assert.equal(cache.displayValue, '41.6%')
  assert.equal(cache.copyValue, '41.6')
  const percent = rows.find(row => row.id === 'context.percent')!
  assert.equal(percent.displayValue, '35.2%')
  assert.equal(percent.copyValue, '35.15625')
  const ttfb = rows.find(row => row.id === 'performance.recentTTFB')!
  assert.equal(ttfb.copyValue, '812.4', 'TTFB copies the raw ms')
})

test('non-terminating decimal sources keep their exact numeric copy while the display rounds', () => {
  const precise = readyView({
    stats: {
      lifetime: { turns: 1, steps: 1, llmMs: 1_000 },
      tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, cacheHitPct: 100 / 3 },
      recent: { firstTokenMsAvg: 812.4, tokensPerSec: 100 / 3 },
      sessionPerformance: { tokensPerSec: 29.970029970029973 },
    },
    contextUsed: 1,
    contextWindow: 3,
  })
  const rows = aboutFactRows(precise)
  const cache = rows.find(row => row.id === 'tokens.cacheHitPct')!
  assert.equal(cache.displayValue, '33.3%')
  assert.equal(cache.copyValue, String(100 / 3))
  const r5 = rows.find(row => row.id === 'performance.R5')!
  assert.equal(r5.displayValue, '33.3 tok/s')
  assert.equal(r5.copyValue, String(100 / 3))
  const all = rows.find(row => row.id === 'performance.All')!
  assert.equal(all.copyValue, '29.970029970029973')
  const percent = rows.find(row => row.id === 'context.percent')!
  assert.equal(percent.displayValue, '33.3%')
  assert.equal(percent.copyValue, String((1 / 3) * 100))
  const lines = serializeAboutStatus(precise).split('\n')
  assert.ok(lines.includes(`Cache hit: ${100 / 3}%`), 'the report keeps the exact percentage')
  assert.ok(lines.includes(`R5 tokens/sec: ${100 / 3} tok/s`), 'the report keeps the exact rate and unit')
  assert.ok(lines.includes('All tokens/sec: 29.970029970029973 tok/s'))
  assert.ok(lines.includes(`Percent: ${(1 / 3) * 100}%`))
  assert.ok(lines.includes('TTFB (recent): 0.8s (812.4 ms)'), 'the report keeps the exact TTFB ms')
})

test('an unavailable projection keeps the captured session id and words the state Unavailable', () => {
  const view = readyView({ stats: undefined, contextUsed: undefined, context: 'unavailable' })
  const view2: AboutStatusView = { ...view, session: { ...view.session, kind: 'unavailable' } } as AboutStatusView
  const rows = aboutFactRows(view2)
  assert.equal(rows.find(row => row.id === 'session.id')!.displayValue, 'sess-main-0001')
  const state = rows.find(row => row.id === 'status.unavailable')!
  assert.equal(state.displayValue, 'Unavailable')
  assert.equal(state.copyValue, 'Unavailable')
})

test('a degraded view keeps the Projection and final Status rows as unique stable facts', () => {
  const base = readyView({ stats: undefined, contextUsed: undefined, context: 'unavailable' })
  const degraded: AboutStatusView = {
    ...base,
    session: {
      ...base.session,
      kind: 'unavailable',
      projectionUnavailable: true,
      projectionFailed: true,
    },
  } as AboutStatusView
  const rows = aboutFactRows(degraded)
  const factIds = rows.map(row => row.id)
  assert.equal(new Set(factIds).size, factIds.length, `every fact id is unique: ${factIds.join(', ')}`)
  const projection = rows.find(row => row.id === 'status.projection')!
  assert.equal(projection.displayValue, 'Failed')
  assert.equal(projection.copyValue, 'Failed')
  const status = rows.find(row => row.id === 'status.unavailable')!
  assert.equal(status.displayValue, 'Unavailable')
  assert.equal(status.copyValue, 'Unavailable')
})

test('a CJK / control-character fact never carries raw ANSI in a copy value', () => {
  const view = readyView({ title: '重启\u001b[31m生产\u001b[0m服务' })
  const rows = aboutFactRows(view)
  const title = rows.find(row => row.id === 'session.title')!
  assert.ok(!title.copyValue.includes('\u001b'), 'the raw copy value never carries an escape byte')
})

test('Copy All is the deterministic LF serialization: every defined id, sessionless omits the detail groups', () => {
  const report = serializeAboutStatus(readyView())
  const lines = report.split('\n')
  assert.equal(lines[0], 'dsh-pi-tui Status')
  assert.deepEqual(lines.slice(1, 5), ['TUI: 0.5.3', 'DSH: 0.2.1-rc.2', 'Backend: Direct', ''])
  assert.ok(report.includes('\r') === false, 'no CR bytes')
  for (const key of [
    'Session ID: sess-main-0001', 'Title: fix the flux', 'Provider: deepseek', 'Model: deepseek-chat',
    'Reasoning effort: high', 'Preset: pi-tui', 'CWD: /home/u/project/alpha',
    'Turns: 12', 'Steps: 30', 'LLM wall: 27m58s (1678900 ms)',
    'Input tokens: 1234', 'Output tokens: 567', 'Cache read tokens: 890', 'Cache write tokens: 12',
    'Cache hit: 41.6%',
    'TTFB (recent): 0.8s (812.4 ms)', 'R5 tokens/sec: 33.3 tok/s', 'All tokens/sec: 29.97 tok/s',
    'Used tokens: 45000', 'Window tokens: 128000', 'Percent: 35.15625%', 'Observation: Fresh',
  ]) {
    assert.ok(lines.some(line => line === key), `the report line ${key} is present verbatim`)
  }
  assert.ok(!report.includes('🐋') && !report.includes('o\n'), 'the whale artwork is never serialized')

  const sessionless: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: '0.2.1-rc.2', backend: 'direct' },
    session: { kind: 'none' },
    epoch: 9,
  }
  const noneReport = serializeAboutStatus(sessionless)
  assert.match(noneReport, /Session ID: No active session/u)
  assert.ok(!noneReport.includes('Turns:'), 'sessionless omits the detail groups entirely')
  assert.ok(!noneReport.includes('Percent:'))
})

test('one captured revision supplies BOTH the visible and the copied value', () => {
  const view = readyView()
  const rows = aboutFactRows(view)
  const report = serializeAboutStatus(view)
  // The report and the rows come from the SAME input object: mutate nothing,
  // read everything — a second call with the same view is byte-identical.
  assert.equal(serializeAboutStatus(view), report)
  assert.equal(aboutFactRows(view).length, rows.length)
})

// ── RFL-A-008/A-014: loading Copy All completeness + hostile inputs ───────

test('a LOADING live view Copy All serializes the FULL fixed report with pending wording', () => {
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: '0.2.1-rc.2', backend: 'direct' },
    session: { kind: 'loading', sessionId: 'sess-loading-9' },
    epoch: 2,
  }
  const report = serializeAboutStatus(view)
  const lines = report.split('\n')
  for (const key of [
    'Session ID: sess-loading-9',
    'Title: Unavailable', 'Provider: Unavailable', 'Model: Unavailable',
    'Reasoning effort: Unavailable', 'Preset: Unavailable', 'CWD: Unavailable',
    'Turns: Unavailable', 'Steps: Unavailable', 'LLM wall: Unavailable',
    'Input tokens: Unavailable', 'Output tokens: Unavailable',
    'Cache read tokens: Unavailable', 'Cache write tokens: Unavailable', 'Cache hit: Unavailable',
    'TTFB (recent): Unavailable', 'R5 tokens/sec: Unavailable', 'All tokens/sec: Unavailable',
    'Used tokens: Unavailable', 'Window tokens: Unavailable', 'Percent: Unavailable',
    'Observation: Loading…',
    'Status: Loading…',
  ]) {
    assert.ok(lines.some(line => line === key), `the loading report carries ${key}`)
  }
})

test('a hostile Session ID or version never emits terminal controls into Copy All', () => {
  const view: AboutStatusView = {
    runtime: { tui: '1.0.0\u001b]52;c;pw\u0007', dsh: '2.0\u001b[31mred', backend: 'direct' },
    session: {
      kind: 'ready',
      sessionId: 'sess\u001b]0;evil\u0007-id',
      title: 't\u0000itle',
      cwd: '/x\u009bdanger',
      context: 'fresh',
    },
    epoch: 1,
  }
  const report = serializeAboutStatus(view)
  assert.ok(!report.includes('\u001b'), 'no ESC survives the serialization')
  assert.ok(!report.includes('\u009b'), 'no C1 CSI introducer survives')
  assert.ok(!report.includes('pw'), 'the OSC-52 payload dropped with its sequence')
  assert.ok(report.includes('sess-id'), 'the verbatim id text survives (minus the controls)')
  const rows = aboutFactRows(view)
  for (const row of rows) {
    assert.ok(!row.copyValue.includes('\u001b'), `${row.id} copy value is control-safe`)
  }
})

test('the copy control guard applies to the sessionless and loading branches too', () => {
  const loading: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: { kind: 'loading', sessionId: 'sess\u001b]52;c;pw\u0007-id' },
    epoch: 1,
  }
  const loadingId = aboutFactRows(loading).find(row => row.id === 'session.id')!
  assert.equal(loadingId.copyValue, 'sess-id', 'the loading Session ID copy is control-safe')
  const sessionless: AboutStatusView = {
    runtime: { tui: '1.0.0\u001b[31mred', dsh: '2.0\u001b]0;evil\u0007', backend: 'direct' },
    session: { kind: 'none' },
    epoch: 1,
  }
  for (const row of aboutFactRows(sessionless)) {
    assert.ok(!row.copyValue.includes('\u001b'), `${row.id} sessionless copy value is control-safe`)
  }
})

test('C1 controls and C1-introduced sequences are dropped whole while ordinary suffixes survive', () => {
  const cases: readonly [string, string][] = [
    ['title\u0084\u0085\u0088\u008d', 'title'],
    ['pre\u009d52;c;secret\u0007-post', 'pre-post'],
    ['pre\u009b31m-post', 'pre-post'],
    ['pre\u001b]0;secret\u009c-post', 'pre-post'],
    ['pre\u0090secret\u009c-post', 'pre-post'],
    ['pre\u0098sos\u009c-post', 'pre-post'],
    ['pre\u009epm\u009c-post', 'pre-post'],
    ['pre\u009fapc\u009c-post', 'pre-post'],
    ['pre\u009b31m', 'pre'],
    ['pre\u009d0;x', 'pre'],
  ]
  for (const [title, expected] of cases) {
    const view = readyView({ title })
    const row = aboutFactRows(view).find(candidate => candidate.id === 'session.title')!
    assert.equal(row.copyValue, expected, `single-field copy sanitizes ${JSON.stringify(title)}`)
    const reportTitle = serializeAboutStatus(view).split('\n').find(line => line.startsWith('Title:'))!
    assert.equal(reportTitle, `Title: ${expected}`, `Copy All sanitizes ${JSON.stringify(title)}`)
  }
  // The whole standalone 0x80–0x8F C1 range (IND/NEL/HTS/RI and peers) drops.
  let c1 = ''
  for (let code = 0x80; code <= 0x8f; code += 1) c1 += String.fromCharCode(code)
  const standalone = aboutFactRows(readyView({ title: `pre${c1}-post` }))
    .find(candidate => candidate.id === 'session.title')!
  assert.equal(standalone.copyValue, 'pre-post', 'the 0x80–0x8F C1 range is dropped')
})

test('generic ESC sequences drop whole while a bare ESC keeps ordinary Unicode', () => {
  const cases: readonly [string, string][] = [
    ['pre\u001b(B-post', 'pre-post'],
    ['pre\u001b%G-post', 'pre-post'],
    ['pre\u001b#8-post', 'pre-post'],
    ['pre\u001b(B', 'pre'],
    ['pre\u001b鲸-post', 'pre鲸-post'],
    ['pre\u001b😀-post', 'pre😀-post'],
  ]
  for (const [title, expected] of cases) {
    const row = aboutFactRows(readyView({ title })).find(candidate => candidate.id === 'session.title')!
    assert.equal(row.copyValue, expected, `copy sanitizes ${JSON.stringify(title)}`)
    const reportTitle = serializeAboutStatus(readyView({ title })).split('\n').find(line => line.startsWith('Title:'))!
    assert.equal(reportTitle, `Title: ${expected}`, `Copy All sanitizes ${JSON.stringify(title)}`)
  }
})

test('CR/LF/TAB are escaped so a field can never forge a fixed report line', () => {
  const view = readyView({ title: 'normal\nBackend: Remote\r\n\tTabbed' })
  const row = aboutFactRows(view).find(candidate => candidate.id === 'session.title')!
  assert.equal(row.copyValue, 'normal\\nBackend: Remote\\r\\n\\tTabbed')
  const report = serializeAboutStatus(view)
  assert.ok(!report.includes('\r'), 'no raw CR survives')
  assert.equal(
    report.split('\n').filter(line => line.startsWith('Backend:')).length,
    1,
    'the title cannot inject a Backend report line',
  )
  assert.equal(
    report.split('\n').find(line => line.startsWith('Title:')),
    'Title: normal\\nBackend: Remote\\r\\n\\tTabbed',
    'the title stays one escaped line',
  )
})
