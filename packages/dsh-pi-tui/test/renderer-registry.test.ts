/**
 * M7 renderer tests (plan §12): the transcript/tool renderer registry —
 * chain semantics for message renderers, keyed+fallback for tool
 * renderers, throw isolation, fiber-bound unload, and the surface-level
 * cache identity (a renderer HMR/unload rebuilds the affected components).
 * @module @xmoon76/dsh-pi-tui/renderer-registry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
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
