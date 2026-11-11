/**
 * Production-runner transcript-search structural gates (perf plan S5 §8.1):
 * drive the REAL `apply(ctx, config)` wiring through a session, open the search
 * overlay and assert the presentation epoch invariants — one rebuild per
 * interaction, zero re-windows for a same-window query/Next/Prev, exactly one
 * projection for an off-window jump, and a clean dismiss that keeps the current
 * window while clearing the target. This closes the PR #149 tracked follow-up
 * (production `apply` wiring had no integration harness).
 * @module @xmoon76/dsh-pi-tui/transcript-search-runner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { sanitizeDisplayText } from '../../src/tui/presentation/terminal-text.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import {
  disposeContext,
  event,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  settle,
  type FakeSession,
} from '../support/runner-harness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** Capture the production TuiApp the runner starts (without replacing it). */
function captureApps(): { apps: TuiApp[]; restore: () => void } {
  const original = TuiApp.prototype.start
  const apps: TuiApp[] = []
  TuiApp.prototype.start = function (this: TuiApp) {
    apps.push(this)
    return original.call(this)
  }
  return { apps, restore: () => { TuiApp.prototype.start = original } }
}

/** Count `TranscriptFolder.window()` projections while a test measures. */
function countProjections(): { count(): number; reset(): void; restore: () => void } {
  const original = TranscriptFolder.prototype.window
  let calls = 0
  TranscriptFolder.prototype.window = function (this: TranscriptFolder, options: Parameters<TranscriptFolder['window']>[0]) {
    calls += 1
    return original.call(this, options)
  }
  return { count: () => calls, reset: () => { calls = 0 }, restore: () => { TranscriptFolder.prototype.window = original } }
}

/** One settled turn: a user prompt, an assistant answer, and (when marked) the
 * search term in the user text. */
function searchSession(turns: number, matchTurns: readonly number[], term = 'transcript needle'): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < turns; turn += 1) {
    const text = matchTurns.includes(turn) ? `turn ${turn} ${term}` : `turn ${turn} ordinary body`
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('user/message', {
      id: MessageId(`u-${turn}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, seq++))
    events.push(event('assistant/message', {
      turn, step: 0,
      message: {
        id: MessageId(`a-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, seq++))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, seq++))
  }
  return events
}

interface RunnerFixture {
  readonly app: TuiApp
  readonly vt: VirtualTerminal
  readonly projections: ReturnType<typeof countProjections>
  readonly harness: ReturnType<typeof makeHarness>
  readonly context: Context
  readonly fiber: { dispose(): Promise<unknown> }
  readonly sessionId: string
  /** Feed one raw terminal input chunk through the real input path. */
  input(data: string): void
  /** Let the runner's repaint timer and render pipeline settle. */
  settleRender(): Promise<void>
}

async function mountSearchRunner(
  t: Parameters<typeof testLifecycle>[0],
  turns: number,
  matchTurns: readonly number[],
  term = 'transcript needle',
  events?: readonly SessionEvent[],
  fullscreen: 'on' | 'off' = 'on',
): Promise<RunnerFixture> {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-search-runner-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 30)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = captureApps()
  life.defer(probe.restore)
  const projections = countProjections()
  life.defer(projections.restore)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const session: FakeSession = fakeSession({
    id: 'search-runner-session',
    header: { id: 'search-runner-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: events === undefined ? searchSession(turns, matchTurns, term) : [...events],
  })
  const harness = makeHarness(home, session, { provider: 'p', model: 'm' })
  const fiber = await mountRunner(context, home, harness, { sessionId: session.id }, { sessionId: session.id, fullscreen })
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const screens = app as unknown as {
      tui: { handleTerminalInput(data: string): void }
      fullscreen?: { handleTerminalInput(data: string): void }
    }
    ;(screens.fullscreen ?? screens.tui).handleTerminalInput(data)
  }
  return {
    app,
    vt,
    projections,
    harness,
    context,
    fiber,
    sessionId: session.id,
    input,
    settleRender: async () => {
      await settle()
      await new Promise<void>(resolve => setTimeout(resolve, 40))
      await settle()
      await vt.waitForRender()
    },
  }
}

function typeQuery(fixture: RunnerFixture, query: string): void {
  for (const char of query) fixture.input(char)
}

interface RunnerSearchSelection {
  readonly selectedIndex: number
  readonly selectedRow?: number
  readonly exact: boolean
  readonly sourceDisposition?: 'not-painted' | 'unproven'
  readonly exactPaintedSegments?: ReadonlyArray<{ readonly row: number; readonly startCol: number; readonly endCol: number }>
  readonly matches?: ReadonlyArray<{ readonly segments: ReadonlyArray<{ readonly row: number }> }>
}

function mountedSearchSelection(app: TuiApp, message: TranscriptMessage): RunnerSearchSelection | undefined {
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ block: { message?: TranscriptMessage }; searchSelection?: RunnerSearchSelection }>
  }).mountedTranscriptBlocks
  return mounted.find(entry => entry.block.message === message)?.searchSelection
}

/** The terminal column of one visible needle occurrence (cell width, never a
 * JS string index). */
function columnOf(line: string, needle: string, occurrence = 0): number {
  let index = -1
  let from = 0
  for (let occurrenceIndex = 0; occurrenceIndex <= occurrence; occurrenceIndex += 1) {
    index = line.indexOf(needle, from)
    assert.ok(index >= 0, `occurrence ${occurrenceIndex} of ${JSON.stringify(needle)} missing from ${JSON.stringify(line)}`)
    from = index + needle.length
  }
  return visibleWidth(line.slice(0, index))
}

const STRONG_BG = 0xe58a24
const WEAK_BG = 0xf5c542

test('runner rolls back a Runtime scope committed before Search projection throws', async (t) => {
  const fixture = await mountSearchRunner(t, 1, [], 'needle', undefined, 'off')
  const { app } = fixture
  assert.equal(app.isFullscreen(), false, 'the Direct runner starts in Regular')
  const originalSetSearchScope = app.setSearchScope
  const failure = new Error('Search scope projection failed')
  app.setSearchScope = function (this: TuiApp, scope) {
    originalSetSearchScope.call(this, scope)
    throw failure
  }

  assert.throws(() => app.startTranscriptSearch('view'), error => error === failure,
    'the original post-commit projection failure remains observable')
  assert.equal(app.isSearching(), false, 'the failed admission never mounts Search')
  assert.equal(app.isFullscreen(), false, 'the temporary Reader returns on Runtime admission failure')

  app.setSearchScope = originalSetSearchScope
  app.startTranscriptSearch('full')
  await fixture.settleRender()
  assert.equal(app.isSearching(), true, 'Runtime activeSearchScope was retired and a later Full open is admitted')
  assert.equal(app.isFullscreen(), true)
  app.closeTranscriptSearch()
  await fixture.settleRender()
  assert.equal(app.isFullscreen(), false)
})

test('runner search: Ctrl+F routes View hits and Tab switches the retained query to Full semantics', async (t) => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  t.after(() => setCapabilities(previousCapabilities))
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('dual-search-user'),
      role: 'user',
      content: [{ type: 'text', text: 'needle in the prompt' }],
      source: { kind: 'user' },
    }, 1),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('dual-search-assistant'),
        role: 'assistant',
        content: [{ type: 'text', text: '[label needle](https://example.invalid/needle) needle body' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  const originalSearch = TranscriptFolder.prototype.search
  let fullSearchCalls = 0
  TranscriptFolder.prototype.search = function (this: TranscriptFolder, query: string, options?: Parameters<TranscriptFolder['search']>[1]) {
    fullSearchCalls += 1
    return originalSearch.call(this, query, options)
  }
  t.after(() => { TranscriptFolder.prototype.search = originalSearch })

  fixture.input('\x06')
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()
  const mountedRows = (fixture.app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ rendered: readonly string[] }>
  }).mountedTranscriptBlocks.flatMap(block => block.rendered).map(stripTerminalSequences)
  assert.deepEqual(fixture.app.renderedViewSearchStatus(), { currentIndex: 0, count: 3 },
    `View counts prompt, visible link label and body, not hidden href; mounted=${JSON.stringify(mountedRows)}; frame=${JSON.stringify(fixture.vt.getViewport().map(stripTerminalSequences))}`)
  assert.equal(fullSearchCalls, 0, 'View input never calls the Full Folder authority')
  let title = fixture.vt.getViewport().map(stripTerminalSequences).find(line => line.includes('[View]'))
  assert.ok(title?.includes('1/3'), `View title reads its mounted occurrence status:\n${fixture.vt.getViewport().join('\n')}`)
  assert.equal(fixture.app.transcriptSearchPresentationForTest(), undefined,
    'View never installs a Full semantic target')

  fixture.input('\t')
  await fixture.settleRender()
  assert.ok(fullSearchCalls > 0, 'Tab switches to the existing semantic Folder search')
  assert.equal(fixture.app.transcriptSearchCoverageForTest(), 'entire-session',
    'the Direct runner publishes complete Folder coverage only on its Direct composition')
  title = fixture.vt.getViewport().map(stripTerminalSequences).find(line => line.includes('[Full]'))
  assert.ok(title?.includes('1/4'), `Full retains the hidden-href semantic occurrence:\n${fixture.vt.getViewport().join('\n')}`)
  assert.ok(fixture.vt.getViewport().map(stripTerminalSequences).some(line => line.includes('needle')),
    'the scope switch retains the original query')
  const fullTarget = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(fullTarget, 'Full query installs a current semantic target')
  assert.equal(fullTarget?.message?.kind, 'user',
    'Full current selection follows semantic source order, not a View ordinal')

  fixture.input('\x06')
  await fixture.settleRender()
  assert.deepEqual(fixture.app.renderedViewSearchStatus(), { currentIndex: 0, count: 3 })
  assert.equal(fixture.app.transcriptSearchPresentationForTest(), undefined,
    'Full target and reveal are retired before mounted View results return')
  const callsAfterSwitch = fullSearchCalls
  fixture.input('\r')
  await fixture.settleRender()
  assert.deepEqual(fixture.app.renderedViewSearchStatus(), { currentIndex: 1, count: 3 })
  assert.equal(fullSearchCalls, callsAfterSwitch, 'View Next never calls the Full Folder authority')
})

