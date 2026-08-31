/**
 * The unified Thinking disclosure contract (the 2026-08-25 redesign plan
 * §26 matrix): Thinking blocks are DISCLOSURE, never visibility — a block
 * exists whenever the model produced reasoning and the current projection
 * contains it. Alt+T is the ONE bulk detail owner (compact/full), Ctrl+O
 * never touches Thinking detail, fullscreen clicks and search reveals
 * layer per-card overrides on top of the bulk preference, and the bulk
 * preference survives Focus ON/OFF and surface switches.
 *
 * Matrix coverage (A–L): Focus OFF regular/fullscreen, Focus ON
 * collapsed/expanded, Focus & surface switches, search, /settings, no
 * reasoning, running reasoning, and the render-cache identity.
 * @module @xmoon76/dsh-pi-tui/thinking-disclosure.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { visibleWidth } from '@xmoon76/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import { TuiApp, transcriptContentWidth } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

function startApp(width = 100, height = 30): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

/** A realistic base time: synthetic fixture events would produce absurd
 * running durations against Date.now(). */
const T0 = Date.now() - 60_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** A running turn with user + thinking + a running tool. */
function runningTurn(seqBase: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'check the transcript' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'locating the transcript path…' } }, T0 + 2, seqBase + 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: JSON.stringify({ path: 'src/transcript.ts' }) }, T0 + 3, seqBase + 3),
  ]
}

/** A settled turn with TWO per-step thinking blocks and NO tools — the
 * per-card override matrix needs at least two Thinking cards. */
function twoThinkingTurn(seqBase: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'think twice' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'alpha reasoning\nalpha latest' } }, T0 + 2, seqBase + 2),
    eventAt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'beta reasoning\nbeta latest' } }, T0 + 3, seqBase + 3),
    eventAt('assistant/message', {
      turn: 1, step: 2,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 4, seqBase + 4),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 5, seqBase + 5),
  ]
}

/** A turn with NO reasoning at all (user + tool + final). */
function noReasoningTurn(seqBase: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'just run it' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, T0 + 2, seqBase + 2),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
    }, T0 + 3, seqBase + 3),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 4, seqBase + 4),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 5, seqBase + 5),
  ]
}

/** The row (0-based viewport y) whose text contains `needle`, or -1. */
function findRow(view: readonly string[], needle: string): number {
  return view.findIndex(line => line.includes(needle))
}

/** SGR click on one viewport cell (the fork converts to 0-based). */
function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

function show(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities())
}

/** The number of `(… to expand)` hints in a view (the compact-card
 * affordance count). */
function hintCount(view: string, verb: string): number {
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (view.match(new RegExp(`\\(${escaped} to expand\\)`, 'g')) ?? []).length
}

// ── A. Focus OFF · regular ───────────────────────────────────────────────

test('A1: Focus OFF regular — Thinking exists compact with a preview and the Alt+T hint', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  show(app, folder)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('🌊 Thinking'), `Thinking card missing:\n${view}`)
  assert.ok(view.includes('alpha latest'), `the compact preview must be the LATEST line:\n${view}`)
  assert.ok(!view.includes('alpha reasoning'), `the earlier body line must not leak:\n${view}`)
  assert.ok(hintCount(view, 'alt+t') === 2, `both compact cards carry the Alt+T hint:\n${view}`)
  app.stop()
})

test('A2/A3: Alt+T expands ALL Thinking full, then back to compact — never removed', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  show(app, folder)
  await vt.waitForRender()
  vt.sendInput('\x1bt') // Alt+T: bulk full
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('alpha reasoning'), `full reasoning missing:\n${view}`)
  assert.ok(view.includes('beta reasoning'), `full reasoning missing:\n${view}`)
  assert.ok(hintCount(view, 'alt+t') === 0, `no compact hints while full:\n${view}`)
  assert.equal(app.isThinkingExpanded(), true)
  vt.sendInput('\x1bt') // Alt+T again: compact
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('alpha latest'), `the compact preview must return:\n${view}`)
  assert.ok(!view.includes('alpha reasoning'), `the body must fold again:\n${view}`)
  assert.ok(hintCount(view, 'alt+t') === 2, `both cards carry the hint again:\n${view}`)
  assert.ok(view.includes('🌊 Thinking'), 'the blocks are PRESENT — Alt+T is a detail toggle, never a visibility gate')
  app.stop()
})

