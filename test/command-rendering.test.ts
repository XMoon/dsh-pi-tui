/**
 * Rendering-level regressions for the post-PR166 command convergence
 * (plan §11/§12): the real `kind: 'command'` node renders through the
 * Command-owned HOST path — slash-command icon family, status pill
 * vocabulary, verbatim args without a doubled separator, standalone
 * disclosure independent of the Focus root (the transcript-detail master
 * and the per-card click both own it, defaulting to the one-line
 * first-line preview), and an extension renderer that never receives a
 * command snapshot.
 * @module @xmoon76/dsh-pi-tui/command-rendering.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TranscriptCommandMessage, TranscriptMessage, TranscriptSearchMatch } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { RendererRegistry } from '../src/renderer-registry.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(preset: DisplayState['preset'] = 'full', renderers?: RendererRegistry): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset },
    ...(renderers === undefined ? {} : { renderers }),
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function command(overrides: Partial<TranscriptCommandMessage> = {}): TranscriptCommandMessage {
  return {
    kind: 'command',
    commandId: CommandId('cmd-1'),
    seq: SessionSeq(1),
    time: 1,
    name: 'compact',
    args: null,
    outcome: null,
    ...overrides,
  }
}

async function view(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** The private per-card click toggle, reached the same way the disclosure
 * regression suite reaches `expandedOverride`. */
function toggle(app: TuiApp, message: TranscriptMessage): void {
  ;(app as unknown as { toggleMessageExpanded: (message: TranscriptMessage) => void }).toggleMessageExpanded(message)
}

function overrideOf(app: TuiApp, message: TranscriptMessage): boolean | undefined {
  return (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride.get(message)
}

test('A18: the host command card keeps the slash-command icon row and status pill vocabulary', async () => {
  const { vt, app } = startApp()
  const messages: TranscriptMessage[] = [
    command({ commandId: CommandId('cmd-run'), name: 'compact' }),
    command({ commandId: CommandId('cmd-ok'), name: 'theme', args: 'dark', outcome: { kind: 'success', text: 'theme set to dark' } }),
    command({ commandId: CommandId('cmd-bad'), name: 'model', outcome: { kind: 'error', text: 'no such model' } }),
  ]
  app.setTranscript(messages, new Map())
  const rendered = await view(vt)
  assert.ok(rendered.includes('🎛'), `the slash-command icon family renders:\n${rendered}`)
  assert.ok(rendered.includes('/compact'), `the running row shows the slash command:\n${rendered}`)
  assert.ok(rendered.includes('[running]'), `the running pill:\n${rendered}`)
  assert.ok(rendered.includes('/theme dark'), `name + args render:\n${rendered}`)
  assert.ok(rendered.includes('[ok]'), `the success pill:\n${rendered}`)
  assert.ok(rendered.includes('theme set to dark'), `the outcome preview renders:\n${rendered}`)
  assert.ok(rendered.includes('[error]'), `the error pill:\n${rendered}`)
  assert.ok(!rendered.includes('executed'), `no synthetic 'executed' result body:\n${rendered}`)
  app.stop()
})

test('A18: verbatim rawInput args never double the separator whitespace', async () => {
  const { vt, app } = startApp()
  // The official args are parseCommand's VERBATIM rawInput INCLUDING the
  // separator whitespace after the name — a leading space must not become
  // two, and a spaceless fragment still gets exactly one separator.
  app.setTranscript([
    command({ commandId: CommandId('cmd-v1'), name: 'deploy', args: ' now' }),
    command({ commandId: CommandId('cmd-v2'), name: 'deploy', args: 'now' }),
  ], new Map())
  const rendered = await view(vt)
  const doubled = rendered.includes('/deploy  now')
  assert.ok(!doubled, `a verbatim leading space must not double the separator:\n${rendered}`)
  assert.ok(rendered.includes('/deploy now'), `the verbatim args render after one separator:\n${rendered}`)
  app.stop()
})

test('A19: the regular default is the one-line first-line preview; the master reveals the full body', async () => {
  const { vt, app } = startApp()
  const outcome = `first preview line of a long outcome\nsecond body line ${'x'.repeat(50)}\nthird body line`
  const target = command({ name: 'export', outcome: { kind: 'success', text: outcome } })
  app.setTranscript([target], new Map())
  let rendered = await view(vt)
  assert.ok(rendered.includes('/export'), `the row head:\n${rendered}`)
  assert.ok(rendered.includes('first preview line'), `the folded one-line preview is visible:\n${rendered}`)
  assert.ok(!rendered.includes('third body line'), `the folded preview is ONE line, not the whole body:\n${rendered}`)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the master defaults to compact')
  // The ordinary transcript-detail owner (Ctrl+O) reveals the full body.
  app.setTranscriptDetailExpanded(true)
  rendered = await view(vt)
  assert.ok(rendered.includes('third body line'), `the master reveals the full outcome:\n${rendered}`)
  // And back: the master collapse returns the one-line preview.
  app.setTranscriptDetailExpanded(false)
  rendered = await view(vt)
  assert.ok(!rendered.includes('third body line'), `the master collapse folds it again:\n${rendered}`)
  app.stop()
})

test('A19: the per-card click flips a command against its effective state', async () => {
  const { vt, app } = startApp()
  const target = command({ name: 'theme', outcome: { kind: 'success', text: 'theme set to dark' } })
  app.setTranscript([target], new Map())
  await view(vt)
  // Default effective state is compact (the master is off): the first click
  // EXPANDS this card explicitly…
  toggle(app, target)
  assert.equal(overrideOf(app, target), true, 'the first click writes an explicit expansion')
  let rendered = await view(vt)
  assert.ok(rendered.includes('theme set to dark'), `the clicked card shows the outcome:\n${rendered}`)
  // …and the second click COLLAPSES it (never a no-op `true`).
  toggle(app, target)
  assert.equal(overrideOf(app, target), false, 'the second click writes an explicit collapse')
  rendered = await view(vt)
  assert.ok(rendered.includes('theme set to dark'), `the collapsed preview still shows the one-line outcome:\n${rendered}`)
  app.stop()
})

test('A19: in collapsed Focus the command stays standalone-visible, independent of the Thought root', async () => {
  const { vt, app } = startApp('focus')
  const target = command({ commandId: CommandId('cmd-f'), name: 'theme', outcome: { kind: 'success', text: 'focused outcome body' } })
  app.setTranscript([
    { kind: 'user', turn: 1, text: 'go' },
    target,
  ], new Map())
  const rendered = await view(vt)
  assert.ok(rendered.includes('/theme'), `the command row stays visible in collapsed Focus:\n${rendered}`)
  assert.ok(rendered.includes('focused outcome body'), `its outcome preview stays operable outside the Thought root:\n${rendered}`)
  app.stop()
})

test('A19: in fullscreen Focus the command keeps its own click disclosure', async () => {
  const { vt, app } = startApp('focus')
  app.setFullscreen(true)
  await view(vt)
  const target = command({ name: 'export', outcome: { kind: 'success', text: 'fullscreen outcome body' } })
  app.setTranscript([target], new Map())
  let rendered = await view(vt)
  assert.ok(rendered.includes('/export'), `the command renders in fullscreen Focus:\n${rendered}`)
  assert.ok(rendered.includes('fullscreen outcome body'), `its preview row renders:\n${rendered}`)
  toggle(app, target)
  assert.equal(overrideOf(app, target), true)
  rendered = await view(vt)
  assert.ok(rendered.includes('fullscreen outcome body'), `the explicit expansion keeps the body:\n${rendered}`)
  app.stop()
})

test('A20: an extension message renderer never receives a command snapshot', async () => {
  const registry = new RendererRegistry()
  let messageCalls = 0
  registry.registerMessageRenderer({
    id: 'capture-message', order: 1,
    render: snapshot => {
      messageCalls += 1
      return { kind: 'text', spans: [{ text: `PLUGIN-MESSAGE-${(snapshot as { kind?: string }).kind ?? '?'}` }] }
    },
  }, 'test')
  const { vt, app } = startApp('full', registry)
  app.setTranscript([command({ name: 'compact', outcome: { kind: 'success', text: 'done' } })], new Map())
  const rendered = await view(vt)
  assert.equal(messageCalls, 0, 'the message chain never sees a command (host-owned snapshot)')
  assert.ok(rendered.includes('/compact'), `the host card renders instead:\n${rendered}`)
  assert.ok(!rendered.includes('PLUGIN'), `no plugin view leaks in:\n${rendered}`)
  app.stop()
})

test('A19/A15: a search hit in the outcome body reveals the command with the matched content', async () => {
  const { vt, app } = startApp()
  const target = command({ name: 'export', args: 'unique-arg-token', outcome: { kind: 'success', text: 'needle-in-outcome body' } })
  app.setTranscript([target], new Map())
  await view(vt)
  const match: TranscriptSearchMatch = { id: 0, turn: 0, occurrence: 0, source: { kind: 'command-field', field: 'outcome' }, sourceOccurrence: 0 }
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([target]),
    target: { query: 'needle', match, message: target },
    grantReveal: true,
  })
  const rendered = await view(vt)
  assert.ok(rendered.includes('needle-in-outcome'), `the revealed matched body is visible:\n${rendered}`)
  app.stop()
})