test('runner search: a same-window query re-windows zero times and rebuilds at most once', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [25, 29])
  const { app, projections } = fixture
  app.setTranscriptSearchTarget(undefined)
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'transcrip')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 25, 'precondition: the first in-window match is current')

  // ONE more query step, still inside the projected window.
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('t')
  await fixture.settleRender()
  const diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(projections.count(), 0, 'a same-window query must not re-window the transcript')
  assert.ok(diagnostics.rebuilds <= 1, `a same-window query rebuilds at most once (got ${diagnostics.rebuilds})`)
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 25, 'the current match is unchanged')
})

test('runner search: Next/Prev inside the window re-window zero times and rebuild once', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [10, 27])
  const { app, projections } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'transcript')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 10, 'precondition: the first match is current')

  // Next jumps FORWARD past the anchored window: exactly one projection.
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('\r') // Enter = next
  await fixture.settleRender()
  assert.equal(projections.count(), 1, 'Next past the anchored window projects once')
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'the jump commits exactly one rebuild')
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 27, 'Next lands on the later match')

  // The window now spans BOTH matches, so Prev and Next stay same-window.
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('\x1b[13;2u') // Shift+Enter = previous
  await fixture.settleRender()
  assert.equal(projections.count(), 0, 'Prev inside the window must not re-window')
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'Prev commits exactly one rebuild')
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 10, 'Prev returns to the earlier match')

  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('\r')
  await fixture.settleRender()
  assert.equal(projections.count(), 0, 'Next inside the window must not re-window')
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'Next commits exactly one rebuild')
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 27, 'Next returns to the later match')
})

test('runner search: an off-window jump re-windows exactly once and rebuilds once', async (t) => {
  // `zzq` appears ONLY in the far-off turn, so no prefix of the query matches
  // anything in the origin (latest) window.
  const fixture = await mountSearchRunner(t, 30, [2], 'zzq marker')
  const { app, projections } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('z')
  await fixture.settleRender()
  const diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(projections.count(), 1, 'an off-window jump projects the transcript exactly once')
  assert.equal(diagnostics.rebuilds, 1, 'the projection epoch commits as ONE rebuild')
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 2, 'the off-window match is current')
  assert.ok(app.searchMatchMessagesForTest().size >= 1, 'the weak-match representative set is published')

  // The NEXT character of the same query is now INSIDE the re-anchored window:
  // zero re-windows, one rebuild.
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('z')
  await fixture.settleRender()
  assert.equal(projections.count(), 0, 'a prefix refinement inside the re-anchored window must not re-window')
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'the refinement commits exactly one rebuild')
})

test('runner search: fullscreen dismiss preserves the historical result viewport', async (t) => {
  const longMatch = [
    ...Array.from({ length: 12 }, (_, index) => `prefix line ${index}`),
    'zzq marker',
    ...Array.from({ length: 12 }, (_, index) => `suffix line ${index}`),
  ].join('\n')
  const fixture = await mountSearchRunner(t, 30, [2], longMatch)
  const { app, projections, vt } = fixture
  app.setFullscreen(true)
  await fixture.settleRender()
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'zzq')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 2,
    'precondition: fullscreen search really jumped to the historical result')
  const beforeTargetRow = vt.getViewport().findIndex(line => line.includes('zzq marker'))
  assert.ok(beforeTargetRow > 0,
    'precondition: the searched middle row is visible below the fullscreen viewport top')
  const beforeScroll = app.fullscreenScrollForTest()?.scrollTop
  assert.ok(beforeScroll !== undefined && beforeScroll > 0,
    'precondition: fullscreen owns a real historical scroll position')

  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  app.closeTranscriptSearch()
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'closing clears the search target')
  assert.equal(app.isSearching(), false, 'the overlay is gone')
  assert.equal(projections.count(), 0, 'dismiss does not re-window the current transcript')
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1,
    'dismiss promotes and clears the presentation in one rebuild')
  assert.equal(app.fullscreenScrollForTest()?.scrollTop, beforeScroll,
    'dismiss preserves the real fullscreen viewport position')
  assert.equal(vt.getViewport().findIndex(line => line.includes('zzq marker')), beforeTargetRow,
    'the searched historical row keeps the same viewport offset after dismiss')
  assert.equal(app.searchMatchMessagesForTest().size, 0, 'closing clears the weak-match set')
})

test('runner search: a Compact dismiss promotes the revealed Work span and keeps the match visible', async (t) => {
  // A Compact turn whose search needle lives in a TOOL row hidden inside the
  // collapsed Work span, closed by an assistant narration.
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('u-0'), role: 'user',
      content: [{ type: 'text', text: 'go' }], source: { kind: 'user' },
    }, 1),
    event('tool/call', {
      turn: 0, step: 0, callId: ToolCallId('c1'), name: 'read',
      arguments: JSON.stringify({ path: 'zzq-needle.ts' }),
    }, 2),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('r-0'), role: 'tool',
        toolCallId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'zzq-needle-body' }],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
    }, 3),
    event('assistant/message', {
      turn: 0, step: 1,
      message: {
        id: MessageId('a-0'), role: 'assistant',
        content: [{ type: 'text', text: 'answer 0' }], source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ]
  const fixture = await mountSearchRunner(t, 1, [0], 'zzq-needle', events)
  const { app, vt } = fixture
  app.setDisplayPreset('compact')
  await fixture.settleRender()
  // The expanded tool card renders its status pill; the collapsed Work preview
  // does not — that is the observable "the owning span is open" fact.
  assert.ok(!vt.getViewport().join('\n').includes('[ok]'),
    'precondition: the tool row is inside the collapsed Work span')

  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'zzq-needle')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 0,
    'precondition: the query resolved to the hidden tool row')
  assert.equal(app.expandedWorkOwnersForTest().size, 0,
    'the search reveal stays presentation-only while searching')
  assert.ok(vt.getViewport().join('\n').includes('[ok]'),
    `the reveal opens the owning Work span so the match is reachable:\n${vt.getViewport().join('\n')}`)

  // The REAL dismiss path: Esc semantics through the runner's onSearchClose
  // ('dismiss') handler -> preserveCurrentReveal -> owner promotion.
  app.closeTranscriptSearch()
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'the search target is cleared')
  assert.equal(app.expandedWorkOwnersForTest().size, 1,
    'the dismissal promotes the revealed Work span to a manual owner')
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('[ok]'),
    `the promoted span keeps the matched row visible after dismissal:\n${after}`)
})

test('runner search: a surface switch clears search without latest or promotion', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [2], 'zzq marker')
  const { app } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'zzq')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 2, 'precondition: a historical target is current')

  app.setFullscreen(!app.isFullscreen())
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'surface change clears the search target')
  assert.equal(app.searchMatchMessagesForTest().size, 0, 'surface change clears weak representatives')
  assert.equal(app.isSearching(), false, 'surface change closes search')
})

test('runner search: a session switch clears the search presentation', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [2], 'zzq marker')
  const { app } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'zzq')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 2, 'precondition: the old session match is current')

  const newHandler = (fixture.harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register /new')
  await newHandler()
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined,
    'a session switch must never keep the old session card as the current match')
  assert.equal(app.searchMatchMessagesForTest().size, 0, 'a session switch clears the weak-match set')
})

test('runner search: dispose tears the search presentation down cleanly', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [2], 'zzq marker')
  const { app } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'zzq')
  await fixture.settleRender()

  await fixture.fiber.dispose()
  await settle()
  await disposeContext(fixture.context)
  assert.equal(app.isDisposed(), true, 'the surface is disposed with the runner fiber')
})

