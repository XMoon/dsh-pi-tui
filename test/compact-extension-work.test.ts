/**
 * PR4/F4 hardening (Track G): a custom Tool presented by an extension renderer
 * stays extension-owned inside an EXPANDED Work span; the collapsed Work card
 * uses only the semantic preview/fallback and never serializes the extension
 * UI into Compact-only text.
 * @module @xmoon76/dsh-pi-tui/compact-extension-work.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { RendererRegistry } from '../src/renderer-registry.ts'
import type { TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function workHeaderCount(view: string, expanded?: boolean): number {
  const glyph = expanded === undefined ? '(?:▸|▾)' : expanded ? '▾' : '▸'
  return view.split('\n').filter(line => new RegExp(`^\\s*${glyph} Activity(?: | ·|$)`).test(line)).length
}

test('a custom tool is extension-owned only inside an expanded Work span', async () => {
  const registry = new RendererRegistry()
  registry.registerToolRenderer({
    id: 'custom',
    toolName: 'customtool',
    render: () => ({ kind: 'text', spans: [{ text: 'EXTENSION_BODY_MARKER' }] }),
  }, 'test')

  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset: 'compact' }, renderers: registry })
  app.start()
  startedApps.add(app)

  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'reasoning about the custom tool' }
  app.setTranscript([
    owner,
    { kind: 'tool', turn: 1, name: 'customtool', args: '{"x":1}', result: 'ok', status: 'ok' },
  ], new Map())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(workHeaderCount(view, false), 1, `one collapsed Work span:\n${view}`)
  assert.ok(!view.includes('EXTENSION_BODY_MARKER'),
    `the collapsed card must not serialize the extension body:\n${view}`)

  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(workHeaderCount(view, true), 1, `the Work span opens:\n${view}`)
  assert.ok(view.includes('EXTENSION_BODY_MARKER'),
    `the expanded Work child is owned by the extension renderer:\n${view}`)

  // Collapsing again returns to the semantic-only preview with no residue.
  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('EXTENSION_BODY_MARKER'), `collapsing hides the extension body again:\n${view}`)
})
