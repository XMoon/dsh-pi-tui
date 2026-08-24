/**
 * Headless tests for the builtin footer items (plan §7/§13.3): each item
 * renders the right segment from the snapshot, returns null when its fact
 * is absent, and never throws.
 * @module @xmoon76/dsh-pi-tui/footer-items.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { renderSpans } from '../src/footer/composer.ts'
import type { FooterItemRef } from '../src/footer/types.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

const registry = createBuiltinFooterRegistry()
const CONTEXT = { editorEmpty: true, extensionFooterText: '' }
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
  const withDraft = def.render(snapshotWith(snap => { snap.activity.taskCount = 1 }), REF, 'preferred', { ...CONTEXT, editorEmpty: false })
  assert.equal(withDraft === null ? '' : plain(renderSpans(withDraft.spans)), '[1 task running]')
  assert.equal(render('tasks', emptyStatusSnapshot()), '')
})

test('cwd shortens to the last two segments; empty → nothing', () => {
  const text = render('cwd', snapshotWith(snap => { snap.workspace.cwd = '/a/b/c/d' }))
  assert.equal(text, 'c/d')
  assert.equal(render('cwd', emptyStatusSnapshot()), '')
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
  assert.equal(text, '↑1.2k ↓3.4k | LLM 8.1s · TTFB 0s · 0 tok/s')
})

test('view-scope renders the legacy viewer identity block', () => {
  const oneShot = render('view-scope', snapshotWith(snap => {
    snap.view.subject = { kind: 'subagent', id: 'c1', label: 'audit', mode: 'one-shot', activity: 'inactive' }
  }))
  assert.equal(oneShot, '[subagent · one-shot]  audit  inactive')
  const running = render('view-scope', snapshotWith(snap => {
    snap.view.subject = { kind: 'subagent', id: 'c1', label: 'research', mode: 'continuable', activity: 'running' }
  }))
  assert.equal(running, '[subagent · continuable]  research  ● running')
  assert.equal(render('view-scope', emptyStatusSnapshot()), '')
})

test('ext:* bridges the extension footer text; empty → nothing', () => {
  const def = registry.get('ext:*')!
  const withText = def.render(emptyStatusSnapshot(), REF, 'preferred', { ...CONTEXT, extensionFooterText: '[EXT]' })
  assert.equal(withText === null ? '' : plain(renderSpans(withText.spans)), '[EXT]')
  assert.equal(render('ext:*', emptyStatusSnapshot()), '')
})
test('the registry rejects duplicate ids and lists every id', () => {
  const def = registry.get('model')!
  const registry2 = createBuiltinFooterRegistry()
  assert.throws(() => registry2.register(def), /duplicate footer item id/)
  assert.ok(registry.ids().includes('model'))
  assert.ok(registry.ids().includes('view-scope'))
  assert.ok(registry.ids().includes('ext:*'))
})
