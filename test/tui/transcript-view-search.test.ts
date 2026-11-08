import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { findAltScreenSearchMatches, getCapabilities, resetCapabilitiesCache, setCapabilities, stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { TuiApp } from '../../src/tui-app.ts'
import type { AssistantLiveInput } from '../../src/runtime/assistant-stream-port.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { enterChildDisplaySubject } from '../support/display-subject.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const STRONG_BG = 0xf5c542
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()

afterEach(() => {
  disposeStartedApps()
})

function pngHeaderBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function startApp(width = 100, height = 30, preset: 'full' | 'compact' | 'focus' = 'full'):
  { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function assistantFolder(rows: readonly { id: string; text: string }[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (const [turn, row] of rows.entries()) {
    events.push(event('turn/start', { turn }, seq++))
    events.push(event('assistant/message', {
      turn,
      step: 0,
      message: {
        id: MessageId(row.id),
        role: 'assistant',
        content: [{ type: 'text', text: row.text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, seq++))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, seq++))
  }
  folder.apply(events)
  return folder
}

function occurrences(lines: readonly string[], query: string): Array<{ row: number; column: number }> {
  const result: Array<{ row: number; column: number }> = []
  for (const [row, line] of lines.entries()) {
    const plain = stripTerminalSequences(line)
    for (let index = plain.indexOf(query); index >= 0; index = plain.indexOf(query, index + query.length)) {
      result.push({ row, column: visibleWidth(plain.slice(0, index)) })
    }
  }
  return result
}

function strongOccurrences(
  vt: VirtualTerminal,
  lines: readonly string[],
  query: string,
): Array<{ row: number; column: number }> {
  return occurrences(lines, query).filter(({ row, column }) => vt.getCellBgRgb(row, column) === STRONG_BG)
}

async function paintTranscript(
  app: TuiApp,
  vt: VirtualTerminal,
  folder: TranscriptFolder,
): Promise<void> {
  app.setFullscreen(true)
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
}

test('rendered View indexes the currently painted User, Thinking, Tool and Context text', async () => {
  const { vt, app } = startApp(120, 40)
  try {
    const messages: TranscriptMessage[] = [
      { kind: 'user', turn: 0, text: 'User needle' },
      { kind: 'thinking', turn: 0, text: 'Thinking needle' },
      { kind: 'tool', turn: 0, name: 'echo', args: '{}', result: 'Tool result needle', status: 'ok' },
      {
        kind: 'system',
        turn: 0,
        text: 'hidden context payload',
        label: 'Context',
        summary: 'Context summary needle',
        context: true,
        contextPresentation: { role: 'inject', form: 'notice', sourceKind: 'tool-jobs' },
      },
      { kind: 'assistant', turn: 0, text: 'Assistant needle' },
    ]
    app.setThinkingExpanded(true)
    app.setFullscreen(true)
    app.setTranscript(messages)
    await vt.waitForRender()
    const before = vt.getViewport().map(stripTerminalSequences)
    for (const text of ['User needle', 'Thinking needle', 'Tool result needle', 'Context summary needle', 'Assistant needle']) {
      assert.ok(before.some(line => line.includes(text)), `fixture paints ${text}:\\n${before.join('\\n')}`)
    }

    const paintedCount = occurrences(vt.getViewport(), 'needle').length
    assert.ok(paintedCount >= 5, 'the fixture exposes every intended message family')
    const result = app.setRenderedViewSearchQuery('needle')
    assert.deepEqual(result, { currentIndex: 0, count: paintedCount },
      'the View count is exactly the text the mounted renderer paints')
    await vt.waitForRender()
    assert.equal(strongOccurrences(vt, vt.getViewport(), 'needle').length, 1)
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View searches text emitted by the mounted plugin renderer', async () => {
  const { RendererRegistry } = await import('../../src/extension/internal/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'rendered-view-plugin',
    kind: 'thinking',
    render: () => ({ kind: 'text', spans: [{ text: 'Plugin card needle' }] }),
  }, 'plugin')
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)
  try {
    app.setFullscreen(true)
    app.setTranscript([{ kind: 'thinking', turn: 0, text: 'hidden source needle' }])
    await vt.waitForRender()
    assert.ok(vt.getViewport().some(line => stripTerminalSequences(line).includes('Plugin card needle')),
      'the plugin renderer owns the currently painted text')
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 })
    await vt.waitForRender()
    const lines = vt.getViewport()
    assert.equal(occurrences(lines, 'needle').length, 1)
    assert.equal(strongOccurrences(vt, lines, 'needle').length, 1,
      'View highlights the plugin-emitted cell instead of its hidden source text')
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('rendered View counts painted Markdown text but excludes a hidden href without changing Full results', async () => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  const { vt, app } = startApp(120, 40)
  try {
    const folder = assistantFolder([{
      id: 'view-markdown',
      text: '# needle\n\nVisible **needle** and [label needle](https://example.invalid/needle)\n\n- needle\n\n`needle`',
    }])
    const fullBefore = folder.search('needle').map(match => ({
      id: match.id,
      sourceOccurrence: match.sourceOccurrence,
      range: match.normalizedSourceRange,
    }))
    assert.equal(fullBefore.length, 6, 'Full retains the raw hidden href occurrence')
    await paintTranscript(app, vt, folder)
    const plainBefore = vt.getViewport().map(stripTerminalSequences)

    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 5 })
    await vt.waitForRender()
    const lines = vt.getViewport()
    assert.equal(occurrences(lines, 'needle').length, 5, 'the mounted Markdown paints five searchable occurrences')
    assert.equal(strongOccurrences(vt, lines, 'needle').length, 1, 'only the selected painted occurrence is strong')
    assert.ok(lines.some(line => stripTerminalSequences(line).includes('label needle')),
      'the visible link label remains painted')
    assert.deepEqual(lines.map(stripTerminalSequences), plainBefore,
      'highlighting preserves visible text, ANSI/OSC-stripped layout and link label')
    assert.deepEqual(folder.search('needle').map(match => ({
      id: match.id,
      sourceOccurrence: match.sourceOccurrence,
      range: match.normalizedSourceRange,
    })), fullBefore, 'View does not mutate Full match identity or source ranges')

    assert.deepEqual(app.setRenderedViewSearchQuery(''), { currentIndex: -1, count: 0 },
      'an empty query clears the current occurrence and returns 0/0')
    await vt.waitForRender()
    assert.equal(app.renderedViewSearchStatus(), undefined)
    assert.equal(strongOccurrences(vt, vt.getViewport(), 'needle').length, 0,
      'an empty query removes every View strong highlight')

    const fullMatch = folder.search('needle')[0]!
    app.setTranscriptSearchTarget({ query: 'needle', match: fullMatch, message: folder.messages()[0]! })
    await vt.waitForRender()
    assert.equal(app.renderedViewSearchStatus(), undefined,
      'a Full semantic target cannot coexist with the rendered View selection')
    assert.equal(app.transcriptSearchPresentationForTest()?.sourceOccurrence, fullMatch.sourceOccurrence,
      'the Full semantic source ordinal is not replaced by the rendered View ordinal')
    assert.equal(folder.search('needle').length, 6, 'Full continues to include the hidden href occurrence')
  } finally {
    setCapabilities(previousCapabilities)
  }
})

test('rendered View navigation distinguishes repeated painted occurrences and wraps both directions', async () => {
  const { vt, app } = startApp(100, 30)
  const folder = assistantFolder([{ id: 'view-repeated', text: 'needle alpha needle beta\nneedle gamma' }])
  try {
    await paintTranscript(app, vt, folder)
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 3 })
    await vt.waitForRender()
    let lines = vt.getViewport()
    assert.equal(occurrences(lines, 'needle').length, 3)
    assert.deepEqual(strongOccurrences(vt, lines, 'needle'), [occurrences(lines, 'needle')[0]])

    assert.deepEqual(app.stepRenderedViewSearch(1), { currentIndex: 1, count: 3 })
    await vt.waitForRender()
    lines = vt.getViewport()
    assert.deepEqual(strongOccurrences(vt, lines, 'needle'), [occurrences(lines, 'needle')[1]])

    assert.deepEqual(app.stepRenderedViewSearch(1), { currentIndex: 2, count: 3 })
    await vt.waitForRender()
    lines = vt.getViewport()
    assert.deepEqual(strongOccurrences(vt, lines, 'needle'), [occurrences(lines, 'needle')[2]])

    assert.deepEqual(app.stepRenderedViewSearch(1), { currentIndex: 0, count: 3 }, 'Next wraps to the first occurrence')
    await vt.waitForRender()
    assert.deepEqual(strongOccurrences(vt, vt.getViewport(), 'needle'), [occurrences(vt.getViewport(), 'needle')[0]])
    assert.deepEqual(app.stepRenderedViewSearch(-1), { currentIndex: 2, count: 3 }, 'Prev wraps to the last occurrence')
    await vt.waitForRender()
    lines = vt.getViewport()
    assert.deepEqual(strongOccurrences(vt, lines, 'needle'), [occurrences(lines, 'needle')[2]])
    assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'View never installs a Full semantic target')
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View selects the first match after the viewport top and scrolling alone keeps current', async () => {
  const { vt, app } = startApp(80, 12)
  try {
    const text = Array.from({ length: 32 }, (_, index) => `row ${index} needle`).join('\n\n')
    const folder = assistantFolder([{ id: 'view-viewport-top', text }])
    await paintTranscript(app, vt, folder)
    for (let index = 0; index < 4; index += 1) vt.sendInput('\x1b[<64;5;8M')
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()!
    assert.ok(before.scrollTop > 0, 'the viewport starts in the middle of the mounted transcript')

    const mounted = (app as unknown as {
      mountedTranscriptBlocks: Array<{ rendered: readonly string[] }>
      transcriptWelcomeHeight: number
    })
    const matches = findAltScreenSearchMatches(mounted.mountedTranscriptBlocks[0]!.rendered, 'needle')
    const contentTop = before.scrollTop - mounted.transcriptWelcomeHeight
    const afterTop = matches.findIndex(match => match.segments[0]!.row >= contentTop)
    const expectedIndex = afterTop < 0 ? 0 : afterTop
    const result = app.setRenderedViewSearchQuery('needle')
    assert.deepEqual(result, { currentIndex: expectedIndex, count: 32 })
    await vt.waitForRender()
    assert.equal(strongOccurrences(vt, vt.getViewport(), 'needle').length, 1,
      'the selected occurrence is proven by its painted strong cell')

    const scrollBeforeManual = app.fullscreenScrollForTest()!.scrollTop
    vt.sendInput('\u001b[<64;5;8M')
    await vt.waitForRender()
    assert.notEqual(app.fullscreenScrollForTest()!.scrollTop, scrollBeforeManual,
      'a real wheel gesture moves the viewport independently of the selected occurrence')
    assert.deepEqual(app.renderedViewSearchStatus(), result,
      'manual scrolling alone does not change the current occurrence')

    const nextIndex = (expectedIndex + 1) % result.count
    assert.deepEqual(app.stepRenderedViewSearch(1), { currentIndex: nextIndex, count: result.count })
    await vt.waitForRender()
    assert.equal(strongOccurrences(vt, vt.getViewport(), 'needle').length, 1,
      'explicit Next moves strong highlighting and keeps its destination painted')
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View searches each mounted block independently and follows a replaced window only', async () => {
  const { vt, app } = startApp(100, 30)
  try {
    const folder = assistantFolder([
      { id: 'view-block-a', text: 'cross' },
      { id: 'view-block-b', text: 'block needle' },
      { id: 'view-window-outside', text: 'outside needle' },
    ])
    await paintTranscript(app, vt, folder)
    app.setTranscript(folder.messages().slice(0, 2), folder.turnActivities())
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 })
    assert.deepEqual(app.setRenderedViewSearchQuery('cross block'), { currentIndex: -1, count: 0 },
      'a query is not synthesized across separate mounted blocks')

    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 })
    app.setTranscript([folder.messages()[2]!], folder.turnActivities())
    await vt.waitForRender()
    assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: 0, count: 1 },
      'replacing the mounted window re-derives View results from only its current row')
    assert.ok(vt.getViewport().some(line => stripTerminalSequences(line).includes('outside needle')))

    app.setFullscreen(false)
    assert.equal(app.renderedViewSearchStatus(), undefined,
      'an actual Fullscreen-to-Regular handoff retires the View state')
    app.setFullscreen(true)
    assert.equal(app.renderedViewSearchStatus(), undefined,
      're-entering Fullscreen does not resurrect the retired query')
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View reflows CJK, emoji and combining graphemes at supported transcript widths', async () => {
  const { vt, app } = startApp(120, 40)
  try {
    const folder = assistantFolder([{
      id: 'view-unicode',
      text: '检索 👨‍👩‍👧‍👦 e\u0301 token',
    }])
    await paintTranscript(app, vt, folder)
    for (const [width, query] of [
      [12, '检索'],
      [44, '👨‍👩‍👧‍👦'],
      [80, 'e\u0301'],
      [120, 'token'],
    ] as const) {
      vt.resize(width, 32)
      await vt.waitForRender()
      assert.deepEqual(app.setRenderedViewSearchQuery(query), { currentIndex: 0, count: 1 },
        `width ${width} finds the currently painted grapheme`)
      await vt.waitForRender()
      const lines = vt.getViewport()
      assert.equal(occurrences(lines, query).length, 1, `width ${width} paints one occurrence`)
      const selected = occurrences(lines, query)
      assert.equal(selected.length, 1, `width ${width} paints one selected occurrence`)
      const selectedCell = selected[0]!
      const styledColumns = Array.from({ length: width }, (_, column) => column)
        .filter(column => vt.getCellBgRgb(selectedCell.row, column) === STRONG_BG)
      assert.ok(styledColumns.length > 0,
        `width ${width} paints the unique selected grapheme with the strong style; selected=${JSON.stringify(selectedCell)}, styledColumns=${styledColumns.join(',')}, line=${JSON.stringify(lines[selectedCell.row])}`)
    }
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View reflows the active strong cell and retires its old coordinates after resize', async () => {
  const { vt, app } = startApp(120, 30)
  try {
    const folder = assistantFolder([{
      id: 'view-resize-active',
      text: `${'prefix '.repeat(12)}needle tail`,
    }])
    await paintTranscript(app, vt, folder)
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 })
    await vt.waitForRender()
    const before = strongOccurrences(vt, vt.getViewport(), 'needle')[0]!
    assert.ok(before !== undefined && before.column > 42,
      'the wide layout paints the current match beyond the narrow content width')

    vt.resize(44, 30)
    await vt.waitForRender()
    assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: 0, count: 1 },
      'the active query is remeasured rather than retired on resize')
    const after = strongOccurrences(vt, vt.getViewport(), 'needle')
    assert.equal(after.length, 1, 'the reflowed frame has one current painted cell')
    assert.notDeepEqual(after[0], before, 'the strong segment moves with the wrapped rendered row')
    assert.notEqual(vt.getCellBgRgb(before.row, before.column), STRONG_BG,
      'the pre-resize coordinates cannot retain a stale strong highlight')
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View remeasures its current cell when an async image changes the preceding block height', async () => {
  const previousCapabilities = getCapabilities()
  const previousEnvironment = {
    PI_IMAGE_PROTOCOL: process.env.PI_IMAGE_PROTOCOL,
    TERM: process.env.TERM,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    TMUX: process.env.TMUX,
    ZELLIJ: process.env.ZELLIJ,
    STY: process.env.STY,
  }
  process.env.PI_IMAGE_PROTOCOL = 'kitty'
  process.env.TERM = 'xterm-256color'
  process.env.TERM_PROGRAM = 'xterm'
  delete process.env.TMUX
  delete process.env.ZELLIJ
  delete process.env.STY
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const vt = new VirtualTerminal(100, 30)
  let resolveRead!: (value: { ref: unknown; data: Uint8Array }) => void
  let readStarted = false
  const imageRead = new Promise<{ ref: unknown; data: Uint8Array }>(resolve => { resolveRead = resolve })
  const imageRef = {
    attachmentId: 'view-async-image' as never,
    mediaType: 'image/png' as const,
    bytes: 33,
    width: 800,
    height: 400,
    name: 'async.png',
  }
  const loader = new ImageLoader(() => {
    readStarted = true
    return imageRead
  })
  let markImageSettled!: () => void
  const imageSettled = new Promise<void>(resolve => { markImageSettled = resolve })
  const unsubscribe = loader.subscribe(imageRef.attachmentId, markImageSettled)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: text => text },
  })
  try {
    app.start()
    startedApps.add(app)
    app.setFullscreen(true)
    app.setTranscript([
      {
        kind: 'user',
        turn: 0,
        text: 'image prompt',
        content: [
          { type: 'text', text: 'image prompt' },
          { type: 'image', attachment: imageRef },
        ],
      },
      { kind: 'assistant', turn: 0, text: 'answer needle' },
    ])
    await vt.waitForRender()
    assert.equal(readStarted, true,
      `the mounted image starts its asynchronous read; cap=${JSON.stringify(getCapabilities())}, state=${loader.get(imageRef).state}, view=${vt.getViewport().join('\\n')}`)
    const beforeHeight = app.transcriptContentHeightForTest()
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 })
    await vt.waitForRender()
    const before = strongOccurrences(vt, vt.getViewport(), 'needle')[0]!
    assert.ok(before !== undefined, 'the loading-frame query has a painted current cell')

    resolveRead({ ref: {}, data: pngHeaderBytes(800, 400) })
    await imageSettled
    await vt.waitForRender()
    assert.ok(app.transcriptContentHeightForTest() > beforeHeight,
      'the real image settle expands the mounted transcript row height')
    assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: 0, count: 1 },
      'settling the image preserves the active query and its occurrence count')
    const after = strongOccurrences(vt, vt.getViewport(), 'needle')
    assert.equal(after.length, 1, 'the remeasured frame has one current painted cell')
    assert.notDeepEqual(after[0], before,
      'the current highlight follows the answer row after the preceding image gains rows')
    assert.notEqual(vt.getCellBgRgb(before.row, before.column), STRONG_BG,
      'the old viewport cell is no longer strong after reflow')
  } finally {
    try {
      if (!app.isDisposed()) app.dispose()
    } finally {
      startedApps.delete(app)
      unsubscribe()
      resolveRead({ ref: {}, data: pngHeaderBytes(800, 400) })
      setCapabilities(previousCapabilities)
      resetCapabilitiesCache()
      for (const key of Object.keys(previousEnvironment) as Array<keyof typeof previousEnvironment>) {
        const value = previousEnvironment[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
})

test('rendered View follows Compact Work disclosure without opening hidden tool output', async () => {
  const { vt, app } = startApp(120, 40, 'compact')
  try {
    const folder = new TranscriptFolder()
    const callId = ToolCallId('view-compact-tool')
    folder.apply([
      event('turn/start', { turn: 0 }, 0),
      event('user/message', {
        id: MessageId('view-compact-user'),
        role: 'user',
        content: [{ type: 'text', text: 'compact prompt' }],
        source: { kind: 'user' },
      }, 1),
      event('tool/call', { turn: 0, step: 0, callId, name: 'echo', arguments: '{}' }, 2),
      event('tool/result', {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('view-compact-result'),
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: 'result-only-needle' }],
          source: { kind: 'tool', callId },
        },
      }, 3),
      event('assistant/message', {
        turn: 0,
        step: 1,
        message: {
          id: MessageId('view-compact-answer'),
          role: 'assistant',
          content: [{ type: 'text', text: 'compact answer' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }, 4),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
    ])
    await paintTranscript(app, vt, folder)
    assert.deepEqual(app.setRenderedViewSearchQuery('result-only-needle'), { currentIndex: -1, count: 0 },
      'collapsed Compact Work does not expose the hidden tool result to View')
    const tool = folder.messages().find((message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool')!
    app.toggleWorkSpan(tool)
    await vt.waitForRender()
    assert.ok(vt.getViewport().some(line => stripTerminalSequences(line).includes('result-only-needle')),
      'the manually expanded Work paints its tool result')
    assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: 0, count: 1 },
      'View follows the new mounted Compact projection')
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View does not reveal collapsed Focus text and tracks manual disclosure changes', async () => {
  const { vt, app } = startApp(100, 30, 'focus')
  try {
    app.setThinkingExpanded(true)
    const folder = new TranscriptFolder()
    folder.apply([
      event('turn/start', { turn: 0 }, 0),
      event('user/message', {
        id: MessageId('view-focus-user'),
        role: 'user',
        content: [{ type: 'text', text: 'focus prompt' }],
        source: { kind: 'user' },
      }, 1),
      event('assistant/message', {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('view-focus-answer'),
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'private thought needle\nvisible line' },
            { type: 'text', text: 'focus answer' },
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [
          { type: 'chunk', time: 1_700_000_000_002, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
          { type: 'chunk', time: 1_700_000_000_003, chunk: { type: 'reasoning-delta', index: 0, text: 'private thought needle\nvisible line' } },
          { type: 'chunk', time: 1_700_000_000_004, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private thought needle\nvisible line' } } },
          { type: 'chunk', time: 1_700_000_000_005, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
          { type: 'chunk', time: 1_700_000_000_006, chunk: { type: 'text-delta', index: 1, text: 'focus answer' } },
          { type: 'chunk', time: 1_700_000_000_007, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'focus answer' } } },
        ],
      }, 2),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
    ])
    assert.equal(folder.turnActivities().has(0), true, 'the real fold publishes a Focus root for the turn')
    assert.ok(folder.messages().some(message => message.kind === 'thinking'), 'the fold contains the reasoning source')
    const thinking = folder.messages().find((message): message is Extract<TranscriptMessage, { kind: 'thinking' }> => message.kind === 'thinking')!
    await paintTranscript(app, vt, folder)
    assert.deepEqual(app.setRenderedViewSearchQuery('private thought'), { currentIndex: -1, count: 0 },
      'collapsed Focus content is not part of the rendered View corpus')
    app.toggleFocusTurn(0)
    await vt.waitForRender()
    assert.deepEqual(app.focusExpandedTurnsForTest(), new Set([0]), 'the explicit disclosure commits the turn root')
    assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: -1, count: 0 },
      'the nested Work remains collapsed after opening the Focus root')
    app.toggleWorkSpan(thinking)
    await vt.waitForRender()
    const expandedLines = vt.getViewport().map(stripTerminalSequences)
    assert.ok(expandedLines.some(line => line.includes('private thought')),
      `the manually opened Work paints its Thinking source:\\n${expandedLines.join('\\n')}`)
    assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: 0, count: 1 },
      'opening the nested Work makes its painted reasoning searchable')
    app.toggleFocusTurn(0)
    await vt.waitForRender()
    assert.deepEqual(app.renderedViewSearchStatus(), { currentIndex: -1, count: 0 },
      'collapsing the Focus root removes the hit without the View changing disclosure')
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View uses the mounted component when an equivalent summary object replaces its source object', async () => {
  const { vt, app } = startApp(100, 30)
  try {
    const first: TranscriptMessage = { kind: 'summary', text: 'Window summary needle' }
    app.setFullscreen(true)
    app.setTranscript([first])
    await vt.waitForRender()
    const batch = (app as unknown as {
      mountedTranscriptBlocks: Array<{ block: { kind: string }; component: unknown }>
    }).mountedTranscriptBlocks
    const component = batch[0]!.component

    app.setTranscript([{ kind: 'summary', text: 'Window summary needle' }])
    assert.strictEqual((app as unknown as {
      mountedTranscriptBlocks: Array<{ block: { kind: string }; component: unknown }>
    }).mountedTranscriptBlocks[0]!.component, component,
    'the equivalent summary keeps its mounted component')
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 },
      'View indexes the mounted summary without requiring a cache entry for its replacement object')
    await vt.waitForRender()
    assert.equal(strongOccurrences(vt, vt.getViewport(), 'needle').length, 1)
  } finally {
    app.clearRenderedViewSearch()
  }
})

test('rendered View is retired before a display-subject identity change commits', async () => {
  const { vt, app } = startApp(100, 30)
  try {
    const folder = assistantFolder([{ id: 'view-subject-main', text: 'main needle' }])
    await paintTranscript(app, vt, folder)
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 })
    await vt.waitForRender()

    enterChildDisplaySubject(app, {
      id: 'view-child',
      label: 'Child',
      mode: 'continuable',
      activity: 'inactive',
      cwd: '/workspace/child',
      turns: 0,
      steps: 0,
    })
    assert.equal(app.renderedViewSearchStatus(), undefined,
      'the main subject occurrence cannot survive the committed child identity')
    await vt.waitForRender()
    assert.equal(strongOccurrences(vt, vt.getViewport(), 'needle').length, 0,
      'the retired subject loses its strong painted cells')
  } finally {
    app.clearRenderedViewSearch()
  }
})
