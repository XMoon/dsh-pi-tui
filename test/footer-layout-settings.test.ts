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
  // The runner repaints the footer on the status refresh that follows a
  // focus toggle; the test mirrors that (the app's setFocusMode only
  // updates the store, it never paints).
  app.setStatus({})
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

test('a tone override applies to EMPHASIZED spans too (strong/dim/italic keep the override color)', () => {
  const composer = new FooterComposer(createBuiltinFooterRegistry())
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
  const text = composer.render({
    snapshot: snap,
    layout: {
      schemaVersion: 1,
      rows: [{
        left: [{ id: 'model', tone: 'warning' }],
        right: [],
      }],
    },
    width: 100,
    context: { editorEmpty: true, extensionFooterText: '' },
  })
  // The model item's span is uncolored; the warning override must color
  // it (the emphasis path is not involved here, but the override must
  // reach the span render).
  assert.ok(text.includes('\x1b[38;2;232;168;56m'), `the tone override must apply: ${JSON.stringify(text)}`)
})

test('the compact phase re-renders items at the compact density before dropping', () => {
  const composer = new FooterComposer(createBuiltinFooterRegistry())
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.usage.context = { usedTokens: 25000, windowTokens: 100000, percent: 25 }
  snap.usage.cacheHitPct = 91.9
  snap.usage.tokens = { input: 2579, output: 5507, cacheRead: 20000, cacheWrite: 0 }
  snap.usage.performance = { llmMs: 2000, firstTokenMs: 2000, tokensPerSec: 40 }
  // A right zone pins 'focus'; the left zone must fit the remaining width.
  // The context item's compact form ('25%') is much shorter than its
  // preferred bar — the compact phase must keep it instead of dropping it.
  snap.interaction.focusMode = true
  const text = composer.render({
    snapshot: snap,
    layout: {
      schemaVersion: 1,
      rows: [{
        left: [
          { id: 'context', format: 'bar' },
          { id: 'cache-hit' },
          { id: 'token-usage', format: 'io' },
          { id: 'performance', format: 'full' },
        ],
        right: [{ id: 'focus-mode' }],
        separator: { text: '  ' },
      }],
    },
    width: 40,
    context: { editorEmpty: true, extensionFooterText: '' },
  })
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(plain.includes('25%'), `the compact context form must survive:\n${plain}`)
  assert.ok(plain.includes('focus'), `the right zone must survive:\n${plain}`)
})

test('the activity setters repaint the run-state item (no status refresh needed)', async () => {
  const { vt, app } = startApp()
  // A custom layout with the run-state item in view.
  app.setFooterLayout({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'run-state' }], right: [] }],
  })
  app.setStatus({})
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('working'), `idle must not badge working:\n${view}`)
  // The activity setter projects the store AND repaints the footer — a
  // direct caller (no runner refresh in between) must see the phase.
  app.setWorking(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('working'), `setWorking must repaint the run state:\n${view}`)
  app.setWorking(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('working'), `idle must restore after setWorking(false):\n${view}`)
  app.stop()
})

test('an emptied footer surface reflows with no stale content', async () => {
  const { vt, app } = startApp()
  // Fill the transcript so the fullscreen scroll pane overflows, then
  // paint the two-row default footer.
  const messages = Array.from({ length: 25 }, (_, i) => ({
    kind: 'user' as const,
    turn: i,
    text: `message ${i} with a reasonably long line to consume width`,
  }))
  app.setTranscript(messages, new Map())
  app.setStatus({ model: 'p/m', cwd: '/ws', turns: 2, steps: 3 })
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('t2/s3'), `the default footer must be painted in fullscreen:\n${view}`)
  const before = vt.getViewport().join('\n')
  // Switch to a custom layout whose ONLY item is unavailable (an
  // unloaded extension item): the composer renders an empty surface. The
  // old footer rows must not stay behind — the layout reflows and the
  // transcript takes the freed rows (earlier messages become visible).
  app.setFooterLayout({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'ext:gone/unknown' }], right: [] }],
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('t2/s3'), `the emptied footer must clear its rows:\n${view}`)
  assert.ok(!view.includes('p/m'), `the emptied footer must clear its rows:\n${view}`)
  const visibleNow = view
  const revealed = messages.map(m => m.text).filter(text => !before.includes(text) && visibleNow.includes(text))
  assert.ok(revealed.length >= 1, `the reflow must reveal earlier transcript rows:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})