test('runner search: a late session event never strands the current target', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-search-runner-live-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 6)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = captureApps()
  life.defer(probe.restore)
  const projections = countProjections()
  life.defer(projections.restore)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const settingsDoc: Record<string, unknown> = {
    theme: 'auto', iconStyle: 'emoji', footer: 'full', footerFallbackMode: 'default',
    footerLayout: { schemaVersion: 1, rows: [] }, footerCustomItems: undefined, footerCommand: undefined,
    fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'input',
    focusMode: 'off', wheelScrollLines: '1', notificationMode: 'unfocused', notificationMethod: 'auto',
  }
  context.provide('settings', {
    describe: () => [{ ns: 'tui-app', user: { footerCustomItems: [] } }],
    register: () => ({
      get: () => ({ ...settingsDoc }),
      replace: async (next: Record<string, unknown>) => { Object.assign(settingsDoc, next) },
    }),
  } as never)
  const session: FakeSession = fakeSession({
    id: 'search-runner-live-session',
    header: { id: 'search-runner-live-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: searchSession(3, [0, 2]),
  })
  const harness = makeHarness(home, session, { provider: 'p', model: 'm' })
  const fiber = await mountRunner(context, home, harness, { sessionId: session.id }, { sessionId: session.id, fullscreen: 'on' })
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const screens = app as unknown as {
      tui: { handleTerminalInput(data: string): void }
      fullscreen?: { handleTerminalInput(data: string): void }
    }
    ;(screens.fullscreen ?? screens.tui).handleTerminalInput(data)
  }
  const settleRender = async (): Promise<void> => {
    await settle()
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    await settle()
    await vt.waitForRender()
  }

  app.startTranscriptSearch()
  await settleRender()
  for (const char of 'transcript') input(char)
  await settleRender()
  const before = app.transcriptSearchPresentationForTest()
  assert.equal(before?.matchTurn, 0, 'precondition: the first match is current')

  // Move away from the current target before the passive runner repaint. The
  // target must be outside the viewport so a later accidental explicit reveal
  // would change the observable scroll position.
  app.scrollToBottom({ disableFollow: true })
  await settleRender()
  const beforeScroll = app.fullscreenScrollForTest()?.scrollTop
  assert.ok(beforeScroll !== undefined && beforeScroll > 0,
    `precondition: the user has scrolled away from the target (scrollTop=${beforeScroll}, contentHeight=${app.transcriptContentHeightForTest()})`)
  assert.ok(!vt.getViewport().some(line => line.includes('turn 0 transcript needle')),
    'precondition: the current target is outside the manually selected viewport')

  // A durable event lands while the search stays open: the runner repaints the
  // projection and the passive binding re-resolves the SAME match against the
  // new epoch — one projection, one rebuild, no stale target.
  const liveSession = (harness.sessions as { get(id: string): unknown }).get(session.id)
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  const emit = (context as unknown as { emit(name: string, ...args: unknown[]): void }).emit
  emit('session/event', liveSession, event('assistant/message', {
    turn: 30, step: 0,
    message: {
      id: MessageId('late-answer'),
      role: 'assistant',
      content: [{ type: 'text', text: 'late answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, 900))
  await settleRender()
  assert.equal(projections.count(), 1, 'the live event projects the transcript exactly once')
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'the live projection stays one rebuild')
  assert.equal(app.fullscreenScrollForTest()?.scrollTop, beforeScroll,
    'a passive production-runner repaint must not snap back to the search target')
  const after = app.transcriptSearchPresentationForTest()
  assert.equal(after?.matchId, before?.matchId, 'the current match identity is preserved across the live projection')
  assert.equal(after?.revealGranted, true, 'the reveal grant survives the passive projection')
})

test('runner search: a no-match query atomically clears the representative set', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [25, 29])
  const { app, projections } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'transcript')
  await fixture.settleRender()
  assert.ok(app.searchMatchMessagesForTest().size > 0, 'precondition: the result cards are published')

  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  typeQuery(fixture, 'zzz') // 'transcriptzzz' — no match
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'the target is cleared')
  assert.equal(app.searchMatchMessagesForTest().size, 0,
    'the representative set is cleared ATOMICALLY with the target (never left stale)')
  assert.ok(app.searchPresentationDiagnosticsForTest().rebuilds <= 1,
    `the clear costs at most one rebuild (got ${app.searchPresentationDiagnosticsForTest().rebuilds})`)
  assert.equal(projections.count(), 0, 'a no-match clear never re-windows the transcript')
})

test('runner search: Ctrl+End while search is open repaints exactly once', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [2], 'zzq marker')
  const { app, projections } = fixture
  app.setFullscreen(true)
  await fixture.settleRender()
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'zzq') // off-window: the view sits on a history window
  await fixture.settleRender()
  assert.equal(app.isSearching(), true, 'precondition: the search box is open')
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 2,
    'precondition: fullscreen search really jumped to history')

  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('\x1b[1;5F') // Ctrl+End
  await fixture.settleRender()
  assert.equal(app.isSearching(), false, 'Ctrl+End closes the search box')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'the search presentation is cleared')
  assert.equal(projections.count(), 1,
    `Ctrl+End must project the transcript exactly ONCE (got ${projections.count()})`)
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1,
    'Ctrl+End commits the cleared search and latest window in exactly one rebuild')
})

test('runner search: every operation performs exactly one representative pass', async (t) => {
  const originalWrite = process.stderr.write
  const captured: string[] = []
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  process.env.DSH_TUI_SEARCH_PROFILE = '1'
  try {
    const fixture = await mountSearchRunner(t, 30, [25, 29])
    const { app } = fixture
    const operations = (): string[] => captured.filter(line => line.includes('[search-profile]') && line.includes('search.total='))
    const since = (start: number): string[] => operations().slice(start)

    app.startTranscriptSearch()
    await fixture.settleRender()

    // 1. A query WITH results: every keystroke resolves representatives once and
    //    commits + rebuilds.
    let mark = operations().length
    typeQuery(fixture, 'transcript')
    await fixture.settleRender()
    const hitOps = since(mark)
    assert.equal(hitOps.length, 10, `expected one line per keystroke, got ${hitOps.length}`)
    for (const operation of hitOps) {
      assert.equal(operation.split('search.resolve-representatives=').length - 1, 1,
        `each operation must resolve representatives exactly ONCE: ${operation.trim()}`)
      assert.ok(operation.includes('search.presentation-commit='), operation.trim())
      assert.ok(operation.includes('search.rebuild='), `a query with results rebuilds: ${operation.trim()}`)
    }

    // 2. Next / Prev steps over the same result set.
    mark = operations().length
    fixture.input('\r')
    await fixture.settleRender()
    fixture.input('\x1b[13;2u')
    await fixture.settleRender()
    assert.equal(since(mark).length, 2)

    // 3. The FIRST no-match step really clears the presentation (one rebuild).
    mark = operations().length
    fixture.input('z') // 'transcriptz' — first no-match
    await fixture.settleRender()
    const firstClear = since(mark)
    assert.equal(firstClear.length, 1, `expected one operation, got ${firstClear.length}`)
    assert.ok(firstClear[0]!.includes('search.presentation-commit='), 'the clear reports its commit')
    assert.ok(firstClear[0]!.includes('search.rebuild='), 'the FIRST no-match step commits an empty presentation')
    assert.ok(!firstClear[0]!.includes('search.window='), 'the clear never fabricates a projection stage')
    assert.ok(!firstClear[0]!.includes('search.scroll='), 'the clear never fabricates a scroll stage')

    // 4. A REPEAT no-match step changes nothing: the setter is a no-op, so the
    //    profiler must NOT report a rebuild for it.
    mark = operations().length
    typeQuery(fixture, 'zz') // still no match
    await fixture.settleRender()
    const noopClears = since(mark)
    assert.equal(noopClears.length, 2)
    for (const operation of noopClears) {
      assert.equal(operation.split('search.resolve-representatives=').length - 1, 1,
        `the pass still runs exactly once: ${operation.trim()}`)
      assert.ok(operation.includes('search.presentation-commit='), 'the presentation resolution still runs')
      assert.ok(!operation.includes('search.rebuild='),
        `a no-op no-match step must NOT report a rebuild: ${operation.trim()}`)
      assert.ok(!operation.includes('search.window='), 'no fabricated projection stage')
      assert.ok(!operation.includes('search.scroll='), 'no fabricated scroll stage')
    }
  } finally {
    process.stderr.write = originalWrite
    delete process.env.DSH_TUI_SEARCH_PROFILE
  }
})

