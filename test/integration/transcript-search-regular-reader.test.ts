import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiAltScreen } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function appWith(terminal: VirtualTerminal, events: ConstructorParameters<typeof TuiApp>[1]): TuiApp {
  const app = new TuiApp(terminal, events)
  app.start()
  startedApps.add(app)
  return app
}

test('a fullscreen screen-start failure restores Regular and releases the pending Search open', async () => {
  const vt = new VirtualTerminal(100, 30)
  let opened = 0
  const app = appWith(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchOpen: () => { opened += 1 },
  })
  await vt.waitForRender()
  app.setDraft('reader start failure draft')
  const failure = new Error('alt screen start failed')
  const originalStart = TuiAltScreen.prototype.start
  const originalStop = TuiAltScreen.prototype.stop
  let failedScreen: TuiAltScreen | undefined
  let failedScreenStops = 0
  try {
    TuiAltScreen.prototype.start = function (this: TuiAltScreen): void {
      failedScreen = this
      originalStart.call(this)
      throw failure
    }
    TuiAltScreen.prototype.stop = function (this: TuiAltScreen, options?: Parameters<TuiAltScreen['stop']>[0]): void {
      if (this === failedScreen) failedScreenStops += 1
      originalStop.call(this, options)
    }
    try {
      assert.throws(() => app.startTranscriptSearch('view'), error => error === failure,
        'the original physical screen-start failure remains observable')
    } finally {
      TuiAltScreen.prototype.start = originalStart
      TuiAltScreen.prototype.stop = originalStop
    }

    assert.equal(failedScreenStops, 1, 'the partially started candidate screen is stopped exactly once')
    assert.equal(app.isFullscreen(), false, 'failed reader admission leaves Main as the screen owner')
    assert.equal(app.isSearching(), false, 'a failed screen transition never mounts Search')
    assert.equal(app.hostEditorTextForTest(), 'reader start failure draft')
    assert.equal(opened, 0, 'Runtime admission runs only after the physical screen starts')
    app.startTranscriptSearch('full')
    await vt.waitForRender()
    assert.equal(app.isSearching(), true, 'the failed opening latch was retired and a later Search can open')
    assert.equal(app.isFullscreen(), true)
    assert.equal(opened, 1)
    app.closeTranscriptSearch()
    await vt.waitForRender()
    assert.equal(app.isFullscreen(), false)
  } finally {
    TuiAltScreen.prototype.start = originalStart
    TuiAltScreen.prototype.stop = originalStop
    if (failedScreen !== undefined && failedScreenStops === 0) originalStop.call(failedScreen)
    app.stop()
  }
})

test('a throwing Search blur callback still closes Runtime and returns the temporary Reader', async () => {
  const vt = new VirtualTerminal(100, 30)
  let closed = 0
  const app = appWith(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchClose: () => { closed += 1 },
  })
  app.startTranscriptSearch('view')
  await vt.waitForRender()
  assert.equal(app.isSearching(), true)
  assert.equal(app.isFullscreen(), true)
  const component = (app as unknown as { searchComponent: { focused: boolean } }).searchComponent
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(component), 'focused')
  assert.ok(descriptor?.get && descriptor.set, 'Search is the FocusForwardingFrame child and owns the physical blur callback')
  const failure = new Error('Search blur callback failed')
  let blurCalls = 0
  Object.defineProperty(component, 'focused', {
    configurable: true,
    get: () => descriptor.get!.call(component),
    set: (focused: boolean) => {
      if (!focused && blurCalls++ === 0) throw failure
      descriptor.set!.call(component, focused)
    },
  })

  assert.throws(() => app.closeTranscriptSearch(), error => error === failure,
    'the original focus callback failure remains observable after cleanup')
  assert.equal(closed, 1, 'Runtime close still runs after the overlay hide failure')
  assert.equal(app.isSearching(), false)
  assert.equal(app.isFullscreen(), false, 'the temporary Reader returns even when hide throws')
  app.stop()
})

