/**
 * Agent Context readable identity on the REAL production composition.
 *
 * A mounted `TuiApp` over a `VirtualTerminal`, the real `SurfaceRuntime`
 * repaint commit (`repaintTarget`), the real `TaskRuntime` catalog commit and
 * the existing semantic `SessionReader` fake drive the WHOLE chain
 * `projection → sender identity → setContextSenderLabels → renderMessage`.
 * Assertions read the PAINTED frame: the relay/settled card header shows the
 * official title (or the exact descendant catalog label), never a
 * pre-computed `senderDisplayName` handed to the row by the test.
 *
 * Covered: the short-id first frame upgrading to the official title through
 * the real component-cache invalidation; the catalog-label path with a
 * duplicate label under a different childId; the main↔viewer subject
 * alternation with a stale async completion; and the fact that the title
 * change leaves the folder search corpus, an open disclosure and the
 * fullscreen scroll position untouched.
 * @module @xmoon76/dsh-pi-tui/app/agent-context-identity-integration.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import type { TuiApp } from '../../src/tui-app.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createSurfaceRuntime, type SurfaceEventRoutingSource, type SurfaceViewedChildPresentation } from '../../src/app/surface/runtime.ts'
import type { TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import type { JobObservationPort, JobStopOutcome } from '../../src/runtime/job-observation-port.ts'
import type { SessionContentSearchPage, SessionReader, SessionStatusProjection, SessionSummary } from '../../src/runtime/session-reader-port.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const MAIN_SESSION = 'session-main-0000'
const RELAY_SENDER = 'session-8f23a19c-0d4e-4c55-9f6b-9a7c1e2d3f40'
const RELAY_SHORT = '8f23a19c'
const RELAY_BODY = `Agent ${RELAY_SENDER} sent a message: 已完成审核，两处需要修复。`
const SETTLED_SUMMARY = `Background subagent ${RELAY_SENDER} finished and will do no further work unless you send it more.`

/** The card's short-id fallback (the shared `shortSessionId` convention). */
function shortId(id: string): string {
  return id.replace(/^session[-_]/i, '').slice(0, 8)
}

function event(type: string, data: Record<string, unknown>, seq: number, surfaceOp?: 'append'): SessionEvent {
  return {
    type,
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  } as SessionEvent
}

/** One completed turn whose opening injected Context is a relay from one
 * child Agent (the producer-declared DSH source shape). */
