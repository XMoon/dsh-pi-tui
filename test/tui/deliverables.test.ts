import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { DeliveredFilesComponent } from '../../src/tui/components/transcript-leaves.ts'
import {
  deliveredFilesCapabilityStub,
  deliveredFolder,
  deliveredSurfaceRouting,
  mountDeliveredSurface,
} from '../support/delivered-files.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

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
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text: 'Presented out/report.md' }],
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
  assert.deepEqual(folder.search('a.txt').map(match => ({ id: match.id, turn: match.turn })), [{ id: 0, turn: 1 }])

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
  assert.deepEqual(pathMatches.map(match => ({ id: match.id, turn: match.turn })), [{ id: 0, turn: 1 }])
  assert.deepEqual(descriptionMatches.map(match => ({ id: match.id, turn: match.turn })), [{ id: 0, turn: 1 }])
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
  assert.ok(after.includes('out/report.md'), `${after}\nthe tail shows the declared path when no trusted root exists`)
  const deliveredLines = after.split('\n')
  const pathRow = deliveredLines.findIndex(line => line.includes('out/report.md'))
  assert.ok(pathRow >= 0, after)
  assert.ok(deliveredLines[pathRow + 1]!.includes('Final report'),
    `the description owns its own indented row:\n${after}`)
  assert.deepEqual(folder.search('report').map(match => ({ id: match.id, turn: match.turn })), [
    { id: 0, turn: 1 },
    { id: 0, turn: 1 },
  ], 'the path and the description each carry one occurrence')
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

  app.setTranscriptDetailExpanded(true)
  const expanded = await viewport(vt)
  assert.ok(expanded.includes('five.txt'), expanded)
  assert.ok(!expanded.includes('+1 more'), expanded)
})

test('the delivered tail paints the CURRENT workspace-relative path, never the old root', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workspaceRoot: '/old' })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [{ path: '/new/docs/a.txt' }],
  }])

  // The component was built under /old, then the session identity moved to
  // /new: the tail must rebuild with the CURRENT root, not the captured one.
  app.setWelcomeCard({ cwd: '/new', sessionId: 'session-2', model: 'test/model', version: 'test' })
  const view = await viewport(vt)
  assert.ok(view.includes('  docs/a.txt'), view)
  assert.ok(!view.includes('/new/docs/a.txt'), view)
  assert.ok(!view.includes('/old/docs/a.txt'), view)
})

test('delivery tails reflow without visual overflow at supported widths', async () => {
  const vt = new VirtualTerminal(40, 36)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workspaceRoot: '/workspace' })
  app.start()
  startedApps.add(app)
  app.setTranscriptDetailExpanded(true)
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

test('the delivered tail keeps a constant row budget for 1..200 files', async () => {
  const delivery = (count: number): { path: string; description?: string }[] =>
    Array.from({ length: count }, (_, index) => ({ path: `/ws/file-${index + 1}.md`, description: `file ${index + 1}` }))
  // A MOUNTED PiTui surface: the `/deliverables` entry exists (the component
  // itself never assumes it).
  const tail = (count: number, width: number, options: { pointerActions?: boolean } = {}): string[] =>
    new DeliveredFilesComponent(delivery(count), false, { commandEntry: true, ...options })
      .render(width)
      .map(row => stripTerminalSequences(row))

  // N=1..4: every file, no extra marker, and the minimal browse entry. Each
  // file is TWO rows here (path + description).
  assert.equal(tail(1, 100).filter(row => row.includes('file-1.md')).length, 1)
  for (const count of [1, 4]) {
    const rows = tail(count, 100)
    assert.ok(!rows.some(row => row.includes('more')), `N=${count} paints no +N marker:\n${rows.join('\n')}`)
    assert.ok(rows[0]!.includes('/deliverables'), `N=${count} keeps the browse entry:\n${rows[0]}`)
  }
  // N=5 and N=200 cost the SAME number of rows: title + 4 files x 2 rows +
  // one marker.
  const five = tail(5, 100)
  const twoHundred = tail(200, 100)
  assert.equal(five.length, twoHundred.length, 'a large delivery never grows the transcript tail')
  assert.equal(five.length, 10)
  assert.ok(five.some(row => row.includes('+1 more')), five.join('\n'))
  assert.ok(twoHundred.some(row => row.includes('+196 more')), twoHundred.join('\n'))
  assert.ok(!twoHundred.some(row => row.includes('file-5.md')), 'only the first four are painted')
  assert.ok(twoHundred[9]!.includes('/deliverables'), 'the tail row names the command')

  // An EXPANDED tail is the explicit user request: it re-renders every file.
  assert.equal(new DeliveredFilesComponent(delivery(5), true, { commandEntry: true }).render(100).length, 11)

  // Fullscreen Full paints the real pointer verbs; a regular surface does not.
  const pointer = tail(5, 100, { pointerActions: true })
  assert.ok(pointer[0]!.includes('Browse all'), pointer.join('\n'))
  assert.ok(pointer.some(row => row.includes('Details')), 'the per-file verb is painted')
  assert.ok(pointer.some(row => row.includes('+196 more') === false))
  assert.ok(!tail(5, 100).some(row => row.includes('Details')), 'a mouse-less surface paints no dead verb')

  // The mounted PiTui transcript shows the same 4+1 shape for a 200-file turn.
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'final', deliverables: delivery(200) }])
  const view = await viewport(vt)
  assert.ok(view.includes('+196 more · /deliverables'), `the mounted tail stays capped:\n${view}`)
  assert.ok(!view.includes('file-5.md'), 'the fifth file is not painted')
})

