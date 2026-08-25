/**
 * M7 renderer tests (plan §12): the transcript/tool renderer registry —
 * chain semantics for message renderers, keyed+fallback for tool
 * renderers, throw isolation, fiber-bound unload, and the surface-level
 * cache identity (a renderer HMR/unload rebuilds the affected components).
 * @module @xmoon76/dsh-pi-tui/renderer-registry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { RendererRegistry } from '../src/renderer-registry.ts'
import type { ExtensionView } from '../src/extension/public-types.ts'

function textView(text: string): ExtensionView {
  return { kind: 'text', spans: [{ text }] }
}

test('RendererRegistry: message chain — first non-undefined wins, in order ASC', () => {
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'r1', order: 2,
    render: () => textView('first'),
  }, 'a')
  registry.registerMessageRenderer({
    id: 'r2', order: 1,
    render: () => undefined, // abdicate
  }, 'b')
  registry.registerMessageRenderer({
    id: 'r3', order: 3,
    render: () => textView('never'),
  }, 'c')
  const result = registry.renderMessage(
    { kind: 'user', turn: 1, text: 'hi' },
    () => {},
  )
  // r2 (order 1) abdicated; r1 (order 2) wins; r3 (order 3) never runs.
  assert.ok(result !== undefined)
  assert.equal(result.rendererId, 'r1')
})

test('RendererRegistry: a throwing message renderer is isolated and the chain continues', () => {
  const registry = new RendererRegistry()
  const errors: string[] = []
  registry.registerMessageRenderer({
    id: 'boom',
    render: () => { throw new Error('renderer exploded') },
  }, 'a')
  registry.registerMessageRenderer({
    id: 'worker',
    render: () => textView('worked'),
  }, 'b')
  const result = registry.renderMessage({ kind: 'assistant', turn: 0, text: 'x' }, (id, error) => {
    errors.push(`${id}:${error instanceof Error ? error.message : String(error)}`)
  })
  assert.ok(result !== undefined)
  assert.equal(result.rendererId, 'worker')
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /boom:renderer exploded/)
})

test('RendererRegistry: an onError throw does not stop the message chain', () => {
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({ id: 'boom', order: 1, render: () => { throw new Error('render boom') } }, 'a')
  registry.registerMessageRenderer({ id: 'fallback', order: 2, render: () => textView('fallback') }, 'b')
  assert.equal(
    registry.renderMessage({ kind: 'assistant', turn: 0, text: 'x' }, () => { throw new Error('health boom') })?.rendererId,
    'fallback',
  )
})

test('RendererRegistry: kind-scoped message renderers only apply to their kind', () => {
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'tool-only', kind: 'tool',
    render: () => textView('tool view'),
  }, 'a')
  assert.equal(registry.renderMessage({ kind: 'user', turn: 0, text: 'x' }, () => {}), undefined)
  assert.ok(registry.renderMessage({ kind: 'tool', turn: 0, tool: {
    callId: 'c', toolName: 'bash', status: 'ok', expanded: false,
  } }, () => {}) !== undefined)
})

test('RendererRegistry: tool renderers are keyed — the winner for a tool name', () => {
  const registry = new RendererRegistry()
  registry.registerToolRenderer({
    id: 'bash-winner', toolName: 'bash', priority: 1,
    render: () => textView('bash custom'),
  }, 'a')
  registry.registerToolRenderer({
    id: 'bash-loser', toolName: 'bash', priority: 10,
    render: () => textView('never'),
  }, 'b')
  registry.registerToolRenderer({
    id: 'edit-renderer', toolName: 'edit',
    render: () => textView('edit custom'),
  }, 'c')
  const bash = registry.renderTool({ callId: 'c', toolName: 'bash', status: 'ok', expanded: false }, () => {})
  assert.equal(bash?.rendererId, 'bash-winner')
  const edit = registry.renderTool({ callId: 'c', toolName: 'edit', status: 'running', expanded: false }, () => {})
  assert.equal(edit?.rendererId, 'edit-renderer')
  // Unknown tool: undefined (host fallback).
  assert.equal(registry.renderTool({ callId: 'c', toolName: 'nope', status: 'ok', expanded: false }, () => {}), undefined)
})

test('RendererRegistry: tool priority tie is an explicit error', () => {
  const registry = new RendererRegistry()
  registry.registerToolRenderer({ id: 'a', toolName: 'bash', priority: 5, render: () => undefined }, 'o1')
  assert.throws(() => registry.registerToolRenderer({ id: 'b', toolName: 'bash', priority: 5, render: () => undefined }, 'o2'), /priority tie/)
})

test('RendererRegistry: a tool winner that abdicates falls through the chain', () => {
  const registry = new RendererRegistry()
  registry.registerToolRenderer({
    id: 'abdicate', toolName: 'bash', priority: 1,
    render: () => undefined,
  }, 'a')
  registry.registerToolRenderer({
    id: 'fallback', toolName: 'bash', priority: 10,
    render: () => textView('fallback view'),
  }, 'b')
  const result = registry.renderTool({ callId: 'c', toolName: 'bash', status: 'ok', expanded: false }, () => {})
  assert.equal(result?.rendererId, 'fallback')
})

test('RendererRegistry: owner unload removes exactly the owner renderers', () => {
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({ id: 'm1', render: () => textView('m1') }, 'owner-a')
  registry.registerMessageRenderer({ id: 'm2', render: () => textView('m2') }, 'owner-b')
  registry.registerToolRenderer({ id: 't1', toolName: 'bash', render: () => textView('t1') }, 'owner-a')
  registry.disposeOwner('owner-a')
  assert.equal(registry.renderMessage({ kind: 'user', turn: 0, text: 'x' }, () => {})?.rendererId, 'm2')
  assert.equal(registry.renderTool({ callId: 'c', toolName: 'bash', status: 'ok', expanded: false }, () => {}), undefined)
  const snapshot = registry.snapshot()
  assert.equal(snapshot.messageRenderers.length, 1)
  assert.equal(snapshot.toolRenderers.length, 0)
})

test('RendererRegistry: duplicate ids are errors', () => {
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({ id: 'dup', render: () => undefined }, 'a')
  assert.throws(() => registry.registerMessageRenderer({ id: 'dup', render: () => undefined }, 'b'), /duplicate/)
})

// ── Surface integration: the message cache rebuilds on renderer change ────

test('TuiApp: a tool renderer replaces the tool card; unload rebuilds the host card', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, { renderers: registry })
  app.start()
  await vt.waitForRender()
  // A tool message.
  const message = {
    kind: 'tool' as const,
    turn: 0,
    name: 'bash',
    args: JSON.stringify({ command: 'echo hi' }),
    result: 'hi',
    status: 'ok' as const,
  }
  // Without a renderer: the host card renders (the tool name appears in
  // the cache-built component; the tool branch of renderMessage runs).
  void app.messageCacheEntryForTest?.(message, 0)
  // Register a tool renderer.
  registry.registerToolRenderer({
    id: 'custom-bash', toolName: 'bash',
    render: (snapshot) => textView(`CUSTOM ${snapshot.toolName}`),
  }, 'plugin')
  // The cache identity: the entry must rebuild with the renderer id.
  const entry = app.messageCacheEntryForTest?.(message)
  assert.equal(entry?.rendererId, 'custom-bash', 'the cache entry must record the renderer id')
  assert.ok(entry?.rendererRevision !== undefined)
  // Unload the renderer: the cache entry must rebuild to the host card.
  registry.disposeOwner('plugin')
  const entryAfter = app.messageCacheEntryForTest?.(message)
  assert.equal(entryAfter?.rendererId, undefined, 'unload must drop the renderer identity')
  app.stop()
})

test('TuiApp: a throwing tool renderer falls back to the host card (no stall)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, { renderers: registry })
  app.start()
  await vt.waitForRender()
  registry.registerToolRenderer({
    id: 'exploder', toolName: 'bash',
    render: () => { throw new Error('kaboom') },
  }, 'plugin')
  const message = {
    kind: 'tool' as const,
    turn: 0,
    name: 'bash',
    args: '{}',
    result: '',
    status: 'running' as const,
  }
  // The cache builds the HOST card (the throw was isolated).
  const entry = app.messageCacheEntryForTest?.(message)
  assert.equal(entry?.rendererId, undefined, 'a throwing renderer must not claim the card')
  app.stop()
})

// ── Round-1 regression tests ───────────────────────────────────────────────

test('TuiApp: the recorded rendererId matches the view actually built on content change (round-1 P1)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  let renderCalls = 0
  registry.registerToolRenderer({
    id: 'counter', toolName: 'bash',
    render: () => { renderCalls += 1; return textView('CUSTOM') },
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  await vt.waitForRender()
  // First build: the renderer runs and the identity is recorded.
  const m1 = { kind: 'tool' as const, turn: 0, name: 'bash', args: '{"a":1}', result: '', status: 'running' as const }
  const e1 = app.messageCacheEntryForTest?.(m1, 0)
  assert.equal(e1?.rendererId, 'counter')
  const callsAfterFirst = renderCalls
  assert.ok(callsAfterFirst >= 1)
  // Content changes (streaming result) but the registry revision does NOT.
  const m2 = { ...m1, result: 'streaming output' }
  const e2 = app.messageCacheEntryForTest?.(m2, 0)
  assert.equal(e2?.rendererId, 'counter', 'the rebuilt entry must keep the ACTUAL renderer id')
  // The renderer ran again for the content change.
  assert.ok(renderCalls > callsAfterFirst)
  app.stop()
})

test('TuiApp: a host-fallback entry records the revision so renderers do NOT re-run (round-1 P2)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  let renderCalls = 0
  // A message renderer for 'system' only — user messages have NO renderer
  // (host fallback), but the registry exists.
  registry.registerMessageRenderer({
    id: 'sys-only', kind: 'system',
    render: () => { renderCalls += 1; return textView('SYS') },
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  await vt.waitForRender()
  const user = { kind: 'user' as const, turn: 0, text: 'hello' }
  const e1 = app.messageCacheEntryForTest?.(user, 0)
  // Host fallback: no rendererId, but the REVISION is recorded.
  assert.equal(e1?.rendererId, undefined)
  assert.ok(e1?.rendererRevision !== undefined, 'a host-fallback entry must record the revision')
  const callsAfterFirst = renderCalls
  // Access again with UNCHANGED content + revision: the renderer chain
  // must NOT re-run (the sys-only renderer is not for user, but the cheap
  // gate must skip the chain entirely — plan §23).
  app.messageCacheEntryForTest?.(user, 0)
  assert.equal(renderCalls, callsAfterFirst, 'unchanged content + revision must not re-run renderers')
  app.stop()
})

test('TuiApp: renderer failures reach the health ledger sink (round-1 P3)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerToolRenderer({
    id: 'exploder', toolName: 'bash',
    render: () => { throw new Error('kaboom renderer') },
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  const failures: { id: string; error: unknown }[] = []
  app.setRendererErrorSink((record) => failures.push(record))
  app.start()
  await vt.waitForRender()
  const tool = { kind: 'tool' as const, turn: 0, name: 'bash', args: '{}', result: '', status: 'running' as const }
  app.messageCacheEntryForTest?.(tool, 0)
  assert.equal(failures.length, 1, 'the throw must reach the sink (never swallowed)')
  assert.equal(failures[0]?.id, 'exploder')
  app.stop()
})

test('TuiApp: a broken renderer view lets a lower-priority renderer claim the card (P1-R5)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  let fallbackCalls = 0
  registry.registerToolRenderer({
    id: 'broken-first', toolName: 'bash', priority: 0,
    render: () => ({
      kind: 'text' as const,
      get spans(): never { throw new Error('first compile boom') },
    } as unknown as import('../src/extension/public-types.ts').ExtensionView),
  }, 'plugin')
  registry.registerToolRenderer({
    id: 'valid-second', toolName: 'bash', priority: 1,
    render: () => {
      fallbackCalls++
      return textView('SECOND')
    },
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  await vt.waitForRender()
  const tool = { kind: 'tool' as const, turn: 0, name: 'bash', args: '{}', result: '', status: 'ok' as const }
  const entry = app.messageCacheEntryForTest?.(tool, 0)
  assert.equal(entry?.rendererId, 'valid-second')
  assert.equal(fallbackCalls, 1)
  assert.ok(entry?.component.render(80).join('').includes('SECOND'))
  app.stop()
})

test('TuiApp: a renderer-returned view whose COMPILATION throws abdicates to the host card, never escapes (P1-07)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  // The render() itself SUCCEEDS (the registry's per-renderer boundary is
  // not the failing stage) — the returned view's `spans` GETTER throws at
  // COMPILE time. P1-07: that failure must be isolated (recorded) and the
  // message must fall back to the host card.
  registry.registerToolRenderer({
    id: 'broken-view', toolName: 'bash',
    render: () => ({
      kind: 'text' as const,
      get spans(): never { throw new Error('compile boom') },
    } as unknown as import('../src/extension/public-types.ts').ExtensionView),
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  const failures: { id: string; error: unknown }[] = []
  app.setRendererErrorSink((record) => failures.push(record))
  app.start()
  await vt.waitForRender()
  const tool = { kind: 'tool' as const, turn: 0, name: 'bash', args: '{}', result: 'out', status: 'ok' as const }
  // Must NOT throw (the old code let 'compile boom' escape the render
  // path); the entry must fall back to the host card (rendererId
  // undefined) and the failure must reach the health sink.
  const entry = app.messageCacheEntryForTest?.(tool, 0)
  assert.equal(entry?.rendererId, undefined, 'a compile failure abdicates to the host card')
  assert.equal(failures.length, 1, 'the compile failure must be recorded (never swallowed)')
  assert.equal(failures[0]?.id, 'broken-view')
  assert.ok(String(failures[0]?.error).includes('compile boom'))
  // The host card still renders the tool content (the fallback path).
  const rendered = entry?.component.render(80).join('\n') ?? ''
  assert.ok(rendered.includes('out'), `the host card renders the tool result:\n${rendered}`)
  app.stop()
})

test('TuiApp: a failed renderer RECOVERS and its health record clears (P1-08)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const { ExtensionLedger } = await import('../src/extension/internal/ledger.ts')
  const ledger = new ExtensionLedger(() => {})
  // P1-08: renderers are tracked in the health ledger by the SERVICE; the
  // TuiApp test uses the ledger directly to prove the full loop: track →
  // fail → recover.
  ledger.trackHealth('transcript.renderer', 'flaky', 'plugin')
  const registry = new RendererRegistry()
  let explode = true
  registry.registerToolRenderer({
    id: 'flaky', toolName: 'bash',
    render: () => {
      if (explode) throw new Error('flaky boom')
      return textView('flaky ok')
    },
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.setRendererErrorSink(({ id, error }) => {
    ledger.recordError('transcript.renderer', id, String(error))
  })
  app.setRendererRecoveredSink(({ id }) => ledger.clearError('transcript.renderer', id))
  app.start()
  await vt.waitForRender()
  const tool = { kind: 'tool' as const, turn: 0, name: 'bash', args: '{}', result: 'out', status: 'ok' as const }
  // FAIL: the renderer throws → the host card renders + the health record
  // is failed.
  const failed = app.messageCacheEntryForTest?.(tool, 0)
  assert.equal(failed?.rendererId, undefined, 'a throwing renderer falls back to the host card')
  assert.equal(ledger.healthSnapshot().find(r => r.id === 'flaky')?.state, 'failed')
  // RECOVER: the renderer stops throwing → a NEW message (different
  // turn — the cache identity rebuilds on content) is claimed by the
  // renderer AND the health record clears (the next failure starts a NEW
  // generation).
  explode = false
  const recovered = app.messageCacheEntryForTest?.({ ...tool, turn: 1 }, 0)
  assert.equal(recovered?.rendererId, 'flaky', 'a recovered renderer claims the card')
  assert.equal(ledger.healthSnapshot().find(r => r.id === 'flaky')?.state, 'active', 'recovery clears the health record')
  assert.equal(ledger.healthSnapshot().find(r => r.id === 'flaky')?.lastError, undefined)
  app.stop()
})

test('TuiApp: the tool snapshot arguments/result are deeply frozen (round-1 P4)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  let snapshotArgs: unknown
  registry.registerToolRenderer({
    id: 'peeker', toolName: 'bash',
    render: (snapshot) => {
      snapshotArgs = snapshot.arguments
      return textView('peek')
    },
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  await vt.waitForRender()
  const tool = {
    kind: 'tool' as const, turn: 0, name: 'bash',
    args: JSON.stringify({ command: 'echo', nested: { deep: [1, 2] } }),
    result: '',
    status: 'running' as const,
  }
  app.messageCacheEntryForTest?.(tool, 0)
  assert.ok(Object.isFrozen(snapshotArgs as object), 'the arguments object must be frozen')
  assert.ok(Object.isFrozen((snapshotArgs as { nested: unknown }).nested as object), 'nested objects must be frozen')
  assert.ok(Object.isFrozen((snapshotArgs as { nested: { deep: unknown[] } }).nested.deep), 'nested arrays must be frozen')
  app.stop()
})

test('TuiApp: a plugin-rendered component renders inside the transcript gutter (host-applied width)', async () => {
  // The right-gutter contract (2026-08-26 plan §8.8): the gutter is
  // applied by the HOST outside the plugin component — a plugin renderer
  // must never need to know the terminal gutter exists. The probe
  // component's long unbroken line wraps at the transcript content width
  // (78 at 80 cols): 320 probe chars span ceil(320/78) = 5 rows, the
  // first exactly 78 cells — a full-width wrap (80) would yield only 4
  // rows of 80, so the row COUNT discriminates the two hypotheses even
  // without reading the row width. (The plan's literal `observedWidths`
  // probe is impossible through the public SDK: plugins contribute
  // semantic VIEWS, the host compiles them and owns width measurement —
  // no raw component ever sees the width. The decisive wrap count is the
  // honest observable of the same contract.)
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp, transcriptContentWidth } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'width-probe', kind: 'assistant',
    render: () => ({ kind: 'text', spans: [{ text: 'probe'.repeat(64) }] }),
  }, 'plugin')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'host fallback never runs' }])
  await vt.waitForRender()
  // The wrapped rows follow the first `probe` row (the tail row of the
  // wrap may be a partial word like `robe`, so slice by position, never
  // by content match) and end at the editor border (chrome, not content).
  const rowsOf = (): string[] => {
    const lines = vt.getViewport()
    const start = lines.findIndex(line => line.includes('probe'))
    const border = lines.findIndex(line => /^[─═]+$/.test(line.trim()))
    assert.ok(start >= 0, `plugin rows missing:\n${lines.join('\n')}`)
    return lines.slice(start, border === -1 ? start + 5 : border)
  }
  let rows = rowsOf()
  assert.equal(rows.length, 5, `320 chars must wrap to 5 rows at the 78-col content width (4 at 80):\n${rows.join('\n')}`)
  assert.equal(visibleWidth(rows[0]!), transcriptContentWidth(80),
    `the first plugin row must fill exactly the 78-col content width:\n${rows[0]}`)
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= transcriptContentWidth(80),
      `a plugin row exceeds the 78-col content width: ${JSON.stringify(row)}`)
  }
  // A resize keeps the plugin component live inside the gutter: at 100
  // cols the same component re-wraps at 98 (320 chars → 4 rows).
  vt.resize(100, 24)
  await vt.waitForRender()
  rows = rowsOf()
  assert.equal(rows.length, 4, `the plugin line must re-wrap at the widened content width (320 chars / 98):\n${rows.join('\n')}`)
  assert.equal(visibleWidth(rows[0]!), transcriptContentWidth(100),
    `the first plugin row must fill exactly the 98-col content width:\n${rows[0]}`)
  app.stop()
})