test('runner search: a real User hit proves both occurrences at their painted cells', async (t) => {
  const text = [
    'top filler',
    'needle first hit',
    ...Array.from({ length: 20 }, (_, index) => `middle filler ${index}`),
    'needle second hit',
    'bottom filler',
  ].join('\n')
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('user-proof-message'),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, 1),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('user-proof-answer'),
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  const { app, vt } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()

  const firstTarget = app.transcriptSearchPresentationForTest()
  assert.equal(firstTarget?.sourceKey, 'message', 'the real Folder hit is the User message source')
  assert.equal(firstTarget?.sourceOccurrence, 0)
  const message = firstTarget?.message
  assert.ok(message?.kind === 'user')
  let selection = mountedSearchSelection(app, message)
  assert.equal(selection?.exact, true, 'the real runner proves the User source cell, not a guessed ordinal')
  assert.equal(selection?.selectedIndex, -1, 'the plain-text channel needs no rendered regex ordinal')
  assert.equal(selection?.selectedRow, selection?.exactPaintedSegments?.[0]?.row)
  assert.ok((selection?.exactPaintedSegments?.length ?? 0) > 0)
  let lines = vt.getViewport()
  let row = lines.findIndex(line => line.includes('needle first hit'))
  assert.ok(row >= 0, `the first painted target is visible:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG,
    'the first occurrence owns its real painted cell')
  const firstScrollTop = app.fullscreenScrollForTest()?.scrollTop ?? 0

  fixture.input('\r')
  await fixture.settleRender()
  const secondTarget = app.transcriptSearchPresentationForTest()
  assert.equal(secondTarget?.sourceOccurrence, 1, 'Next reaches the second authoritative occurrence')
  selection = mountedSearchSelection(app, message)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.selectedIndex, -1)
  lines = vt.getViewport()
  row = lines.findIndex(line => line.includes('needle second hit'))
  assert.ok(row >= 0, `the second painted target is visible:\n${lines.join('\n')}`)
  // The second proven row is already readable and uncovered, so Next must not
  // jitter the viewport: the sibling occurrence above legitimately stays
  // visible (the old "first is gone" expectation encoded a re-centering jump,
  // never a product requirement).
  assert.equal(app.fullscreenScrollForTest()?.scrollTop ?? 0, firstScrollTop,
    'an already-readable next occurrence keeps the viewport')
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG,
    'the second occurrence owns its real painted cell')

  fixture.input('\x1b[13;2u')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.sourceOccurrence, 0, 'Prev returns to the first occurrence')
  lines = vt.getViewport()
  row = lines.findIndex(line => line.includes('needle first hit'))
  assert.ok(row >= 0, `Prev returns the first painted row:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG)
})

test('runner search: sanitized Thinking bodies exclude title and hint from semantic matches', async (t) => {
  const rawControlOnly = '\x1b[?25i'
  assert.equal(sanitizeDisplayText(rawControlOnly), '', 'the control-only Thinking source has no safe display body')
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('thinking-search-user'),
      role: 'user',
      content: [{ type: 'text', text: 'i' }],
      source: { kind: 'user' },
    }, 1),
    event('assistant/attempt', {
      turn: 0, step: 0,
      stream: [{ type: 'chunk', time: 1_700_000_000_002, chunk: { type: 'reasoning-delta', index: 0, text: rawControlOnly } }],
    }, 2),
    event('assistant/attempt', {
      turn: 0, step: 1,
      stream: [{ type: 'chunk', time: 1_700_000_000_003, chunk: { type: 'reasoning-delta', index: 0, text: 'visible i preview' } }],
    }, 3),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'i', events)
  const { app, vt } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'i')
  await fixture.settleRender()

  const thinkingCards = [...app.searchMatchMessagesForTest()].filter(
    (message): message is Extract<TranscriptMessage, { kind: 'thinking' }> => message.kind === 'thinking',
  )
  const controlOnly = thinkingCards.find(message => message.text === rawControlOnly)
  const visiblePreview = thinkingCards.find(message => message.text === 'visible i preview')
  assert.ok(controlOnly !== undefined, 'raw control bytes still produce the semantic Thinking match')
  assert.ok(visiblePreview !== undefined, 'the safe preview remains a separate semantic match')

  const lines = vt.getViewport().map(stripTerminalSequences)
  const titleRow = lines.findIndex(line => line.includes('Thinking'))
  const hintRow = lines.findIndex(line => line.includes('click to expand'))
  const previewRow = lines.findIndex(line => line.includes('visible i preview'))
  assert.ok(titleRow >= 0 && hintRow >= 0 && previewRow >= 0, `all compact Thinking rows are painted:\n${lines.join('\n')}`)
  assert.notEqual(vt.getCellBgRgb(titleRow, lines[titleRow]!.indexOf('i')), WEAK_BG,
    'a non-current body-less Thinking title is not a weak message match')
  assert.notEqual(vt.getCellBgRgb(hintRow, lines[hintRow]!.indexOf('i')), WEAK_BG,
    'a compact disclosure hint is not part of the Thinking message source')
  assert.equal(vt.getCellBgRgb(previewRow, lines[previewRow]!.indexOf('i')), WEAK_BG,
    'the visible compact preview remains a yellow ordinary match')

  fixture.input('\r')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.message, controlOnly,
    'Next reaches the body-less Thinking semantic result')
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{
      block: { message?: TranscriptMessage }
      searchSelection?: { matches: readonly unknown[]; selectedIndex: number; selectedRow?: number; exact: boolean }
    }>
  }).mountedTranscriptBlocks
  const selection = mounted.find(entry => entry.block.message === controlOnly)?.searchSelection
  assert.deepEqual(selection?.matches, [], 'the empty safe body contributes no rendered candidates')
  assert.equal(selection?.selectedIndex, -1)
  assert.equal(selection?.selectedRow, 0, 'the empty body falls back to the card top')
  assert.equal(selection?.exact, false)
  const currentTitleRow = vt.getViewport().map(stripTerminalSequences).findIndex(line => line.includes('Thinking'))
  assert.ok(currentTitleRow >= 0)
  assert.notEqual(vt.getCellBgRgb(currentTitleRow, stripTerminalSequences(vt.getViewport()[currentTitleRow]!).indexOf('i')), WEAK_BG,
    'the current body-less Thinking title is never painted as a visible source match')
})

test('runner search: expanded Thinking body starts after a wrapped title at narrow width', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('thinking-wrapped-title-user'),
      role: 'user',
      content: [{ type: 'text', text: 'ordinary prompt' }],
      source: { kind: 'user' },
    }, 1),
    event('assistant/attempt', {
      turn: 0, step: 0,
      stream: [{ type: 'chunk', time: 1_700_000_000_002, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking about the issue' } }],
    }, 2),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'thinking', events)
  const { app, vt } = fixture
  vt.resize(12, 24)
  await fixture.settleRender()
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'thinking')
  await fixture.settleRender()

  const lines = vt.getViewport().map(stripTerminalSequences)
  const iconTitleRow = lines.findIndex(line => line.includes('🌊'))
  const titleTextRow = lines.findIndex((line, index) => index > iconTitleRow && line.includes('Thinking'))
  const bodyRow = lines.findIndex((line, index) => index > titleTextRow && line.includes('thinking'))
  assert.ok(iconTitleRow >= 0 && titleTextRow > iconTitleRow && bodyRow > titleTextRow,
    `the narrow expanded title wraps before the body:\n${lines.join('\n')}`)

  const selected = app.transcriptSearchPresentationForTest()?.message
  assert.equal(selected?.kind, 'thinking')
  const selection = mountedSearchSelection(app, selected!)
  assert.ok(selection !== undefined)
  assert.equal(selection.exact, true, 'the expanded reasoning body is proven at narrow width')
  assert.equal(selection.selectedIndex, -1, 'no rendered title ordinal is guessed')
  const titleRows = titleTextRow - iconTitleRow + 1
  const painted = selection.exactPaintedSegments
  assert.ok(painted !== undefined && painted.length > 0)
  assert.equal(selection.selectedRow, painted![0]!.row)
  assert.ok(painted!.every(segment => segment.row >= titleRows), 'every proven cell is below the wrapped title')
  assert.ok((selection.matches?.length ?? 0) > 0, 'the body occurrence remains available as a weak hint')
  assert.ok(selection.matches!.every(match => match.segments.every(segment => segment.row >= titleRows)),
    'rendered title rows are excluded from the same matcher list')
  const titleColumn = visibleWidth(lines[titleTextRow]!.slice(0, lines[titleTextRow]!.indexOf('Thinking')))
  assert.notEqual(vt.getCellBgRgb(titleTextRow, titleColumn), STRONG_BG,
    'the wrapped Thinking title word is never the body source cell')
  const bodyColumn = visibleWidth(lines[bodyRow]!.slice(0, lines[bodyRow]!.toLowerCase().indexOf('thinking')))
  assert.equal(vt.getCellBgRgb(bodyRow, bodyColumn), STRONG_BG,
    'the real body occurrence is the current painted cell')
})