function relayTurn(turn: number, senderSessionId: string, text: string): SessionEvent[] {
  const seq = turn * 10
  return [
    event('turn/start', { turn }, seq),
    event('user/message', {
      id: MessageId(`relay-${turn}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId },
    }, seq + 1, 'append'),
    event('assistant/message', {
      turn,
      step: 0,
      message: {
        id: MessageId(`answer-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `已接收审核报告 ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      stream: [],
    }, seq + 2, 'append'),
    event('turn/end', { turn, reason: { kind: 'completed' } }, seq + 3),
  ]
}

/** One completed turn whose opening injected Context is the DSH settlement
 * notice for the same child Agent. */
function settledTurn(turn: number, senderSessionId: string, summary: string, body: string): SessionEvent[] {
  const seq = turn * 10
  return [
    event('turn/start', { turn }, seq),
    event('user/message', {
      id: MessageId(`settled-${turn}`),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId },
    }, seq + 1, 'append'),
    event('turn/end', { turn, reason: { kind: 'completed' } }, seq + 2),
  ]
}

function folderWith(events: readonly SessionEvent[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply(events)
  return folder
}

/** The controllable semantic SessionReader: synchronous official titles plus
 * the ONE list/projection-batch demand round. */
class FakeSessionReader implements SessionReader {
  readonly statusTitles = new Map<string, string>()
  readonly listed: SessionSummary[] = []
  readonly batchTitles = new Map<string, string>()
  listCalls = 0
  holdNextBatch: Promise<void> | undefined

  sessionStatus(sessionId: string): SessionStatusProjection | undefined {
    const title = this.statusTitles.get(sessionId)
    return title === undefined ? undefined : { sessionId, title }
  }

  async list(): Promise<SessionSummary[] | undefined> {
    this.listCalls += 1
    return [...this.listed]
  }

  async projectionBatch(rows: readonly SessionSummary[]): Promise<Map<string, { title?: string }>> {
    const hold = this.holdNextBatch
    if (hold !== undefined) {
      this.holdNextBatch = undefined
      await hold
    }
    const result = new Map<string, { title?: string }>()
    for (const row of rows) {
      const title = this.batchTitles.get(row.id)
      if (title !== undefined) result.set(row.id, { title })
    }
    return result
  }

  async search(): Promise<SessionContentSearchPage | undefined> {
    return undefined
  }

  blank(): boolean | undefined {
    return undefined
  }

  measureContext(): number | undefined {
    return undefined
  }

  turnOutline(): [] {
    return []
  }
}

class JobObservationDouble implements JobObservationPort {
  open(): () => void {
    return () => {}
  }

  async stop(): Promise<JobStopOutcome> {
    return { kind: 'requested' }
  }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly surface: ReturnType<typeof createSurfaceRuntime<SessionEvent>>
  readonly reader: FakeSessionReader
  readonly descendants: TaskSubagentEntry[]
  /** Switch the main transcript (a new Session commit). */
  setMain(folder: TranscriptFolder): void
  /** Enter the child viewer with its own folder. */
  setViewed(folder: TranscriptFolder): void
  /** Leave the viewer. */
  clearViewed(): void
  /** Repaint, drain the identity continuations and wait for the painted frame. */
  paint(): Promise<void>
  /** The painted viewport rows, sequences stripped. */
  rows(): string[]
  rowContaining(needle: string): string | undefined
  dispose(): void
}

function mount(options: { mainFolder: TranscriptFolder; statusTitles?: Record<string, string>; descendants?: TaskSubagentEntry[] }): Harness {
  const vt = new VirtualTerminal(120, 60)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const reader = new FakeSessionReader()
  for (const [id, title] of Object.entries(options.statusTitles ?? {})) reader.statusTitles.set(id, title)
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  let mainFolder = options.mainFolder
  let viewed: { folder: TranscriptFolder; window: TranscriptWindowController } | undefined
  const previews = new Map()
  const stats = { apply: () => {} }
  const mainPresentation = {
    folder: { apply: (events: readonly SessionEvent[]) => mainFolder.apply(events) },
    stats,
    get window() { return controller },
    previews,
    applyToolPreview: () => {},
  }
  const childPresentation = (): SurfaceViewedChildPresentation<SessionEvent> => ({
    id: 'session-child-viewed',
    folder: { apply: (events: readonly SessionEvent[]) => viewed!.folder.apply(events) },
    stats,
    window: viewed!.window,
    previews,
    applyToolPreview: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    refreshFooter: () => {},
  })
  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: session => session.id === MAIN_SESSION || viewed !== undefined,
    currentSessionId: () => MAIN_SESSION,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => mainPresentation,
    viewedChildId: () => viewed === undefined ? undefined : 'session-child-viewed',
    viewedChild: () => childPresentation(),
    mainFolder: () => mainFolder,
    viewedChildFolder: () => viewed!.folder,
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => { viewed = undefined },
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    refreshWorkspaceFacts: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: input => viewed!.folder.applyLiveInput(input),
    applyMainAssistantInput: input => mainFolder.applyLiveInput(input),
  }
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: {
      handleFocusReport: () => {},
      markFocused: () => {},
      focusState: () => 'focused' as const,
      notify: () => {},
      enableFocusReporting: () => {},
      disableFocusReporting: () => {},
    },
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    diag,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  surface.attachEventRouting(source)
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'full' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: MAIN_SESSION, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  startedApps.add(surface.app)
  // The composition's existing semantic reader is the ONLY identity source.
  surface.attachAgentContextIdentity({ sessionReader: reader })
  const descendants = [...(options.descendants ?? [])]
  const subject = {} as SessionSubject
  const tasks: TaskSurfaceSource = {
    sessionId: () => MAIN_SESSION,
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: new JobObservationDouble(),
    jobs: { list: () => [], subscribe: () => () => {} },
    taskRead: {
      currentKey: () => `g1:${MAIN_SESSION}`,
      currentSessionId: () => MAIN_SESSION,
      readTask: async () => ({ parentSessionId: MAIN_SESSION, parentAvailable: true, descendants: [...descendants], jobs: [] }),
      activityOf: childId => descendants.find(entry => entry.id === childId)?.kind === 'child'
        ? (descendants.find(entry => entry.id === childId) as Extract<TaskSubagentEntry, { kind: 'child' }>).activity
        : 'inactive',
    },
  }
  surface.attachTasks(tasks, { diag, isCleanedUp: () => false })

  const rows = (): string[] => vt.getViewport().map(line => line.replace(/\u001B\[[0-9;]*m/g, ''))
  const harness: Harness = {
    vt,
    surface,
    reader,
    descendants,
    setMain(next) { mainFolder = next },
    setViewed(next) {
      viewed = { folder: next, window: new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 }) }
    },
    clearViewed() { viewed = undefined },
    async paint() {
      for (let index = 0; index < 8; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
      surface.repaint()
      await vt.waitForRender()
      for (let index = 0; index < 8; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
      surface.repaint()
      await vt.waitForRender()
    },
    rows,
    rowContaining(needle) { return rows().find(line => line.includes(needle)) },
    dispose() {
      surface.dispose()
      restoreTerminal()
    },
  }
  return harness
}

test('the relay and settled headers upgrade from the short id to the official title on the painted frame', async () => {
  const folder = folderWith([
    ...relayTurn(0, RELAY_SENDER, RELAY_BODY),
    ...settledTurn(1, RELAY_SENDER, SETTLED_SUMMARY, `${SETTLED_SUMMARY}\nIts closing message:\n审核完成`),
  ])
  const h = mount({ mainFolder: folder })
  try {
    await h.paint()
    const relayHeader = h.rowContaining('Agent message')
    assert.ok(relayHeader !== undefined, `the relay header painted:\n${h.rows().join('\n')}`)
    assert.ok(relayHeader.includes(`Agent message · ${RELAY_SHORT}`), `the first frame shows the short session id: ${relayHeader}`)
    assert.ok(!relayHeader.includes(RELAY_SENDER), 'the header never uses the full raw UUID')
    assert.ok(h.rowContaining(`${RELAY_SENDER} sent a message:`) !== undefined, 'the DSH body keeps the raw protocol prefix')

    // The official title lands through the EXISTING semantic read (sync status);
    // the repaint must rebuild the two affected cards and nothing else.
    h.reader.statusTitles.set(RELAY_SENDER, '可复用性审核员')
    await h.paint()
    assert.ok(h.rowContaining('Agent message · 可复用性审核员') !== undefined, `relay title:\n${h.rows().join('\n')}`)
    assert.ok(h.rowContaining('Subagent settled · 可复用性审核员') !== undefined, `settled title:\n${h.rows().join('\n')}`)
    assert.ok(h.rowContaining(`${RELAY_SENDER} sent a message:`) !== undefined, 'the relay body is byte-for-byte unchanged')
    assert.ok(!h.rows().some(row => row.includes('success')), 'no invented outcome word')

    // A later rename of the SAME live subject repaints both cards through the
    // real component-cache invalidation (never a stale first title).
    h.reader.statusTitles.set(RELAY_SENDER, '通讯降噪审核员')
    await h.paint()
    assert.ok(h.rowContaining('Agent message · 通讯降噪审核员') !== undefined, `renamed relay title:\n${h.rows().join('\n')}`)
    assert.ok(h.rowContaining('Subagent settled · 通讯降噪审核员') !== undefined, `renamed settled title:\n${h.rows().join('\n')}`)
    assert.ok(h.rowContaining('可复用性审核员') === undefined, 'the stale title is gone from both headers')
  } finally {
    h.dispose()
  }
})

test('the catalog label wins only for its exact childId (a duplicate label does not cross-match)', async () => {
  const childId = 'session-catalog-child-0001'
  const otherId = 'session-catalog-child-0002'
  const unclaimedId = 'session-catalog-child-9999'
  const folder = folderWith([
    ...relayTurn(0, childId, `Agent ${childId} sent a message: 来自 catalog 的审核结果`),
    ...relayTurn(1, otherId, `Agent ${otherId} sent a message: 另一个孩子`),
  ])
  const h = mount({
    mainFolder: folder,
    descendants: [
      { kind: 'child', id: childId, label: 'Catalog Reviewer', mode: 'continuable', activity: 'inactive', hasChildren: false, parentId: MAIN_SESSION, depth: 1 },
      // The SAME label under a DIFFERENT exact child id must never stand in
      // for the second sender (whose own id is absent from the catalog).
      { kind: 'child', id: unclaimedId, label: 'Catalog Reviewer', mode: 'one-shot', activity: 'inactive', hasChildren: false, parentId: MAIN_SESSION, depth: 1 },
    ],
  })
  try {
    await h.paint()
    // Give the deterministic catalog commit its frame, then repaint: the
    // enrichment re-resolves from the SAME committed rows.
    h.surface.repaint()
    await h.vt.waitForRender()
    const rows = h.rows()
    const lines = rows.filter(row => row.includes('Agent message ·'))
    assert.equal(lines.length, 2, `one header per sender:\n${rows.join('\n')}`)
    assert.ok(lines.some(row => row.includes('Catalog Reviewer')), 'the exact childId resolves its catalog label')
    assert.ok(lines.some(row => row.includes(shortId(otherId))), `the duplicate label never stands in for another sender:\n${lines.join('\n')}`)
  } finally {
    h.dispose()
  }
})

test('a stale async title completion never pollutes the next subject; a subject re-entry re-demands once', async () => {
  const mainSender = 'session-main-child-aaaa'
  const viewerSender = 'session-view-child-bbbb'
  const mainFolder = folderWith(relayTurn(0, mainSender, `Agent ${mainSender} sent a message: 主会话中进行`))
  const viewerFolder = folderWith(relayTurn(0, viewerSender, `Agent ${viewerSender} sent a message: 子视图消息`))
  let release: () => void = () => {}
  const h = mount({ mainFolder })
  try {
    h.reader.listed.push({ id: mainSender, updatedAt: 1, live: false }, { id: viewerSender, updatedAt: 2, live: false })
    h.reader.batchTitles.set(mainSender, '主会话审核员')
    h.reader.batchTitles.set(viewerSender, '子视图审核员')
    h.reader.holdNextBatch = new Promise<void>(resolve => { release = resolve })
    await h.paint()
    assert.ok(h.rowContaining(`Agent message · ${shortId(mainSender)}`) !== undefined, 'the held title frame shows the short id')

    // Enter the child viewer (a different subject AND projection source).
    h.setViewed(viewerFolder)
    await h.paint()
    assert.ok(h.rowContaining('Agent message · 子视图审核员') !== undefined, `the viewer resolves its own title:\n${h.rows().join('\n')}`)
    release()
    await h.paint()
    assert.ok(!h.rows().some(row => row.includes('主会话审核员')), 'the stale main-session completion must not leak into the viewer')

    // Back to the main subject: the viewer-specific map was dropped and the
    // main sender is demanded again (its title now settles).
    h.clearViewed()
    await h.paint()
    assert.ok(h.rowContaining('Agent message · 主会话审核员') !== undefined, `the re-entered subject re-demands:\n${h.rows().join('\n')}`)
    assert.ok(!h.rows().some(row => row.includes('子视图审核员')), 'the viewer name never leaks back')
    assert.equal(h.reader.listCalls, 3, 'one demand round per subject entry (main, viewer, main), never a poll')
  } finally {
    h.dispose()
  }
})

test('a title landing keeps the folder search corpus, the open disclosure and the scroll position unchanged', async () => {
  const longBody = Array.from({ length: 30 }, (_, index) => `审核步骤 ${index}`).join('\n')
  const folder = folderWith([
    ...relayTurn(0, RELAY_SENDER, `Agent ${RELAY_SENDER} sent a message: ${longBody} 已完成审核`),
    ...Array.from({ length: 6 }, (_, index) => event('assistant/message', {
      turn: 0,
      step: index + 1,
      message: {
        id: MessageId(`more-${index}`),
        role: 'assistant',
        content: [{ type: 'text', text: `补充说明 ${index}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      stream: [],
    }, 100 + index, 'append')),
  ])
  const matchesBefore = folder.search('审核步骤 20').map(match => `${match.turn}:${match.id}`)
  assert.ok(matchesBefore.length > 0, 'the raw folder corpus is searchable before the title lands')
  const h = mount({ mainFolder: folder })
  try {
    await h.paint()
    assert.ok(!h.rows().some(row => row.includes('审核步骤 20')), 'the long relay body starts collapsed')
    h.vt.sendInput('\x0f') // Ctrl+O: the transcript disclosure master
    await h.vt.waitForRender()
    assert.ok(h.rows().some(row => row.includes('审核步骤 20')), `the relay body opens:\n${h.rows().join('\n')}`)
    h.surface.app.setFullscreen(true)
    await h.vt.waitForRender()
    h.surface.app.scrollToTop({ disableFollow: true })
    await h.vt.waitForRender()
    const scrollBefore = h.surface.app.fullscreenScrollForTest()
    assert.ok(scrollBefore !== undefined && scrollBefore.scrollTop === 0)

    h.reader.statusTitles.set(RELAY_SENDER, '可复用性审核员')
    await h.paint()
    assert.ok(h.rows().some(row => row.includes('Agent message · 可复用性审核员')), `title painted:\n${h.rows().join('\n')}`)
    const scrollAfter = h.surface.app.fullscreenScrollForTest()
    assert.equal(scrollAfter?.scrollTop, scrollBefore.scrollTop, 'the title change never moves the viewport')
    assert.ok(h.rows().some(row => row.includes('审核步骤 20')), 'the open disclosure survives the title landing')
    assert.deepEqual(folder.search('审核步骤 20').map(match => `${match.turn}:${match.id}`), matchesBefore,
      'the raw search corpus is untouched by the header identity')
  } finally {
    h.dispose()
  }
})