test('the delivered tail stays inside 40/72/100/140 columns', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [
      { path: '/ws/docs/a-rather-long-delivery-name.md', description: '一个很长的描述 with a long tail description' },
      { path: '/ws/output/client-server-migration.md', description: '迁移 🧪 说明' },
      { path: '/ws/c.md' },
      { path: '/ws/d.md' },
      { path: '/ws/e.md' },
    ],
  }])
  for (const columns of [40, 72, 100, 140]) {
    vt.resize(columns, 40)
    const view = await viewport(vt)
    assert.ok(view.includes('Delivered files · 5'), `${columns}: title present`)
    assert.ok(view.includes('/deliverables'), `${columns}: the entry stays discoverable`)
    for (const line of view.split('\n')) {
      assert.ok(visibleWidth(stripTerminalSequences(line)) <= columns, `${columns}: ${JSON.stringify(line)}`)
    }
    // Every width paints the description on its OWN row; only the pointer
    // verb waits for the fullscreen AltScreen / action budget.
    assert.ok(view.includes('一个很长的描述'), `${columns}: the description is visible on its own row`)
    assert.ok(!view.includes('Details'), `${columns}: a regular surface paints no dead pointer verb`)
  }
})

test('paths that differ only in stripped control bytes keep distinct painted labels', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  const hostile = '/a/report\u001b]52;c;YQ==\u0007.md'
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [{ path: hostile }, { path: '/b/report.md' }],
  }])
  const view = await viewport(vt)
  const rows = view.split('\n').filter(line => line.includes('report.md'))
  assert.equal(rows.length, 2, `both declared files are painted:\n${view}`)
  const [first, second] = rows.map(row => row.trim())
  assert.notEqual(first, second, 'the two rows must stay distinguishable after the display projection')
  assert.ok(first!.includes('a/report.md'), `first label keeps its directory: ${first}`)
  assert.ok(second!.includes('b/report.md'), `second label keeps its directory: ${second}`)
  assert.ok(!view.includes('YQ=='), 'no OSC 52 payload reaches the frame')
  assert.ok(!view.includes('\u001b]52'), 'no OSC introducer reaches the frame')
})

test('declarations whose paths project to nothing stay distinguishable when painted', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [{ path: '/a/report\u001b[31m' }, { path: '/a/report\u001b[32m' }],
  }])
  const view = await viewport(vt)
  const rows = view.split('\n').filter(line => line.includes('report'))
  assert.equal(rows.length, 2, `both declared files are painted:\n${view}`)
  const labels = rows.map(row => row.trim())
  assert.notEqual(labels[0], labels[1], 'the two rows must stay distinguishable')
  assert.ok(!view.includes('\u001b[31m') && !view.includes('\u001b[32m'),
    'no control sequence from a declared path reaches the frame')
})

test('a generated ordinal never collides with a naturally painted label', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [
      { path: '/a/report\u001b[31m' },
      { path: '/a/report\u001b[32m' },
      { path: '/b/report (2)' },
    ],
  }])
  const view = await viewport(vt)
  const rows = view.split('\n').filter(line => line.trim() !== '' && line.includes('report'))
  assert.equal(rows.length, 3, `all three declared files are painted:\n${view}`)
  const labels = rows.map(row => row.trim())
  assert.equal(new Set(labels).size, 3, `three visibly distinct rows:\n${labels.join('\n')}`)
  assert.ok(labels.includes('/b/report (2)'), `the natural label survives:\n${labels.join('\n')}`)
  assert.ok(labels.includes('/a/report (2)'), `the generated ordinal keeps the full path prefix:\n${labels.join('\n')}`)
  assert.ok(!view.includes('\u001b[31m') && !view.includes('\u001b[32m'),
    'no control sequence from a declared path reaches the frame')
})

