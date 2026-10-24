/**
 * Image UX PR2: the REAL `/view-image` registration and execution path.
 *
 * The test drives the production Client command registry (the same object the
 * submission owner executes from) into `TuiApp.openTranscriptImagePicker()`,
 * then the REAL keyboard journey through the mounted `SearchablePicker`:
 * Enter opens the read-only Viewer above the still-mounted list, Esc returns
 * to the same selection, a second Esc closes the list. The TSP-shaped runner
 * (no PiTui `app`) must not register the command at all.
 * @module @xmoon76/dsh-pi-tui/view-image-command.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { classifyCommandLine, isLocalCommandLine, LOCAL_COMMANDS, SESSIONLESS_COMMANDS } from '../../src/domain/command/policy.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

const IMAGE_A = { attachmentId: 'att-a', mediaType: 'image/png', bytes: 33, width: 800, height: 100, name: 'first.png' } as const
const IMAGE_B = { attachmentId: 'att-b', mediaType: 'image/png', bytes: 33, width: 640, height: 480, name: 'second.png' } as const

/** The stub runner shape the command coordinator needs (the existing
 * image-command suite's known-good set), plus a REAL Client registry. */
function setup(options: {
  loader: ImageLoader
  mounted?: boolean
  cwd?: string
  sessionCwd?: string
  signal?: AbortSignal
  transitionPending?: () => boolean
}): {
  vt: VirtualTerminal
  app: TuiApp
  runner: TuiCommandRunner
  ensureSessionCalls: () => number
} {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: options.loader,
    imageTheme: { fallbackColor: (text: string) => text },
  })
  app.start()
  startedApps.add(app)
  const ctx = new Context()
  const store = new DraftImageStore()
  const fileStore = new DraftFileStore()
  let ensureSessionCalls = 0
  const clientCwd = options.cwd ?? '/ws'
  const sessionCwd = options.sessionCwd ?? '/ws'
  const runner: TuiCommandRunner = {
    ctx,
    app: options.mounted === false ? undefined : app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...sessionScopeFacts(() => undefined, () => 0),
    currentSessionId: undefined,
    ensureSession: async () => { ensureSessionCalls += 1 },
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: clientCwd,
    sessionCwd: () => sessionCwd,
    fileStore,
    imageStore: store,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: (text) => app.insertIntoEditor(text),
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: options.signal ?? new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openPluginManager: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: options.transitionPending ?? (() => false),
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  return { vt, app, runner, ensureSessionCalls: () => ensureSessionCalls }
}

function mountImages(app: TuiApp): void {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'first' },
      { type: 'image', attachment: IMAGE_A },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [
      { type: 'text', text: 'second' },
      { type: 'image', attachment: IMAGE_B },
    ], source: { kind: 'user' } } },
  ] as never[])
  app.setTranscript(folder.messages())
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('/view-image is registered into the real Client registry only where a PiTui app is mounted', () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const mounted = setup({ loader })
  registerTuiCommandsWithDirectSeams(mounted.runner)
  const def = mounted.runner.clientCommands.get('view-image')
  assert.ok(def !== undefined, 'the mounted PiTui surface owns /view-image')
  assert.equal(def.description, 'View images in the current transcript window')
  const parsed = parseCommand('/view-image')
  assert.ok(parsed !== undefined)
  // The LIVE Client registry is the ownership source; the static policy sets
  // agree but are never the proof.
  assert.equal(mounted.runner.clientCommands.claimsLine(parsed), true)
  assert.deepEqual(
    classifyCommandLine({
      hostOriginClaim: undefined,
      tuiCommand: mounted.runner.clientCommands.claimsLine(parsed),
      extensionCommand: false,
      skillInvocation: false,
    }),
    { kind: 'client-command', source: 'tui' },
  )
  assert.equal(isLocalCommandLine('view-image', undefined, () => mounted.runner.clientCommands.get('view-image') !== undefined, false), true)
  assert.ok(LOCAL_COMMANDS.has('view-image'), 'static local policy agrees with the live registry')
  assert.ok(SESSIONLESS_COMMANDS.has('view-image'), 'the invocation never needs a Session')

})

test('the TSP-shaped runner (no PiTui app) never registers /view-image', () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const unmounted = setup({ loader, mounted: false })
  registerTuiCommandsWithDirectSeams(unmounted.runner)
  assert.equal(unmounted.runner.clientCommands.get('view-image'), undefined, 'the TSP mount exposes no /view-image')
  // The other PiTui-local command registrations still run (this is the
  // registration gate for ONE command, not a broken coordinator).
  assert.ok(unmounted.runner.clientCommands.get('display') !== undefined)
})

