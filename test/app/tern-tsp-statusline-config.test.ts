/**
 * TSP-7 PR-D: the configured native statusline projection (source-level).
 *
 * Uses the REAL `createBuiltinFooterRegistry` / `FooterCustomItemCatalog`
 * through `compileNativeFooterPresentation` and asserts the §6.1 matrix on
 * the projected `ui.status`/`ui.seg` nodes: compact's fixed single row,
 * custom's placement keys/duplicate ids/model/tone/prefix/suffix/importance,
 * the unsupported markers (USER command, extension, unknown id), the inert
 * `view-scope`, hostile-text sanitization and the unchanged default shape.
 *
 * @module @xmoon76/dsh-pi-tui/app/tern-tsp-statusline-config
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Node } from '@stencil-hq/tern'
import type { StatusSnapshot } from '../../src/domain/status/types.ts'
import { emptyStatusSnapshot } from '../../src/domain/status/types.ts'
import {
  compileNativeFooterPresentation,
  nativeStatuslineRows,
  type NativeFooterPresentation,
} from '../../src/tui/tsp/statusline-view.ts'
import { resolveTspNativeFooterConfig } from '../../src/domain/footer/tsp-native-config.ts'
import type { FooterCustomTextItemSettings } from '../../src/domain/footer/custom-items.ts'

function props(node: Node): Record<string, unknown> {
  return node.props as Record<string, unknown>
}

function children(node: Node): readonly Node[] {
  return node.children
}

const READY = 'ready'

function presentation(input: {
  doc: { footer: string; footerFallbackMode?: unknown; footerLayout?: unknown }
  userItems?: { items: (FooterCustomTextItemSettings | { schemaVersion: 1; id: string; kind: 'command'; command: string })[]; invalidCount: number }
}): NativeFooterPresentation {
  const userItems = input.userItems ?? { items: [], invalidCount: 0 }
  return compileNativeFooterPresentation(resolveTspNativeFooterConfig({
    doc: input.doc,
    readiness: READY,
    userItems: userItems as never,
  }))
}

/** A snapshot carrying a rich set of facts. */
function fullSnapshot(): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    access: { permissionPreset: { id: 'workspace-write' } },
    workspace: { cwd: '/workspaces/dsh-pi-tui', branch: 'main' },
    collaboration: { plan: { effective: true } },
    composition: { model: { provider: 'deepseek', id: 'luna-fast', reasoningEffort: 'high' } },
    activity: {
      ...base.activity,
      busy: true,
      phase: 'working',
      taskCount: 2,
      taskTotalCount: 3,
      childAgentCount: 1,
      childAgentTotalCount: 2,
      failedTaskCount: 0,
    },
    usage: {
      ...base.usage,
      tokens: { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 },
      context: { usedTokens: 720_000, windowTokens: 1_000_000, percent: 72 },
      performance: { ...base.usage.performance, firstTokenMs: 2600, tokensPerSec: 116, sessionTokensPerSec: 44 },
    },
  } as unknown as StatusSnapshot
}

// ── Compact: the fixed single row ───────────────────────────────────────────

test('compact paints EXACTLY one row with the fixed plan order and priorities', () => {
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'compact' } }))
  assert.equal(rows.length, 1, 'one row only')
  assert.equal(props(rows[0]!).key, 'status-row-1')
  const segs = children(rows[0]!)
  assert.deepEqual(segs.map(seg => props(seg).key), [
    'status-r1-permission',
    'status-r1-cwd',
    'status-r1-git',
    'status-r1-run',
    'status-r1-plan',
    'status-r1-attention',
    'status-r1-context',
  ], 'the compact preset order')
  assert.deepEqual(segs.map(seg => props(seg).priority), [95, 50, 30, 105, 100, 110, 109],
    'attention/context outrank the environment facts in a narrow pane')
  assert.deepEqual(segs.map(seg => props(seg).side), [undefined, undefined, undefined, undefined, 'right', 'right', 'right'])
  assert.ok(!segs.some(seg => String(props(seg).key as string).includes('tokens')), 'no statistics row is fabricated')
  assert.ok(!segs.some(seg => String(props(seg).text as string).includes('luna')), 'no Model is injected into compact')
})

test('compact with no facts paints nothing at all', () => {
  const bare = emptyStatusSnapshot()
  const rows = nativeStatuslineRows({ ...bare, usage: { ...bare.usage, tokens: undefined } } as unknown as StatusSnapshot,
    presentation({ doc: { footer: 'compact' } }))
  assert.equal(rows.length, 0, 'an idle fact-less subject paints no row and no zero')
})