test('A15/A18: the combined manual-compaction card renders the fused command facts', async () => {
  const { vt, app } = startApp()
  const fused: TranscriptCommandMessage = command({
    commandId: CommandId('cmd-fused'), name: 'compact',
    outcome: { kind: 'success', text: 'distinctive fused outcome' },
  })
  const compaction: TranscriptMessage = {
    kind: 'compaction', turn: 3, text: 'summary body', items: 4, tokens: 120,
    sourceCommandId: CommandId('cmd-fused'), sourceCommand: fused,
  }
  app.setTranscript([compaction], new Map())
  const rendered = await view(vt)
  assert.ok(rendered.includes('Context compacted'), `the compaction state titles the combined card:\n${rendered}`)
  assert.ok(rendered.includes('/compact'), `the fused command name is part of the combined presentation:\n${rendered}`)
  assert.ok(rendered.includes('distinctive fused outcome'), `the command outcome is the presentation fallback:\n${rendered}`)
  app.stop()
})

test('A19: a truncated folded outcome gains a light disclosure hint', async () => {
  const { vt, app } = startApp()
  const outcome = `first preview line\nsecond body line ${'x'.repeat(50)}\nthird body line`
  app.setTranscript([command({ name: 'export', outcome: { kind: 'success', text: outcome } })], new Map())
  const rendered = await view(vt)
  assert.ok(rendered.includes('first preview line'), `the folded preview shows the first line:\n${rendered}`)
  assert.ok(rendered.includes('to expand'), `a truncated preview advertises the disclosure:\n${rendered}`)
  assert.ok(!rendered.includes('third body line'), `the folded preview stays one line:\n${rendered}`)
  // A short single-line outcome stays clean — no hint for nothing cut (one
  // live TuiApp per process: reuse the same app for the second projection).
  app.setTranscript([command({ commandId: CommandId('cmd-clean'), name: 'theme', outcome: { kind: 'success', text: 'theme set to dark' } })], new Map())
  const clean = await view(vt)
  assert.ok(!clean.includes('to expand'), `a fully visible one-line outcome carries no hint:\n${clean}`)
  app.stop()
})