test('long declared filenames keep their distinguishing tail in the transcript tail', async () => {
  const vt = new VirtualTerminal(40, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  const long = 'report-2026-10-client-server-migration-final-version-'
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [{ path: `/ws/docs/${long}alpha.md` }, { path: `/ws/docs/${long}beta.md` }],
  }])
  const view = await viewport(vt)
  const rows = view.split('\n').filter(line => line.includes('alpha.md') || line.includes('beta.md'))
  assert.equal(rows.length, 2, `both rows are painted at 40 columns:\n${view}`)
  assert.notEqual(rows[0]!.trim(), rows[1]!.trim(), 'the two rows must differ')
  assert.ok(rows.some(row => row.includes('alpha.md')), `the tail survives:\n${rows.join('\n')}`)
  assert.ok(rows.some(row => row.includes('beta.md')), `the tail survives:\n${rows.join('\n')}`)
})

test('a middle-only discriminator survives the transcript clamp', async () => {
  const vt = new VirtualTerminal(40, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  const middle = (discriminator: string): string =>
    `/ws/docs/report-${'a'.repeat(24)}${discriminator}${'b'.repeat(24)}.md`
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [{ path: middle('X') }, { path: middle('Y') }],
  }])
  const view = await viewport(vt)
  const rows = view.split('\n').filter(line => line.includes('report-') && line.includes('…'))
  assert.equal(rows.length, 2, `both rows are clamped and painted:\n${view}`)
  assert.notEqual(rows[0]!.trim(), rows[1]!.trim(),
    `a middle-only difference must still produce distinct rows:\n${rows.join('\n')}`)
})

test('the transcript tail hit cells are the cells the row really painted', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 2, files: [{ path: '/ws/a.md' }] }],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: { snapshot: () => snap, isCurrent: () => true },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 2, text: 'done', deliverables: [{ path: '/ws/a.md' }] }], new Map())
  app.setFullscreen(true)
  const view = await viewport(vt)
  const rows = view.split('\n')
  const row = rows.findIndex(line => line.includes('a.md') && line.includes('Details'))
  assert.ok(row >= 0, view)
  const painted = rows[row]!
  const verbStart = painted.lastIndexOf('Details')
  const verbEnd = verbStart + 'Details'.length
  const click = (x: number) => {
    vt.sendInput(`\x1b[<0;${x + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${x + 1};${row + 1}m`)
    return viewport(vt)
  }
  // The FIRST cell of the verb opens the preview; the cell LEFT of it does not.
  await click(verbStart - 1)
  assert.ok(!(await viewport(vt)).includes('a.md · Details'), 'the cell left of the verb is inert')
  await click(verbStart)
  assert.ok((await viewport(vt)).includes('a.md · Details'), 'the first painted cell of the verb opens it')
  app.stop()
})

test('a painted OSC 8 link wins over the delivered tail action (URL first, no overlay)', async () => {
  // Delivered files PR1 plan U05/T09: the input is an ACTUAL painted HTTP OSC 8
  // link inside the Assistant Markdown, and the expected sink is the URL opener
  // ONCE — the delivered-files overlay must never open, and a drag/text
  // selection must not open it either.
  const { setCapabilityOverrides } = await import('@xmoon76/pi-tui')
  setCapabilityOverrides({ hyperlinks: true })
  try {
    const vt = new VirtualTerminal(120, 40)
    const opened: string[] = []
    const snap = {
      subjectKind: 'main' as const,
      sessionId: 'session-1',
      sourceIdentity: {},
      turns: [{ turn: 2, files: [{ path: '/ws/a.md' }] }],
    }
    const app = new TuiApp(vt, {
      onSubmit: () => {},
      onExit: () => {},
    }, {
      displayState: { preset: 'full' },
      deliveredFiles: { snapshot: () => snap, isCurrent: () => true },
      openExternalUrl: (url) => { opened.push(url) },
    })
    app.start()
    startedApps.add(app)
    app.setTranscript([{
      kind: 'assistant',
      turn: 2,
      text: 'See [the plan](https://example.test/plan) for details.',
      deliverables: [{ path: '/ws/a.md' }],
    }], new Map())
    app.setFullscreen(true)
    const view = await viewport(vt)
    const rows = view.split('\n')
    const linkRow = rows.findIndex(line => line.includes('the plan'))
    assert.ok(linkRow >= 0, `the link text is painted:\n${view}`)
    const linkCol = rows[linkRow]!.indexOf('the plan') + 2
    const tailRow = rows.findIndex(line => line.includes('a.md') && line.includes('Details'))
    assert.ok(tailRow >= 0, `the delivered tail is painted too:\n${view}`)

    // A complete click on the painted URL: the opener fires EXACTLY once and no
    // overlay appears (the delivered-files page never opens).
    vt.sendInput(`\x1b[<0;${linkCol + 1};${linkRow + 1}M`)
    vt.sendInput(`\x1b[<0;${linkCol + 1};${linkRow + 1}m`)
    await viewport(vt)
    assert.deepEqual(opened, ['https://example.test/plan'], 'the URL opener ran exactly once')
    assert.ok(!(await viewport(vt)).includes('a.md · Details'),
      'the delivered-files overlay never opened from a URL cell')

    // A DRAG across the same link cell is a text selection, never an activation.
    vt.sendInput(`\x1b[<0;${linkCol + 1};${linkRow + 1}M`)
    vt.sendInput(`\x1b[<32;${linkCol + 8};${linkRow + 1}M`)
    vt.sendInput(`\x1b[<0;${linkCol + 8};${linkRow + 1}m`)
    await viewport(vt)
    assert.deepEqual(opened, ['https://example.test/plan'], 'a drag never activates the URL a second time')
    assert.ok(!(await viewport(vt)).includes('a.md · Details'), 'a drag never opens the overlay')

    // The delivered tail's own verb still works: URL priority did not disable it.
    const verbStart = rows[tailRow]!.lastIndexOf('Details')
    vt.sendInput(`\x1b[<0;${verbStart + 1};${tailRow + 1}M`)
    vt.sendInput(`\x1b[<0;${verbStart + 1};${tailRow + 1}m`)
    assert.ok((await viewport(vt)).includes('a.md · Details'),
      'the delivered action still opens its page from its own painted cells')
    app.stop()
  } finally {
    // Restore AUTO-DETECTION, not a forced `false`: an override would leak into
    // every other test in this process and silently disable OSC 8 painting.
    setCapabilityOverrides({})
  }
})