// ── Custom: placements, duplicates, model, tone, prefix/suffix, importance ──

test('custom walks the persisted placements in order with the right side and keys', () => {
  const layout = {
    schemaVersion: 1,
    rows: [
      {
        left: [{ id: 'model', format: 'compact', importance: 90 }, { id: 'git-branch', format: 'label', prefix: 'branch:', importance: 20 }],
        right: [{ id: 'context', format: 'percent', importance: 100 }],
      },
      {
        left: [{ id: 'performance', format: 'latency', importance: 40 }, { id: 'performance', format: 'speed-both', importance: 45 }],
        right: [],
      },
    ],
  }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => props(row).key), ['status-row-1', 'status-row-2'])
  const rowOne = children(rows[0]!)
  assert.deepEqual(rowOne.map(seg => props(seg).key), ['footer-r1-l0', 'footer-r1-l1', 'footer-r1-r0'],
    'keys come from the placement path, not the item id')
  assert.deepEqual(rowOne.map(seg => props(seg).side), [undefined, undefined, 'right'])
  assert.deepEqual(rowOne.map(seg => props(seg).priority), [90, 20, 100], 'the user importance wins over any default')
  const texts = rowOne.map(seg => String(props(seg).text))
  assert.ok(texts[0]!.includes('luna-fast'), `the explicit model renders: ${texts.join(' | ')}`)
  assert.ok(texts[1]!.startsWith('branch:'), `the user prefix decorates a real rendering: ${texts[1]}`)
  assert.ok(texts[1]!.includes('main'))
  assert.ok(texts[2]!.includes('72%'))
  const rowTwo = children(rows[1]!)
  assert.deepEqual(rowTwo.map(seg => props(seg).key), ['footer-r2-l0', 'footer-r2-l1'])
  assert.ok(String(props(rowTwo[0]!).text).includes('TTFB'), 'the latency placement')
  assert.ok(String(props(rowTwo[1]!).text).includes('116'), 'the speed placement keeps BOTH scopes at preferred density')
})

test('a duplicate id keeps two independent segments with different formats and keys', () => {
  const layout = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'performance', format: 'latency' }, { id: 'performance', format: 'speed-all' }], right: [] }],
  }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  const segs = children(rows[0]!)
  assert.equal(segs.length, 2, 'no dedup by id')
  assert.notEqual(props(segs[0]!).key, props(segs[1]!).key)
  assert.ok(String(props(segs[0]!).text).includes('TTFB'))
  assert.ok(String(props(segs[1]!).text).includes('All'))
})

test('an explicit custom tone overrides the item tone; absent keeps the item tone', () => {
  const layout = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'context', tone: 'warning' as const }, { id: 'git-branch' }], right: [] }],
  }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  const segs = children(rows[0]!)
  assert.equal(props(segs[0]!).tone, 'warning', 'the explicit placement tone wins')
  assert.equal(String(props(segs[0]!).text as string).includes('72%'), true, 'the tone override does not change the fact text')
})

test('an explicit palette-only tone (no Tern counterpart) RESETS the item tone instead of falling back', () => {
  // `token-usage` emits `success`; `text`/`primary` are PiTui palette tokens
  // with no negotiated Tern tone. An explicit override to one of them must
  // leave the seg UNTONED (the client's own text styling) — the item's
  // original `success` may not survive the override.
  const layout = {
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'token-usage', format: 'pi', tone: 'text' as const },
        { id: 'git-branch', tone: 'primary' as const },
      ],
      right: [],
    }],
  }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  const segs = children(rows[0]!)
  assert.equal(props(segs[0]!).tone, undefined, 'tone:text resets the token-usage success tone (no fallback)')
  assert.equal(props(segs[1]!).tone, undefined, 'tone:primary resets the item tone too')
  // The control: WITHOUT an override the same items keep their own tones.
  const plain = nativeStatuslineRows(fullSnapshot(), presentation({
    doc: { footer: 'custom', footerLayout: { schemaVersion: 1, rows: [{ left: [{ id: 'token-usage', format: 'pi' }], right: [] }] } },
  }))
  assert.equal(props(children(plain[0]!)[0]!).tone, 'success', 'the un-overridden placement keeps the item tone')
  // And an explicit `auto` keeps the item tone as well.
  const auto = nativeStatuslineRows(fullSnapshot(), presentation({
    doc: { footer: 'custom', footerLayout: { schemaVersion: 1, rows: [{ left: [{ id: 'token-usage', format: 'pi', tone: 'auto' as const }], right: [] }] } },
  }))
  assert.equal(props(children(auto[0]!)[0]!).tone, 'success', "tone:'auto' keeps the item tone")
})