test('runner search: passive assistant settlement refreshes the source range for the stable target', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('search-range-assistant'),
        role: 'assistant',
        content: [{ type: 'text', text: 'needle' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 1),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  const { app, projections, context, harness } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()
  const initial = app.transcriptSearchPresentationForTest()
  assert.equal(initial?.sourceKey, 'message')
  const readRange = (): { start: number; end: number } | undefined =>
    (app as unknown as { searchTarget?: { match: { normalizedSourceRange?: { start: number; end: number } } } })
      .searchTarget?.match.normalizedSourceRange
  assert.deepEqual(readRange(), { start: 0, end: 6 })

  const liveSession = (harness.sessions as { get(id: string): unknown }).get(fixture.sessionId)
  const emit = (context as unknown as { emit(name: string, ...args: unknown[]): void }).emit
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  emit('session/event', liveSession, event('assistant/message', {
    turn: 0, step: 0,
    message: {
      id: MessageId('search-range-assistant'),
      role: 'assistant',
      content: [{ type: 'text', text: 'prefix needle' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, 2))
  await fixture.settleRender()

  const updated = app.transcriptSearchPresentationForTest()
  assert.equal(updated?.matchId, initial?.matchId, 'the target keeps its stable message identity')
  assert.equal(updated?.occurrence, initial?.occurrence)
  assert.equal(updated?.sourceOccurrence, initial?.sourceOccurrence)
  assert.deepEqual(readRange(), { start: 7, end: 13 }, 'passive binding carries the current source-local offset')
  assert.equal(projections.count(), 1, 'the settlement projects once')
  assert.ok(app.searchPresentationDiagnosticsForTest().rebuilds <= 1, 'the offset refresh commits at most one rebuild')
})

test('runner search: Folder Workflow run status maps to the pill interior without its brackets', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId: 'workflow-status-run' as never, name: 'audit' }, 1),
    event('tool-workflow/run-end', { runId: 'workflow-status-run' as never, stopReason: 'completed' }, 2),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'completed', events)
  fixture.app.setIconStyle('minimal')
  await fixture.settleRender()
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'completed')
  await fixture.settleRender()

  assert.equal(fixture.app.transcriptSearchPresentationForTest()?.sourceKey, 'workflow-run.status')
  const lines = fixture.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes('Workflow audit [completed]'))
  assert.ok(row >= 0, `the real Workflow status pill is painted:\n${lines.join('\n')}`)
  const status = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf('completed')))
  const mounted = (fixture.app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ block: { message?: TranscriptMessage }; searchSelection?: { exact: boolean } }>
  }).mountedTranscriptBlocks
  assert.equal(mounted.find(entry => entry.block.message?.kind === 'workflow')?.searchSelection?.exact, true,
    'the real Folder run-status range is proven at paint time')
  assert.equal(fixture.vt.getCellBgRgb(row, status), STRONG_BG, 'the status text is the current cell')
  assert.notEqual(fixture.vt.getCellBgRgb(row, status - 1), STRONG_BG, 'the opening bracket is outside the exact field')
  assert.notEqual(fixture.vt.getCellBgRgb(row, status + visibleWidth('completed')), STRONG_BG, 'the closing bracket is outside the exact field')
})

test('runner search: Folder Workflow phase label maps to its exact painted cell', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId: 'workflow-phase-run' as never, name: 'audit' }, 1),
    event('tool-workflow/agent-start', {
      runId: 'workflow-phase-run' as never, seq: 1, label: 'worker', phase: 'needle phase', childId: 'child-phase' as never,
    }, 2),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()

  assert.ok(fixture.app.transcriptSearchPresentationForTest()?.sourceKey.startsWith('workflow-phase.'),
    'the Folder phase source survives the real runner binding')
  const lines = fixture.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes('needle phase'))
  assert.ok(row >= 0, `the real Workflow phase label is painted:\n${lines.join('\n')}`)
  const column = lines[row]!.indexOf('needle')
  assert.equal(fixture.vt.getCellBgRgb(row, column), STRONG_BG, 'the phase field is the current cell')
})

test('runner search: Folder Workflow member occurrences map to separate painted cells', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId: 'workflow-member-run' as never, name: 'audit' }, 1),
    event('tool-workflow/agent-start', {
      runId: 'workflow-member-run' as never, seq: 1, label: 'needle member needle', phase: 'P', childId: 'child-member' as never,
    }, 2),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()

  let target = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(target?.sourceKey.endsWith('.label'), 'the real Folder result is the member label field')
  let lines = fixture.vt.getViewport().map(stripTerminalSequences)
  let row = lines.findIndex(line => line.includes('needle member needle'))
  assert.ok(row >= 0, `the member label row is painted:\n${lines.join('\n')}`)
  let first = lines[row]!.indexOf('needle')
  let second = lines[row]!.lastIndexOf('needle')
  assert.equal(fixture.vt.getCellBgRgb(row, first), STRONG_BG)
  assert.equal(fixture.vt.getCellBgRgb(row, second), WEAK_BG, 'the other visible member hit stays yellow')

  fixture.input('\r')
  await fixture.settleRender()
  target = fixture.app.transcriptSearchPresentationForTest()
  assert.equal(target?.sourceOccurrence, 1)
  lines = fixture.vt.getViewport().map(stripTerminalSequences)
  row = lines.findIndex(line => line.includes('needle member needle'))
  assert.ok(row >= 0)
  first = lines[row]!.indexOf('needle')
  second = lines[row]!.lastIndexOf('needle')
  assert.equal(fixture.vt.getCellBgRgb(row, first), WEAK_BG, 'the previous occurrence stays yellow')
  assert.equal(fixture.vt.getCellBgRgb(row, second), STRONG_BG)
})

test('runner search: Folder Workflow member status maps to its exact painted cell', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId: 'workflow-member-status-run' as never, name: 'audit' }, 1),
    event('tool-workflow/agent-start', {
      runId: 'workflow-member-status-run' as never, seq: 1, label: 'worker', phase: 'P', childId: 'child-status' as never,
    }, 2),
    event('tool-workflow/agent-end', { runId: 'workflow-member-status-run' as never, seq: 1, outcome: 'cancelled' }, 3),
    event('tool-workflow/run-end', { runId: 'workflow-member-status-run' as never, stopReason: 'completed' }, 4),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'cancelled', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'cancelled')
  await fixture.settleRender()

  assert.ok(fixture.app.transcriptSearchPresentationForTest()?.sourceKey.endsWith('.status'),
    'the Folder result is the member status field')
  const lines = fixture.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes('worker — cancelled'))
  assert.ok(row >= 0, `the settled member status is painted:\n${lines.join('\n')}`)
  const column = lines[row]!.indexOf('cancelled')
  assert.equal(fixture.vt.getCellBgRgb(row, column), STRONG_BG, 'the member status text is the current cell')
})

test('runner search: Folder Workflow kind maps lowercase semantics to the painted title cell', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId: 'workflow-kind-run' as never, name: 'audit' }, 1),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'workflow', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'workflow')
  await fixture.settleRender()

  assert.equal(fixture.app.transcriptSearchPresentationForTest()?.sourceKey, 'workflow-run.kind',
    'the semantic source is the lowercase run kind')
  const lines = fixture.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes('Workflow audit'))
  assert.ok(row >= 0, `the real Workflow header is painted:\n${lines.join('\n')}`)
  const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf('Workflow')))
  assert.equal(fixture.vt.getCellBgRgb(row, column), STRONG_BG,
    'the lowercase semantic kind proves its painted title cell')
})

test('runner search: hidden Workflow member status proves the generated context-row cell', async (t) => {
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId: 'workflow-context-status-run' as never, name: 'audit' }, 1),
  ]
  for (let seq = 0; seq < 6; seq += 1) {
    events.push(event('tool-workflow/agent-start', {
      runId: 'workflow-context-status-run' as never,
      seq,
      label: seq === 0 ? 'failed worker' : `worker-${seq}`,
      phase: 'Research',
      childId: `context-child-${seq}` as never,
    }, 2 + seq))
  }
  events.push(event('tool-workflow/agent-end', {
    runId: 'workflow-context-status-run' as never, seq: 0, outcome: 'failed',
  }, 8))
  events.push(event('tool-workflow/agent-end', {
    runId: 'workflow-context-status-run' as never, seq: 1, outcome: 'completed',
  }, 9))

  const fixture = await mountSearchRunner(t, 1, [], 'completed', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'completed')
  await fixture.settleRender()

  const target = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(target?.sourceKey.endsWith('.status'), 'Folder source authority is the hidden member status')
  const lines = fixture.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes('↳ worker-1 — completed'))
  assert.ok(row >= 0, `the production renderer publishes the search-only context row:\n${lines.join('\n')}`)
  const label = lines[row]!.indexOf('worker-1')
  const status = lines[row]!.indexOf('completed')
  assert.equal(fixture.vt.getCellBgRgb(row, visibleWidth(lines[row]!.slice(0, status))), STRONG_BG,
    'the hidden member status maps to the exact context-row cell')
  assert.notEqual(fixture.vt.getCellBgRgb(row, visibleWidth(lines[row]!.slice(0, label))), STRONG_BG,
    'the neighboring context label is outside the status source')
})

