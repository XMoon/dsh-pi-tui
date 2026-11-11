import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createSurfaceRuntime } from '../../src/app/surface/runtime.ts'
import { createSessionPresentation, type SessionPresentationEvent } from '../../src/app/surface/session-presentation.ts'
import { toolSummaryKeys } from '../../src/tui/transcript/tool-presentation.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const CURRENT_BG = 0xe58a24

const notificationPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

function strongNeedleCount(vt: VirtualTerminal): number {
  let count = 0
  for (const [row, line] of vt.getViewport().entries()) {
    const plain = stripTerminalSequences(line)
    for (let index = plain.indexOf('needle'); index >= 0; index = plain.indexOf('needle', index + 6)) {
      if (vt.getCellBgRgb(row, visibleWidth(plain.slice(0, index))) === CURRENT_BG) count += 1
    }
  }
  return count
}

test('a session generation bump through SurfaceRuntime retires View strong cells before the next session paints', async () => {
  const vt = new VirtualTerminal(100, 30)
  const surface = createSurfaceRuntime<SessionPresentationEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  const previous = {
    columns: process.env.COLUMNS,
    lines: process.env.LINES,
    write: process.stdout.write,
  }
  process.env.COLUMNS = '100'
  process.env.LINES = '30'
  process.stdout.write = ((chunk: unknown): boolean => {
    if (typeof chunk === 'string') vt.write(chunk)
    else if (chunk instanceof Uint8Array) vt.write(Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write

  try {
    surface.start({
      events: { onSubmit: () => {}, onExit: () => {} },
      workspaceRoot: '/workspace',
      iconStyle: 'emoji',
      displayState: { preset: 'full' },
      historySearchSource: { search: async () => { throw new Error('unused') } },
      readImage: async () => { throw new Error('unused') },
      imageScope: () => undefined,
      present: { call: () => undefined, result: () => undefined },
      sessionCwd: () => '/workspace',
      captureHistoryScope: () => ({ sessionId: 'view-generation', isCurrent: () => true }),
      onTerminalResize: () => {},
      copySelection: async () => false,
      deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
      openExternalUrl: () => {},
      readClipboardText: async () => undefined,
      imageFallbackColor: text => text,
    })

    const app = surface.app
    app.setFullscreen(true)
    app.setTranscript([{ kind: 'assistant', turn: 0, text: 'old session needle' }])
    assert.deepEqual(app.setRenderedViewSearchQuery('needle'), { currentIndex: 0, count: 1 })
    await vt.waitForRender()
    assert.equal(strongNeedleCount(vt), 1, 'the old session has one painted current View cell')

    const presentation = createSessionPresentation({
      surface,
      diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} } as unknown as Diag,
      summaryKeys: toolSummaryKeys,
      isCleanedUp: () => false,
      refreshStatusCheap: () => {},
      folds: { title: () => undefined },
      direct: {
        installModelSelection: () => {},
        assistantStreamBaselineFor: () => [],
        planActive: () => false,
        effectiveCwd: () => '/workspace',
      },
      status: {
        setGoalText: () => {},
        refresh: () => {},
        refreshTerminalTitle: () => {},
        refreshTerminalCwd: () => {},
        updateWelcomeCard: () => {},
        scheduleInitialMeasurement: () => {},
        markContextDirty: () => {},
        refreshContextMeasurement: () => {},
      },
      history: {
        rememberCwd: () => {},
        currentCwd: () => '/workspace',
        records: () => [],
        setLastContent: () => {},
      },
      commands: { register: () => {} },
      submission: { clearPending: () => {} },
      viewer: { resetAutoPop: () => {}, teardownForSessionSwap: () => {} },
    })
    const ownership = createSessionOwnershipCore({
      isSurfaceDisposed: () => surface.app.isDisposed(),
      resetForGeneration: () => presentation.resetForGeneration(),
    })
    assert.equal(ownership.bumpGeneration(), 1, 'the real ownership core commits a new generation')
    assert.equal(app.renderedViewSearchStatus(), undefined,
      'SurfaceRuntime generation reset retires the active View projection')

    app.setTranscript([{ kind: 'assistant', turn: 0, text: 'new session needle' }])
    await vt.waitForRender()
    assert.equal(strongNeedleCount(vt), 0, 'the next session paints no strong cell from the retired View query')
    assert.equal(app.renderedViewSearchStatus(), undefined, 'the query is not inherited by the new session')
  } finally {
    try {
      surface.dispose()
    } finally {
      process.stdout.write = previous.write
      if (previous.columns === undefined) delete process.env.COLUMNS
      else process.env.COLUMNS = previous.columns
      if (previous.lines === undefined) delete process.env.LINES
      else process.env.LINES = previous.lines
    }
  }
})