test('Regular Find leases the existing fullscreen reader and restores the inline editor without persisting fullscreen', async () => {
  const vt = new VirtualTerminal(100, 30)
  const opened: Array<{ scope: string; fullscreen: boolean }> = []
  const queries: string[] = []
  const scopes: string[] = []
  const closed: string[] = []
  const fullscreenPreferences: boolean[] = []
  let app: TuiApp
  app = appWith(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchOpen: scope => {
      opened.push({ scope, fullscreen: app.isFullscreen() })
    },
    onSearchScope: scope => {
      scopes.push(scope)
      app.setSearchScope(scope)
    },
    onSearchQuery: query => queries.push(query),
    onSearchClose: reason => closed.push(reason),
    onFullscreenChange: fullscreen => fullscreenPreferences.push(fullscreen),
  })
  app.setTranscript([
    {
      kind: 'user',
      turn: 0,
      text: Array.from({ length: 12 }, (_, index) => index === 11 ? 'manual-user-tail' : `prompt row ${index}`).join('\n'),
    },
    { kind: 'thinking', turn: 0, text: 'manual-thinking-tail' },
  ])
  app.setTranscriptDetailExpanded(true)
  app.setThinkingExpanded(true)
  app.setDraft('draft survives reader')
  await vt.waitForRender()
  const cursorBefore = app.seatEditorForTest().getCursor()
  assert.ok(vt.getViewport().some(line => line.includes('manual-user-tail')))
  assert.ok(vt.getViewport().some(line => line.includes('manual-thinking-tail')))

  vt.sendInput('\x06') // View Find enters the temporary reader through the real key path.
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true)
  assert.deepEqual(opened, [{ scope: 'view', fullscreen: true }],
    'Runtime admission runs after the existing Fullscreen screen became the physical owner')
  assert.equal(app.isSearching(), true)
  assert.equal(app.transcriptSearchCoverageForTest(), 'loaded-history', 'standalone evidence defaults to conservative loaded coverage')
  assert.equal(app.hostEditorTextForTest(), 'draft survives reader')
  assert.deepEqual(fullscreenPreferences, [], 'temporary reader never writes the user fullscreen preference')

  vt.sendInput('needle')
  await vt.waitForRender()
  assert.equal(queries.at(-1), 'needle')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full'])
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.hostEditorTextForTest(), 'draft survives reader', 'search Enter never submits or edits the inline draft')

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.isSearching(), false)
  assert.equal(app.isFullscreen(), false, 'closing the one Search overlay returns to the original Regular mode')
  assert.equal(app.focusSeatForTest(), 'editor')
  assert.equal(app.hostEditorTextForTest(), 'draft survives reader')
  assert.equal(app.seatEditorForTest().getCursor(), cursorBefore)
  assert.ok(vt.getViewport().some(line => line.includes('manual-user-tail')),
    'Regular manual User disclosure survives the temporary fullscreen transition')
  assert.ok(vt.getViewport().some(line => line.includes('manual-thinking-tail')),
    'Regular manual Thinking disclosure survives the temporary fullscreen transition')
  assert.deepEqual(closed, ['dismiss'])
  assert.deepEqual(fullscreenPreferences, [])
  app.stop()
})

test('Regular Find admission refuses an existing capturing overlay without switching screens', async () => {
  const vt = new VirtualTerminal(100, 30)
  let opened = 0
  const app = appWith(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchOpen: () => { opened += 1 },
  })
  await vt.waitForRender()
  const picker = app.openPicker([{ value: 'one', label: 'One' }], () => {}, () => {}, { width: 28, maxHeight: 3 })
  await vt.waitForRender()

  app.startTranscriptSearch('view')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), false)
  assert.equal(app.isSearching(), false)
  assert.equal(opened, 0, 'a captured overlay refuses before Runtime admission')
  assert.ok(vt.getViewport().join('\n').includes('One'), 'the existing capturing owner remains visible')
  picker.close()
  app.stop()
})

test('a surface change re-entered from Search admission cancels only the pending reader open', async () => {
  const vt = new VirtualTerminal(100, 30)
  let app!: TuiApp
  let opens = 0
  let closes = 0
  app = appWith(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchOpen: () => {
      opens += 1
      app.setFullscreen(false)
    },
    onSearchClose: () => { closes += 1 },
  })
  app.setDraft('reentrant draft')
  await vt.waitForRender()

  app.startTranscriptSearch('view')
  await vt.waitForRender()
  assert.equal(opens, 1)
  assert.equal(closes, 1, 'the admitted transaction is paired with exactly one surface-change close')
  assert.equal(app.isSearching(), false)
  assert.equal(app.isFullscreen(), false, 'the callback-selected Regular screen wins over stale Search opening')
  assert.equal(app.hostEditorTextForTest(), 'reentrant draft')
  app.stop()
})

test('closing the old Search can synchronously open a new one without the old Reader return stealing it', async () => {
  const vt = new VirtualTerminal(100, 30)
  let app!: TuiApp
  let opens = 0
  let closes = 0
  app = appWith(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchOpen: () => { opens += 1 },
    onSearchClose: reason => {
      closes += 1
      if (reason === 'dismiss' && closes === 1) app.startTranscriptSearch('full')
    },
  })
  app.startTranscriptSearch('view')
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true)
  app.closeTranscriptSearch()
  await vt.waitForRender()
  assert.equal(opens, 2)
  assert.equal(closes, 1)
  assert.equal(app.isSearching(), true, 'the new overlay remains mounted')
  assert.equal(app.isFullscreen(), true, 'the stale close does not return the new Reader to Regular')
  app.closeTranscriptSearch()
  await vt.waitForRender()
  assert.equal(closes, 2)
  assert.equal(app.isFullscreen(), false)
  app.stop()
})
test('a declined Runtime admission rolls back only the newly created temporary reader', async () => {
  const vt = new VirtualTerminal(100, 30)
  let closed = 0
  const app = appWith(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchOpen: () => false,
    onSearchClose: () => { closed += 1 },
  })
  app.setDraft('unchanged')
  await vt.waitForRender()

  app.startTranscriptSearch('full')
  await vt.waitForRender()
  assert.equal(app.isSearching(), false)
  assert.equal(app.isFullscreen(), false)
  assert.equal(app.hostEditorTextForTest(), 'unchanged')
  assert.equal(closed, 0, 'a refused open has no Search close transaction')
  app.stop()
})