test('the production app routes a preview request through the owned runner', async () => {
  // The panel that ISSUES the reads must receive `runOwned`; a tail-component
  // injection would leave the panel on its fallback branch. This drives the real
  // TuiApp construction path with NO delivered tail in the transcript, so any
  // owned label observed can only come from the panel.
  const vt = new VirtualTerminal(100, 30)
  const owned: string[] = []
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path: '/ws/a.md' }] }],
  }
  // `runOwned` is the EVENTS hook (the host's owned-task entry), not an option.
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (label, task) => {
      owned.push(label)
      void task()
    },
  }, {
    displayState: { preset: 'full' },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
    deliveredFilePreview: () => ({
      stat: async () => ({ version: 'v1', bytes: 3 }),
      read: async () => ({ stat: { version: 'v1', bytes: 3 }, offset: 1, limit: 120, text: 'a', lines: 1, eof: true }),
    }),
  })
  app.start()
  startedApps.add(app)
  // NO deliverables in the message: there is no tail component at all, so any
  // owned label below can only come from the PANEL.
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot)
  await viewport(vt)
  // Enter on the Files page is the action that starts the preview request.
  vt.sendInput('\r')
  await viewport(vt)
  assert.ok(owned.some(label => label.startsWith('delivered file preview')),
    `the panel request went through runOwned (saw: ${JSON.stringify(owned)})`)
  app.stop()
})

test('the panel follows the LIVE surface: swapping fullscreen adds and removes the verb', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path: '/ws/a.md' }, { path: '/ws/b.md' }] }],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())

  // Open on the REGULAR surface: no terminal mouse reporting, so no verb.
  app.openDeliveredFiles(snapshot)
  const regular = await viewport(vt)
  assert.ok(regular.includes('a.md'), regular)
  assert.ok(!regular.includes('Details'), `the regular surface paints no dead verb:\n${regular}`)

  // Swap to FULLSCREEN: the SAME panel is remounted on a surface that routes
  // mouse events, so its painted verb must appear without re-opening.
  app.setFullscreen(true)
  const full = await viewport(vt)
  assert.ok(full.includes('a.md'), full)
  assert.ok(full.includes('Details'), `the fullscreen surface paints the real verb:\n${full}`)

  // …and back again: the verb must disappear on the regular surface.
  app.setFullscreen(false)
  const back = await viewport(vt)
  assert.ok(back.includes('a.md'), back)
  assert.ok(!back.includes('Details'), `the verb is withdrawn again after the swap:\n${back}`)
  app.stop()
})

