import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of startedApps) {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
})

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return {
    type,
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    data,
  } as SessionEvent
}

function assistant(seq: number, step: number, text: string, turn = 1): SessionEvent {
  return event('assistant/message', {
    turn,
    step,
    message: {
      id: MessageId(`assistant-${turn}-${step}-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
    stream: [],
  }, seq)
}

function delivery(seq: number, files: readonly Record<string, unknown>[], turn = 1): SessionEvent {
  return event('deliverables/presented', { turn, callId: `present-${seq}`, files: [...files] }, seq)
}

function successfulPresentToolEvents(turn = 1): SessionEvent[] {
  const callId = ToolCallId(`present-${turn}`)
  return [
    event('tool/call', {
      turn,
      step: 0,
      callId,
      name: 'present',
      arguments: JSON.stringify({ files: [{ path: 'out/report.md', description: 'tool receipt' }] }),
    }, 1),
    event('tool/result', {
      turn,
      step: 0,
      message: {
        id: MessageId(`present-result-${turn}`),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: 'Presented out/report.md' }],
        }],
        source: { kind: 'tool', callId },
      },
    }, 2),
  ]
}

function closing(folder: TranscriptFolder): Extract<TranscriptMessage, { kind: 'assistant' }> {
  const message = folder.messages().find(item => item.kind === 'assistant' && item.text === 'final')
  assert.ok(message !== undefined && message.kind === 'assistant')
  return message
}

test('attaches valid durable declarations to the closing assistant', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    ...successfulPresentToolEvents(),
    delivery(3, [
      { path: 'out/report.md', description: 'Final report' },
      { path: 'LICENSE' },
    ]),
    assistant(4, 0, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  ])

  assert.deepEqual(closing(folder).deliverables, [
    { path: 'out/report.md', description: 'Final report' },
    { path: 'LICENSE' },
  ])
  assert.equal(folder.messages().some(item => item.kind === 'assistant' && item.deliverables === undefined), false)
  assert.equal((folder as unknown as { deliverableDeclarationsByTurn: Map<number, unknown> }).deliverableDeclarationsByTurn.size, 0)
})

test('attaches deliveries only to the latest assistant step', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    assistant(1, 0, 'intermediate'),
    delivery(2, [{ path: 'intermediate.md', description: 'not final' }]),
    assistant(3, 1, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ])

  const assistants = folder.messages().filter((item): item is Extract<TranscriptMessage, { kind: 'assistant' }> => item.kind === 'assistant')
  assert.equal(assistants.length, 2)
  assert.equal(assistants[0]?.deliverables, undefined)
  assert.deepEqual(assistants[1]?.deliverables, [{ path: 'intermediate.md', description: 'not final' }])
})

test('deduplicates by first-seen path order and keeps the latest pre-close description', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [
      { path: 'a.md', description: 'draft' },
      { path: 'b.md', description: 'final b' },
    ]),
    delivery(2, [{ path: 'a.md', description: 'final a' }]),
    assistant(3, 0, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ])

  assert.deepEqual(closing(folder).deliverables, [
    { path: 'a.md', description: 'final a' },
    { path: 'b.md', description: 'final b' },
  ])
})

test('uses a strict closing sequence boundary for late declarations', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    assistant(5, 0, 'final'),
    delivery(6, [{ path: 'late.md', description: 'too late' }]),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7),
  ])

  assert.equal(closing(folder).deliverables, undefined)
})

test('rejects malformed durable delivery envelopes before projection', () => {
  const malformed: Array<{ readonly event: SessionEvent; readonly turn: number }> = [
    {
      event: event('deliverables/presented', { turn: 1, files: [{ path: 'bad.md' }] }, 1),
      turn: 1,
    },
    {
      event: delivery(1, [{ path: 'bad.md' }], 0),
      turn: 0,
    },
    {
      event: delivery(1, [{ path: 'bad.md' }], Number.NaN),
      turn: Number.NaN,
    },
    {
      event: { ...delivery(1, [{ path: 'bad.md' }]), seq: undefined } as unknown as SessionEvent,
      turn: 1,
    },
  ]

  for (const { event: badEvent, turn } of malformed) {
    const folder = new TranscriptFolder()
    folder.hydrate([
      event('turn/start', { turn }, 0),
      badEvent,
      assistant(2, 0, 'final', turn),
      event('turn/end', { turn, reason: { kind: 'completed' } }, 3),
    ])
    const final = folder.messages().find(item => item.kind === 'assistant')
    assert.ok(final !== undefined && final.kind === 'assistant')
    assert.equal(final.deliverables, undefined)
    assert.equal(folder.search('bad.md').length, 0)
  }
})

test('does not create a synthetic delivery message without a closing assistant', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [{ path: 'error.log' }]),
    event('turn/end', { turn: 1, reason: { kind: 'error' } }, 2),
  ])

  assert.equal(folder.messages().some(item => item.kind === 'assistant'), false)
  assert.deepEqual(folder.messages().map(item => item.kind), ['tool'])
  assert.equal((folder as unknown as { deliverableDeclarationsByTurn: Map<number, unknown> }).deliverableDeclarationsByTurn.size, 0)
})

test('an empty closing assistant stays visible when it owns deliverables', async () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [{ path: 'a.txt', description: 'empty-answer delivery' }]),
    assistant(2, 0, ''),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])

  const messages = folder.messages()
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], {
    kind: 'assistant',
    turn: 1,
    text: '',
    deliverables: [{ path: 'a.txt', description: 'empty-answer delivery' }],
  })
  assert.deepEqual(folder.search('a.txt'), [{ id: 0, turn: 1 }])

  const vt = new VirtualTerminal(80, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setFocusMode(true)
  app.setTranscript(messages, folder.turnActivities())
  const view = await viewport(vt)
  assert.ok(view.includes('Delivered files · 1'), view)
  assert.ok(view.includes('a.txt'), view)
})

test('keeps assistants without declarations unchanged', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    assistant(1, 0, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
  ])

  const message = closing(folder)
  assert.equal(message.deliverables, undefined)
  assert.deepEqual(folder.search('final').map(match => folder.resolveSearchMatch(match)), [message])
})

test('searches delivery paths and final descriptions, including duplicate updates', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [{ path: 'docs/client-server-migration.md', description: 'old note' }]),
    delivery(2, [{ path: 'docs/client-server-migration.md', description: 'closure ledger' }]),
    assistant(3, 0, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ])

  const pathMatches = folder.search('client-server-migration')
  const descriptionMatches = folder.search('closure ledger')
  assert.deepEqual(pathMatches, [{ id: 0, turn: 1 }])
  assert.deepEqual(descriptionMatches, [{ id: 0, turn: 1 }])
  assert.equal(folder.search('old note').length, 0)
  assert.equal(folder.resolveSearchMatch(pathMatches[0]!)?.kind, 'assistant')
})

test('does not count delivery declarations as tools in a window summary', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    ...successfulPresentToolEvents(),
    delivery(3, [{ path: 'one.txt' }]),
    assistant(4, 0, 'one'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    event('turn/start', { turn: 2 }, 6),
    assistant(7, 0, 'two', 2),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 8),
  ])

  const window = folder.window({ maxTurns: 1 })
  const summary = window.messages.find(item => item.kind === 'summary')
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.equal(summary.text, '… 1 earlier turn · 1 tool call — window 1 turns')
})

test('live apply and cold hydrate produce the same delivery projection', () => {
  const events = [
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [{ path: 'a.txt', description: 'A' }]),
    assistant(2, 0, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ]
  const live = new TranscriptFolder()
  live.apply(events)
  const cold = new TranscriptFolder()
  cold.hydrate(events)

  assert.deepEqual(
    live.messages().map(message => message.kind === 'assistant' ? { ...message, deliverables: message.deliverables } : message),
    cold.messages().map(message => message.kind === 'assistant' ? { ...message, deliverables: message.deliverables } : message),
  )
})

test('turn-end delivery attachment invalidates the live assistant component', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [{ path: 'out/report.md', description: 'Final report' }]),
    assistant(2, 0, 'final'),
  ])
  const vt = new VirtualTerminal(80, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript(folder.messages(), folder.turnActivities())
  const before = await viewport(vt)
  assert.ok(before.includes('final'), before)
  assert.ok(!before.includes('Delivered files'), before)
  assert.equal(folder.search('report').length, 0)

  folder.apply([
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  const after = await viewport(vt)
  assert.ok(after.includes('Delivered files · 1'), after)
  assert.ok(after.includes('out/report.md'), after)
  assert.ok(after.includes('Final report'), after)
  assert.deepEqual(folder.search('report'), [{ id: 0, turn: 1 }])
})

test('Focus keeps the delivery tail on the final assistant message', async () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [
      { path: 'one.txt' },
      { path: 'two.txt' },
      { path: 'three.txt' },
      { path: 'four.txt' },
      { path: 'five.txt' },
    ]),
    assistant(2, 0, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  const vt = new VirtualTerminal(80, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setFocusMode(true)
  app.setTranscript(folder.messages(), folder.turnActivities())
  const folded = await viewport(vt)
  assert.ok(folded.includes('Delivered files · 5'), folded)
  assert.ok(folded.includes('four.txt'), folded)
  assert.ok(!folded.includes('five.txt'), folded)

  app.setToolOutputExpanded(true)
  const expanded = await viewport(vt)
  assert.ok(expanded.includes('five.txt'), expanded)
  assert.ok(!expanded.includes('… +1'), expanded)
})

test('delivered paths follow the current session workspace after a welcome update', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workspaceRoot: '/old' })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [{ path: '/new/a.txt' }],
  }])

  app.setWelcomeCard({ cwd: '/new', sessionId: 'session-2', model: 'test/model', version: 'test' })
  const view = await viewport(vt)
  assert.ok(view.includes('  a.txt'), view)
  assert.ok(!view.includes('/new/a.txt'), view)
})

test('delivery tails reflow without visual overflow at supported widths', async () => {
  const vt = new VirtualTerminal(40, 36)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workspaceRoot: '/workspace' })
  app.start()
  startedApps.add(app)
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [
      { path: '/workspace/docs/client-server-migration.md', description: '迁移 🧪 说明 with a longer description' },
      { path: '/workspace/docs/second-file.md', description: '第二个文件' },
    ],
  }])

  for (const columns of [40, 80, 120]) {
    vt.resize(columns, 36)
    const view = await viewport(vt)
    assert.ok(view.includes('Delivered files · 2'), view)
    for (const line of view.split('\n')) {
      assert.ok(visibleWidth(stripTerminalSequences(line)) <= columns, `${columns}: ${JSON.stringify(line)}`)
    }
  }
})