test('runner search: a Folder Workflow name range reaches its exact VirtualTerminal cell', async (t) => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId: 'workflow-search-run' as never, name: 'needle-run' }, 1),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()

  const target = fixture.app.transcriptSearchPresentationForTest()
  assert.equal(target?.sourceKey, 'workflow-run.name', 'the real Folder hit retains its semantic field source')
  assert.equal(target?.message?.kind, 'workflow', 'the production runner resolves the Workflow card')
  const lines = fixture.vt.getViewport()
  const row = lines.findIndex(line => stripTerminalSequences(line).includes('needle-run'))
  assert.ok(row >= 0, `the Workflow header is painted:\n${lines.join('\n')}`)
  const column = stripTerminalSequences(lines[row]!).indexOf('needle')
  assert.equal(fixture.vt.getCellBgRgb(row, column), STRONG_BG,
    `the real semantic match range reaches the exact painted cell:\n${lines[row]}`)
  // A direct-field Workflow region is exact WITHOUT the dedicated
  // User/Thinking/Assistant proof channel, so the Source-only notice must be
  // decided by the FINAL selection exactness, never by one proof channel.
  const selection = mountedSearchSelection(fixture.app, target!.message!)
  assert.equal(selection?.exact, true, 'the Workflow name hit is a proven source range')
  assert.equal(selection?.sourceDisposition, undefined, 'an exact Workflow selection carries no Source-only state')
  assert.equal(fixture.app.currentFullSearchNotice(), undefined,
    'an exact Workflow hit never shows the Source-only row')
  assert.ok(!fixture.vt.getViewport().map(stripTerminalSequences).some(line => line.includes('Source-only')),
    'the Search box keeps its three-row form for the exact Workflow hit')
})

// ── F2: Full proves the current Assistant Markdown source onto real cells ─────

/** The terminal cell column of one visible occurrence on one viewport row,
 * measured from the terminal's OWN cells (never a JS string index, so a wide
 * glyph in the card prefix shifts exactly as the terminal sees it). */
function cellColumnOf(vt: VirtualTerminal, row: number, needle: string, occurrence = 0): number {
  let plain = ''
  const cellOfCharacter: number[] = []
  for (let column = 0; column < vt.columns; column += 1) {
    const text = vt.getCellText(row, column) ?? ''
    for (let index = 0; index < text.length; index += 1) cellOfCharacter.push(column)
    plain += text
  }
  let index = -1
  let from = 0
  for (let current = 0; current <= occurrence; current += 1) {
    index = plain.indexOf(needle, from)
    assert.ok(index >= 0, `occurrence ${current} of ${JSON.stringify(needle)} is painted on the terminal row`)
    from = index + needle.length
  }
  return cellOfCharacter[index]!
}

/** The STRONG exact-match background of the production dark palette. */
const F2_STRONG_BG = STRONG_BG

function strongRuns(vt: VirtualTerminal): Array<{ row: number; startCol: number; endCol: number; text: string }> {
  return vt.getRgbBackgroundRuns(F2_STRONG_BG).filter(run => vt.getCellBold(run.row, run.startCol))
}

function strongText(vt: VirtualTerminal): string {
  return strongRuns(vt).map(run => run.text).join('')
}

/** Whether any mounted block claims a PROVEN source-cell selection. */
function anyExactSelection(app: TuiApp): boolean {
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ searchSelection?: { exact: boolean } }>
  }).mountedTranscriptBlocks
  return mounted.some(entry => entry.searchSelection?.exact === true)
}