test('a subject change retires an IN-FLIGHT preview read and never paints it', async () => {
  const vt = new VirtualTerminal(100, 30)
  let currentSubject = true
  let releaseStat: (() => void) | undefined
  const statsAsked: string[] = []
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-a',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path: '/ws/a.md' }] }],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => currentSubject },
    deliveredFilePreview: () => ({
      // The read stays in flight until this test releases it.
      stat: (path: string) => {
        statsAsked.push(path)
        return new Promise(resolve => {
          releaseStat = () => resolve({ version: 'v1', bytes: 16 })
        })
      },
      read: async () => ({
        stat: { version: 'v1', bytes: 16 },
        offset: 1,
        limit: 120,
        text: 'STALE PAGE BYTES',
        lines: 1,
        eof: true,
      }),
    }),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot)
  await viewport(vt)
  vt.sendInput('\r') // Enter Preview: the stat is now in flight
  await viewport(vt)
  assert.deepEqual(statsAsked, ['/ws/a.md'], 'the request really started')

  // The DISPLAY SUBJECT changes (viewed Session switched): the app retires the
  // stale surface on the next transcript commit.
  currentSubject = false
  app.setTranscript([{ kind: 'assistant', turn: 2, text: 'other session' }], new Map())
  await viewport(vt)

  // Even when the abandoned read finally settles, nothing of it may paint.
  releaseStat?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  const after = await viewport(vt)
  assert.ok(!after.includes('STALE PAGE BYTES'), `the abandoned page never paints:\n${after}`)
  assert.ok(!after.includes('a.md · Details'), `the stale overlay is gone:\n${after}`)
  app.stop()
})

test('a REAL subject switch through SurfaceRuntime aborts the in-flight read (same path/turn)', async () => {
  // Two REAL folders with the SAME declared path and the SAME turn number: the
  // identity fence must key on the subject, not on the shape of the data.
  // Two REAL folders with the IDENTICAL declared path and turn number: only the
  // subject identity can tell them apart.
  const folderA = deliveredFolder([{ turn: 3, files: [{ path: '/ws/same.md' }] }])
  const folderB = deliveredFolder([{ turn: 3, files: [{ path: '/ws/same.md' }] }])
  let currentSession = 'session-a'
  const routing = deliveredSurfaceRouting({
    sessionId: () => currentSession,
    mainFolder: () => (currentSession === 'session-a' ? folderA : folderB),
  })
  const surface = mountDeliveredSurface(routing)
  try {
    const vt = new VirtualTerminal(100, 30)
    let heldSignal: AbortSignal | undefined
    let release: ((stat: { version: string; bytes: number }) => void) | undefined
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      displayState: { preset: 'full' },
      deliveredFiles: {
        snapshot: () => surface.deliveredFilesSnapshot(),
        isCurrent: (snapshot) => surface.isDeliveredFilesSnapshotCurrent(snapshot),
      },
      deliveredFilePreview: () => ({
        stat: (_path: string, signal: AbortSignal) => {
          heldSignal = signal
          return new Promise(resolve => { release = value => resolve(value) })
        },
        read: async () => ({
          stat: { version: 'v1', bytes: 15 },
          offset: 1,
          limit: 120,
          text: 'STALE SUBJECT PAGE',
          lines: 1,
          eof: true,
        }),
      }),
    })
    app.start()
    startedApps.add(app)
    app.setTranscript([{ kind: 'assistant', turn: 3, text: 'done' }], new Map())
    app.setFullscreen(true)
    const snapshotA = surface.deliveredFilesSnapshot()
    assert.ok(snapshotA !== undefined)
    app.openDeliveredFiles(snapshotA)
    await viewport(vt)
    assert.ok((await viewport(vt)).includes('same.md'), 'the panel opened on subject A')
    vt.sendInput('\r')
    await viewport(vt)
    assert.ok(heldSignal !== undefined, 'the preview request really started')
    assert.equal(heldSignal!.aborted, false, 'it is not aborted while the subject is current')

    // The display subject REALLY changes: another Session with the identical
    // path/turn shape, so only the subject identity can tell them apart.
    currentSession = 'session-b'
    assert.equal(surface.isDeliveredFilesSnapshotCurrent(snapshotA), false,
      'the application owner sees the old subject as stale')
    const snapshotB = surface.deliveredFilesSnapshot()
    assert.ok(snapshotB !== undefined)
    assert.equal(snapshotB.sessionId !== snapshotA.sessionId, true, 'the subject identity really changed')
    app.setTranscript([{ kind: 'assistant', turn: 3, text: 'done' }], new Map())
    await viewport(vt)

    // The in-flight read is ABORTED and its page can never paint.
    assert.equal(heldSignal!.aborted, true, 'retirement aborts the in-flight read')
    const afterSwitch = await viewport(vt)
    assert.ok(!afterSwitch.includes('same.md · Details'), `the stale overlay is gone:\n${afterSwitch}`)
    release?.({ version: 'v1', bytes: 15 })
    await new Promise(resolve => setTimeout(resolve, 20))
    const settled = await viewport(vt)
    assert.ok(!settled.includes('STALE SUBJECT PAGE'), `the late result never paints:\n${settled}`)
    app.stop()
  } finally {
    surface.dispose()
  }
})

