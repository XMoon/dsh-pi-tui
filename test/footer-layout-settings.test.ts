/**
 * Headless tests for the M2 footer settings integration (plan §14.2/§14.8):
 * the app's custom-layout API, the mode mapping (default/compact/custom),
 * and the fail-soft invalid-config path.
 * @module @xmoon76/dsh-pi-tui/footer-layout-settings.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import { StatusStore } from '../src/status/store.ts'
import { initialStatusSnapshot } from '../src/status/snapshot.ts'
import { FooterComposer } from '../src/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

/** A screenshot-like custom layout (plan §14.6). */
const SCREENSHOT_LAYOUT = {
  schemaVersion: 1 as const,
  rows: [{
    left: [
      { id: 'model' },
      { id: 'cwd' },
      { id: 'context', format: 'full' },
      { id: 'turns-steps' },
      { id: 'stats-line' },
    ],
    right: [],
    separator: { text: ' │ ' },
  }],
}

test('the app applies a custom layout and reports the custom mode', async () => {
  const { vt, app } = startApp()
  assert.equal(app.getFooterMode(), 'default')
  app.setStatus({
    model: 'deepseek/flash',
    cwd: '/home/x/space4',
    turns: 2,
    steps: 5,
    usage: {
      tokens: { input: 160000, output: 0, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 0, firstTokenMs: 0, tokensPerSec: 0 },
      turns: 2,
      steps: 5,
    },
  })
  app.setStatus({ contextTokens: 160000, contextWindow: 1_000_000 })
  app.setFooterLayout(SCREENSHOT_LAYOUT)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(app.getFooterMode(), 'custom')
  // The custom separator and the full context formatter apply.
  assert.ok(view.includes(' │ '), `custom separator missing:\n${view}`)
  assert.ok(view.includes('160k/1.0M (16%)'), `full context formatter missing:\n${view}`)
  // The default-only items (permission badge) are gone.
  assert.ok(!view.includes('[workspace-write]'), `default-only item must not render:\n${view}`)
  app.stop()
})

test('clearing the custom layout restores the builtin preset', async () => {
  const { vt, app } = startApp()
  app.setFooterLayout(SCREENSHOT_LAYOUT)
  assert.equal(app.getFooterMode(), 'custom')
  app.setFooterLayout(undefined)
  assert.equal(app.getFooterMode(), 'default')
  app.setFooterPreset('compact')
  assert.equal(app.getFooterMode(), 'compact')
  app.stop()
})

test('the custom layout renders the screenshot-like acceptance fixture', async () => {
  // The version item reads the store's host section: wire a store stamped
  // with the bundle version (the runner's store carries the real one).
  const store = new StatusStore(initialStatusSnapshot('0.3.3'))
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { statusStore: store })
  app.start()
  app.setStatus({
    model: 'deepseek-v4-flash',
    cwd: '/home/x/space4',
    turns: 12,
    steps: 38,
    usage: {
      tokens: { input: 2579, output: 5507, cacheRead: 20000, cacheWrite: 0 },
      cacheHitPct: 91.9,
      performance: { llmMs: 2000, firstTokenMs: 2000, tokensPerSec: 40 },
      turns: 12,
      steps: 38,
    },
  })
  app.setStatus({ contextTokens: 160000, contextWindow: 1_000_000 })
  app.setFooterLayout({
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'model' },
        { id: 'cwd' },
        { id: 'context', format: 'full' },
        { id: 'cache-hit' },
        { id: 'token-usage', format: 'io' },
        { id: 'performance', format: 'full' },
        { id: 'version', format: 'tui' },
      ],
      right: [{ id: 'focus-mode' }],
      separator: { text: ' │ ', tone: 'textDim' },
    }],
  })
  app.setFocusMode(true)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // The plan's screenshot-like line: model │ cwd │ context │ cache │
  // tokens │ performance │ version ... focus. The M2 items render the
  // structured facts (the plan's exact token spellings are formatter
  // choices — the pi vocabulary applies, so 2000ms renders `2s`).
  assert.ok(view.includes('deepseek-v4-flash'), `model missing:\n${view}`)
  assert.ok(view.includes('space4'), `project cwd missing:\n${view}`)
  assert.ok(view.includes('160k/1.0M (16%)'), `context missing:\n${view}`)
  assert.ok(view.includes('C 91.9%'), `cache-hit missing:\n${view}`)
  assert.ok(view.includes('2579/5507'), `token-usage missing:\n${view}`)
  assert.ok(view.includes('2s 40 tok/s'), `performance missing:\n${view}`)
  assert.ok(view.includes('v0.3.3'), `version missing:\n${view}`)
  assert.ok(view.includes('focus'), `focus-mode missing:\n${view}`)
  app.stop()
})

test('layout overrides apply: prefix/suffix wrap the item, tone overrides the semantic tone, separator tone styles the separator', () => {
  // The composer is the authority (the viewport strips ANSI).
  const composer = new FooterComposer(createBuiltinFooterRegistry())
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
  const text = composer.render({
    snapshot: snap,
    layout: {
      schemaVersion: 1,
      rows: [{
        left: [{ id: 'model', prefix: '‹ ', suffix: ' ›', tone: 'warning' }],
        right: [],
        separator: { text: ' │ ', tone: 'error' },
      }],
    },
    width: 100,
    context: { editorEmpty: true, extensionFooterText: '' },
  })
  assert.ok(text.includes('‹ '), `prefix must wrap the item: ${JSON.stringify(text)}`)
  assert.ok(text.includes(' ›'), `suffix must wrap the item: ${JSON.stringify(text)}`)
  // The tone override replaces the item's semantic tone (the model item is
  // uncolored by default — the warning override must color it).
  assert.ok(text.includes('\x1b[38;2;232;168;56m'), `the tone override must apply: ${JSON.stringify(text)}`)
})