test('/view-image lists the mounted window without creating a Session; Enter opens the Viewer above the list; Esc steps back one layer at a time', async () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const { vt, app, runner, ensureSessionCalls } = setup({ loader })
  registerTuiCommandsWithDirectSeams(runner)
  mountImages(app)
  const execution = await runner.clientCommands.execute({ line: '/view-image', signal: new AbortController().signal })
  assert.ok(execution !== undefined)
  assert.equal(execution.result.kind, 'success')
  assert.equal(ensureSessionCalls(), 0, 'a sessionless invocation must not create a Session')
  const listed = await viewport(vt)
  assert.ok(listed.includes('Images · current transcript'), `the list header is painted:
${listed}`)
  assert.ok(listed.includes('#1 · first.png · 800×100 · image/png'), `the first occurrence is listed:
${listed}`)
  assert.ok(listed.includes('#2 · second.png · 640×480 · image/png'), `the second occurrence is listed:
${listed}`)
  // Move down to the second occurrence, then Enter: the Viewer opens ABOVE the
  // still-mounted list.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  const opened = await viewport(vt)
  assert.ok(opened.includes('Image · second.png'), 'VIEWER LINES ' + JSON.stringify(opened.split('\n')))
  // Esc #1: the Viewer closes and the SAME list/selection is restored.
  vt.sendInput('\x1b')
  const restored = await viewport(vt)
  assert.ok(!restored.includes('Image · second.png'), `the Viewer closed:
${restored}`)
  assert.ok(restored.includes('Images · current transcript'), `the list is still mounted:
${restored}`)
  const selectedRow = restored.split('\n').find(line => line.includes('#2 · second.png')) ?? ''
  assert.ok(selectedRow.includes('> '), `the second occurrence kept its selection:\n${restored}`)
  // Esc #2: the list closes.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const closed = await viewport(vt)
  assert.ok(!closed.includes('Images · current transcript'), `the second Esc closed the list:
${closed}`)
  app.stop()
})

test('/view-image with no mounted image paints the exact notice and opens no list', async () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const { vt, app, runner } = setup({ loader })
  registerTuiCommandsWithDirectSeams(runner)
  const execution = await runner.clientCommands.execute({ line: '/view-image', signal: new AbortController().signal })
  assert.ok(execution !== undefined)
  assert.equal(execution.result.kind, 'success')
  const view = await viewport(vt)
  assert.ok(view.includes('No images in the current transcript window'), `the exact empty-window notice:
${view}`)
  assert.ok(!view.includes('Images · current transcript'), 'no picker mounted without images')
  app.stop()
})

test('/view-image opens its leased list from a fullscreen transcript and Esc restores that exact surface', async () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const { vt, app, runner } = setup({ loader })
  registerTuiCommandsWithDirectSeams(runner)
  app.setFullscreen(true)
  mountImages(app)
  const fullscreenBefore = await viewport(vt)
  assert.ok(fullscreenBefore.includes('dsh-pi-tui'), `the fullscreen transcript painted:\n${fullscreenBefore}`)
  assert.ok(fullscreenBefore.includes('second'), `the fullscreen transcript content painted:\n${fullscreenBefore}`)
  const execution = await runner.clientCommands.execute({ line: '/view-image', signal: new AbortController().signal })
  assert.ok(execution !== undefined && execution.result.kind === 'success')
  const listed = await viewport(vt)
  assert.ok(listed.includes('Images · current transcript'), `the list screen owns the terminal:\n${listed}`)
  assert.ok(listed.includes('#1 · first.png'), `the first occurrence is listed:\n${listed}`)
  assert.ok(listed.includes('#2 · second.png'), `the second occurrence is listed:\n${listed}`)
  vt.sendInput('\x1b')
  const restored = await viewport(vt)
  assert.ok(!restored.includes('Images · current transcript'), `Esc closed the list screen:\n${restored}`)
  assert.ok(restored.includes('second'), `the fullscreen transcript is restored:\n${restored}`)
  app.setFullscreen(false)
  app.stop()
})

test('a session switch retires the image workspace screen (no old-scope candidate survives)', async () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const { vt, app, runner } = setup({ loader })
  registerTuiCommandsWithDirectSeams(runner)
  mountImages(app)
  const execution = await runner.clientCommands.execute({ line: '/view-image', signal: new AbortController().signal })
  assert.ok(execution !== undefined && execution.result.kind === 'success')
  assert.ok((await viewport(vt)).includes('Images · current transcript'), 'the list screen is open')
  // The runner's session-switch choke point retires the leased screen with
  // the other workspace leases.
  app.clearSessionOverrides()
  const after = await viewport(vt)
  assert.ok(!after.includes('Images · current transcript'), `the session switch closed the workspace:\n${after}`)
  app.stop()
})

test('a list candidate that left the mounted window is refused with a notice (never re-authorized)', async () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const { vt, app, runner } = setup({ loader })
  registerTuiCommandsWithDirectSeams(runner)
  mountImages(app)
  const execution = await runner.clientCommands.execute({ line: '/view-image', signal: new AbortController().signal })
  assert.ok(execution !== undefined && execution.result.kind === 'success')
  assert.ok((await viewport(vt)).includes('Images · current transcript'), 'the snapshot list is open')
  // The mounted window changes underneath the list (a page/window update): the
  // candidate no longer belongs to the current batch.
  app.setTranscript([])
  await vt.waitForRender()
  vt.sendInput('\r')
  const after = await viewport(vt)
  assert.ok(!after.includes('Images · current transcript'), `the stale candidate closed the workspace:\n${after}`)
  assert.ok(after.includes('the image left the current transcript window'), `the owner reported the stale candidate:\n${after}`)
  app.stop()
})