test('runner search: Full proves visible Assistant Markdown cells and keeps a hidden href honest', async (t) => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  t.after(() => setCapabilities(previousCapabilities))
  const events: SessionEvent[] = []
  let seq = 0
  const answer = (turn: number, text: string): void => {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('assistant/message', {
      turn, step: 0,
      message: {
        id: MessageId(`f2-runner-assistant-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, seq++))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, seq++))
  }
  answer(0, '[needle](https://example.invalid/needle) needle body')
  for (let turn = 1; turn < 24; turn += 1) answer(turn, `ordinary answer ${turn}`)
  answer(24, 'second card ordinary needle body')
  const fixture = await mountSearchRunner(t, 25, [], 'needle', events)
  const { app, vt } = fixture

  // View: only the mounted rendered occurrences of the newest window count.
  fixture.input('\x06')
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()
  assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: 0, count: 1 },
    'View counts the mounted rendered occurrence only')
  assert.equal(anyExactSelection(app), false, 'View never claims a Full source-cell proof')

  // Full: the semantic corpus owns hidden-href occurrence 1, and the first
  // semantic hit lives in an OFF-WINDOW turn, so this is a real Folder result.
  fixture.input('\t')
  await fixture.settleRender()
  let title = vt.getViewport().map(stripTerminalSequences).find(line => line.includes('[Full]'))
  assert.ok(title?.includes('1/4'), `Full keeps the hidden-href semantic occurrence:\n${vt.getViewport().join('\n')}`)
  let target = app.transcriptSearchPresentationForTest()
  assert.equal(target?.matchTurn, 0, 'Full selection starts at the earliest semantic source (off-window jump)')
  assert.equal(target?.message?.kind, 'assistant')
  const firstCard = target!.message!
  assert.equal(app.transcriptSearchCoverageForTest(), 'entire-session', 'Direct Full covers the entire session')
  let lines = vt.getViewport()
  let row = lines.findIndex(line => stripTerminalSequences(line).includes('needle needle body'))
  assert.ok(row >= 0, `the off-window Assistant card is painted after the jump:\n${lines.join('\n')}`)
  assert.deepEqual(strongRuns(vt).map(run => run.text), ['needle'], 'the link label is the proven current cell')
  assert.equal(strongRuns(vt)[0]!.startCol, cellColumnOf(vt, row, 'needle', 0), 'the LABEL occurrence is strong')
  let selection = mountedSearchSelection(app, firstCard)
  assert.equal(selection?.exact, true, 'the label hit is proven from the semantic source range')
  assert.equal(selection?.selectedIndex, -1)

  // Enter -> the hidden href: no painted homonym may become the current cell.
  fixture.projections.reset()
  fixture.input('\r')
  await fixture.settleRender()
  target = app.transcriptSearchPresentationForTest()
  assert.equal(target?.sourceOccurrence, 1, 'the hidden href is the second visible-source occurrence')
  assert.deepEqual(strongRuns(vt), [], 'a hidden href never strong-highlights a visible homonym')
  selection = mountedSearchSelection(app, target!.message!)
  assert.equal(selection?.exact, false)
  assert.equal(selection?.exactPaintedSegments, undefined)
  assert.equal(selection?.sourceDisposition, 'not-painted', 'F1 NOT_PAINTED owns the source disposition')
  const hiddenNotice = app.currentFullSearchNotice()
  assert.deepEqual(hiddenNotice, { kind: 'not-painted', sourceLabel: 'Assistant text' },
    'a hidden link target is honest Source-only metadata, never a visible homonym')
  const frameAfterHidden = vt.getViewport().map(stripTerminalSequences)
  assert.ok(frameAfterHidden.some(line => line.includes('Source-only') && line.includes('no visible cell')),
    `the Search box paints the not-painted Source-only row:\n${frameAfterHidden.join('\n')}`)
  assert.ok(!frameAfterHidden.some(line => line.includes('https://example.invalid')),
    'the hidden href never leaks into the notice')

  // Enter -> the visible body occurrence.
  fixture.input('\r')
  await fixture.settleRender()
  target = app.transcriptSearchPresentationForTest()
  lines = vt.getViewport()
  row = lines.findIndex(line => stripTerminalSequences(line).includes('needle needle body'))
  assert.ok(row >= 0, `the body row is visible:\n${lines.join('\n')}`)
  assert.deepEqual(strongRuns(vt).map(run => run.text), ['needle'], 'the body occurrence is proven')
  assert.equal(strongRuns(vt)[0]!.startCol, cellColumnOf(vt, row, 'needle', 1), 'the BODY occurrence is strong')
  selection = mountedSearchSelection(app, target!.message!)
  assert.equal(selection?.exact, true)
  assert.ok((selection?.exactPaintedSegments?.length ?? 0) > 0)
  assert.equal(selection?.sourceDisposition, undefined, 'an exact selection carries no Source-only state')
  assert.equal(app.currentFullSearchNotice(), undefined, 'an exact hit never shows the Source-only row')
  assert.ok(!vt.getViewport().map(stripTerminalSequences).some(line => line.includes('Source-only')),
    'the Search box returns to its three-row form for an exact target')
  assert.equal(fixture.projections.count(), 0, 'same-card Full Next never re-windows the transcript')

  // Enter -> the cross-card result (a second off-window jump forward).
  fixture.projections.reset()
  fixture.input('\r')
  await fixture.settleRender()
  target = app.transcriptSearchPresentationForTest()
  assert.equal(target?.matchTurn, 24, 'Next crosses cards to the later semantic result')
  lines = vt.getViewport()
  assert.ok(lines.some(line => stripTerminalSequences(line).includes('second card ordinary needle body')),
    `the second card is the viewport destination:\n${lines.join('\n')}`)
  assert.deepEqual(strongRuns(vt).map(run => run.text), ['needle'], 'the later card proves its own cells')
  assert.equal(mountedSearchSelection(app, target!.message!)?.exact, true)
  assert.equal(fixture.projections.count(), 1, 'the cross-card off-window jump projects the transcript exactly once')

  // Shift+Enter returns to the previous card and re-proves it.
  fixture.input('\x1b[13;2u')
  await fixture.settleRender()
  target = app.transcriptSearchPresentationForTest()
  assert.equal(target?.matchTurn, 0)
  lines = vt.getViewport()
  row = lines.findIndex(line => stripTerminalSequences(line).includes('needle needle body'))
  assert.ok(row >= 0, `the previous card is the viewport destination:\n${lines.join('\n')}`)
  assert.deepEqual(strongRuns(vt).map(run => run.text), ['needle'])
  assert.equal(strongRuns(vt)[0]!.startCol, cellColumnOf(vt, row, 'needle', 1), 'the body cell is re-proven')

  // Back to View: the Full source proof and its reveal are retired; View counts
  // only the mounted rendered occurrences again.
  fixture.input('\x06')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'the Full target is retired before View returns')
  assert.equal(anyExactSelection(app), false, 'the old Full source-cell proof never survives the scope switch')
  assert.equal(app.currentFullSearchNotice(), undefined, 'the View scope retires the Full Source-only notice')
  assert.ok(!vt.getViewport().map(stripTerminalSequences).some(line => line.includes('Source-only')),
    'the previous scope never leaves its Source-only row painted')
  assert.ok((app.renderedViewSearchStatus()?.count ?? 0) >= 1,
    'View returns to its own mounted rendered occurrence authority')
})

// ── Full navigation projection: real Folder read groups and card-level targets ──

/** Fold one same-turn run of settled `read` calls whose results all contain
 * `needle`. This is a REAL Folder event stream: grouping comes from the
 * folder's own consecutive-read authority, never a fixture flag. */
function mergedReadSession(count: number, extraTurns: readonly number[] = []): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  events.push(event('turn/start', { turn: 0 }, seq++))
  for (let index = 0; index < count; index += 1) {
    const callId = ToolCallId(`g${index}`)
    events.push(event('tool/call', { turn: 0, step: 0, callId, name: 'read', arguments: JSON.stringify({ file: `src/f${index}.ts` }) }, seq++))
    events.push(event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId(`g-result-${index}`), role: 'tool', toolCallId: callId,
        content: [{ type: 'text', text: `needle payload ${index}` }],
        source: { kind: 'tool', callId },
      },
    }, seq++))
  }
  events.push(event('turn/end', { turn: 0, reason: { kind: 'completed' } }, seq++))
  for (const turn of extraTurns) {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('user/message', {
      id: MessageId(`extra-${turn}`), role: 'user',
      content: [{ type: 'text', text: `needle in the next card ${turn}` }],
      source: { kind: 'user' },
    }, seq++))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, seq++))
  }
  return events
}

function fullTitle(fixture: RunnerFixture): string {
  return fixture.vt.getViewport().map(stripTerminalSequences).find(line => line.includes('[Full]')) ?? ''
}

test('runner search: a real 12-read group is ONE Full target and one Enter leaves it', async (t) => {
  const fixture = await mountSearchRunner(t, 2, [], 'needle', mergedReadSession(12, [1]))
  const originalSearch = TranscriptFolder.prototype.search
  let rawMatches = 0
  TranscriptFolder.prototype.search = function (this: TranscriptFolder, query: string, options?: Parameters<TranscriptFolder['search']>[1]) {
    const matches = originalSearch.call(this, query, options)
    if (query === 'needle') rawMatches = matches.length
    return matches
  }
  t.after(() => { TranscriptFolder.prototype.search = originalSearch })

  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()

  assert.equal(rawMatches, 13, 'the Folder raw corpus keeps all 12 read occurrences plus the next card')
  assert.match(fullTitle(fixture), /1\/2/, `the overlay counts navigable targets, not raw hits:\n${fullTitle(fixture)}`)
  const first = fixture.app.transcriptSearchPresentationForTest()
  assert.equal(first?.message?.kind, 'tool', 'the first target is the merged read card')

  fixture.input('\r')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /2\/2/, `one Enter crosses to the next card:\n${fullTitle(fixture)}`)
  const second = fixture.app.transcriptSearchPresentationForTest()
  assert.equal(second?.message?.kind, 'user', 'the next card is the second target')
  assert.ok(fixture.vt.getViewport().some(line => stripTerminalSequences(line).includes('needle in the next card 1')),
    'the next card is the viewport destination')

  fixture.input('\x1b[13;2u')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /1\/2/, `Shift+Enter returns to the read card:\n${fullTitle(fixture)}`)
  assert.equal(fixture.app.transcriptSearchPresentationForTest()?.message?.kind, 'tool')
  assert.equal(rawMatches, 13, 'navigation projection never mutates the Folder semantic hits')
})

test('runner search: one folded card with 100+ hits stays ONE target without repeated rebuilds', async (t) => {
  const fixture = await mountSearchRunner(t, 1, [], 'needle', mergedReadSession(120))
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /1\/1/, `a single unlocatable card is ONE target:\n${fullTitle(fixture)}`)

  fixture.app.resetSearchPresentationDiagnosticsForTest()
  fixture.projections.reset()
  const target = fixture.app.transcriptSearchPresentationForTest()
  for (let step = 0; step < 5; step += 1) {
    fixture.input('\r')
    await fixture.settleRender()
    assert.match(fullTitle(fixture), /1\/1/, `repeated Next keeps 1/1 (step ${step})`)
    assert.equal(fixture.app.transcriptSearchPresentationForTest()?.sourceKey, target?.sourceKey,
      'the same card target survives repeated Next')
  }
  const diagnostics = fixture.app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.rebuilds, 0, 'a single card target is never rebuilt by repeated Next')
  assert.equal(diagnostics.occlusionCorrections, 0, 'a single card target never re-aims the viewport')
  assert.equal(fixture.projections.count(), 0, 'a single card target never re-windows the transcript')

  for (let step = 0; step < 3; step += 1) {
    fixture.input('\x1b[13;2u')
    await fixture.settleRender()
    assert.match(fullTitle(fixture), /1\/1/, `repeated Prev keeps 1/1 (step ${step})`)
  }
  assert.equal(fixture.app.searchPresentationDiagnosticsForTest().rebuilds, 0,
    'a single card target is never rebuilt by repeated Prev')
})

test('runner search: a folded same-turn subagent settlement is ONE card target and its reveal restores', async (t) => {
  const payload = 'FOLDED_SETTLED_NEEDLE payload with the needle inside'
  // The producer's exact wire shape: the fold reads it structurally, and the
  // session-event fixture carries the same branded ids as the navigation test.
  const settledMessage = {
    id: MessageId('runner-folded-settled'), role: 'user',
    content: [{ type: 'text', text: payload }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'child completed', senderSessionId: 'runner-child' },
  } as never
  const events: SessionEvent[] = [
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('settled-c1'), name: 'read', arguments: '{}' }, 1),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('settled-r1'), role: 'tool', toolCallId: ToolCallId('settled-c1'),
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('settled-c1') },
      },
    }, 2),
    event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [settledMessage] }, 3),
    event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 4),
    event('user/message', settledMessage, 5),
    event('tool/call', { turn: 0, step: 1, callId: ToolCallId('settled-c2'), name: 'bash', arguments: '{}' }, 6),
    event('tool/result', {
      turn: 0, step: 1,
      message: {
        id: MessageId('settled-r2'), role: 'tool', toolCallId: ToolCallId('settled-c2'),
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('settled-c2') },
      },
    }, 7),
    event('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('settled-final'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 8),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 9),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'FOLDED_SETTLED_NEEDLE', events)
  const view = (): string => fixture.vt.getViewport().map(stripTerminalSequences).join('\n')
  fixture.app.setDisplayPreset('compact')
  await fixture.settleRender()
  assert.ok(!view().includes('FOLDED_SETTLED_NEEDLE'),
    `precondition: Compact folds the qualified settlement under its Work:\n${view()}`)

  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'FOLDED_SETTLED_NEEDLE')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /1\/1/, `the settlement owns ONE navigation target:\n${fullTitle(fixture)}`)
  const target = fixture.app.transcriptSearchPresentationForTest()
  assert.equal(target?.revealGranted, true, 'Full grants the temporary reveal for the folded owner')
  assert.ok(view().includes('FOLDED_SETTLED_NEEDLE'),
    `the reveal opens the owning Work and locates the settlement body:\n${view()}`)
  const selection = target?.message === undefined ? undefined : mountedSearchSelection(fixture.app, target.message)
  assert.equal(selection?.exact, false, 'the folded settlement body is not a proven source cell')
  assert.equal(selection?.sourceDisposition, 'unproven', 'the honest Source-only classification survives')

  fixture.input('\x1b')
  await fixture.settleRender()
  assert.equal(fixture.app.transcriptSearchPresentationForTest(), undefined,
    'closing Search retires the temporary target')
  assert.ok(!fullTitle(fixture).includes('[Full]'), 'the Search overlay is closed after Esc')
  const closedMessage = target?.message
  assert.ok(closedMessage !== undefined)
  assert.equal(mountedSearchSelection(fixture.app, closedMessage), undefined,
    'the temporary settlement selection and its card anchor are retired')
})

test('runner search: two hidden-only hits on one card are ONE target and one Enter crosses cards', async (t) => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  t.after(() => setCapabilities(previousCapabilities))
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('assistant/message', {
      turn: 0, step: 0,
      message: {
        id: MessageId('hidden-only-assistant'), role: 'assistant',
        content: [{ type: 'text', text: '[a](https://example.invalid/needle) [b](https://example.invalid/needle)' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 1),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
    event('turn/start', { turn: 1 }, 3),
    event('user/message', {
      id: MessageId('hidden-only-next'), role: 'user',
      content: [{ type: 'text', text: 'needle in the next card' }],
      source: { kind: 'user' },
    }, 4),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  ]
  const fixture = await mountSearchRunner(t, 2, [], 'needle', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()
  const first = fixture.app.transcriptSearchPresentationForTest()
  assert.equal(first?.message?.kind, 'assistant')
  const hiddenSelection = first?.message === undefined ? undefined : mountedSearchSelection(fixture.app, first.message)
  assert.equal(hiddenSelection?.sourceDisposition, 'not-painted')
  assert.deepEqual(hiddenSelection?.matches, [], 'the card renders no query occurrence at all')
  assert.match(fullTitle(fixture), /1\/2/,
    `both hidden hits collapse into ONE card target plus the next card:\n${fullTitle(fixture)}`)

  fixture.input('\r')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /2\/2/, `one Enter crosses to the next card:\n${fullTitle(fixture)}`)
  assert.equal(fixture.app.transcriptSearchPresentationForTest()?.message?.kind, 'user')
})

test('runner search: a truncated workflow member does not swallow its exact-capable neighbour', async (t) => {
  const runId = 'find-truncated-workflow' as never
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('tool-workflow/run-start', { runId, name: 'audit' }, 1),
    event('tool-workflow/agent-start', {
      runId, seq: 0, label: `needle ${'x'.repeat(400)}`, phase: 'P', childId: 'find-truncated-0' as never,
    }, 2),
    event('tool-workflow/agent-start', {
      runId, seq: 1, label: 'needle short', phase: 'P', childId: 'find-truncated-1' as never,
    }, 3),
    event('tool-workflow/run-end', { runId, stopReason: 'completed' }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ]
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  fixture.vt.resize(72, 30)
  await fixture.settleRender()
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()

  const first = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(first?.sourceKey.includes('.0.label'), `the truncated member is the first target: ${first?.sourceKey}`)
  const firstSelection = first?.message === undefined ? undefined : mountedSearchSelection(fixture.app, first.message)
  assert.equal(firstSelection?.exact, false, 'the truncated label is honestly unproven')
  assert.match(fullTitle(fixture), /1\/2/,
    `the unproven member and its exact-capable neighbour are TWO targets:\n${fullTitle(fixture)}`)

  fixture.input('\r')
  await fixture.settleRender()
  const second = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(second?.sourceKey.includes('.1.label'),
    `Enter reaches the exact-capable visible member instead of leaving the card: ${second?.sourceKey}`)
  assert.equal(mountedSearchSelection(fixture.app, second!.message!)?.exact, true)
  assert.match(fullTitle(fixture), /2\/2/)
})

test('runner search: a hidden summary-phase status does not swallow an exact inline status', async (t) => {
  const runId = 'find-cross-source-workflow' as never
  const events: SessionEvent[] = [event('turn/start', { turn: 0 }, 0), event('tool-workflow/run-start', { runId, name: 'audit' }, 1)]
  let seq = 2
  for (let index = 0; index < 6; index += 1) {
    events.push(event('tool-workflow/agent-start', {
      runId, seq: index, label: `P member ${index}`, phase: 'P', childId: `find-cross-p-${index}` as never,
    }, seq++))
  }
  events.push(event('tool-workflow/agent-end', { runId, seq: 0, outcome: 'cancelled' }, seq++))
  events.push(event('tool-workflow/agent-start', {
    runId, seq: 6, label: 'Q member', phase: 'Q', childId: 'find-cross-q-6' as never,
  }, seq++))
  events.push(event('tool-workflow/agent-end', { runId, seq: 6, outcome: 'cancelled' }, seq++))
  events.push(event('tool-workflow/run-end', { runId, stopReason: 'completed' }, seq++))
  events.push(event('turn/end', { turn: 0, reason: { kind: 'completed' } }, seq++))

  const fixture = await mountSearchRunner(t, 1, [], 'cancelled', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'cancelled')
  await fixture.settleRender()

  const first = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(first?.sourceKey.endsWith('.status'), `the hidden summary status is the first target: ${first?.sourceKey}`)
  const firstSelection = first?.message === undefined ? undefined : mountedSearchSelection(fixture.app, first.message)
  assert.equal(firstSelection?.exact, false, 'the hidden summary status is honestly unproven')
  assert.equal(firstSelection?.selectedRow, 0,
    'with only chrome homonyms the viewport stays on the card anchor, never a status count')
  assert.match(fullTitle(fixture), /1\/2/,
    `the card-wide proving channel keeps the inline exact-capable status as its own target:\n${fullTitle(fixture)}`)

  fixture.input('\r')
  await fixture.settleRender()
  const second = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(second !== undefined && second.sourceKey !== first?.sourceKey,
    'Enter reaches the different-source inline status on the same card')
  assert.ok(second!.sourceKey.endsWith('.status'))
  assert.equal(mountedSearchSelection(fixture.app, second!.message!)?.exact, true)
  assert.match(fullTitle(fixture), /2\/2/)
})

test('runner search: two hidden summary statuses with only chrome homonyms are ONE card target', async (t) => {
  const runId = 'find-chrome-only-workflow' as never
  const events: SessionEvent[] = [event('turn/start', { turn: 0 }, 0), event('tool-workflow/run-start', { runId, name: 'audit' }, 1)]
  let seq = 2
  for (let index = 0; index < 6; index += 1) {
    events.push(event('tool-workflow/agent-start', {
      runId, seq: index, label: `P member ${index}`, phase: 'P', childId: `find-chrome-only-${index}` as never,
    }, seq++))
  }
  events.push(event('tool-workflow/agent-end', { runId, seq: 0, outcome: 'cancelled' }, seq++))
  events.push(event('tool-workflow/agent-end', { runId, seq: 1, outcome: 'cancelled' }, seq++))
  events.push(event('tool-workflow/run-end', { runId, stopReason: 'completed' }, seq++))
  events.push(event('turn/end', { turn: 0, reason: { kind: 'completed' } }, seq++))

  const fixture = await mountSearchRunner(t, 1, [], 'cancelled', events)
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'cancelled')
  await fixture.settleRender()

  const first = fixture.app.transcriptSearchPresentationForTest()
  assert.ok(first?.sourceKey.endsWith('.status'))
  const selection = first?.message === undefined ? undefined : mountedSearchSelection(fixture.app, first.message)
  assert.equal(selection?.exact, false)
  assert.equal(selection?.selectedRow, 0,
    'only status-count chrome renders the query, so the viewport stays at the card anchor')
  assert.match(fullTitle(fixture), /1\/1/,
    `both hidden summary statuses collapse into ONE card target:\n${fullTitle(fixture)}`)

  fixture.app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('\r')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /1\/1/, 'the single card target never re-targets itself')
  assert.equal(fixture.app.transcriptSearchPresentationForTest()?.sourceKey, first?.sourceKey)
  assert.equal(fixture.app.searchPresentationDiagnosticsForTest().rebuilds, 0,
    'a single card target is never rebuilt by Enter')
})

test('runner search: resize expires cached exact targets before the next step', async (t) => {
  const runId = 'find-resize-workflow' as never
  const events: SessionEvent[] = [event('turn/start', { turn: 0 }, 0), event('tool-workflow/run-start', { runId, name: 'audit' }, 1)]
  let seq = 2
  for (let index = 0; index < 2; index += 1) {
    events.push(event('tool-workflow/agent-start', {
      runId, seq: index, label: `needle ${'x'.repeat(50)}`, phase: 'P', childId: `find-resize-${index}` as never,
    }, seq++))
  }
  events.push(event('tool-workflow/run-end', { runId, stopReason: 'completed' }, seq++))
  events.push(event('turn/end', { turn: 0, reason: { kind: 'completed' } }, seq++))
  const fixture = await mountSearchRunner(t, 1, [], 'needle', events)
  fixture.vt.resize(120, 30)
  await fixture.settleRender()
  fixture.app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'needle')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /1\/2/)
  assert.equal(mountedSearchSelection(fixture.app, fixture.app.transcriptSearchPresentationForTest()!.message!)?.exact, true)
  fixture.input('\r')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /2\/2/)
  assert.equal(mountedSearchSelection(fixture.app, fixture.app.transcriptSearchPresentationForTest()!.message!)?.exact, true)

  fixture.vt.resize(40, 30)
  await fixture.settleRender()
  fixture.input('\r')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /1\/1/,
    `narrowing invalidates both cached exact targets and converges to one card:\n${fullTitle(fixture)}`)
  const presented = fixture.app.transcriptSearchPresentationForTest()
  assert.equal(mountedSearchSelection(fixture.app, presented!.message!)?.exact, false)
  fixture.input('\r')
  await fixture.settleRender()
  assert.match(fullTitle(fixture), /1\/1/, 'the converged card target never recycles stale exact targets')
})
