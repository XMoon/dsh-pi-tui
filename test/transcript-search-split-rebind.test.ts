/**
 * Passive search-rebind regression: when a read GROUP splits under an OPEN
 * search, the next PASSIVE projection commit must rebind the highlight/target
 * to the occurrence that still holds the needle.
 *
 * The stale-binding hazard is fold-level: two raw-adjacent settled reads merge
 * into ONE card whose searchable corpus lives on the FIRST member (the
 * representative). A query matching read B's result therefore yields a match
 * whose `id` is read A's raw index. When a later durable settlement proves the
 * Conversation became visible BETWEEN the reads, the fold splits the group —
 * and that stored id now resolves to read A's own card, which does NOT contain
 * the query, while a fresh `folder.search(query)` resolves to read B.
 *
 * `searchBindingForRepaint()` is the real PASSIVE caller (invoked after every
 * projection commit). This test drives the production runner exactly like
 * `test/transcript-search-runner.test.ts` does: real `apply(ctx, config)`
 * wiring, the real TuiApp, the real raw-input search overlay, and the real
 * `session/event` firehose (never an explicit Next/Prev navigation) to commit
 * the splitting projection. The expected cards come from the domain fold
 * authority (`TranscriptFolder`), never from a re-implementation of the
 * runtime binding.
 * @module @xmoon76/dsh-pi-tui/transcript-search-split-rebind.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui-app.ts'
import { transcriptSearchText } from '../src/transcript.ts'
import {
  disposeContext,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  settle,
  type FakeSession,
} from './support/runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const T0 = 1_700_000_000_000

/** A durable event envelope with explicit time/seq (the fold's read-split
 *  evidence is TIME-ordered inside one step, so the harness `event()` helper's
 *  seq-derived clock cannot express it). */
function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

function toolCall(callId: string, turn: number, step: number, time: number, seq: number, args: string): SessionEvent {
  return eventAt('tool/call', { turn, step, callId, name: 'read', arguments: args }, time, seq)
}

function toolResult(callId: string, turn: number, step: number, time: number, seq: number, text: string): SessionEvent {
  return eventAt('tool/result', {
    turn,
    step,
    message: {
      id: `r-${callId}`,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId },
    },
  }, time, seq)
}

/**
 * The MERGED state: the two settled reads are raw-adjacent with no record yet
 * proving a Conversation sat between them, so the fold produces ONE `2 files`
 * card whose representative is read A. Only read B's result carries the needle
 * (`zzq`), and only the merged representative corpus exposes it.
 */
function mergedReadEvents(): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    toolCall('read-a', 1, 0, T0 + 1_000, 1, '{"file_path":"a.ts"}'),
    toolResult('read-a', 1, 0, T0 + 1_500, 2, 'alpha body only'),
    toolCall('read-b', 1, 1, T0 + 3_000, 3, '{"file_path":"b.ts"}'),
    toolResult('read-b', 1, 1, T0 + 4_000, 4, 'zzq needle marker'),
  ]
}

/**
 * The splitting settlement (the `readsAcrossConversationEvents` shape from
 * `test/transcript-display-order-convergence.test.ts`): the reply text is
 * visible at +2s — BEFORE read B's +3s call — so the fold must DISPLACE read B
 * after the Conversation and split the merged group.
 */
function splitSettlement(): SessionEvent {
  return eventAt('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'm-1-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'between the reads' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [
      { type: 'chunk', time: T0 + 2_000, chunk: { type: 'text-delta', index: 0, text: 'between the reads' } },
      { type: 'chunk', time: T0 + 3_000, chunk: { type: 'tool-call-delta', index: 1, id: 'read-b', name: 'read', argumentsDelta: '{}' } },
    ],
  }, T0 + 5_000, 5)
}

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

test('a passive repaint rebinds a split read group to the card that holds the needle', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-search-split-')
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
  const context = new Context()
  life.defer(() => disposeContext(context))
  const session: FakeSession = fakeSession({
    id: 'search-split-session',
    header: { id: 'search-split-session', cwd: home, createdAt: T0, version: SESSION_FORMAT_VERSION },
    events: mergedReadEvents(),
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

  // 1. Run the query through the REAL overlay entry point on the MERGED fold.
  app.startTranscriptSearch()
  await settleRender()
  for (const char of 'zzq') input(char)
  await settleRender()

  const before = app.transcriptSearchPresentationForTest()
  assert.ok(before, 'precondition: the query is bound to a card')
  assert.ok(before.message !== undefined, 'precondition: the query resolved a card')
  assert.equal(before.message.kind, 'tool', 'precondition: the match is a read card')
  assert.match(before.message.kind === 'tool' ? before.message.args : '', /2 files/u,
    'precondition: the two settled reads are still ONE merged card')
  assert.ok(transcriptSearchText(before.message).includes('zzq'),
    'precondition: the merged representative holds read Bs needle')

  // 2. Commit the SPLITTING projection through the real `session/event`
  //    firehose. This is a PASSIVE commit — no explicit Next/Prev navigation.
  const liveSession = (harness.sessions as { get(id: string): unknown }).get(session.id)
  const emit = (context as unknown as { emit(name: string, ...args: unknown[]): void }).emit
  emit('session/event', liveSession, splitSettlement())
  await settleRender()

  // 3. The passive binding must follow the refreshed occurrence: the stale id
  //    would resolve to read A's card, which does NOT contain the query.
  const after = app.transcriptSearchPresentationForTest()
  assert.ok(after, 'the passive repaint keeps a bound target while the overlay is open')
  assert.ok(after.message !== undefined, 'the rebind resolved a live card')
  assert.ok(transcriptSearchText(after.message).includes('zzq'),
    'the passive repaint must bind the card that CONTAINS the needle, not the stale representative')
  assert.equal(after.message.kind === 'tool' ? after.message.callId : undefined, 'read-b',
    'the rebound card is read B (the split occurrence), not read A')
  assert.notEqual(after.matchId, before.matchId,
    'the split must rebind the match to the new representative occurrence')

  const published = [...app.searchMatchMessagesForTest()]
  assert.equal(published.length, 1, 'exactly the split occurrence is published as the representative')
  assert.ok(published.every(message => transcriptSearchText(message).includes('zzq')),
    'every published representative card contains the needle')
})