test('the tail follows the display subject root: main -> viewed child -> main, outside-root raw', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    workspaceRoot: '/main/ws',
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/main/ws', sessionId: 'main-session', model: 'test/model', version: 'test' })
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'main',
    deliverables: [
      { path: '/main/ws/docs/report.md', description: 'main document' },
      { path: '/outside/report.md', description: 'outside root' },
    ],
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('  docs/report.md'), view)
  assert.ok(view.includes('/outside/report.md'), `an outside-root path stays absolute:\n${view}`)
  assert.ok(!view.includes('/main/ws/docs/report.md'), view)

  // The viewer's OWN workspace root, not the main cwd, relativizes child files.
  app.commitDisplaySubject({}, {}, {
    sessionId: 'child-session',
    workspaceRoot: '/child/ws',
    title: '',
    todos: [],
    goal: undefined,
  })
  app.setTranscript([{
    kind: 'assistant',
    turn: 2,
    text: 'child',
    deliverables: [{ path: '/child/ws/notes/child.md', description: 'child document' }],
  }])
  view = await viewport(vt)
  assert.ok(view.includes('  notes/child.md'), view)
  assert.ok(!view.includes('/child/ws/notes/child.md'), view)
  assert.ok(!view.includes('docs/report.md'), 'the previous subject tail is gone')

  // Back to main: the original root applies again.
  app.commitDisplaySubject({}, {}, undefined)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'main again',
    deliverables: [{ path: '/main/ws/docs/report.md' }],
  }])
  view = await viewport(vt)
  assert.ok(view.includes('  docs/report.md'), view)
})

for (const preset of ['full', 'compact', 'focus'] as const) {
  test(`the tail Details verb opens the exact file in fullscreen ${preset}`, async () => {
    const vt = new VirtualTerminal(120, 40)
    const snap = {
      subjectKind: 'main' as const,
      sessionId: 'session-1',
      sourceIdentity: {},
      turns: [{ turn: 2, files: [{ path: 'out/report.md', description: 'report' }] }],
    }
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      displayState: { preset },
      deliveredFiles: { snapshot: () => snap, isCurrent: () => true },
    })
    app.start()
    startedApps.add(app)
    // A REAL settled turn: the Focus projection needs its TurnActivity and
    // the fold attaches the declaration to the closing Assistant row.
    const folder = new TranscriptFolder()
    folder.hydrate([
      event('turn/start', { turn: 2 }, 0),
      delivery(1, [{ path: 'out/report.md', description: 'report' }], 2),
      assistant(2, 0, 'done', 2),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3),
    ])
    app.setTranscript(folder.messages(), folder.turnActivities())
    app.setFullscreen(true)
    const view = await viewport(vt)
    const rows = view.split('\n')
    const row = rows.findIndex(line => line.includes('out/report.md') && line.includes('Details'))
    assert.ok(row >= 0, `${preset}: the tail paints its Details verb on the alt screen:\n${view}`)
    const column = rows[row]!.lastIndexOf('Details') + 2
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
    const after = await viewport(vt)
    assert.ok(after.includes('report.md · Details'), `${preset}: the complete click opens Details:\n${after}`)
    assert.ok(after.includes('Host: out/report.md'), `${preset}: the exact raw path reaches the browser:\n${after}`)
  })
}

for (const preset of ['full', 'compact', 'focus'] as const) {
  test(`the tail Browse all verb opens the card's Turn in fullscreen ${preset}`, async () => {
    const files = Array.from({ length: 5 }, (_, index) => ({ path: `out/file-${index + 1}.md` }))
    const vt = new VirtualTerminal(120, 40)
    const snap = {
      subjectKind: 'main' as const,
      sessionId: 'session-1',
      sourceIdentity: {},
      turns: [{ turn: 2, files }],
    }
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      displayState: { preset },
      deliveredFiles: { snapshot: () => snap, isCurrent: () => true },
    })
    app.start()
    startedApps.add(app)
    const folder = new TranscriptFolder()
    folder.hydrate([
      event('turn/start', { turn: 2 }, 0),
      delivery(1, files, 2),
      assistant(2, 0, 'done', 2),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3),
    ])
    app.setTranscript(folder.messages(), folder.turnActivities())
    app.setFullscreen(true)
    const view = await viewport(vt)
    const rows = view.split('\n')
    const row = rows.findIndex(line => line.includes('Browse all'))
    assert.ok(row >= 0, `${preset}: Browse all is painted:\n${view}`)
    const column = rows[row]!.lastIndexOf('Browse all') + 2
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
    const after = await viewport(vt)
    assert.ok(after.includes('Delivered files · Turn 2'), `${preset}: the card's Turn opened:\n${after}`)
    assert.ok(after.includes('file-1.md'), after)
  })
}

/** Slice a painted row by CELL columns (CJK/emoji make string indices differ). */
function cellText(row: string, start: number, end: number): string {
  let column = 0
  let text = ''
  for (const char of row) {
    const width = visibleWidth(char)
    if (column >= start && column + width <= end) text += char
    column += width
  }
  return text
}