test('A4: Ctrl+O expands recent tool/system output but NEVER Thinking detail', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  show(app, folder)
  await vt.waitForRender()
  vt.sendInput('\x0f') // Ctrl+O ON
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Read src/transcript.ts'), `the recent tool must expand:\n${view}`)
  assert.ok(hintCount(view, 'alt+t') === 1, `Thinking stays compact (its own owner):\n${view}`)
  // Both disclosure states share the 🌊 marker, so compactness is proven
  // by the geometry, not the marker: the card must still be the compact
  // 3-row block (title + preview + hint) — an expanded card would render
  // the reasoning body rows instead.
  const rows = view.split('\n')
  const thinkRow = rows.findIndex(line => line.includes('🌊 Thinking'))
  assert.ok(thinkRow >= 0, `Thinking card missing:\n${view}`)
  const block = rows.slice(thinkRow, thinkRow + 3)
  assert.equal(block.length, 3, `the Thinking card must stay compact under Ctrl+O:\n${view}`)
  assert.ok(block[2]!.includes('to expand'), `the compact hint must survive Ctrl+O:\n${view}`)
  app.stop()
})

// ── B. Focus OFF · fullscreen ────────────────────────────────────────────

test('B1: fullscreen — clicking ONE Thinking card expands only that card', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Click the SECOND card (its preview row).
  const y = findRow(vt.getViewport(), 'beta latest')
  assert.ok(y >= 0, `beta card missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 10, y + 1)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  beta reasoning'), `the clicked card must be full:\n${view}`)
  assert.ok(!view.includes('\n  alpha reasoning'), `the other card must stay compact:\n${view}`)
  assert.equal(hintCount(view, 'click'), 1, `exactly the alpha card keeps the click hint:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

test('B2/B3: Alt+T after a local override resets every override and bulk-toggles ALL', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Local override: expand beta only.
  const y = findRow(vt.getViewport(), 'beta latest')
  click(vt, 10, y + 1)
  await vt.waitForRender()
  // Alt+T expand: overrides are cleared AND the bulk flips — ALL full.
  vt.sendInput('\x1bt')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  alpha reasoning'), `alpha must be full too:\n${view}`)
  assert.ok(view.includes('\n  beta reasoning'), `beta must stay full (bulk now owns it):\n${view}`)
  assert.equal(hintCount(view, 'click'), 0, `no compact Thinking cards after bulk expand:\n${view}`)
  // Alt+T collapse: ALL compact, the old local override did not survive.
  vt.sendInput('\x1bt')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\n  beta reasoning'), `beta must collapse with the bulk:\n${view}`)
  assert.equal(hintCount(view, 'click'), 2, `both cards compact again:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

// ── C. Focus ON · collapsed root ─────────────────────────────────────────

test('C1/C2: Focus collapsed — the Think: preview stays; Alt+T changes only the bulk preference', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Think:   locating the transcript path…'), `the collapsed Think: preview missing:\n${view}`)
  assert.ok(!view.includes('🌊 Thinking'), 'the collapsed root hides the process rows')
  // Alt+T flips the bulk preference — the collapsed root shows nothing new.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('🐋 Thought'), 'the root stays collapsed')
  assert.ok(!view.includes('🌊 Thinking'), 'no process leak under a collapsed root')
  assert.equal(app.isThinkingExpanded(), true, 'the bulk preference changed')
  app.setFullscreen(false)
  app.stop()
})

// ── D. Focus ON · regular expanded ───────────────────────────────────────

test('D1: regular Focus expanded root — Thinking compact (never absent), Tool full', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  await vt.waitForRender()
  app.expandFocusTurn(1)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('🐳 Thought'), 'the root must expand')
  assert.ok(view.includes('Read src/transcript.ts [running]'), 'the non-Thinking process is full (regular)')
  assert.ok(view.includes('locating the transcript path'), 'Thinking is present — compact preview')
  assert.ok(view.includes('(alt+t to expand)'), 'the compact Thinking card carries the Alt+T hint')
  app.stop()
})

test('D2/D3: Alt+T expands Thinking full; Ctrl+O never changes it — Tool unchanged throughout', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.setToolOutputExpanded(true) // Ctrl+O master ON (tools full)
  show(app, folder)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Read src/transcript.ts'), 'precondition: the tool is revealed')
  assert.ok(view.includes('(alt+t to expand)'), 'precondition: Thinking compact')
  vt.sendInput('\x1bt')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('locating the transcript path'), 'Thinking is full')
  assert.ok(!view.includes('(alt+t to expand)'), 'no compact hint while full')
  assert.ok(view.includes('Read src/transcript.ts'), 'the Tool is unchanged by Alt+T')
  vt.sendInput('\x1bt')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('(alt+t to expand)'), 'Thinking is compact again')
  assert.ok(view.includes('Read src/transcript.ts'), 'the Tool is unchanged by the collapse too')
  app.stop()
})

// ── E. Focus ON · fullscreen expanded ────────────────────────────────────

test('E1: Focus ON fullscreen expanded root — Thinking compact, Tool compact', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('locating the transcript path'), 'the Thinking preview is present')
  assert.ok(view.includes('Read src/transcript.ts [running]'), 'the Tool card is present')
  assert.equal(hintCount(view, 'click'), 1, `the compact Thinking card carries the click hint (compact secondaries):\n${view}`)
  assert.ok(!view.includes('(ctrl+o to expand)'), 'fullscreen secondaries are click-owned, never Ctrl+O')
  app.setFullscreen(false)
  app.stop()
})

test('E2–E5: per-card clicks layer over the bulk preference; Alt+T resets them', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const rootY = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, rootY + 1)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('alpha latest') && view.includes('beta latest'), 'both Thinking cards present (compact)')
  assert.equal(hintCount(view, 'click'), 2, 'both compact (no tools in this fixture)')
  // E2: click beta — ONLY beta full.
  const betaY = findRow(vt.getViewport(), 'beta latest')
  click(vt, 10, betaY + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  beta reasoning'), `beta must be full:\n${view}`)
  assert.ok(!view.includes('\n  alpha reasoning'), `alpha must stay compact:\n${view}`)
  assert.equal(hintCount(view, 'click'), 1, `exactly alpha keeps its hint:\n${view}`)
  // E3: Alt+T — all Thinking full, the local override reset.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  alpha reasoning'), `alpha full after bulk expand:\n${view}`)
  assert.ok(view.includes('\n  beta reasoning'), `beta full after bulk expand:\n${view}`)
  assert.equal(hintCount(view, 'click'), 0, 'bulk expand clears every override and hint')
  // E4: click ONE Thinking after bulk full — only that one becomes compact.
  const alphaY = findRow(vt.getViewport(), 'alpha reasoning')
  click(vt, 10, alphaY + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\n  alpha reasoning'), `the clicked card must be compact:\n${view}`)
  assert.ok(view.includes('\n  beta reasoning'), `the other card stays full:\n${view}`)
  assert.equal(hintCount(view, 'click'), 1, `exactly the clicked card shows the hint:\n${view}`)
  // E5: Alt+T collapse — all compact, overrides reset again.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\n  alpha reasoning') && !view.includes('\n  beta reasoning'), 'all compact after bulk collapse')
  assert.equal(hintCount(view, 'click'), 2, 'both cards compact again — the E4 override was cleared')
  app.setFullscreen(false)
  app.stop()
})

// ── F. Focus switch ──────────────────────────────────────────────────────

test('F1/F2: the Thinking preference survives Focus ON/OFF switches', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  // F1: Focus OFF + expanded → Focus ON → still expanded.
  show(app, folder)
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  assert.equal(app.isThinkingExpanded(), true)
  app.setFocusMode(true)
  await vt.waitForRender()
  assert.equal(app.isThinkingExpanded(), true, 'Focus ON must not reset the bulk preference')
  // F2: Focus ON + compact → Focus OFF → still compact.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  assert.equal(app.isThinkingExpanded(), false)
  app.setFocusMode(false)
  await vt.waitForRender()
  assert.equal(app.isThinkingExpanded(), false, 'Focus OFF must not reset the bulk preference')
  app.stop()
})

// ── G. Surface switch ────────────────────────────────────────────────────

test('G2: a fullscreen click override never leaks into regular — regular follows the bulk only', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Local override: beta full.
  const betaY = findRow(vt.getViewport(), 'beta latest')
  click(vt, 10, betaY + 1)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  beta reasoning'), 'precondition: beta full in fullscreen')
  // Switch to regular: the override is dropped — beta renders compact
  // like every other card (the bulk preference is the only state).
  app.setFullscreen(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\n  beta reasoning'), `the stale override must not leak into regular:\n${view}`)
  assert.ok(view.includes('beta latest'), 'beta renders compact with its preview')
  assert.ok(hintCount(view, 'alt+t') === 2, 'both cards compact with the Alt+T hint')
  app.stop()
})

// ── H. Search ────────────────────────────────────────────────────────────

test('H1: a search hit full-reveals ONLY the matched Thinking; the bulk preference stays compact', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  show(app, folder)
  await vt.waitForRender()
  const messages = folder.messages()
  const beta = messages.find(m => m.kind === 'thinking' && m.text.includes('beta'))
  assert.ok(beta !== undefined, 'fixture: the beta thinking card exists')
  app.revealSearchMatch(beta)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  beta reasoning'), `the matched card must be full:\n${view}`)
  assert.ok(!view.includes('\n  alpha reasoning'), `the other card must stay compact:\n${view}`)
  assert.equal(hintCount(view, 'alt+t'), 1, `the unmatched card keeps its hint:\n${view}`)
  assert.equal(app.isThinkingExpanded(), false, 'the bulk preference is untouched by search')
  app.stop()
})

test('H2: Focus collapsed search hit opens the owner Thought with the matched Thinking full', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const messages = folder.messages()
  const alpha = messages.find(m => m.kind === 'thinking' && m.text.includes('alpha'))
  assert.ok(alpha !== undefined, 'fixture: the alpha thinking card exists')
  app.revealSearchMatch(alpha)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('🐳 Thought'), `the owner root must open:\n${view}`)
  assert.ok(view.includes('\n  alpha reasoning'), `the matched reasoning must be full:\n${view}`)
  assert.ok(view.includes('beta latest'), 'the unmatched card stays compact (preview)')
  assert.equal(app.isThinkingExpanded(), false, 'search never touches the bulk preference')
  app.setFullscreen(false)
  app.stop()
})

// ── I. /settings ─────────────────────────────────────────────────────────

/** A fake tuiSettings document recording every replace write. */
function fakeTuiSettings(): { value: TuiSettingsLike; writes: Array<Record<string, unknown>> } {
  const doc: Record<string, unknown> = {
    theme: 'auto', footer: 'full', fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport',
  }
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    value: {
      get: () => ({ ...doc }) as unknown as TuiSettingsLike['get'] extends () => infer R ? R : never,
      replace: (next) => {
        writes.push({ ...next })
        Object.assign(doc, next)
        return undefined as unknown
      },
    },
  }
}

/** Register the TUI commands with a stubbed runner and return /settings. */
function setupSettings() {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const defs: { name: string; handler?: unknown }[] = []
  ctx.provide('commands', {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      defs.push(def)
      return () => {}
    },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  } as never)
  const settings = fakeTuiSettings()
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: settings.value,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' as const }),
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommands(runner)
  const def = defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const run = async (): Promise<void> => {
    await (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
      commandId: CommandId('cmd-test-1'),
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  }
  return { vt, app, run, view, settings }
}

test('I1–I6: the /settings Thinking row is the SAME state as Alt+T (detail semantics)', async () => {
  const t = setupSettings()
  await t.run()
  let view = await t.view()
  // I1: the default current value is collapsed.
  assert.ok(view.includes('Thinking detail'), `the row must render:\n${view}`)
  assert.ok(view.includes('collapsed'), `the default value must be collapsed:\n${view}`)
  // I2: the value list is exactly collapsed / expanded (cycle once).
  // Select the row (rows without a session: theme, icon-style, expand,
  // thinking).
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  view = await t.view()
  assert.ok(view.includes('collapsed'), `still collapsed on the row:\n${view}`)
  // I3: the description speaks DETAIL, never visibility.
  assert.ok(view.includes('Default detail level for reasoning blocks; blocks stay visible'),
    `the detail description missing:\n${view}`)
  assert.ok(!view.includes('shown') && !view.includes('hidden') && !view.includes('render at all'),
    `the old shown/hidden language must be gone:\n${view}`)
  // I4: selecting expanded sets the app state DIRECTLY (declarative setter).
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.app.isThinkingExpanded(), true, 'the settings pick must set the app state')
  view = await t.view()
  assert.ok(view.includes('expanded'), `the row must reflect the new value:\n${view}`)
  // I5: Alt+T after the settings write toggles from the SAME state.
  t.app.toggleThinkingExpanded()
  assert.equal(t.app.isThinkingExpanded(), false, 'Alt+T must toggle from the settings state')
  // I6: a REOPENED settings panel reflects the Alt+T state (one source).
  t.vt.sendInput('\x1b') // close the panel
  await t.view()
  await t.run()
  view = await t.view()
  assert.ok(view.includes('collapsed'), `the reopened row must reflect the Alt+T toggle:\n${view}`)
  t.app.stop()
})

test('I7: the /settings declarative setter clears per-card overrides like Alt+T (bulk statement)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(twoThinkingTurn(0))
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Fullscreen click: beta full (per-card override), bulk compact.
  const betaY = findRow(vt.getViewport(), 'beta latest')
  click(vt, 10, betaY + 1)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  beta reasoning'), 'precondition: beta full via the click override')
  // The settings picker sets the SAME value ('collapsed' — the early
  // return path): the stale override must still be cleared, so beta
  // falls back to the bulk compact state.
  app.setThinkingExpanded(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\n  beta reasoning'), `the declarative set must reset the stale override:\n${view}`)
  assert.equal(hintCount(view, 'click'), 2, 'both cards compact again (no leftover override)')
  // The flip path clears overrides as well: click alpha full, then the
  // settings picker chooses 'expanded' — alpha follows the bulk.
  const alphaY = findRow(vt.getViewport(), 'alpha latest')
  click(vt, 10, alphaY + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  alpha reasoning'), 'alpha: full via the click override')
  app.setThinkingExpanded(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  alpha reasoning') && view.includes('\n  beta reasoning'),
    `the declarative expanded must own BOTH cards (overrides cleared):\n${view}`)
  assert.equal(hintCount(view, 'click'), 0, 'no compact card under the bulk-expanded statement')
  app.setFullscreen(false)
  app.stop()
})

// ── J. No reasoning ──────────────────────────────────────────────────────

test('J1: a turn without reasoning-delta never manufactures a Thinking block', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(noReasoningTurn(0))
  show(app, folder)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Thinking'), `no Thinking block may be manufactured:\n${view}`)
  assert.ok(view.includes('Bash pnpm test'), 'the tool card still renders')
  app.stop()
})

// ── K. Running ───────────────────────────────────────────────────────────

test('P1: an override on a Thinking card OUTSIDE the visible window is still cleared by Alt+T and surface transitions', async () => {
  // The visible transcript is WINDOWED: a clicked card can scroll out of
  // `messages` while its override stays in the map. Alt+T and the
  // fullscreen → regular transition must reset EVERY Thinking override —
  // a later search jump / window restore must never resurrect a stale
  // per-card state (review finding).
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setFullscreen(true)
  await vt.waitForRender()
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  // A card that IS in the visible window, and one that is NOT (its turn
  // scrolled out — the window only carries the newest turns).
  const visible = { kind: 'thinking', turn: 9, text: 'visible card' } as const
  const scrolledOut = { kind: 'thinking', turn: 0, text: 'scrolled-out card' } as const
  app.setTranscript([visible])
  overrides.set(visible, true)
  overrides.set(scrolledOut, true)
  await vt.waitForRender()
  // Alt+T: clears EVERY Thinking override, windowed or not.
  app.toggleThinkingExpanded()
  assert.equal(overrides.has(visible), false, 'Alt+T must clear the visible card override')
  assert.equal(overrides.has(scrolledOut), false, 'Alt+T must clear a scrolled-out card override too')
  // The fullscreen → regular transition clears them as well.
  overrides.set(visible, true)
  overrides.set(scrolledOut, true)
  app.setFullscreen(false)
  assert.equal(overrides.has(visible), false, 'leaving fullscreen must clear the visible card override')
  assert.equal(overrides.has(scrolledOut), false, 'leaving fullscreen must clear a scrolled-out card override too')
  app.stop()
})

// ── K. Running ───────────────────────────────────────────────────────────

test('K2: FULL running reasoning live-appends new deltas into the open body', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  show(app, folder)
  app.setThinkingExpanded(true) // full from the start
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('locating the transcript path'), 'the full body renders')
  // A new reasoning delta streams in: it live-appends into the full card.
  folder.apply([
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: '\nchecking turn boundaries…' } }, T0 + 4000, 10),
  ])
  show(app, folder)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('checking turn boundaries…'), `new reasoning must stream into the full card:\n${view}`)
  assert.ok(view.includes('locating the transcript path'), 'the earlier reasoning stays')
  app.stop()
})

// ── L. Cache identity ────────────────────────────────────────────────────

test('P2a: a wide → narrow resize re-derives the compact Thinking rows (no stale build at 100 cols)', async () => {
  // The compact card truncates AT RENDER TIME: resizing 100 → 8 must
  // keep the fixed three-row geometry with every row within the new
  // width — a stale build-time truncation would make the cached Text
  // wrap at the new width and inflate the block (review finding).
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'a fairly long reasoning preview that must re-truncate' }])
  await vt.waitForRender()
  let lines = vt.getViewport()
  let start = lines.findIndex(line => line.includes('🌊 Thinking'))
  assert.ok(start >= 0, `thinking block missing:\n${lines.join('\n')}`)
  assert.ok(lines[start + 1]!.includes('a fairly long reasoning preview'),
    'precondition: the 100-col preview is untruncated')
  vt.resize(8, 24)
  await vt.waitForRender()
  lines = vt.getViewport()
  // At 8 terminal cols the transcript content width is 6 and the 2-cell
  // 🌊 marker eats into the title, so it truncates to `🌊 Th…` — locate
  // by the marker, never the truncated word (the right-gutter contract).
  start = lines.findIndex(line => line.includes('🌊'))
  assert.ok(start >= 0, `thinking block missing after resize:\n${lines.join('\n')}`)
  const block = lines.slice(start, start + 3)
  assert.equal(block.length, 3, `resize must keep the fixed 3-row geometry:\n${block.join('\n')}`)
  for (const line of block) {
    assert.ok(visibleWidth(line) <= transcriptContentWidth(8),
      `a row exceeds the 6-col transcript content width after resize: ${JSON.stringify(line)}`)
  }
  app.stop()
})

test('P2b: a narrow → wide resize restores the untruncated preview', async () => {
  // The 8-col truncation must never survive a widening: the SAME cached
  // component re-derives its rows at the new width (review finding).
  const vt = new VirtualTerminal(8, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'a fairly long reasoning preview line' }])
  await vt.waitForRender()
  let lines = vt.getViewport()
  // 8 terminal cols → 6 content cols: the 2-cell 🌊 marker eats into the
  // title, so it truncates to `🌊 Th…` — locate by the marker, never the
  // truncated word (the right-gutter contract).
  let start = lines.findIndex(line => line.includes('🌊'))
  assert.ok(start >= 0, `thinking block missing:\n${lines.join('\n')}`)
  const narrowPreview = lines[start + 1]!
  assert.ok(visibleWidth(narrowPreview) <= transcriptContentWidth(8), `precondition: truncated at the 6-col content width (${JSON.stringify(narrowPreview)})`)
  assert.ok(!narrowPreview.includes('reasoning preview line'), 'precondition: the 8-col preview is truncated')
  vt.resize(100, 24)
  await vt.waitForRender()
  lines = vt.getViewport()
  start = lines.findIndex(line => line.includes('🌊 Thinking'))
  assert.ok(start >= 0, `thinking block missing after widening:\n${lines.join('\n')}`)
  const widePreview = lines[start + 1]!
  assert.ok(widePreview.includes('a fairly long reasoning preview line'),
    `the widened preview must recover from the stale 8-col truncation:\n${widePreview}`)
  assert.ok(visibleWidth(widePreview) <= 100, `preview row exceeds 100 cols: ${JSON.stringify(widePreview)}`)
  app.stop()
})

test('P2c: fullscreen resize keeps the compact rows stable and the click map aligned', async () => {
  // The fullscreen click hit-map depends on stable row heights: after a
  // 100 -> 8 resize the compact Thinking card must stay exactly 3 rows
  // AND a click on the re-derived title row must still toggle the card.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setFullscreen(true)
  app.setTranscript([
    { kind: 'thinking', turn: 0, text: 'one\ntwo\nthree' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a\nb\nc', status: 'ok' },
  ])
  await vt.waitForRender()
  // Precondition: compact, click the title row → full.
  let lines = vt.getViewport()
  let start = findRow(lines, '🌊 Thinking')
  assert.ok(start >= 0, `thinking block missing:\n${lines.join('\n')}`)
  click(vt, 3, start + 1)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('\n  two'), 'precondition: the click expands the card')
  // Collapse again (a different cell — the alt screen treats a fast
  // repeat at the same cell as a double-click word selection).
  lines = vt.getViewport()
  const bodyY = findRow(lines, 'two')
  click(vt, 20, bodyY + 1)
  await vt.waitForRender()
  // Resize to 8: the card stays 3 rows, each within the 6-col content
  // width (the transcript right gutter — the 2-cell 🌊 marker eats into
  // the title, so locate by the marker, never the truncated word).
  vt.resize(8, 24)
  await vt.waitForRender()
  lines = vt.getViewport()
  start = lines.findIndex(line => line.includes('🌊'))
  assert.ok(start >= 0, `thinking block missing after resize:\n${lines.join('\n')}`)
  const block = lines.slice(start, start + 3)
  assert.equal(block.length, 3, `fullscreen resize must keep the 3-row geometry:\n${block.join('\n')}`)
  for (const line of block) {
    assert.ok(visibleWidth(line) <= transcriptContentWidth(8),
      `a row exceeds the 6-col transcript content width after resize: ${JSON.stringify(line)}`)
  }
  // The click map follows: clicking the (new) title row toggles the card.
  click(vt, 3, start + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('one'), `the post-resize click must still expand the card:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

test('P2d: the compact card keeps a TRUE per-width reference-stable cache (width A → B → A)', async () => {
  // The same component + same width must return the SAME array instance
  // even after an intermediate width — the fork's per-frame processed-line
  // reuse depends on it (review finding: a single last-width slot breaks
  // the A → B → A sequence).
  const { ThinkingCompactComponent } = await import('../src/tui-app.ts')
  const component = new ThinkingCompactComponent(
    { kind: 'thinking', turn: 0, text: 'a preview line' },
    'alt+t',
  )
  const at100 = component.render(100)
  const at8 = component.render(8)
  assert.notEqual(at8, at100, 'different widths must build different rows')
  const at100again = component.render(100)
  assert.equal(at100again, at100, 'the same width must return the SAME array instance (reference-stable)')
  // invalidate() drops the cache; a re-render rebuilds (fresh instance).
  component.invalidate()
  const afterInvalidate = component.render(100)
  assert.notEqual(afterInvalidate, at100, 'invalidate() must drop the cached rows')
  assert.equal(afterInvalidate.length, 3, 'the rebuilt rows keep the compact geometry')
})

test('P2: the compact Thinking card never wraps on a narrow terminal', async () => {
  // Every compact row must truncate to the transcript CONTENT width (the
  // terminal width minus the right gutter) — a wrapped hint row would
  // break the fixed three-row geometry (review finding).
  const vt = new VirtualTerminal(8, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'a very long reasoning line that would wrap' }])
  await vt.waitForRender()
  const lines = vt.getViewport()
  const start = lines.findIndex(line => line.includes('🌊'))
  assert.ok(start >= 0, `thinking block missing:\n${lines.join('\n')}`)
  const block = lines.slice(start, start + 3)
  assert.equal(block.length, 3, `the block must stay 3 rows on a narrow terminal:\n${block.join('\n')}`)
  for (const line of block) {
    assert.ok(visibleWidth(line) <= transcriptContentWidth(8),
      `a compact row exceeds the 6-col content width: ${JSON.stringify(line)}`)
  }
  assert.ok(block[2]!.trim() !== '', 'the (truncated) hint row must still render')
  app.stop()
})

test('P2e: the compact card survives the 100 → 8 → 100 resize matrix inside the transcript gutter', async () => {
  // The right-gutter contract's resize matrix (plan §8.2):
  // the same cached component must narrow to the 6-col content width and
  // widen back to the full preview — the per-width cache keeps the fixed
  // three-row geometry at every stop.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'a fairly long reasoning preview line that must survive both resizes' }])
  await vt.waitForRender()
  const rowsOf = (): string[] => {
    const lines = vt.getViewport()
    const start = lines.findIndex(line => line.includes('🌊'))
    assert.ok(start >= 0, `thinking block missing:\n${lines.join('\n')}`)
    return lines.slice(start, start + 3)
  }
  let block = rowsOf()
  assert.equal(block.length, 3, `100-col block must be 3 rows:\n${block.join('\n')}`)
  assert.ok(block[1]!.includes('a fairly long reasoning preview line'),
    `the 100-col preview must be untruncated:\n${block[1]}`)
  vt.resize(8, 24)
  await vt.waitForRender()
  block = rowsOf()
  assert.equal(block.length, 3, `8-col block must stay 3 rows:\n${block.join('\n')}`)
  for (const line of block) {
    assert.ok(visibleWidth(line) <= transcriptContentWidth(8),
      `a row exceeds the 6-col content width at 8 cols: ${JSON.stringify(line)}`)
  }
  vt.resize(100, 24)
  await vt.waitForRender()
  block = rowsOf()
  assert.equal(block.length, 3, `widened block must stay 3 rows:\n${block.join('\n')}`)
  assert.ok(block[1]!.includes('a fairly long reasoning preview line'),
    'the widened preview must recover the full content width')
  app.stop()
})

test('L3: an Alt+T expanded transition rebuilds the plugin-rendered component too', async () => {
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const calls: string[] = []
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'probe', kind: 'thinking',
    render: (snapshot) => {
      calls.push(snapshot.text ?? '')
      return { kind: 'text', spans: [{ text: `probe ${snapshot.text ?? ''}` }] }
    },
  }, 'plugin')
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'one\ntwo', running: true }])
  await vt.waitForRender()
  assert.ok(calls.length >= 1, 'the plugin renderer must run once')
  const before = calls.length
  // Alt+T: the effective expansion flips — the cache identity must rebuild
  // the plugin component (host and plugin transition together).
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  assert.ok(calls.length > before, `the expanded transition must rebuild the plugin component (${calls.length} vs ${before})`)
  app.stop()
})
