/**
 * Headless tests for the builtin footer items (plan §7/§13.3): each item
 * renders the right segment from the snapshot, returns null when its fact
 * is absent, and never throws.
 * @module @xmoon76/dsh-pi-tui/footer-items.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { createBuiltinFooterRegistry } from '../src/tui/footer/builtin-items.ts'
import { FooterComposer, renderSpans } from '../src/tui/footer/composer.ts'
import { isFooterLayout, parseFooterLayout } from '../src/domain/footer/layout.ts'
import type { FooterItemRef } from '../src/tui/footer/presentation-types.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'

const registry = createBuiltinFooterRegistry()
const CONTEXT = { taskBrowserAvailable: true, extensionFooterText: '' }
const REF: FooterItemRef = { id: 'x' }

/** Strip ANSI SGR sequences for text-level assertions. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function render(id: string, snapshot: StatusSnapshot, ref: FooterItemRef = REF): string {
  const def = registry.get(id)
  assert.ok(def !== undefined, `item ${id} must be registered`)
  const segment = def.render(snapshot, ref, 'preferred', CONTEXT)
  return segment === null ? '' : plain(renderSpans(segment.spans))
}

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

function snapshotWith(patch: (snap: DeepMutable<StatusSnapshot>) => void): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  patch(snap)
  return snap as StatusSnapshot
}

test('permission-preset renders the four legacy badges and nothing else', () => {
  const cases: Array<[string, string]> = [
    ['danger-full-access', '[yolo]'],
    ['read-only', '[read-only]'],
    ['workspace-write', '[workspace-write]'],
    ['custom', '[custom]'],
  ]
  for (const [id, expected] of cases) {
    const text = render('permission-preset', snapshotWith(snap => {
      snap.access.permissionPreset = { id, label: id, matched: id !== 'custom' }
    }))
    assert.equal(text, expected, `preset ${id}`)
  }
  // Unknown preset names are not badged (legacy parity).
  const unknown = render('permission-preset', snapshotWith(snap => {
    snap.access.permissionPreset = { id: 'code', label: 'PTC mode', matched: true }
  }))
  assert.equal(unknown, '')
  // Absent preset → nothing.
  assert.equal(render('permission-preset', emptyStatusSnapshot()), '')
})

test('plan-state renders [plan] only while effective', () => {
  const on = render('plan-state', snapshotWith(snap => { snap.collaboration.plan.effective = true }))
  assert.equal(on, '[plan]')
  assert.equal(render('plan-state', emptyStatusSnapshot()), '')
})

test('plan-state renders [plan pending] for BOTH pending directions (plan §4.3)', () => {
  // Pending ENTER: the user selected plan mode, not yet effective.
  const entering = render('plan-state', snapshotWith(snap => {
    snap.collaboration.plan = { effective: false, pending: true }
  }))
  assert.equal(entering, '[plan pending]', 'pending enter must badge [plan pending]')
  // Pending EXIT: the user selected exit, plan still effective until applied.
  const exiting = render('plan-state', snapshotWith(snap => {
    snap.collaboration.plan = { effective: true, pending: false }
  }))
  assert.equal(exiting, '[plan pending]', 'pending exit must badge [plan pending]')
  // Effective with no pending stays the plain badge.
  const plainBadge = render('plan-state', snapshotWith(snap => {
    snap.collaboration.plan = { effective: true }
  }))
  assert.equal(plainBadge, '[plan]')
})

test('model renders the legacy label with the effort; absent → nothing', () => {
  const plain = render('model', snapshotWith(snap => {
    snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
  }))
  assert.equal(plain, '[deepseek/flash]')
  const effort = render('model', snapshotWith(snap => {
    snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash', reasoningEffort: 'high' }
  }))
  assert.equal(effort, '[deepseek/flash @high]')
  assert.equal(render('model', emptyStatusSnapshot()), '')
})

test('tasks renders the combined badge with the ↓ hint from the context', () => {
  const both = render('tasks', snapshotWith(snap => {
    snap.activity.taskCount = 1
    snap.activity.childAgentCount = 2
  }))
  assert.equal(both, '[1 task running · 2 agents · ↓ view]')
  // The hint drops when the editor has a draft (the host surface context).
  const def = registry.get('tasks')!
  const withDraft = def.render(snapshotWith(snap => { snap.activity.taskCount = 1 }), REF, 'preferred', { ...CONTEXT, taskBrowserAvailable: false })
  assert.equal(withDraft === null ? '' : plain(renderSpans(withDraft.spans)), '[1 task running]')
  assert.equal(render('tasks', emptyStatusSnapshot()), '')
})

test('cwd shortens to the last two segments; empty → nothing', () => {
  const text = render('cwd', snapshotWith(snap => { snap.workspace.cwd = '/a/b/c/d' }))
  assert.equal(text, 'c/d')
  assert.equal(render('cwd', emptyStatusSnapshot()), '')
})

test('cwd styles handle POSIX and Windows separators without losing roots', () => {
  const windows = snapshotWith(snap => { snap.workspace.cwd = 'C:\\Users\\alice\\project' })
  assert.equal(render('cwd', windows, { id: 'cwd', format: 'short' }), 'alice/project')
  assert.equal(render('cwd', windows, { id: 'cwd', format: 'basename' }), 'project')
  assert.equal(render('cwd', windows, { id: 'cwd', format: 'full' }), 'C:\\Users\\alice\\project')

  const posixBackslash = snapshotWith(snap => { snap.workspace.cwd = '/home/foo\\bar/project' })
  assert.equal(render('cwd', posixBackslash, { id: 'cwd', format: 'short' }), 'foo\\bar/project')
  assert.equal(render('cwd', posixBackslash, { id: 'cwd', format: 'basename' }), 'project')

  const posixRoot = snapshotWith(snap => { snap.workspace.cwd = '/' })
  assert.equal(render('cwd', posixRoot, { id: 'cwd', format: 'short' }), '/')
  assert.equal(render('cwd', posixRoot, { id: 'cwd', format: 'basename' }), '/')
  const unc = snapshotWith(snap => { snap.workspace.cwd = '\\\\server\\share\\project' })
  assert.equal(render('cwd', unc, { id: 'cwd', format: 'short' }), 'share/project')
  assert.equal(render('cwd', unc, { id: 'cwd', format: 'basename' }), 'project')
  const windowsRoot = snapshotWith(snap => { snap.workspace.cwd = 'C:/' })
  assert.equal(render('cwd', windowsRoot, { id: 'cwd', format: 'short' }), 'C:/')
  assert.equal(render('cwd', windowsRoot, { id: 'cwd', format: 'basename' }), 'C:/')
})

test('git-branch renders the branch; empty → nothing', () => {
  const text = render('git-branch', snapshotWith(snap => { snap.workspace.branch = 'main' }))
  assert.equal(text, 'main')
  assert.equal(render('git-branch', emptyStatusSnapshot()), '')
})

test('context renders the legacy bar and the full formatter', () => {
  const bar = render('context', snapshotWith(snap => {
    snap.usage.context = { usedTokens: 25000, windowTokens: 100000, percent: 25 }
  }))
  assert.equal(bar, '[███░░░░░░░░░] 25%')
  const full = render('context', snapshotWith(snap => {
    snap.usage.context = { usedTokens: 160000, windowTokens: 1_000_000, percent: 16 }
  }), { id: 'x', format: 'full' })
  // The pi vocabulary's formatTokens (the plan's screenshot shows 160.0K;
  // the established formatter renders 160k — display words are the
  // formatter's, never the snapshot's).
  assert.equal(full, '160k/1.0M (16%)')
  assert.equal(render('context', emptyStatusSnapshot()), '')
})

test('focus-mode keeps its legacy id but follows the canonical display preset', () => {
  assert.equal(render('focus-mode', snapshotWith(snap => { snap.interaction.displayPreset = 'focus' })), 'focus')
  assert.equal(render('focus-mode', snapshotWith(snap => { snap.interaction.displayPreset = 'full' })), '')
  assert.equal(render('focus-mode', snapshotWith(snap => { snap.interaction.displayPreset = 'compact' })), '')
})

test('display-preset is the canonical always-visible preset indicator', () => {
  assert.equal(render('display-preset', snapshotWith(snap => { snap.interaction.displayPreset = 'full' })), 'full')
  assert.equal(render('display-preset', snapshotWith(snap => { snap.interaction.displayPreset = 'focus' })), 'focus')
  assert.equal(render('display-preset', snapshotWith(snap => { snap.interaction.displayPreset = 'compact' })), 'compact')
})

test('turns-steps renders tN/sN', () => {
  const text = render('turns-steps', snapshotWith(snap => {
    snap.usage.turns = 3
    snap.usage.steps = 7
  }))
  assert.equal(text, 't3/s7')
})

test('stats-line renders the pi vocabulary from the structured usage', () => {
  const text = render('stats-line', snapshotWith(snap => {
    snap.usage.tokens = { input: 1200, output: 3400, cacheRead: 0, cacheWrite: 0 }
    snap.usage.performance = { llmMs: 8100, firstTokenMs: 0, tokensPerSec: 0 }
  }))
  // The performance tail is recent-only — the lifetime LLM wall never
  // appears in the display line.
  assert.equal(text, '↑1.2k ↓3.4k | TTFB 0s · 0 tok/s')
  assert.ok(!text.includes('LLM'))
})

test('view-scope is retired: it stays registered but renders nothing', () => {
  // The child identity moved to the header-adjacent viewer subject bar. The
  // id stays registered (and parseable) so a legacy custom layout that
  // references it still loads/edits/saves, but it contributes no segment.
  const running = render('view-scope', snapshotWith(snap => {
    snap.view.subject = { kind: 'subagent', id: 'c1', label: 'research', mode: 'continuable', activity: 'running' }
  }))
  assert.equal(running, '', 'the retired view-scope item renders nothing')
  assert.equal(render('view-scope', emptyStatusSnapshot()), '')
  assert.ok(registry.ids().includes('view-scope'), 'the retired id stays registered for legacy layouts')
})

test('ext:* bridges the extension footer text; empty → nothing', () => {
  const def = registry.get('ext:*')!
  const withText = def.render(emptyStatusSnapshot(), REF, 'preferred', { ...CONTEXT, extensionFooterText: '[EXT]' })
  assert.equal(withText === null ? '' : plain(renderSpans(withText.spans)), '[EXT]')
  assert.equal(render('ext:*', emptyStatusSnapshot()), '')
})

test('builtin styles render meaningful golden variants without changing defaults', () => {
  const snap = snapshotWith(current => {
    current.composition.agentPreset = { id: 'code', label: 'Code preset', shortLabel: 'CP' }
    current.composition.model = {
      provider: 'deepseek',
      id: 'flash',
      displayName: 'flash',
      reasoningEffort: 'high',
    }
    current.access.permissionPreset = { id: 'read-only', label: 'read-only', matched: true }
    current.collaboration.plan = { effective: true }
    current.workspace = { cwd: '/home/x/proj', branch: 'main' }
    current.usage.context = { usedTokens: 25_000, windowTokens: 100_000, percent: 25 }
    current.usage.tokens = { input: 1_200, output: 3_400, cacheRead: 2_000, cacheWrite: 100 }
    current.usage.cacheHitPct = 91.9
    current.usage.performance = { llmMs: 1_104_000, firstTokenMs: 1_800, tokensPerSec: 40, sessionTokensPerSec: 12 }
    current.usage.turns = 3
    current.usage.steps = 7
    current.host.dshVersion = '1.2.3'
  })

  const cases: Array<{ id: string; formats: Array<[string, string]> }> = [
    {
      id: 'model',
      formats: [
        ['badge', '[deepseek/flash @high]'],
        ['plain', 'deepseek/flash @high'],
        ['compact', 'flash'],
      ],
    },
    {
      id: 'agent-preset',
      formats: [['badge', '[Code preset]'], ['compact', '[CP]']],
    },
    {
      id: 'permission-preset',
      formats: [
        ['badge', '[read-only]'],
        ['plain', 'read-only'],
        ['compact', 'ro'],
      ],
    },
    {
      id: 'plan-state',
      formats: [['badge', '[plan]'], ['plain', 'plan']],
    },
    {
      id: 'cwd',
      formats: [['short', 'x/proj'], ['basename', 'proj'], ['full', '/home/x/proj']],
    },
    {
      id: 'git-branch',
      formats: [['plain', 'main'], ['label', 'branch: main']],
    },
    {
      id: 'context',
      formats: [
        ['bar', '[███░░░░░░░░░] 25%'],
        ['percent', 'ctx 25%'],
        ['full', '25k/100k (25%)'],
      ],
    },
    {
      id: 'token-usage',
      formats: [
        ['pi', '↑1.2k ↓3.4k R2.0k W100'],
        ['io', '1200/3400'],
        ['total', '6.7k tokens'],
        ['compact', '6.7k'],
      ],
    },
    {
      id: 'cache-hit',
      formats: [['pi', 'CH91.9%'], ['full', 'C 91.9%'], ['compact', '91.9%']],
    },
    {
      id: 'performance',
      formats: [
        ['full', 'TTFB 1.8s · R5 40 tok/s'],
        ['speed', 'R5 40 tok/s'],
        ['speed-all', 'All 12 tok/s'],
        ['speed-both', 'R5 40 · All 12 tok/s'],
        ['latency', 'TTFB 1.8s'],
      ],
    },
    {
      id: 'turns-steps',
      formats: [['both', 't3/s7'], ['turns', 't3'], ['steps', 's7']],
    },
    {
      id: 'version',
      formats: [['tui', 'v0.0.0'], ['dsh', 'dsh-1.2.3'], ['both', 'dsh-1.2.3/tui-0.0.0']],
    },
  ]

  for (const { id, formats } of cases) {
    const def = registry.get(id)!
    assert.deepEqual(def.formats, formats.map(([format]) => format), `${id} format catalog`)
    const outputs = formats.map(([format, expected]) => {
      assert.equal(render(id, snap, { id, format }), expected, `${id}/${format}`)
      return expected
    })
    assert.ok(new Set(outputs).size > 1, `${id} formats must not all render identically`)
  }

  // Keep the invariant registry-wide: a future multi-format builtin cannot
  // silently escape the golden catalog above by being omitted from the list.
  for (const id of registry.ids()) {
    const def = registry.get(id)!
    if (def.formats.length <= 1) continue
    const rendered = def.formats.map(format => render(id, snap, { id, format }))
    assert.ok(rendered.every(text => text !== ''), `${id} every declared format must render in the fixture`)
    assert.ok(new Set(rendered).size > 1, `${id} formats must not all render identically`)
  }

  // A ref without an explicit format still selects each definition's old
  // default formatter, so adding choices cannot alter the native layout.
  assert.equal(render('model', snap), '[deepseek/flash @high]')
  assert.equal(render('permission-preset', snap), '[read-only]')
  assert.equal(render('plan-state', snap), '[plan]')
  assert.equal(render('cwd', snap), 'x/proj')
  assert.equal(render('git-branch', snap), 'main')
  assert.equal(render('context', snap), '[███░░░░░░░░░] 25%')
  assert.equal(render('token-usage', snap), '1200/3400')
  assert.equal(render('cache-hit', snap), 'C 91.9%')
  assert.equal(render('performance', snap), 'TTFB 1.8s · R5 40 tok/s')
  assert.equal(render('turns-steps', snap), 't3/s7')
})

test('new builtin styles fall back to the unchanged default formatter', () => {
  const snap = snapshotWith(current => {
    current.composition.agentPreset = { id: 'code', label: 'Code preset' }
    current.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
    current.access.permissionPreset = { id: 'read-only', label: 'read-only', matched: true }
    current.collaboration.plan = { effective: true }
    current.workspace = { cwd: '/home/x/proj', branch: 'main' }
    current.usage.context = { usedTokens: 25_000, windowTokens: 100_000, percent: 25 }
    current.usage.tokens = { input: 1_200, output: 3_400, cacheRead: 0, cacheWrite: 0 }
    current.usage.cacheHitPct = 50
    current.usage.performance = { llmMs: 8_100, firstTokenMs: 0, tokensPerSec: 40 }
    current.host.dshVersion = '1.2.3'
  })
  assert.equal(render('agent-preset', snap, { id: 'agent-preset', format: 'unknown' }), '[Code preset]')
  assert.equal(render('agent-preset', snap, { id: 'agent-preset', format: 'compact' }), '[Code preset]')
  assert.equal(render('model', snap, { id: 'model', format: 'unknown' }), '[deepseek/flash]')
  assert.equal(render('permission-preset', snap, { id: 'permission-preset', format: 'unknown' }), '[read-only]')
  assert.equal(render('plan-state', snap, { id: 'plan-state', format: 'unknown' }), '[plan]')
  assert.equal(render('cwd', snap, { id: 'cwd', format: 'unknown' }), 'x/proj')
  assert.equal(render('git-branch', snap, { id: 'git-branch', format: 'unknown' }), 'main')
  assert.equal(render('context', snap, { id: 'context', format: 'unknown' }), '[███░░░░░░░░░] 25%')
  assert.equal(render('turns-steps', snap, { id: 'turns-steps', format: 'unknown' }), 't0/s0')
  assert.equal(render('cache-hit', snap, { id: 'cache-hit', format: 'unknown' }), 'C 50.0%')
  assert.equal(render('token-usage', snap, { id: 'token-usage', format: 'unknown' }), '1200/3400')
  assert.equal(render('performance', snap, { id: 'performance', format: 'unknown' }), 'TTFB 0s · R5 40 tok/s')
  assert.equal(render('version', snap, { id: 'version', format: 'unknown' }), 'v0.0.0')
  // `plain` (turns) and `compact` (performance) appeared in older custom
  // documents even though they were never declared meaningful styles. They
  // still degrade to the same effective legacy defaults instead of changing
  // old layouts on load (performance's legacy 'compact' fallback is the
  // full style — now the recent TTFB + throughput pair).
  assert.equal(render('turns-steps', snap, { id: 'turns-steps', format: 'plain' }), 't0/s0')
  assert.equal(render('performance', snap, { id: 'performance', format: 'compact' }), 'TTFB 0s · R5 40 tok/s')
})

test('unknown persisted formats survive parsing and fail soft in the real composer', () => {
  const snap = snapshotWith(current => {
    current.usage.tokens = { input: 1_200, output: 3_400, cacheRead: 0, cacheWrite: 0 }
    current.usage.cacheHitPct = 50
    current.usage.performance = { llmMs: 8_100, firstTokenMs: 0, tokensPerSec: 40 }
  })
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'performance', format: 'future-performance' },
        { id: 'cache-hit', format: 'future-cache' },
        { id: 'token-usage', format: 'future-tokens' },
      ],
      right: [],
    }],
  })
  assert.ok(isFooterLayout(parsed), 'unknown format strings must remain valid persisted layout data')
  const output = new FooterComposer(registry).render({
    snapshot: snap,
    layout: parsed,
    width: 40,
    context: CONTEXT,
  })
  for (const row of output.split('\n')) {
    assert.ok(visibleWidth(row) <= 40, `composer output overflows: ${JSON.stringify(row)}`)
  }
  const text = plain(output)
  assert.ok(text.includes('TTFB 0s · R5 40 tok/s'), `performance must use its default: ${text}`)
  assert.ok(!text.includes('LLM'), `no lifetime LLM wall in the performance tail: ${text}`)
  assert.ok(text.includes('C 50.0%'), `cache hit must use its default: ${text}`)
  assert.ok(text.includes('1200/3400'), `token usage must use its default: ${text}`)
})

test('the registry rejects duplicate ids and lists every id', () => {
  const def = registry.get('model')!
  const registry2 = createBuiltinFooterRegistry()
  assert.throws(() => registry2.register(def), /duplicate footer item id/)
  assert.ok(registry.ids().includes('model'))
  assert.ok(registry.ids().includes('view-scope'))
  assert.ok(registry.ids().includes('ext:*'))
})

test('an unknown format string degrades to the item default, never throws', () => {
  // The layout parser accepts any format string (extension items declare
  // their own); builtin items must fall back to their default formatter.
  const model = render('model', snapshotWith(snap => {
    snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
  }), { id: 'x', format: 'zzz-not-a-format' })
  assert.equal(model, '[deepseek/flash]', 'the unknown format must render the default label')
  const context = render('context', snapshotWith(snap => {
    snap.usage.context = { usedTokens: 25000, windowTokens: 100000, percent: 25 }
  }), { id: 'x', format: 'zzz' })
  assert.equal(context, '[███░░░░░░░░░] 25%', 'the unknown context format must fall back to the default bar')
})

test('every performance format renders its own scope in preferred/compact forms', () => {
  const snap = snapshotWith(snap => {
    snap.usage.performance = { llmMs: 138_800, firstTokenMs: 2_600, tokensPerSec: 659, sessionTokensPerSec: 44 }
  })
  const def = registry.get('performance')!
  const renderAt = (format: string, density: 'preferred' | 'compact'): string => {
    const segment = def.render(snap, { id: 'performance', format }, density, CONTEXT)
    return segment === null ? '' : plain(renderSpans(segment.spans))
  }
  // preferred: latency carries the TTFB marker, `speed` the R5 rate,
  // `speed-all` the whole-Session rate, `speed-both` the labelled pair (ONE
  // unit), `full` TTFB beside R5.
  assert.equal(renderAt('latency', 'preferred'), 'TTFB 2.6s')
  assert.equal(renderAt('speed', 'preferred'), 'R5 659 tok/s')
  assert.equal(renderAt('speed-all', 'preferred'), 'All 44 tok/s')
  assert.equal(renderAt('speed-both', 'preferred'), 'R5 659 · All 44 tok/s')
  assert.equal(renderAt('full', 'preferred'), 'TTFB 2.6s · R5 659 tok/s')
  // compact: shortened forms. The pair collapses to its LEADING fact (the
  // recent rate) so a narrow row never carries two rates; the other formats
  // keep their own fact.
  assert.equal(renderAt('latency', 'compact'), '2.6s')
  assert.equal(renderAt('speed', 'compact'), 'R5 659t/s')
  assert.equal(renderAt('speed-all', 'compact'), 'All 44t/s')
  assert.equal(renderAt('speed-both', 'compact'), 'R5 659t/s')
  assert.equal(renderAt('full', 'compact'), '2.6s R5 659t/s')
  // The lifetime LLM wall is gone from every form.
  for (const format of ['full', 'speed', 'speed-all', 'speed-both', 'latency']) {
    for (const density of ['preferred', 'compact'] as const) {
      assert.ok(!renderAt(format, density).includes('138.8'), `${format}/${density} must not show llmMs`)
    }
  }
})

test('token-usage:pi and cache-hit:pi render the pi vocabulary with compact pressure forms', () => {
  const snap = snapshotWith(snap => {
    snap.usage.tokens = { input: 114_000_000, output: 54_000, cacheRead: 520_000, cacheWrite: 12_000 }
    snap.usage.cacheHitPct = 93.9
  })
  // Zero-valued cache terms hide (the plan's preferred example).
  const noCache = snapshotWith(snap => {
    snap.usage.tokens = { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 }
  })
  assert.equal(render('token-usage', noCache, { id: 'token-usage', format: 'pi' }), '↑114M ↓54k')
  assert.equal(render('token-usage', snap, { id: 'token-usage', format: 'pi' }), '↑114M ↓54k R520k W12k')
  assert.equal(render('cache-hit', snap, { id: 'cache-hit', format: 'pi' }), 'CH93.9%')
  // Compact pressure keeps the io pair and drops the cache detail.
  const def = registry.get('token-usage')!
  const segment = def.render(snap, { id: 'token-usage', format: 'pi' }, 'compact', CONTEXT)
  assert.equal(segment === null ? '' : plain(renderSpans(segment.spans)), '↑114M ↓54k')
  const cacheDef = registry.get('cache-hit')!
  const cacheSegment = cacheDef.render(snap, { id: 'cache-hit', format: 'pi' }, 'compact', CONTEXT)
  assert.equal(cacheSegment === null ? '' : plain(renderSpans(cacheSegment.spans)), '93.9%')
})

test('the footer stats line and the /status detail line are SEPARATE contracts', async () => {
  // The footer's stats-line is chrome: recent metrics only, no lifetime
  // LLM wall. The /status Stats row (formatStatsFacts) is the DETAIL
  // surface: it keeps the labeled lifetime wall beside the recent metrics.
  // They share the pi token vocabulary but must never be forced into string
  // equality — the old source-consistency guard pinned them together and
  // would have dragged the LLM wall back into every footer.
  const { formatStatsLine } = await import('../src/tui/footer/formatters.ts')
  const { formatStatsFacts } = await import('../src/tui/commands/status.ts')
  const { sessionStatsFactsOf } = await import('../src/domain/status/stats.ts')
  const { usageFromStats } = await import('../src/domain/status/derive-usage.ts')
  const stats = {
    turns: 12,
    steps: 38,
    llmMs: 120_000,
    cacheHitPct: 91.9,
    inputTokens: 2_579,
    outputTokens: 5_507,
    contextWindow: 1_000_000,
    cacheReadTokens: 20_000,
    cacheWriteTokens: 0,
  }
  // PR-2: the measured performance values are the Host projection's, injected
  // into the usage section (the fold no longer carries them).
  const hostPerformance = { firstTokenMs: 2_000, tokensPerSec: 40, sessionTokensPerSec: 12 }
  const baseUsage = usageFromStats(stats)
  const usage = { ...baseUsage, performance: { ...baseUsage.performance, ...hostPerformance } }
  const footerLine = formatStatsLine(usage)
  const detailLine = formatStatsFacts(sessionStatsFactsOf(stats, hostPerformance))
  assert.ok(!footerLine.includes('LLM'), `the footer line carries no lifetime wall:\n${footerLine}`)
  assert.ok(footerLine.includes('TTFB 2s') && footerLine.includes('40 tok/s'), `recent metrics on the footer line:\n${footerLine}`)
  assert.ok(detailLine.includes('LLM 2m00s'), `the detail line keeps the lifetime wall:\n${detailLine}`)
  assert.ok(detailLine.includes('TTFB 2s') && detailLine.includes('R5 40 tok/s') && detailLine.includes('All 12 tok/s'),
    `the Host facts on the detail line:\n${detailLine}`)
  // The token/cache prefix stays IDENTICAL between the two surfaces.
  const tokenSegment = '↑2.6k ↓5.5k R20k CH91.9%'
  assert.equal(footerLine.split(' | ')[0], tokenSegment, `shared pi vocabulary:\n${footerLine}`)
  assert.ok(detailLine.includes(tokenSegment), `shared pi vocabulary:\n${detailLine}`)
})

test('an unavailable token projection renders the performance segment alone (no orphan separator)', async () => {
  const { formatStatsLine, formatStatsLineCompact } = await import('../src/tui/footer/formatters.ts')
  const { usageFromStats } = await import('../src/domain/status/derive-usage.ts')
  const stats = {
    turns: 12,
    steps: 38,
    llmMs: 120_000,
    cacheHitPct: 91.9,
    inputTokens: 2_579,
    outputTokens: 5_507,
    contextWindow: 1_000_000,
    cacheReadTokens: 20_000,
    cacheWriteTokens: 0,
  }
  // The Remote branch with an unavailable `tokenUsage`/context: the official
  // override is present but empty, so the token facts are UNKNOWN (omitted)
  // while the Host-projection performance metrics still render.
  const base = usageFromStats(stats, undefined, {})
  const usage = { ...base, performance: { ...base.performance, firstTokenMs: 2_000, tokensPerSec: 40 } }
  assert.equal(usage.tokens, undefined, 'no owned token facts')
  const line = formatStatsLine(usage)
  const compact = formatStatsLineCompact(usage)
  assert.equal(line.startsWith('| ') || line.startsWith(' | '), false, `no leading separator:\n${line}`)
  assert.equal(line, 'TTFB 2s · 40 tok/s', `the performance segment alone:\n${line}`)
  assert.equal(compact.startsWith('· ') || compact.startsWith(' · '), false, `no leading separator (compact):\n${compact}`)
  assert.equal(compact, 'TTFB 2s · 40t/s', `the performance segment alone (compact):\n${compact}`)
})

test('PR5: unavailable recent metrics omit the performance segments (never a zero stand-in)', () => {
  const unavailable = snapshotWith(snap => {
    snap.usage.tokens = { input: 1200, output: 3400, cacheRead: 0, cacheWrite: 0 }
    snap.usage.performance = { llmMs: 8100 }
  })
  // stats-line: the token segment survives; the recent tail is omitted.
  assert.equal(render('stats-line', unavailable), '↑1.2k ↓3.4k')
  // EVERY format that needs a missing fact renders nothing.
  for (const format of ['latency', 'speed', 'speed-all', 'speed-both', 'full']) {
    assert.equal(render('performance', unavailable, { id: 'performance', format }), '', `${format} has no fact to show`)
  }
  // A proven zero stays a legitimate measured value.
  const zero = snapshotWith(snap => {
    snap.usage.performance = { llmMs: 8100, firstTokenMs: 0, tokensPerSec: 0 }
  })
  assert.equal(render('performance', zero, { id: 'performance', format: 'full' }), 'TTFB 0s · R5 0 tok/s')
  assert.equal(render('performance', zero, { id: 'performance', format: 'speed-both' }), 'R5 0 tok/s',
    'the pair falls back to the one measured fact, never a fabricated All zero')
  assert.equal(render('stats-line', zero), '↑0 ↓0 | TTFB 0s · 0 tok/s')
})

test('PR5: a partially available fact renders only the formats that own it', () => {
  const latencyOnly = snapshotWith(snap => {
    snap.usage.performance = { llmMs: 8100, firstTokenMs: 2_600 }
  })
  assert.equal(render('performance', latencyOnly, { id: 'performance', format: 'latency' }), 'TTFB 2.6s')
  assert.equal(render('performance', latencyOnly, { id: 'performance', format: 'speed' }), '')
  assert.equal(render('performance', latencyOnly, { id: 'performance', format: 'speed-all' }), '')
  assert.equal(render('performance', latencyOnly, { id: 'performance', format: 'speed-both' }), '')
  assert.equal(render('performance', latencyOnly, { id: 'performance', format: 'full' }), 'TTFB 2.6s')
  const speedOnly = snapshotWith(snap => {
    snap.usage.performance = { llmMs: 8100, tokensPerSec: 51 }
  })
  assert.equal(render('performance', speedOnly, { id: 'performance', format: 'full' }), 'R5 51 tok/s')
  assert.equal(render('performance', speedOnly, { id: 'performance', format: 'speed-both' }), 'R5 51 tok/s')
  assert.equal(render('performance', speedOnly, { id: 'performance', format: 'latency' }), '')
  // TPS plan PR-3: an All-only Session answers the All formats and the pair,
  // and nothing else — the R5 formats must never borrow the All figure.
  const allOnly = snapshotWith(snap => {
    snap.usage.performance = { llmMs: 8100, sessionTokensPerSec: 44 }
  })
  assert.equal(render('performance', allOnly, { id: 'performance', format: 'speed-all' }), 'All 44 tok/s')
  assert.equal(render('performance', allOnly, { id: 'performance', format: 'speed-both' }), 'All 44 tok/s')
  assert.equal(render('performance', allOnly, { id: 'performance', format: 'speed' }), '')
  assert.equal(render('performance', allOnly, { id: 'performance', format: 'full' }), '')
})