test('the two-line tail keeps every width, span and hit aligned with painted cells', () => {
  for (const width of [40, 44, 72, 80, 120, 160, 200]) {
    // A fresh component per width: the cached array is width-keyed, but the
    // span/hit contract is about THIS render.
    const fresh = new DeliveredFilesComponent([
      { path: '/ws/artifacts/image-7b-s0-20261027T055117Z-....tar.gz', description: 'Image 7B S0 本地实机调研证据包，含原始数据、截图、判定及校验索引。' },
      { path: '/ws/a/report.md', description: 'duplicate basename A' },
      { path: '/ws/b/report.md', description: 'duplicate basename B' },
      { path: '/ws/证据包/迁移🧪.md', description: 'CJK 文件名与多列字符' },
      { path: '/ws/evil/report\u001b]52;c;YQ==\u0007.md', description: 'control bytes \u001b[31m must not paint' },
    ], true, { pointerActions: true, commandEntry: true, workspaceRoot: '/ws' })
    const raw = fresh.render(width)
    const plain = raw.map(row => stripTerminalSequences(row))
    for (const row of plain) {
      assert.ok(visibleWidth(row) <= width, `${width}: ${JSON.stringify(row)}`)
      assert.ok(!row.includes('\u001b]52') && !row.includes('YQ==') && !row.includes('\u001b[31m'),
        `${width}: no declared-path control sequence may paint: ${JSON.stringify(row)}`)
    }
    assert.equal(fresh.lastFieldSpans.length, 5, `${width}: one span per file`)
    for (const span of fresh.lastFieldSpans) {
      const pathText = cellText(plain[span.pathRow]!, span.pathStart, span.pathEnd)
      assert.ok(pathText.length > 0, `${width}: the path span is painted`)
      if (span.descriptionRows.length > 0) {
        const description = span.descriptionRows[0]!
        assert.equal(description.row, span.pathRow + 1, `${width}: the description owns the NEXT row`)
        assert.ok(plain[description.row]!.startsWith('    '), `${width}: the description is indented four cells`)
        assert.ok(cellText(plain[description.row]!, description.start, description.end).length > 0)
      }
    }
    // Every published pointer hit is exactly the painted verb text.
    for (const hit of fresh.paintedFileActionHits(width)) {
      const text = cellText(plain[hit.row]!, hit.startCol, hit.endCol)
      assert.ok(text === 'Details' || text === 'Browse all', `${width}: hit paints ${JSON.stringify(text)}`)
    }
    // The two duplicate basenames keep distinct relative paths.
    const reportPaths = fresh.lastFieldSpans
      .map(span => cellText(plain[span.pathRow]!, span.pathStart, span.pathEnd))
      .filter(text => text.includes('report'))
    assert.ok(reportPaths.includes('a/report.md'), `${width}: the first duplicate keeps its directory: ${reportPaths.join(' | ')}`)
    assert.ok(reportPaths.includes('b/report.md'), `${width}: the second duplicate keeps its directory: ${reportPaths.join(' | ')}`)
    assert.equal(new Set(reportPaths).size, reportPaths.length,
      `${width}: no two declared files may paint the same label: ${reportPaths.join(' | ')}`)
  }
})

test('search keeps the full raw path authority while the tail paints a relative path', async () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    delivery(1, [{ path: '/ws/docs/evidence/report.md', description: 'raw authority' }]),
    assistant(2, 0, 'final'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    workspaceRoot: '/ws',
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript(folder.messages(), folder.turnActivities())
  const view = await viewport(vt)
  assert.ok(view.includes('docs/evidence/report.md'), view)
  assert.ok(!view.includes('/ws/docs/evidence/report.md'), view)

  const rawMatches = folder.search('/ws/docs/evidence/report.md')
  assert.deepEqual(rawMatches.map(match => match.source), [{ kind: 'assistant-deliverable', index: 0, field: 'path' }],
    'the search corpus keeps the complete raw Host path')
  const relativeMatches = folder.search('docs/evidence/report.md')
  assert.ok(relativeMatches.length > 0, 'the painted relative path is also searchable')
})