test('a USER text definition renders its persisted text verbatim (USER layer only)', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'user:environment' }], right: [] }] }
  const pres = presentation({
    doc: { footer: 'custom', footerLayout: layout },
    userItems: { items: [{ schemaVersion: 1, id: 'user:environment', kind: 'text', text: 'prod-cluster' }], invalidCount: 0 },
  })
  const rows = nativeStatuslineRows(fullSnapshot(), pres)
  const segs = children(rows[0]!)
  assert.equal(segs.length, 1)
  assert.equal(props(segs[0]!).text, 'prod-cluster')
  assert.equal(props(segs[0]!).key, 'footer-r1-l0')
})

// ── Unsupported: USER command, extension, unknown id, view-scope ────────────

test('a USER command item keeps its placement with the clamped-name unavailable marker', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'user:clock' }, { id: 'cwd' }], right: [] }] }
  const pres = presentation({
    doc: { footer: 'custom', footerLayout: layout },
    userItems: { items: [{ schemaVersion: 1, id: 'user:clock', kind: 'command', command: 'date --rfc-3339=seconds' }], invalidCount: 0 },
  })
  const rows = nativeStatuslineRows(fullSnapshot(), pres)
  const segs = children(rows[0]!)
  assert.equal(segs.length, 2, 'the placement is kept, never dropped')
  assert.equal(props(segs[0]!).text, 'Unavailable: clock')
  assert.equal(props(segs[0]!).tone, 'warning')
  assert.equal(props(segs[0]!).priority, 70, 'the fixed unsupported priority (ref.importance absent)')
  assert.equal(String(props(segs[0]!).text).includes('date'), false, 'the command string itself is never painted')
  assert.ok(String(props(segs[1]!).text).includes('dsh-pi-tui'), 'the sibling keeps rendering')
})

test('a long command item name clamps to the visible bound', () => {
  const longName = 'an-environment-name-that-is-far-too-long-for-one-status-segment'
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: `user:${longName}` }], right: [] }] }
  const pres = presentation({
    doc: { footer: 'custom', footerLayout: layout },
    userItems: { items: [{ schemaVersion: 1, id: `user:${longName}`, kind: 'command', command: 'echo x' }], invalidCount: 0 },
  })
  const rows = nativeStatuslineRows(fullSnapshot(), pres)
  const text = String(props(children(rows[0]!)[0]!).text)
  assert.ok(text.startsWith('Unavailable: '))
  assert.ok(!text.includes(longName), 'the full name is clamped away')
})

test('an unknown user id and an unknown plain id render the item marker', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'user:ghost' }, { id: 'no-such-item' }], right: [] }] }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  const segs = children(rows[0]!)
  assert.deepEqual(segs.map(seg => String(props(seg).text)), ['Unavailable: item', 'Unavailable: item'])
  assert.equal(props(segs[0]!).tone, 'warning')
})

test('extension items (the ext:* bridge and an owned ext item) render the extension marker', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'ext:*' }, { id: 'ext:acme/uptime' }], right: [] }] }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  const segs = children(rows[0]!)
  assert.deepEqual(segs.map(seg => String(props(seg).text)), ['Unavailable: extension', 'Unavailable: extension'])
  assert.equal(props(segs[0]!).tone, 'warning')
})

test('the retired view-scope placement is inert, not unsupported', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'view-scope' }, { id: 'cwd' }], right: [] }] }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  const segs = children(rows[0]!)
  assert.equal(segs.length, 1, 'view-scope contributes no segment and no marker')
  assert.ok(String(props(segs[0]!).text).includes('dsh-pi-tui'))
})

test('an unavailable placement never carries the user prefix/suffix', () => {
  const layout = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'user:clock', prefix: 'at:', suffix: '!' }], right: [] }],
  }
  const pres = presentation({
    doc: { footer: 'custom', footerLayout: layout },
    userItems: { items: [{ schemaVersion: 1, id: 'user:clock', kind: 'command', command: 'date' }], invalidCount: 0 },
  })
  const rows = nativeStatuslineRows(fullSnapshot(), pres)
  assert.equal(String(props(children(rows[0]!)[0]!).text), 'Unavailable: clock',
    'decoration is for real renderings only')
})

// ── Sanitization and unknown formats ────────────────────────────────────────

