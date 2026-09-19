/**
 * Production-runner transcript-search structural gates (perf plan S5 §8.1):
 * drive the REAL `apply(ctx, config)` wiring through a session, open the search
 * overlay and assert the presentation epoch invariants — one rebuild per
 * interaction, zero re-windows for a same-window query/JNext/Prev, exactly one
 * projection for an off-window jump, and a clean close that restores the origin
 * window and clears the target. This closes the PR #149 tracked follow-up
 * (production `apply` wiring had no integration harness).
 * @module @xmoon76/dsh-pi-tui/transcript-search-runner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui-app.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import {
  disposeContext,
  event,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  settle,
  type FakeSession,
} from './support/runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
    events: searchSession(turns, matchTurns, term),
  })
  const harness = makeHarness(home, session, { provider: 'p', model: 'm' })
  const fiber = await mountRunner(context, home, harness, { sessionId: session.id }, { sessionId: session.id })
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
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

test('runner search: closing restores the origin window and clears the presentation', async (t) => {
  const fixture = await mountSearchRunner(t, 30, [2], 'zzq marker')
  const { app, projections } = fixture
  app.startTranscriptSearch()
  await fixture.settleRender()
  typeQuery(fixture, 'zzq')
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest()?.matchTurn, 2, 'precondition: the off-window match is current')

  projections.reset()
  app.closeTranscriptSearch()
  await fixture.settleRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'closing clears the search target')
  assert.equal(app.isSearching(), false, 'the overlay is gone')
  assert.equal(projections.count(), 1, 'closing repaints the restored origin window exactly once')
  assert.equal(app.searchMatchMessagesForTest().size, 0, 'closing clears the weak-match set')
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
  const vt = new VirtualTerminal(100, 30)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = captureApps()
  life.defer(probe.restore)
  const projections = countProjections()
  life.defer(projections.restore)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const session: FakeSession = fakeSession({
    id: 'search-runner-live-session',
    header: { id: 'search-runner-live-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: searchSession(3, [2]),
  })
  const harness = makeHarness(home, session, { provider: 'p', model: 'm' })
  const fiber = await mountRunner(context, home, harness, { sessionId: session.id }, { sessionId: session.id })
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
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
  assert.equal(before?.matchTurn, 2, 'precondition: the only match is current')

  // A durable event lands while the search stays open: the runner repaints the
  // projection and the passive binding re-resolves the SAME match against the
  // new epoch — one projection, one rebuild, no stale target.
  const liveSession = (harness.sessions as { get(id: string): unknown }).get(session.id)
  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  const emit = (context as unknown as { emit(name: string, ...args: unknown[]): void }).emit
  emit('session/event', liveSession, event('assistant/message', {
    turn: 3, step: 0,
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

  projections.reset()
  app.resetSearchPresentationDiagnosticsForTest()
  fixture.input('\x1b[1;5F') // Ctrl+End
  await fixture.settleRender()
  assert.equal(app.isSearching(), false, 'Ctrl+End closes the search box')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'the search presentation is cleared')
  assert.equal(projections.count(), 1,
    `Ctrl+End must project the transcript exactly ONCE (got ${projections.count()})`)
  assert.ok(app.searchPresentationDiagnosticsForTest().rebuilds <= 1,
    `Ctrl+End must not double-rebuild (got ${app.searchPresentationDiagnosticsForTest().rebuilds})`)
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