for (const preset of ['full', 'compact', 'focus'] as const) {
  test(`a non-verb tail cell never opens a file in fullscreen ${preset}`, async () => {
    const vt = new VirtualTerminal(120, 40)
    const snap = {
      subjectKind: 'main' as const,
      sessionId: 'session-1',
      sourceIdentity: {},
      turns: [{ turn: 2, files: [{ path: 'out/report.md', description: 'a description line' }] }],
    }
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      displayState: { preset },
      deliveredFiles: { snapshot: () => snap, isCurrent: () => true },
    })
    app.start()
    startedApps.add(app)
    const folder = new TranscriptFolder()
    folder.hydrate([
      event('turn/start', { turn: 2 }, 0),
      delivery(1, [{ path: 'out/report.md', description: 'a description line' }], 2),
      assistant(2, 0, 'done', 2),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3),
    ])
    app.setTranscript(folder.messages(), folder.turnActivities())
    app.setFullscreen(true)
    const view = await viewport(vt)
    const rows = view.split('\n')
    const pathRow = rows.findIndex(line => line.includes('out/report.md'))
    assert.ok(pathRow >= 0, view)
    const descriptionRow = rows.findIndex((line, index) => index > pathRow && line.includes('a description line'))
    assert.ok(descriptionRow > pathRow, `the description owns the next physical row:\n${view}`)
    const descriptionColumn = rows[descriptionRow]!.indexOf('a description line') + 2
    vt.sendInput(`\x1b[<0;${descriptionColumn + 1};${descriptionRow + 1}M`)
    vt.sendInput(`\x1b[<0;${descriptionColumn + 1};${descriptionRow + 1}m`)
    const after = await viewport(vt)
    assert.ok(!after.includes('report.md · Details'), `${preset}: the description is not a file action:\n${after}`)
  })
}

test('a regular surface paints no dead Browse all and no dead footer buttons', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'done',
    deliverables: [
      { path: 'out/one.md' },
      { path: 'out/two.md' },
      { path: 'out/three.md' },
      { path: 'out/four.md' },
      { path: 'out/five.md' },
    ],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('/deliverables'), view)
  assert.ok(!view.includes('Browse all'), `the regular tail paints no dead list verb:\n${view}`)
  assert.ok(!view.includes('Details'), `the regular tail paints no dead per-file verb:\n${view}`)
})

test('the width cache restores the hits and search spans of the re-rendered width', () => {
  const files = [
    { path: '/ws/docs/a.md', description: 'first' },
    { path: '/ws/output/b.md', description: 'second' },
  ]
  const component = new DeliveredFilesComponent(files, false, {
    pointerActions: true,
    commandEntry: true,
    workspaceRoot: '/ws',
  })
  const rows80 = component.render(80)
  const hits80 = component.paintedFileActionHits(80)
  const spans80 = component.lastFieldSpans
  assert.ok(hits80.length >= 2, 'fixture: 80 columns paints the verbs')
  assert.equal(spans80.length, 2)
  component.render(100)
  assert.notEqual(component.lastFieldSpans, spans80, 'fixture: 100 columns re-derives spans')
  const again = component.render(80)
  assert.equal(again, rows80, 'the reference-stable row cache still hits')
  assert.deepEqual(component.paintedFileActionHits(80), hits80, 'the 80-column hit map is restored')
  assert.deepEqual(component.lastFieldSpans, spans80, 'the 80-column search spans are restored')
  for (const hit of component.paintedFileActionHits(80)) {
    const text = stripTerminalSequences(again[hit.row]!).slice(hit.startCol, hit.endCol)
    assert.ok(text === 'Details' || text === 'Browse all', `the restored hit paints ${JSON.stringify(text)}`)
  }
})

test('a fullscreen transcript Details verb still works after a 120→160→120 resize round-trip', async () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 2 }, 0),
    delivery(1, [{ path: 'out/report.md', description: 'round trip' }], 2),
    assistant(2, 0, 'done', 2),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3),
  ])
  const snap = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 2, files: [{ path: 'out/report.md', description: 'round trip' }] }],
  }
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: { snapshot: () => snap, isCurrent: () => true },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.setFullscreen(true)
  let view = await viewport(vt)
  assert.ok(view.includes('out/report.md') && view.includes('Details'), view)
  vt.resize(160, 50)
  await viewport(vt)
  vt.resize(120, 40)
  view = await viewport(vt)
  const rows = view.split('\n')
  const row = rows.findIndex(line => line.includes('out/report.md') && line.includes('Details'))
  assert.ok(row >= 0, `the Details verb is re-painted after the round-trip:\n${view}`)
  const column = rows[row]!.lastIndexOf('Details') + 2
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
  const after = await viewport(vt)
  assert.ok(after.includes('report.md · Details'), `the re-painted Details verb is clickable:\n${after}`)
})

test('the tail keeps an escaping .. path absolute and normalizes an inside .. path', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    workspaceRoot: '/ws',
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [
      { path: '/ws/../outside/report.md' },
      { path: '/ws/docs/../inside.md' },
    ],
  }])
  const lines = (await viewport(vt)).split('\n')
  assert.ok(lines.some(line => line.startsWith('  /ws/../outside/report.md')),
    `an escaping path keeps its absolute declaration verbatim:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => line.startsWith('  inside.md')),
    `a lexically-inside .. path is relativized:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.startsWith('  ../outside/report.md')),
    `the escaping path must not be painted relative:\n${lines.join('\n')}`)
})