test('hostile USER text cannot smuggle control sequences into ui.seg', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'user:env' }], right: [] }] }
  // The domain parser REJECTS control characters, so this hostile value goes
  // through a synthetic catalog compiled from an already-parsed definition —
  // the render path's own last-line sanitization is the witness under test.
  const pres = compileNativeFooterPresentation({
    mode: 'custom',
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'user:env' }], right: [] }] },
    userTextItems: [{ schemaVersion: 1, id: 'user:env', kind: 'text', text: 'bad\x1b]52;c;oops\x07\x02stuff\rcode' }],
    userCommandIds: new Set<string>(),
    notices: [],
  })
  const rows = nativeStatuslineRows(fullSnapshot(), pres)
  const text = String(props(children(rows[0]!)[0]!).text)
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text), `no C0/C1 survives: ${JSON.stringify(text)}`)
  assert.ok(!text.includes('\x1b'), 'no ESC byte survives')
})

test('an unknown format degrades to the builtin formatter default, never a crash', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'git-branch', format: 'a-format-that-does-not-exist' }], right: [] }] }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  const segs = children(rows[0]!)
  assert.equal(segs.length, 1)
  assert.ok(String(props(segs[0]!).text).includes('main'), 'the builtin fail-soft default renders the branch')
})

// ── Default unchanged under a presentation ──────────────────────────────────

test('a default-mode presentation keeps the frozen PR-A/B two-row shape', () => {
  const snapshot = fullSnapshot()
  const withDefault = nativeStatuslineRows(snapshot, presentation({ doc: { footer: 'default' } }))
  const without = nativeStatuslineRows(snapshot)
  assert.equal(withDefault.length, without.length)
  for (const [index, row] of withDefault.entries()) {
    assert.deepEqual(props(row), props(without[index]))
    assert.deepEqual(children(row).map(seg => props(seg)), children(without[index]!).map(seg => props(seg)))
  }
})

test('command fallback with footerFallbackMode compact projects the compact row', () => {
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'command', footerFallbackMode: 'compact' } }))
  assert.equal(rows.length, 1)
  assert.equal(props(rows[0]!).key, 'status-row-1')
  const segs = children(rows[0]!)
  assert.equal(segs.length, 7, 'the full busy compact row')
})

test('a one-row custom layout mounts exactly one status node', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'cwd' }], right: [{ id: 'context' }] }] }
  const rows = nativeStatuslineRows(fullSnapshot(), presentation({ doc: { footer: 'custom', footerLayout: layout } }))
  assert.equal(rows.length, 1)
  assert.deepEqual(children(rows[0]!).map(seg => props(seg).side), [undefined, 'right'])
})

// ── Mount-local registry ownership (the plan §3.3 single-registry rule) ─────

test('two mounts with different USER text definitions never share definitions', () => {
  const mountPres = (text: string): NativeFooterPresentation => compileNativeFooterPresentation({
    mode: 'custom',
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'user:environment' }], right: [] }] },
    userTextItems: [{ schemaVersion: 1, id: 'user:environment', kind: 'text', text }],
    userCommandIds: new Set<string>(),
    notices: [],
  })
  const first = mountPres('mount-one-value')
  const second = mountPres('mount-two-value')
  const rowsOf = (pres: NativeFooterPresentation): string[] =>
    nativeStatuslineRows(fullSnapshot(), pres).flatMap(row => children(row).map(seg => String(props(seg).text)))
  assert.ok(rowsOf(first).includes('mount-one-value'), JSON.stringify(rowsOf(first)))
  assert.ok(rowsOf(second).includes('mount-two-value'), JSON.stringify(rowsOf(second)))
  // The first mount's compiled projection is IMMUTABLE: re-rendering it after
  // the second mount compiled still paints its OWN value.
  assert.ok(rowsOf(first).includes('mount-one-value'))
  assert.notEqual(first.registry, second.registry, 'each mount owns its own registry instance')
})

test('repeat status repaints reuse the SAME compiled presentation (no per-frame rebuild)', () => {
  const pres = presentation({
    doc: { footer: 'custom', footerLayout: { schemaVersion: 1, rows: [{ left: [{ id: 'user:environment' }], right: [] }] } },
    userItems: { items: [{ schemaVersion: 1, id: 'user:environment', kind: 'text', text: 'stable' }], invalidCount: 0 },
  })
  const registry = pres.registry
  for (let repeat = 0; repeat < 5; repeat += 1) {
    nativeStatuslineRows(fullSnapshot(), pres)
    assert.equal(pres.registry, registry, `the registry instance survives repaint #${repeat}`)
  }
})
