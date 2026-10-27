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

test('a POSIX-root workspace still paints workspace-relative delivered paths', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    workspaceRoot: '/',
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'final',
    deliverables: [{ path: '/artifacts/a.md' }],
  }])
  const lines = (await viewport(vt)).split('\n')
  assert.ok(lines.some(line => line.startsWith('  artifacts/a.md')),
    `the POSIX root is a trusted workspace root:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.startsWith('  /artifacts/a.md')),
    `the absolute path must not win over the valid root:\n${lines.join('\n')}`)
})

/** A real fullscreen app with the ONE delivered-files modal open, plus a
 * clipboard sink so the fork's selection copy can be observed end to end. */
function selectionApp(copied: string[], columns = 100, rows = 30) {
  const vt = new VirtualTerminal(columns, rows)
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path: '/ws/alpha.md', description: 'first report' }] }],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot)
  return { vt, app, snapshot }
}

/** Locate the modal's painted outer frame: its top border row and its left
 * column. The frame is the ONLY rounded box in the fullscreen frame. */
function modalFrame(lines: readonly string[]): { top: number; left: number; width: number; height: number } {
  const top = lines.findIndex(line => line.includes('╭'))
  assert.ok(top >= 0, `fixture: the modal paints a frame:\n${lines.join('\n')}`)
  const line = lines[top]!
  const left = line.indexOf('╭')
  const right = line.lastIndexOf('╮')
  const bottom = lines.findIndex((candidate, index) => index > top && candidate.includes('╰'))
  assert.ok(bottom > top, `fixture: the modal frame is closed:\n${lines.join('\n')}`)
  return { top, left, width: right - left + 1, height: bottom - top + 1 }
}

/** The cell spans that were painted INVERSE (the selection highlight) in the
 *  terminal's own byte stream, one string per inverse run. The product
 *  VirtualTerminal records every raw write, so this is the real painted
 *  highlight, not a re-derivation. */
function inverseRuns(writes: readonly string[]): string[] {
  const runs: string[] = []
  const stream = writes.join('')
  const pattern = /\x1b\[7m((?:[^\x1b]|\x1b\[[0-9;]*[^0-9;m])*?)(?=\x1b\[27m|\x1b\[0m|$)/g
  for (const match of stream.matchAll(pattern)) {
    const text = stripTerminalSequences(match[1] ?? '')
    if (text.length > 0) runs.push(text)
  }
  return runs
}

/** Clear the recorded write stream so the NEXT gesture's highlight is isolated. */
function resetWrites(vt: { writes: string[] }): void {
  vt.writes.length = 0
}

test('B01/B03/B04: a real SGR drag inside the modal copies the modal text, never the transcript', async () => {
  const copied: string[] = []
  const { vt, app } = selectionApp(copied)
  const view = await viewport(vt)
  const frame = modalFrame(view.split('\n'))
  // The first CONTENT row is below the top border; the content column starts
  // after the border cell and its padding cell.
  const row = frame.top + 1
  const column = frame.left + 2
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
  const after = await viewport(vt)

  assert.equal(copied.length, 1, `one drag copies once (saw ${JSON.stringify(copied)})`)
  const text = copied[0]!
  assert.ok(text.trim().length > 0, JSON.stringify(text))
  assert.ok(!text.includes('╭') && !text.includes('│'), `the frame chrome is never copied: ${JSON.stringify(text)}`)
  assert.ok(!text.includes('done'), `the transcript behind the modal is never copied: ${JSON.stringify(text)}`)
  assert.ok(after.includes('Copied!'), `the copy reports a real success:\n${after}`)
  app.stop()
})

test('B07: Details, [Copy path] and press→drag each keep their own gesture under the opt-in', async () => {
  const copied: string[] = []
  const labels: string[] = []
  const reads: number[] = []
  const path = '/ws/reports/2026/report.md'
  const vt = new VirtualTerminal(100, 30)
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path, description: 'Exported final report' }] }],
  }
  const text = 'Summary\nResult line 1'
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The raw-path route announces itself through the owned-task label; the
    // text-selection route copies directly and never uses it.
    runOwned: (label, task) => {
      labels.push(label)
      void task()
    },
  }, {
    displayState: { preset: 'full' },
    copySelection: async (value) => {
      copied.push(value)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
    deliveredFilePreview: () => ({
      stat: async () => ({ version: 'v1', bytes: text.length }),
      read: async () => {
        reads.push(1)
        return { stat: { version: 'v1', bytes: text.length }, offset: 1, limit: 120, text, lines: 2, eof: true }
      },
    }),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  // Open on the FILES page, so the Details transition is really exercised.
  app.openDeliveredFiles(snapshot, { turn: 1, path, page: 'files' })
  let view = ''
  for (let attempt = 0; attempt < 40 && !view.includes('report.md'); attempt += 1) {
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
  }
  // FIXTURE PROOF: this is the Files page, not Details.
  assert.ok(!view.includes('Host: '), `fixture: the Files page has no Details body:\n${view}`)
  assert.ok(view.includes('[Filter]'), `fixture: the Files action bar is painted:\n${view}`)
  const lines = view.split('\n')
  const frame = modalFrame(lines)
  const listRow = lines.findIndex((line, index) => index > frame.top && line.includes('report.md'))
  assert.ok(listRow > frame.top, `fixture: the list row is painted:\n${view}`)
  const verbColumn = columnOf(lines, listRow, 'Details')
  assert.ok(verbColumn > frame.left + 2, `fixture: the Details verb is painted: ${JSON.stringify(lines[listRow])}`)

  // (a) complete click on the painted `Details` verb really CHANGES the page.
  vt.sendInput(`\x1b[<0;${verbColumn + 1};${listRow + 1}M`)
  vt.sendInput(`\x1b[<0;${verbColumn + 1};${listRow + 1}m`)
  const detailsView = await viewport(vt)
  assert.ok(detailsView.includes('Host: '), `the click really opened the Details BODY:\n${detailsView}`)
  assert.ok(!detailsView.includes('[Filter]'), `the Files action bar is gone:\n${detailsView}`)
  assert.equal(copied.length, 0, 'the Details verb must not copy text')
  assert.deepEqual(
    labels.filter(label => label.includes('path copy')),
    [],
    `the Details verb never runs the raw-path copy (saw ${JSON.stringify(labels)})`,
  )
  app.stop()
  startedApps.delete(app)
  app.dispose()

  // (b) `[Copy path]` copies the EXACT raw declared path through its own route.
  const copiedB: string[] = []
  const labelsB: string[] = []
  const vtB = new VirtualTerminal(100, 30)
  const appB = new TuiApp(vtB, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (label, task) => {
      labelsB.push(label)
      void task()
    },
  }, {
    displayState: { preset: 'full' },
    copySelection: async (value) => {
      copiedB.push(value)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
    deliveredFilePreview: () => ({
      stat: async () => ({ version: 'v1', bytes: text.length }),
      read: async () => ({ stat: { version: 'v1', bytes: text.length }, offset: 1, limit: 120, text, lines: 2, eof: true }),
    }),
  })
  appB.start()
  startedApps.add(appB)
  appB.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  appB.setFullscreen(true)
  appB.openDeliveredFiles(snapshot, { turn: 1, path, page: 'details' })
  let detailsOnly = ''
  for (let attempt = 0; attempt < 40 && !detailsOnly.includes('Host: '); attempt += 1) {
    await vtB.waitForRender()
    detailsOnly = vtB.getViewport().join('\n')
  }
  const detailsLines = detailsOnly.split('\n')
  const detailsFrame = modalFrame(detailsLines)
  const barRow = detailsLines.findIndex((line, index) => index >= detailsFrame.top && line.includes('[Copy path]'))
  assert.ok(barRow > detailsFrame.top, `fixture: Details paints \`[Copy path]\`:\n${detailsOnly}`)
  const copyColumn = columnOf(detailsLines, barRow, '[Copy path]') + 2
  vtB.sendInput(`\x1b[<0;${copyColumn + 1};${barRow + 1}M`)
  vtB.sendInput(`\x1b[<0;${copyColumn + 1};${barRow + 1}m`)
  await vtB.waitForRender()
  // The RAW path really reached the clipboard, byte-exact and without padding.
  assert.deepEqual(copiedB, [path], `[Copy path] copies the raw declared path: ${JSON.stringify(copiedB)}`)
  assert.deepEqual(
    labelsB.filter(label => label.includes('path copy')),
    ['delivered path copy'],
    `the raw-path route really ran: ${JSON.stringify(labelsB)}`,
  )
  appB.stop()
  startedApps.delete(appB)
  appB.dispose()

  // (c) press → drag on a FILE ROW selects text and never opens the page.
  const copiedC: string[] = []
  const { vt: vtC, app: appC } = selectionApp(copiedC)
  let viewC = ''
  for (let attempt = 0; attempt < 40 && !viewC.includes('alpha.md'); attempt += 1) {
    await vtC.waitForRender()
    viewC = vtC.getViewport().join('\n')
  }
  const linesC = viewC.split('\n')
  const frameC = modalFrame(linesC)
  const rowC = linesC.findIndex((line, index) => index > frameC.top && line.includes('alpha.md'))
  assert.ok(rowC > frameC.top, `fixture:\n${viewC}`)
  const columnC = columnOf(linesC, rowC, 'alpha.md')
  vtC.sendInput(`\x1b[<0;${columnC + 1};${rowC + 1}M`)
  vtC.sendInput(`\x1b[<32;${columnC + 20};${rowC + 1}M`)
  vtC.sendInput(`\x1b[<0;${columnC + 20};${rowC + 1}m`)
  const afterC = await vtC.waitForRender().then(() => vtC.getViewport().join('\n'))
  assert.equal(copiedC.length, 1, `the drag is a selection (saw ${JSON.stringify(copiedC)})`)
  assert.ok(!afterC.includes('Host: '), `a dragged release never opens the page:\n${afterC}`)
  appC.stop()
  startedApps.delete(appC)
  appC.dispose()
})
test('B08: closing the modal drops its selection, and a later release cannot copy it', async () => {
  const copied: string[] = []
  const { vt, app } = selectionApp(copied)
  const view = await viewport(vt)
  const frame = modalFrame(view.split('\n'))
  const row = frame.top + 1
  const column = frame.left + 2
  // Arm a visible selection without releasing.
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${column + 5};${row + 1}M`)
  await viewport(vt)
  assert.equal(copied.length, 0, 'fixture: nothing is copied until the release')

  app.closeDeliveredFiles()
  await viewport(vt)
  // The release lands on the now-uncovered transcript: it must not copy the
  // modal's text, and it must not resume the retired gesture.
  vt.sendInput(`\x1b[<0;${column + 5};${row + 1}m`)
  const after = await viewport(vt)
  assert.equal(copied.length, 0, `a closed modal never copies: ${JSON.stringify(copied)}`)
  assert.ok(!after.includes('╭'), `fixture: the modal is really gone:\n${after}`)
  app.stop()
})

test('B05: a background gesture is LIVE before it reaches the modal, and the modal cancels it', async () => {
  const copied: string[] = []
  const { vt, app } = selectionApp(copied)
  const view = await viewport(vt)
  const lines = view.split('\n')
  const frame = modalFrame(lines)
  // The transcript text row that really carries the answer text.
  const backgroundRow = lines.findIndex(line => line.includes('done'))
  assert.ok(backgroundRow >= 0 && backgroundRow < frame.top,
    `fixture: the transcript text row is painted above the modal:\n${view}`)
  const textStart = lines[backgroundRow]!.indexOf('done')
  // POSITIVE CONTROL: the background press+drag really paints ITS OWN selection
  // highlight before the pointer ever enters the modal.
  resetWrites(vt)
  vt.sendInput(`\x1b[<0;${textStart + 1};${backgroundRow + 1}M`)
  vt.sendInput(`\x1b[<32;${textStart + 4};${backgroundRow + 1}M`)
  await viewport(vt)
  const backgroundHighlight = inverseRuns(vt.writes).join('')
  assert.ok(
    backgroundHighlight.trim().length > 0,
    `fixture: the background drag paints a real highlight, not an inert press (saw ${JSON.stringify(inverseRuns(vt.writes))})`,
  )
  // Dragging into the modal and releasing cancels it: nothing is copied.
  vt.sendInput(`\x1b[<32;${frame.left + 6};${frame.top + 3}M`)
  vt.sendInput(`\x1b[<0;${frame.left + 6};${frame.top + 3}m`)
  await viewport(vt)
  assert.equal(copied.length, 0, 'a background gesture dragged into the modal never copies')
  app.stop()
})
test('B02: a double-click inside the modal selects the visible word, and a single click only selects the row', async () => {
  const copied: string[] = []
  const { vt, app } = selectionApp(copied)
  const view = await viewport(vt)
  const lines = view.split('\n')
  const frame = modalFrame(lines)
  // The Files body paints one row per file; its path cell is the painted one.
  const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
  assert.ok(row > frame.top, `fixture: the path row is painted:\n${view}`)
  const pathStart = lines[row]!.indexOf('alpha.md')
  // Click INSIDE the path text (never the row's leading marker cell).
  const cell = pathStart + 3

  const clickAt = (column: number) => {
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
  }
  // ONE complete click on a body cell is a DISCLOSURE click, not a copy.
  clickAt(cell)
  await viewport(vt)
  assert.equal(copied.length, 0, 'a plain single click must not copy')

  // A SECOND complete click on the same cell within the multi-click window is
  // the double-click that selects the word, so exactly ONE copy is observed.
  clickAt(cell)
  await viewport(vt)
  assert.equal(copied.length, 1, `a double-click copies the word (saw ${JSON.stringify(copied)})`)
  assert.ok(copied[0]!.includes('alpha.md'), JSON.stringify(copied[0]))
  assert.ok(!copied[0]!.includes('╭') && !copied[0]!.includes('│'), 'the frame chrome is never copied')

  // A THIRD click on the same word cell is the triple-click: the visible
  // content row of the modal, still clipped to the frame.
  clickAt(cell)
  await viewport(vt)
  assert.equal(copied.length, 2, `a triple-click copies the row (saw ${JSON.stringify(copied)})`)
  assert.ok(copied[1]!.includes('alpha.md'), JSON.stringify(copied[1]))
  assert.ok(!copied[1]!.includes('╭') && !copied[1]!.includes('╰'), 'the row copy never includes a border')
  app.stop()
})

test('B03: a wide CJK/emoji path copies whole graphemes, never a half-wide cell', async () => {
  const copied: string[] = []
  const vt = new VirtualTerminal(100, 30)
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path: '/ws/报告-📄.md' }] }],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot)
  const view = await viewport(vt)
  const lines = view.split('\n')
  const frame = modalFrame(lines)
  const row = lines.findIndex((line, index) => index > frame.top && line.includes('报告'))
  assert.ok(row > frame.top, `fixture: the CJK path is painted:\n${view}`)
  const pathStart = lines[row]!.indexOf('报告')
  // Drag across the whole wide-character run, one cell short of its end.
  vt.sendInput(`\x1b[<0;${pathStart + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${pathStart + 1 + visibleWidth('报告-📄.md') - 1};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${pathStart + 1 + visibleWidth('报告-📄.md') - 1};${row + 1}m`)
  await viewport(vt)

  assert.equal(copied.length, 1, JSON.stringify(copied))
  const text = copied[0]!
  assert.ok(text.includes('报告'), `the wide characters survive: ${JSON.stringify(text)}`)
  // No lone half of a wide grapheme: every CJK/emoji glyph appears whole.
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'no lone high surrogate')
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), 'no lone low surrogate')
  app.stop()
})

test('B10: the selectable rectangle tracks the frozen geometry matrix in all three presets', async () => {
  // The frozen PR A matrix (design-language §12.2): the modal is a centered
  // percentage window, so its painted placement — and therefore the selectable
  // rectangle — must follow it exactly at every size.
  const matrix: ReadonlyArray<readonly [number, number]> = [
    [44, 20], [72, 24], [80, 24], [120, 40], [160, 50], [200, 50],
  ]
  for (const preset of ['full', 'compact', 'focus'] as const) {
    for (const [columns, rows] of matrix) {
      const copied: string[] = []
      const vt = new VirtualTerminal(columns, rows)
      const snapshot = {
        subjectKind: 'main' as const,
        sessionId: 'session-1',
        sourceIdentity: {},
        turns: [{ turn: 1, files: [{ path: '/ws/alpha.md', description: 'first report' }] }],
      }
      const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
        displayState: { preset },
        copySelection: async (text) => {
          copied.push(text)
          return true
        },
        deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
      })
      app.start()
      startedApps.add(app)
      app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
      app.setFullscreen(true)
      app.openDeliveredFiles(snapshot)
      const view = await viewport(vt)
      const lines = view.split('\n')
      const frame = modalFrame(lines)
      const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
      assert.ok(row > frame.top, `${preset} ${columns}x${rows}: the list row is painted:\n${view}`)
      const pathStart = lines[row]!.indexOf('alpha.md')
      // Drag from the first path cell onto the frame's RIGHT border cell: the
      // range must stop at the border, never at the terminal edge.
      const rightBorder = frame.left + frame.width - 1
      vt.sendInput(`\x1b[<0;${pathStart + 1};${row + 1}M`)
      vt.sendInput(`\x1b[<32;${rightBorder + 1};${row + 1}M`)
      vt.sendInput(`\x1b[<0;${rightBorder + 1};${row + 1}m`)
      const after = await viewport(vt)

      assert.equal(copied.length, 1, `${preset} ${columns}x${rows}: the drag copies once`)
      const text = copied[0]!
      assert.ok(text.includes('alpha.md'), `${preset} ${columns}x${rows}: ${JSON.stringify(text)}`)
      // The frame's row shape is `│ content… │`: the content runs from
      // `left + 2` to `left + width - 3`. A drag taken onto the RIGHT border
      // must therefore copy exactly the cells from the press column to that
      // last content cell — no border, no padding column, and nothing past the
      // frame's edge.
      const contentEnd = frame.left + frame.width - 3
      const expectedWidth = contentEnd - pathStart + 1
      assert.equal(
        visibleWidth(text),
        expectedWidth,
        `${preset} ${columns}x${rows}: the copy is clipped to the content rectangle `
        + `(want ${expectedWidth} cells, got ${visibleWidth(text)}): ${JSON.stringify(text)}`,
      )
      assert.ok(!text.includes('│'), `${preset} ${columns}x${rows}: the border is never copied: ${JSON.stringify(text)}`)
      assert.ok(after.includes('Copied!'), `${preset} ${columns}x${rows}: the copy really settled`)
      // One live TuiApp per process: release the slot before the next matrix
      // cell, not merely at the end of the whole sweep.
      app.stop()
      startedApps.delete(app)
      app.dispose()
    }
  }
})

test('B09: a very long preview line selects without an eager whole-page wrap or a second Host read', async () => {
  const copied: string[] = []
  const vt = new VirtualTerminal(100, 30)
  const reads: number[] = []
  // 40 flat columns and a folded 2 MiB line: the preview paints it as lazily
  // wrapped physical rows (PR #435), so resolving the selection must not
  // re-mount the page or read the Host again.
  const long = 'x'.repeat(2 * 1024 * 1024)
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path: '/ws/huge.txt' }] }],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
    deliveredFilePreview: () => ({
      stat: async () => ({ version: 'v1', bytes: long.length }),
      read: async () => {
        reads.push(1)
        return { stat: { version: 'v1', bytes: long.length }, offset: 1, limit: 120, text: long, lines: 1, eof: true }
      },
    }),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot, { turn: 1, path: '/ws/huge.txt', page: 'details' })
  await viewport(vt)
  // Enter Preview starts the ONE read of the current page.
  vt.sendInput('\r')
  await viewport(vt)
  const readsAfterOpen = reads.length
  assert.ok(readsAfterOpen >= 1, 'fixture: the preview really read a page')

  const lines = (await viewport(vt)).split('\n')
  const frame = modalFrame(lines)
  // Drag across the first preview row inside the content rectangle.
  const row = lines.findIndex((line, index) => index > frame.top && line.includes('xxxx'));
  assert.ok(row > frame.top, `fixture: the preview row is painted:\n${lines.join('\n')}`)
  const column = frame.left + 2
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${column + 20};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${column + 20};${row + 1}m`)
  await viewport(vt)

  assert.equal(copied.length, 1, 'the drag copies once')
  assert.ok(copied[0]!.includes('x'), JSON.stringify(copied[0]!.slice(0, 40)))
  // Selecting the painted text never re-reads the Host.
  assert.equal(reads.length, readsAfterOpen, 'a text selection must not issue another Host read')
  app.stop()
})

/** A fullscreen app with the ONE delivered-files modal open on the DETAILS page
 *  of a real Host-preview stub, plus the clipboard sink. */
function previewApp(
  copied: string[],
  reads: number[],
  options: {
    columns?: number
    rows?: number
    text?: string
    path?: string
    preset?: 'full' | 'compact' | 'focus'
    page?: 'files' | 'details'
  } = {},
) {
  const vt = new VirtualTerminal(options.columns ?? 100, options.rows ?? 30)
  const path = options.path ?? '/ws/reports/2026/report.md'
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path, description: 'Exported final report' }] }],
  }
  const text = options.text ?? 'Summary\n  indented code line\n\tTAB line\nResult line 1'
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: options.preset ?? 'full' },
    copySelection: async (value) => {
      copied.push(value)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
    deliveredFilePreview: () => ({
      stat: async () => ({ version: 'v1', bytes: text.length }),
      read: async () => {
        reads.push(1)
        return { stat: { version: 'v1', bytes: text.length }, offset: 1, limit: 120, text, lines: text.split('\n').length, eof: true }
      },
    }),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot, { turn: 1, path, page: options.page ?? 'details' })
  return { vt, app, path }
}

/** The painted terminal COLUMN of `needle` on one viewport row. */
function columnOf(lines: readonly string[], row: number, needle: string): number {
  const line = stripTerminalSequences(lines[row] ?? '')
  const characterIndex = line.indexOf(needle)
  if (characterIndex < 0) return -1
  return visibleWidth(line.slice(0, characterIndex))
}

test('B01: a real SGR drag over the Details `Host:` line copies that line, never the raw path route', async () => {
  const copied: string[] = []
  const reads: number[] = []
  const { vt, app, path } = previewApp(copied, reads)
  await viewport(vt)
  const lines = (await viewport(vt)).split('\n')
  const frame = modalFrame(lines)
  const row = lines.findIndex((line, index) => index > frame.top && line.includes('Host: '))
  assert.ok(row > frame.top, `fixture: the Details page paints \`Host: \`:\n${lines.join('\n')}`)
  const hostColumn = columnOf(lines, row, 'Host: ')
  // Drag across the Host line, well into the wrapped path.
  vt.sendInput(`\x1b[<0;${hostColumn + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${hostColumn + 24};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${hostColumn + 24};${row + 1}m`)
  const after = await viewport(vt)

  assert.equal(copied.length, 1, `one drag copies once (saw ${JSON.stringify(copied)})`)
  const text = copied[0]!
  assert.ok(text.startsWith('Host: '), `the drag copies the PAINTED line: ${JSON.stringify(text)}`)
  assert.ok(text.includes('/ws/reports/2026'), JSON.stringify(text))
  assert.ok(after.includes('Copied!'), `the copy really settled:\n${after}`)
  // The raw-path route is a different action and never ran here.
  assert.ok(!after.includes('Path copied'), 'a text selection must not claim the copy-path feedback')
  assert.ok(!text.includes(path) || text.includes('Host: '), 'the payload is the painted text, not the raw string')
  app.stop()
})

test('B03: multi-line preview drag copies line by line, keeps indentation/TAB, and the painted highlight MATCHES the copy', async () => {
  const copied: string[] = []
  const reads: number[] = []
  const { vt, app } = previewApp(copied, reads, {
    text: 'Summary line\n    four-space indent\n\tTAB-prefixed\ncombining e\u0301 and 报告 📄 row',
  })
  await viewport(vt)
  vt.sendInput('\r')
  await viewport(vt)
  const lines = (await viewport(vt)).split('\n')
  const frame = modalFrame(lines)
  const firstRow = lines.findIndex((line, index) => index > frame.top && line.includes('Summary line'))
  assert.ok(firstRow > frame.top, `fixture: the preview body is painted:\n${lines.join('\n')}`)
  const startColumn = columnOf(lines, firstRow, 'Summary')
  const lastRow = lines.findIndex((line, index) => index > firstRow && line.includes('combining'))
  assert.ok(lastRow > firstRow, `fixture: the wide row is painted:\n${lines.join('\n')}`)
  const contentEnd = frame.left + frame.width - 3
  resetWrites(vt)
  // Drag from the first preview cell to the frame's right border cell.
  vt.sendInput(`\x1b[<0;${startColumn + 1};${firstRow + 1}M`)
  vt.sendInput(`\x1b[<32;${contentEnd + 1};${lastRow + 1}M`)
  const dragging = vt.writes.join('')
  vt.sendInput(`\x1b[<0;${contentEnd + 1};${lastRow + 1}m`)
  await viewport(vt)

  // THE HIGHLIGHT IS REAL: the drag painted inverse cells before the release.
  const runs = inverseRuns(vt.writes)
  assert.ok(runs.length > 0, 'the drag must paint an inverse selection highlight')
  const highlighted = runs.join('')
  assert.ok(!highlighted.includes('│'), `the highlight never covers the border: ${JSON.stringify(highlighted)}`)
  assert.ok(!highlighted.includes('╭') && !highlighted.includes('╰'), 'the highlight never covers a corner')

  assert.equal(copied.length, 1, JSON.stringify(copied))
  const rows = copied[0]!.split('\n')
  assert.equal(rows.length, lastRow - firstRow + 1, `every selected row is copied once: ${JSON.stringify(copied[0])}`)
  assert.ok(rows[0]!.startsWith('Summary line'), JSON.stringify(rows[0]))
  // The four-space source indent survives verbatim.
  assert.ok(rows[1]!.startsWith('    four-space indent'), `the indent is preserved: ${JSON.stringify(rows[1])}`)
  // A TAB is painted as terminal cells: the copied text is the PROJECTION (the
  // spaces the terminal really shows), and it must line up with the highlight.
  const tabRow = rows[2]!
  assert.ok(!tabRow.includes('\t'), `the copy is the painted projection, not the raw TAB: ${JSON.stringify(tabRow)}`)
  assert.ok(tabRow.includes('TAB-prefixed'), JSON.stringify(tabRow))
  const tabPainted = lines[firstRow + 2] ?? ''
  const tabColumn = columnOf(lines, firstRow + 2, 'TAB-prefixed')
  assert.ok(tabColumn - startColumn >= 1, `fixture: the TAB advanced the painted column (${tabColumn - startColumn})`)
  void tabPainted
  // Wide CJK/emoji and the combining sequence survive whole.
  const wide = rows.at(-1)!
  assert.ok(wide.includes('报告'), JSON.stringify(wide))
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(copied[0]!), 'no lone high surrogate')
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(copied[0]!), 'no lone low surrogate')
  assert.ok(wide.includes('\u0301'), 'the combining sequence survives whole')
  // HIGHLIGHT == COPY, EXACTLY: on every selected row the inverse run's visible
  // text equals the copied row, character for character. A prefix test would
  // pass for a highlight that is too short or too long.
  // The copy FLASH is painted inverse too ("Copied!"), so it is not part of the
  // selection; every other inverse run is one selected row.
  const runsByRow = runs
    .map(run => stripTerminalSequences(run))
    .filter(run => run.trim() !== 'Copied!')
  assert.equal(
    runsByRow.length,
    rows.length,
    `one inverse run per copied row (highlight ${JSON.stringify(runsByRow)}, copy ${JSON.stringify(rows)})`,
  )
  for (const [index, row] of rows.entries()) {
    const run = runsByRow[index]!
    assert.equal(
      run,
      row,
      `row ${index}: the highlight and the copy must be the SAME cells (highlight ${JSON.stringify(run)}, copy ${JSON.stringify(row)})`,
    )
  }
  void dragging
  app.stop()
})

test('B04: a drag out of EACH of the four frame edges stays inside the content rectangle', async () => {
  const edges = ['left', 'right', 'top', 'bottom'] as const
  for (const edge of edges) {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    assert.ok(row > frame.top, `${edge}: fixture:\n${view}`)
    const column = columnOf(lines, row, 'alpha.md')
    const contentTop = frame.top + 1
    const contentBottom = frame.top + frame.height - 2
    const contentLeft = frame.left + 2
    const contentRight = frame.left + frame.width - 3
    const targetX = edge === 'left' ? contentLeft - 2 : edge === 'right' ? contentRight + 5 : column + 2
    const targetY = edge === 'top' ? contentTop - 3 : edge === 'bottom' ? contentBottom + 3 : row
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${Math.max(1, targetX) + 1};${Math.max(1, targetY) + 1}M`)
    vt.sendInput(`\x1b[<0;${Math.max(1, targetX) + 1};${Math.max(1, targetY) + 1}m`)
    await vt.waitForRender()

    // A REAL selection exists: an empty result must never satisfy a boundary claim.
    assert.equal(copied.length, 1, `${edge}: the drag copies exactly once (saw ${JSON.stringify(copied)})`)
    const payload = copied[0]!
    assert.ok(payload.trim().length > 0, `${edge}: a non-empty selection: ${JSON.stringify(payload)}`)
    // Only FRAME CHROME and the covered transcript are forbidden. The header row
    // and the action bar are INSIDE the content rectangle, so they are legal
    // selection content (the plan's "文字区" contract).
    assert.ok(!payload.includes('│'), `${edge}: the border is never copied: ${JSON.stringify(payload)}`)
    assert.ok(!payload.includes('╭') && !payload.includes('╰'), `${edge}: no corner: ${JSON.stringify(payload)}`)
    assert.ok(!payload.includes('🐋'), `${edge}: no transcript chrome: ${JSON.stringify(payload)}`)
    if (edge === 'right') {
      assert.ok(
        visibleWidth(payload) <= contentRight - column + 1,
        `${edge}: clipped to the content box (${visibleWidth(payload)} > ${contentRight - column + 1})`,
      )
    }
    if (edge === 'bottom') {
      // Clamped DOWN at the last CONTENT row. Without the clamp the range runs
      // to the terminal bottom: blank rows plus the action bar and the editor.
      const rows = payload.split('\n')
      assert.ok(
        rows.length <= contentBottom - row + 1,
        `${edge}: the range stops at the last content row (${rows.length} > ${contentBottom - row + 1})`,
      )
      assert.ok(!payload.includes('[Close]') && !payload.includes('Enter Preview'),
        `${edge}: the action bar is outside the range: ${JSON.stringify(payload.slice(-80))}`)
      assert.ok(!payload.includes('❯'), `${edge}: the editor is never copied`)
    }
    if (edge === 'top') {
      // Clamped UP: the drag target is above the content box, so the anchor is
      // pinned to the FIRST content row and the range is the content rows from
      // there DOWN TO the press row — it may not start above the box (chrome /
      // header) and may not be shortened to start below it either.
      const rows = payload.split('\n')
      // The drag moved only VERTICALLY, so the range starts at the FIRST content
      // row and at the press COLUMN (the range's left edge is the press column).
      const expectedFirstRow = stripTerminalSequences(lines[contentTop] ?? '')
      const startColumn = column + 2 // the press column used above
      const expected = expectedFirstRow.slice(startColumn, startColumn + visibleWidth(rows[0] ?? ''))
      assert.equal(
        rows[0],
        expected,
        `${edge}: the range starts at the FIRST content row (${JSON.stringify(rows[0])} vs ${JSON.stringify(expected)})`,
      )
      // The press row is the LAST row, clipped to the press column.
      assert.ok(
        rows.at(-1)!.startsWith('> a'),
        `${edge}: the press row is the last row of the range: ${JSON.stringify(rows.at(-1))}`,
      )
    }
    if (edge === 'left') {
      // Clamped LEFT: the target is left of the content box, so the anchor side
      // is pinned to the FIRST content column and the range runs right from it
      // — it may not start further right (a wrongly shortened range) nor
      // include a chrome cell.
      const firstContentColumn = contentLeft
      const paintedRow = stripTerminalSequences(lines[row] ?? '')
      const expectedTail = paintedRow.slice(firstContentColumn)
      const expectedCells = expectedTail.slice(0, visibleWidth(payload))
      assert.equal(
        payload,
        expectedCells,
        `${edge}: the range starts at the first content column (${JSON.stringify(payload)} vs ${JSON.stringify(expectedCells)})`,
      )
    }
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
})
test('B06: exactly ONE production site passes the selection opt-in, so no other overlay can inherit it', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('../../', import.meta.url).pathname
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (full.includes('/node_modules/')) continue
      const text = readFileSync(full, 'utf8')
      if (!text.includes('textSelectionInsets')) continue
      // The fork DEFINES and CONSUMES the option; the option constant lives in
      // the geometry module; the ONLY panel that may opt in is Delivered files.
      if (full.includes('/packages/pi-tui/')) continue
      if (full.endsWith('/src/tui/deliverables/overlay-size.ts')) continue
      if (full.endsWith('/src/tui-app.ts')) {
        // Exactly one injection site, and it belongs to the delivered-files
        // overlay option builder.
        const injections = text.split('textSelectionInsets:').length - 1
        assert.equal(injections, 1, `src/tui-app.ts must inject the opt-in exactly once (saw ${injections})`)
        continue
      }
      // A comment or a test may MENTION it; a VALUE must not.
      if (/textSelectionInsets\s*:/.test(text) && !full.includes('/test/')) offenders.push(full)
    }
  }
  walk(join(root, 'src'))
  assert.deepEqual(offenders, [], `only the Delivered files overlay may opt in: ${JSON.stringify(offenders)}`)
})

test('B06: the X058 search box keeps the opaque barrier (it never opts in)', async () => {
  const copied: string[] = []
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'needle in the transcript body' }], new Map())
  app.setFullscreen(true)
  app.startTranscriptSearch()
  const opened = await viewport(vt)
  const lines = opened.split('\n')
  // The search box is a borderless overlay: locate it by its painted title, and
  // drag across the title row itself (inside its own rectangle).
  const boxTop = lines.findIndex(line => line.includes('Find transcript'))
  assert.ok(boxTop >= 0, `fixture: the search box is open:\n${opened}`)
  const boxLeft = lines[boxTop]!.indexOf('Find transcript')
  resetWrites(vt)
  vt.sendInput(`\x1b[<0;${boxLeft + 1};${boxTop + 1}M`)
  vt.sendInput(`\x1b[<32;${boxLeft + 12};${boxTop + 1}M`)
  vt.sendInput(`\x1b[<0;${boxLeft + 12};${boxTop + 1}m`)
  await viewport(vt)
  assert.equal(copied.length, 0, `the search box keeps the opaque barrier (saw ${JSON.stringify(copied)})`)
  app.stop()
})
test('B09: the folded 2 MiB page at 12 and 40 columns stays lazily wrapped across repeated drags', async () => {
  for (const columns of [12, 40]) {
    const copied: string[] = []
    const reads: number[] = []
    const long = 'y'.repeat(2 * 1024 * 1024)
    const vt = new VirtualTerminal(columns, 24)
    const snapshot = {
      subjectKind: 'main' as const,
      sessionId: 'session-1',
      sourceIdentity: {},
      turns: [{ turn: 1, files: [{ path: '/ws/huge.txt' }] }],
    }
    let panel: unknown
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      displayState: { preset: 'full' },
      copySelection: async (text) => {
        copied.push(text)
        return true
      },
      deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
      deliveredFilePreview: () => ({
        stat: async () => ({ version: 'v1', bytes: long.length }),
        read: async () => {
          reads.push(1)
          return { stat: { version: 'v1', bytes: long.length }, offset: 1, limit: 120, text: long, lines: 1, eof: true }
        },
      }),
    })
    app.start()
    startedApps.add(app)
    app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
    app.setFullscreen(true)
    app.openDeliveredFiles(snapshot, { turn: 1, path: '/ws/huge.txt', page: 'details' })
    await vt.waitForRender()
    vt.sendInput('\r')
    await vt.waitForRender()
    panel = (app as unknown as { deliveredFilesPanel?: unknown }).deliveredFilesPanel
    interface WrapProbe { readonly wrappedSourceLines: number; readonly wrappedPhysicalRows: number }
    const probe = panel as WrapProbe
    assert.ok(probe !== undefined, `${columns} cols: the panel is live`)
    const readsAfterOpen = reads.length
    assert.ok(readsAfterOpen >= 1, `${columns} cols: fixture read a page`)

    // THE LAZY-WRAP PROOF: a full wrap of this line at this width would be tens
    // of thousands of physical rows; the panel must materialise viewport scale only.
    const physicalAfterOpen = probe.wrappedPhysicalRows
    assert.ok(
      physicalAfterOpen <= 128,
      `${columns} cols: only viewport-scale physical rows are built (${physicalAfterOpen} of ~${Math.ceil(long.length / columns)})`,
    )
    assert.equal(probe.wrappedSourceLines, 1, `${columns} cols: the ONE source line is wrapped once`)

    const frame = modalFrame((await viewport(vt)).split('\n'))
    for (let round = 0; round < 4; round += 1) {
      const lines = (await viewport(vt)).split('\n')
      const row = lines.findIndex((line, index) => index > frame.top && line.includes('y'))
      assert.ok(row > frame.top, `${columns} cols: the preview row is painted:\n${lines.join('\n')}`)
      const start = Math.max(frame.left + 2, 1)
      const end = Math.max(start + 1, frame.left + frame.width - 3)
      vt.sendInput(`\x1b[<0;${start + 1};${row + 1}M`)
      vt.sendInput(`\x1b[<32;${end + 1};${row + 1}M`)
      vt.sendInput(`\x1b[<0;${end + 1};${row + 1}m`)
      await vt.waitForRender()
    }
    assert.equal(copied.length, 4, `${columns} cols: every drag copies once (saw ${copied.length})`)
    assert.equal(reads.length, readsAfterOpen, `${columns} cols: repeated selection never re-reads the Host`)
    // Selection NEVER triggers a wrap storm: still viewport-scale, still ONE source line.
    assert.ok(
      probe.wrappedPhysicalRows <= 256,
      `${columns} cols: selection keeps the projection viewport-bounded (${probe.wrappedPhysicalRows})`,
    )
    assert.equal(probe.wrappedSourceLines, 1, `${columns} cols: the source line is never re-wrapped`)
    for (const payload of copied) {
      assert.ok(payload.length > 0, `${columns} cols: a real selection`)
      assert.ok(!payload.includes('│'), `${columns} cols: the border is never copied`)
    }
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
})
test('B02: the product path keeps `/` and `-` inside a double-clicked word', async () => {
  const copied: string[] = []
  const vt = new VirtualTerminal(100, 30)
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [{ turn: 1, files: [{ path: '/ws/2026-10/report-final.md' }] }],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
    workspaceRoot: '/ws',
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot)
  await viewport(vt)
  const lines = (await viewport(vt)).split('\n')
  const frame = modalFrame(lines)
  const row = lines.findIndex((line, index) => index > frame.top && line.includes('report-final.md'))
  assert.ok(row > frame.top, `fixture:\n${lines.join('\n')}`)
  // Click INSIDE `report-final`, whose `/` (directory separator) and `-` are
  // word joiners in the fork's segmenter.
  const column = columnOf(lines, row, 'report-final') + 2
  const click = (): void => {
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
  }
  click()
  await viewport(vt)
  assert.equal(copied.length, 0, 'a single click never copies')
  click()
  await viewport(vt)
  assert.equal(copied.length, 1, JSON.stringify(copied))
  // The product path proves the joiner rule end to end: the dash and the
  // directory separator keep the whole painted token together.
  assert.ok(copied[0]!.includes('report-final'), `the dash stays inside the word: ${JSON.stringify(copied[0])}`)
  // The list row paints only the delivered LABEL (a basename), so the `/` joiner
  // is proven where a `/` is really painted: the Details `Host:` line below.
  assert.ok(!copied[0]!.includes('Details'), 'the verb is not part of the word')
  app.stop()
})

test('B08: a page change and the filter seat each retire a selection that was LIVE', async () => {
  // (a) PAGE change (Enter → Details repaints the panel).
  {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    const column = columnOf(lines, row, 'alpha.md')
    resetWrites(vt)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
    await vt.waitForRender()
    // POSITIVE CONTROL: the selection is really LIVE before the invalidation.
    assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: the selection is painted before the page change')
    vt.sendInput('\r')
    await vt.waitForRender()
    vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
    await vt.waitForRender()
    assert.equal(copied.length, 0, `a page change retires the live selection (saw ${JSON.stringify(copied)})`)
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
  // (b) FILTER seat (`/` takes the keyboard and repaints the panel).
  {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    const column = columnOf(lines, row, 'alpha.md')
    resetWrites(vt)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
    await vt.waitForRender()
    assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: live selection before the filter')
    vt.sendInput('/')
    await vt.waitForRender()
    vt.sendInput('zzz')
    await vt.waitForRender()
    vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
    await vt.waitForRender()
    assert.equal(copied.length, 0, `the filter seat retires the live selection (saw ${JSON.stringify(copied)})`)
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
})
test('B02: a double-click on the Details `Host:` path keeps its `/` separator inside the word', async () => {
  const copied: string[] = []
  const reads: number[] = []
  const { vt, app } = previewApp(copied, reads, { path: '/ws/reports/2026/report-final.md' })
  await viewport(vt)
  const lines = (await viewport(vt)).split('\n')
  const frame = modalFrame(lines)
  const row = lines.findIndex((line, index) => index > frame.top && line.includes('Host: '))
  assert.ok(row > frame.top, `fixture:\n${lines.join('\n')}`)
  // Click INSIDE `reports`, whose trailing `/` is a word joiner: the selected
  // token must span the separator, not stop at it.
  const column = columnOf(lines, row, 'reports') + 1
  const click = (): void => {
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
  }
  click()
  await viewport(vt)
  assert.equal(copied.length, 0, 'a single click never copies')
  click()
  await viewport(vt)
  assert.equal(copied.length, 1, JSON.stringify(copied))
  assert.ok(copied[0]!.includes('reports'), `the word: ${JSON.stringify(copied[0])}`)
  assert.ok(
    copied[0]!.includes('reports/') || copied[0]!.includes('/reports'),
    `the \`/\` separator stays inside the selected word: ${JSON.stringify(copied[0])}`,
  )
  app.stop()
})

test('B08: resize, close→reopen and a screen swap each retire a selection that was LIVE', async () => {
  // (a) RESIZE: the modal is rebound at a fresh placement.
  {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    const column = columnOf(lines, row, 'alpha.md')
    resetWrites(vt)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${column + 7};${row + 1}M`)
    await vt.waitForRender()
    assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: live selection before the resize')
    vt.resize(120, 40)
    await vt.waitForRender()
    vt.sendInput(`\x1b[<0;${column + 7};${row + 1}m`)
    await vt.waitForRender()
    assert.equal(copied.length, 0, `a resize retires the live selection (saw ${JSON.stringify(copied)})`)
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
  // (b) CLOSE → REOPEN on the same cell and path.
  {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    const column = columnOf(lines, row, 'alpha.md')
    resetWrites(vt)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
    await vt.waitForRender()
    assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: live selection before the close')
    app.closeDeliveredFiles()
    await vt.waitForRender()
    const snapshot = {
      subjectKind: 'main' as const,
      sessionId: 'session-1',
      sourceIdentity: {},
      turns: [{ turn: 1, files: [{ path: '/ws/alpha.md', description: 'first report' }] }],
    }
    app.openDeliveredFiles(snapshot)
    await vt.waitForRender()
    vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
    await vt.waitForRender()
    assert.equal(copied.length, 0, 'close → reopen never revives the retired gesture')
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
  // (c) SCREEN SWAP: leaving fullscreen stops the alt screen that owned it.
  {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    const column = columnOf(lines, row, 'alpha.md')
    resetWrites(vt)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
    await vt.waitForRender()
    assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: live selection before the swap')
    app.setFullscreen(false)
    await vt.waitForRender()
    app.setFullscreen(true)
    await vt.waitForRender()
    vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
    await vt.waitForRender()
    assert.equal(copied.length, 0, 'a screen swap retires the live selection')
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
})

test('B08: switching the selected Turn really changes the list and retires a LIVE selection', async () => {
  const copied: string[] = []
  const vt = new VirtualTerminal(100, 30)
  const snapshot = {
    subjectKind: 'main' as const,
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: [
      { turn: 2, files: [{ path: '/ws/newest.md' }] },
      { turn: 1, files: [{ path: '/ws/older.md' }] },
    ],
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
    deliveredFiles: { snapshot: () => snapshot, isCurrent: () => true },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 2, text: 'done' }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snapshot)
  let view = ''
  for (let attempt = 0; attempt < 40 && !view.includes('newest.md'); attempt += 1) {
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
  }
  const lines = view.split('\n')
  const frame = modalFrame(lines)
  const row = lines.findIndex((line, index) => index > frame.top && line.includes('newest.md'))
  assert.ok(row > frame.top, `fixture:\n${view}`)
  const column = columnOf(lines, row, 'newest.md')
  resetWrites(vt)
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
  await vt.waitForRender()
  assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: live selection before the Turn switch')

  // A REAL Turn switch: `T` opens the Turns page, then the second Turn is
  // selected with a key and COMMITTED with Enter (openFilesForTurn).
  vt.sendInput('T')
  await vt.waitForRender()
  const turnsView = await viewport(vt)
  assert.ok(turnsView.includes('Turn 1'), `fixture: the Turns page is open:\n${turnsView}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  const switched = await viewport(vt)
  // The list really changed: the OTHER Turn's file is now the painted list.
  assert.ok(switched.includes('older.md'), `the Turn switch really changed the list:\n${switched}`)
  assert.ok(!switched.includes('newest.md'), `the previous Turn's file is gone:\n${switched}`)
  // The release can no longer copy the retired range.
  vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
  await vt.waitForRender()
  assert.equal(copied.length, 0, `a Turn switch retires the live selection (saw ${JSON.stringify(copied)})`)
  app.stop()
})

test('B06: a seat-frame Question is untouched — its selection matches the pre-PR baseline', async () => {
  const copied: string[] = []
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'needle in the transcript body' }], new Map())
  app.setFullscreen(true)
  // A REAL Question through the production flow (never a hand-built frame).
  const pending = app.askQuestions([
    { id: 'q1', question: 'Ship the recovery to every client?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ])
  void pending.catch(() => {})
  let view = ''
  for (let attempt = 0; attempt < 40 && !view.includes('Ship the recovery'); attempt += 1) {
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
  }
  assert.ok(view.includes('Ship the recovery'), `fixture: the Question is presented:\n${view}`)
  const lines = view.split('\n')
  // The question text is painted in the seat frame; drag across it.
  const row = lines.findIndex(line => line.includes('Ship the recovery'))
  assert.ok(row >= 0, `fixture:\n${view}`)
  const column = columnOf(lines, row, 'Ship the recovery')
  resetWrites(vt)
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${column + 14};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${column + 14};${row + 1}m`)
  await vt.waitForRender()
  // The Question is an editor-SEAT occupant, not a managed overlay: it never
  // reaches `OverlayOptions`, so this PR cannot change its pointer behavior.
  // Baseline (main@2bd4ad5c, before this branch) already copies a drag across
  // the Question body — that pre-existing seat-frame selection is NOT part of
  // this PR's scope and must stay unchanged, which is what this control records.
  assert.ok(
    copied.length > 0,
    'a Question drag behaves as it did on main@2bd4ad5c (pre-existing seat-frame selection): '
    + 'this PR neither introduces nor removes it',
  )
  // The opt-in never reaches it: this PR's option appears on NO overlay the
  // Question uses, and the Question's own frame paints its content normally.
  assert.ok(view.includes('Ship the recovery'), 'the Question body is painted')
  app.stop()
})

test('B06: a real managed plugin overlay never becomes a selection source (no opt-in)', async () => {
  const copied: string[] = []
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // A REAL managed overlay through the public extension lease (the same
  // OverlayOptions path the Delivered files modal uses).
  const lease = app.showExtensionOverlay({
    kind: 'frame',
    child: { kind: 'text', spans: [{ text: 'plugin overlay body text' }] },
  })
  let view = ''
  for (let attempt = 0; attempt < 40 && !view.includes('plugin overlay body'); attempt += 1) {
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
  }
  assert.ok(view.includes('plugin overlay body'), `fixture: the managed overlay is painted:\n${view}`)
  const lines = view.split('\n')
  const row = lines.findIndex(line => line.includes('plugin overlay body'))
  const column = columnOf(lines, row, 'plugin overlay body')
  resetWrites(vt)
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${column + 12};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${column + 12};${row + 1}m`)
  await vt.waitForRender()
  // No opt-in: the overlay keeps the opaque default and copies nothing.
  assert.equal(copied.length, 0, `a managed overlay without the opt-in copies nothing (saw ${JSON.stringify(copied)})`)
  assert.ok(
    !inverseRuns(vt.writes).join('').includes('plugin overlay body'),
    'a managed overlay without the opt-in paints no selection highlight',
  )
  lease.close()
  app.stop()
})

test('B08: terminal focus-out and stop each retire an overlay-origin selection that was LIVE', async () => {
  // (a) FOCUS-OUT: the terminal reports the window lost focus.
  {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    const column = columnOf(lines, row, 'alpha.md')
    resetWrites(vt)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
    await vt.waitForRender()
    assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: live overlay selection')
    vt.sendInput('\x1b[O')
    await vt.waitForRender()
    vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
    await vt.waitForRender()
    assert.equal(copied.length, 0, `focus-out retires the overlay selection (saw ${JSON.stringify(copied)})`)
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
  // (b) STOP: the alt screen is stopped (a surface teardown / screen swap).
  {
    const copied: string[] = []
    const { vt, app } = selectionApp(copied)
    let view = ''
    for (let attempt = 0; attempt < 40 && !view.includes('alpha.md'); attempt += 1) {
      await vt.waitForRender()
      view = vt.getViewport().join('\n')
    }
    const lines = view.split('\n')
    const frame = modalFrame(lines)
    const row = lines.findIndex((line, index) => index > frame.top && line.includes('alpha.md'))
    const column = columnOf(lines, row, 'alpha.md')
    resetWrites(vt)
    vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
    vt.sendInput(`\x1b[<32;${column + 6};${row + 1}M`)
    await vt.waitForRender()
    assert.ok(inverseRuns(vt.writes).join('').trim().length > 0, 'fixture: live overlay selection')
    // The real screen-stop path (leaving fullscreen stops the alt screen).
    app.setFullscreen(false)
    await vt.waitForRender()
    vt.sendInput(`\x1b[<0;${column + 6};${row + 1}m`)
    await vt.waitForRender()
    assert.equal(copied.length, 0, `a stopped alt screen never copies the retired range (saw ${JSON.stringify(copied)})`)
    app.stop()
    startedApps.delete(app)
    app.dispose()
  }
})
