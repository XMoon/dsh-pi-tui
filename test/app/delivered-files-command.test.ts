/**
 * `/deliverables` + the transcript's painted delivered-files actions
 * (Delivered files PR1 / M6): the REAL command handler and the REAL fullscreen
 * pointer path both reach the SAME ONE managed overlay, and both carry the
 * Turn the user actually acted on.
 *
 * The fixtures mount a real `TuiApp` on a `VirtualTerminal` with the narrow
 * capability the bootstrap injects, so the assertion chain is
 * command/painted-cell → surface decision → mounted panel, never a handler
 * return value alone.
 * @module @xmoon76/dsh-pi-tui/app/delivered-files-command.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { LOCAL_COMMANDS, SESSIONLESS_COMMANDS } from '../../src/index.ts'
import { deliveredFolder, deliveredSurfaceRouting, mountDeliveredSurface } from '../support/delivered-files.ts'
import type { DeliveredFilesCapability, DeliveredFilesSnapshot } from '../../src/domain/deliverables/catalog.ts'
import type { TranscriptMessage } from '../../src/transcript.ts'
import { createArtifactsCommands } from '../../src/tui/commands/artifacts.ts'
import type { SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { deliveredFilesOverlayGeometry } from '../../src/tui/deliverables/overlay-size.ts'
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
  return vt.getViewport().map(line => stripTerminalSequences(line)).join('\n')
}

function snapshot(turns: readonly { turn: number; files: readonly (string | { path: string; description?: string })[] }[]): DeliveredFilesSnapshot {
  return {
    subjectKind: 'main',
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: turns.map(entry => ({
      turn: entry.turn,
      files: entry.files.map(file => (typeof file === 'string' ? { path: file } : file)),
    })),
  }
}

/** A capability whose snapshots are current until the fixture says otherwise. */
function capability(snap: DeliveredFilesSnapshot | undefined): DeliveredFilesCapability & { stale: () => void } {
  let current = true
  return {
    snapshot: () => (current ? snap : undefined),
    isCurrent: (candidate) => current && candidate === snap,
    stale: () => { current = false },
  }
}

/** The REAL artifacts registrar over a narrow runner (only the members the
 *  `/deliverables` handler reads) and a capturing registration seam. */
function deliverablesCommand(app: TuiApp, readSnapshot: () => DeliveredFilesSnapshot | undefined): {
  readonly result: () => unknown
  readonly runHandler: (rawInput: string) => unknown
  readonly invocations: CommandInvocation[]
  /** Names registered through the TUI-LOCAL seam (never a Host/Agent route). */
  readonly localRegistrations: string[]
  /** Names registered through the HOST compatibility mirror (expected empty). */
  readonly hostRegistrations: string[]
} {
  const invocations: CommandInvocation[] = []
  const localRegistrations: string[] = []
  const hostRegistrations: string[] = []
  const runHandler = (rawInput: string): unknown => {
    const definitions: CommandDefinition[] = []
    const commands = createArtifactsCommands({
      runner: {
        app,
        deliveredFilesSnapshot: readSnapshot,
      } as unknown as Parameters<typeof createArtifactsCommands>[0]['runner'],
      app,
      composer: () => app,
      registerOne: (definition) => { hostRegistrations.push(definition.name) },
      registerTuiCommand: (definition) => {
        localRegistrations.push(definition.name)
        definitions.push(definition as CommandDefinition)
      },
      detach: () => {},
      notifyOutcome: () => {},
    })
    commands.registerDeliverables()
    const definition = definitions.find(candidate => candidate.name === 'deliverables')
    assert.ok(definition !== undefined, 'the registrar really registered /deliverables')
    const invocation = { rawInput } as CommandInvocation
    invocations.push(invocation)
    return definition.handler(invocation)
  }
  return { result: () => runHandler(''), runHandler, invocations, localRegistrations, hostRegistrations }
}

function deliveredAssistant(turn: number, text: string, files: readonly { path: string; description?: string }[]): TranscriptMessage {
  return { kind: 'assistant', turn, text, deliverables: files }
}

test('no current catalog answers a readable error and mounts nothing', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: capability(undefined),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([deliveredAssistant(1, 'done', [{ path: '/ws/a.md' }])], new Map())
  const view = await viewport(vt)

  const command = deliverablesCommand(app, () => undefined)
  assert.deepEqual(command.result(), { kind: 'error', text: 'No delivered files in this session' })
  assert.ok(!(await viewport(vt)).includes('Delivered files · Turn'), 'no empty overlay is mounted')
  assert.ok(view.includes('Delivered files · 1'), 'the transcript tail itself is untouched')
})

test('arguments are refused instead of opening a different subject', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 4, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)
  const command = deliverablesCommand(app, () => snap)
  assert.deepEqual(command.runHandler('other'), {
    kind: 'error',
    text: 'The /deliverables command does not accept arguments.',
  })
  assert.ok(!(await viewport(vt)).includes('Delivered files · Turn'))
})

test('/deliverables really mounts the ONE managed overlay on the newest Turn', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([
    { turn: 9, files: [{ path: '/ws/report.md', description: 'Final analysis' }] },
    { turn: 4, files: ['/ws/old.md'] },
  ])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)
  const command = deliverablesCommand(app, () => snap)
  assert.deepEqual(command.result(), { kind: 'success' })
  const view = await viewport(vt)
  assert.ok(view.includes('Delivered files · Turn 9'), `the overlay header is painted:\n${view}`)
  assert.ok(view.includes('> report.md'), `the first file is selected:\n${view}`)
  assert.ok(view.includes('Enter Preview · ↑↓ Select'), `the real key path is advertised in the §7.2 order:\n${view}`)
})

test('a snapshot that stopped being current never mounts', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 2, files: ['/ws/a.md'] }])
  const live = capability(snap)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: live })
  app.start()
  startedApps.add(app)
  const command = deliverablesCommand(app, () => snap)
  live.stale()
  assert.deepEqual(command.result(), { kind: 'success' }, 'the handler reports only that it asked the surface')
  assert.ok(!(await viewport(vt)).includes('Delivered files · Turn 2'), 'the surface refused the stale catalog')
})

test('a repeated invocation keeps ONE live lease instead of stacking overlays', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 6, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)
  const command = deliverablesCommand(app, () => snap)
  command.result()
  await viewport(vt)
  command.result()
  const view = await viewport(vt)
  const headers = view.split('\n').filter(line => line.includes('Delivered files · Turn 6'))
  assert.equal(headers.length, 1, `exactly one overlay is mounted:\n${view}`)
})

/** Press+release one left click at a 0-based viewport cell. */
function clickCell(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
}

test('the fullscreen Detail verb opens THAT Turn and file, never the newest Turn', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([
    { turn: 9, files: [{ path: '/ws/newest.md', description: 'newest' }] },
    { turn: 2, files: [{ path: '/ws/archive/report.md', description: 'older report' }] },
  ])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([
    deliveredAssistant(9, 'newest answer', [{ path: '/ws/newest.md', description: 'newest' }]),
    deliveredAssistant(2, 'older answer', [{ path: '/ws/archive/report.md', description: 'older report' }]),
  ], new Map())
  app.setFullscreen(true)
  const before = await viewport(vt)
  const row = before.split('\n').findIndex(line => line.includes('report.md') && line.includes('Details'))
  assert.ok(row >= 0, `the older card paints its Details verb:\n${before}`)
  const line = before.split('\n')[row]!
  clickCell(vt, line.lastIndexOf('Details') + 2, row)
  const after = await viewport(vt)
  assert.ok(after.includes('report.md · Details'), `the Details page opened:\n${after}`)
  assert.ok(after.includes('/ws/archive/report.md'), `the exact file's Host path is shown:\n${after}`)
  assert.ok(!after.includes('Delivered files · Turn 9'), 'the newest Turn was never substituted')
})

test('the painted Browse all verb opens the Turn the card belongs to', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([
    { turn: 9, files: [{ path: '/ws/newest.md' }] },
    { turn: 2, files: ['/ws/a.md', '/ws/b.md', '/ws/c.md', '/ws/d.md', '/ws/e.md'] },
  ])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([
    deliveredAssistant(9, 'newest answer', [{ path: '/ws/newest.md' }]),
    deliveredAssistant(2, 'older answer', ['/ws/a.md', '/ws/b.md', '/ws/c.md', '/ws/d.md', '/ws/e.md'].map(path => ({ path }))),
  ], new Map())
  app.setFullscreen(true)
  const before = await viewport(vt)
  const row = before.split('\n').findIndex(line => line.includes('+1 more') && line.includes('Browse all'))
  assert.ok(row >= 0, `the older card paints its Browse all verb:\n${before}`)
  const line = before.split('\n')[row]!
  clickCell(vt, line.lastIndexOf('Browse all') + 2, row)
  const after = await viewport(vt)
  assert.ok(after.includes('Delivered files · Turn 2'), `the card's own Turn opened:\n${after}`)
  assert.ok(!after.includes('Delivered files · Turn 9'))
})

test('a click on plain card text never opens the browser', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 2, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([deliveredAssistant(2, 'the answer body', [{ path: '/ws/a.md' }])], new Map())
  app.setFullscreen(true)
  const before = await viewport(vt)
  const row = before.split('\n').findIndex(line => line.includes('the answer body'))
  assert.ok(row >= 0, before)
  clickCell(vt, 2, row)
  const after = await viewport(vt)
  assert.ok(!after.includes('Delivered files · Turn 2'), `plain text is not a delivered-files target:\n${after}`)
})

test('/deliverables is a TUI-LOCAL admission, never a Host/Agent route', () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 1, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)
  const command = deliverablesCommand(app, () => snap)
  command.result()
  assert.deepEqual(command.localRegistrations, ['deliverables'], 'registered through the TUI local seam')
  assert.deepEqual(command.hostRegistrations, [], 'never through the Host compatibility mirror')
  assert.ok(LOCAL_COMMANDS.has('deliverables'), 'the static policy agrees it is a local command')
  assert.ok(SESSIONLESS_COMMANDS.has('deliverables'),
    'a sessionless invocation answers honestly instead of creating a session')
})

test('the composed chain: canonical events → folder → surface snapshot → command → panel', async () => {
  // The REAL fixture: a folder built from canonical `deliverables/presented`
  // events, selected by a real SurfaceRuntime, read through the SAME capability
  // the bootstrap injects, and mounted by the REAL /deliverables handler.
  const folder = deliveredFolder([
    { turn: 9, files: [{ path: '/ws/docs/composed-report.md', description: 'from the fold' }] },
    { turn: 4, files: ['/ws/older.md'] },
  ])
  const surface = mountDeliveredSurface(deliveredSurfaceRouting({
    sessionId: () => 'composed-session',
    mainFolder: () => folder,
  }))
  try {
    const vt = new VirtualTerminal(100, 30)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      deliveredFiles: {
        snapshot: () => surface.deliveredFilesSnapshot(),
        isCurrent: (candidate) => surface.isDeliveredFilesSnapshotCurrent(candidate),
      },
    })
    app.start()
    startedApps.add(app)
    // The tail is fed by the SAME full projection (no bounded window).
    app.setTranscript(folder.messages(), folder.turnActivities())
    const tail = await viewport(vt)
    assert.ok(tail.includes('Delivered files · 1'), `the fold's declaration reaches the tail:\n${tail}`)

    const command = deliverablesCommand(app, () => surface.deliveredFilesSnapshot())
    assert.deepEqual(command.result(), { kind: 'success' })
    const view = await viewport(vt)
    assert.ok(view.includes('Delivered files · Turn 9'), `the newest delivered Turn opened:\n${view}`)
    assert.ok(view.includes('> composed-report.md'), `the fold's real declaration is listed:\n${view}`)
    assert.ok(!view.includes('older.md'), 'the newest Turn owns the Files page')

    // Enter opens Details, which is the ONE place the DECLARED path and
    // description are shown in full (the list stays one row per file).
    vt.sendInput('\r')
    const details = await viewport(vt)
    assert.ok(details.includes('composed-report.md · Details'), `the Details page opened:\n${details}`)
    assert.ok(details.includes('/ws/docs/composed-report.md'), `the declared Host path is shown:\n${details}`)
    assert.ok(details.includes('from the fold'), 'the fold\'s description is carried through')
  } finally {
    surface.dispose()
  }
})

test('a reentrant open inside the mount keeps ONE lease', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 6, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)
  const screen = (app as unknown as { activeScreen: { showOverlay: (...args: never[]) => unknown } }).activeScreen
  const original = screen.showOverlay.bind(screen) as (...args: never[]) => unknown
  let mounts = 0
  screen.showOverlay = ((...args: never[]) => {
    mounts += 1
    // A plugin onFocus callback re-entering the SAME command during the mount.
    if (mounts === 1) app.openDeliveredFiles(snap)
    return original(...args)
  }) as typeof screen.showOverlay
  try {
    app.openDeliveredFiles(snap)
  } finally {
    screen.showOverlay = original as typeof screen.showOverlay
  }
  assert.equal(mounts, 1, 'the reentrant open coalesced into the committed lease')
  const view = await viewport(vt)
  assert.equal(view.split('\n').filter(line => line.includes('Delivered files · Turn 6')).length, 1,
    `exactly one panel is painted:\n${view}`)
})

test('a failed mount releases the precommit so a later open still works', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 6, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)
  const screen = (app as unknown as { activeScreen: { showOverlay: (...args: never[]) => unknown } }).activeScreen
  const original = screen.showOverlay.bind(screen) as (...args: never[]) => unknown
  screen.showOverlay = (() => { throw new Error('mount failed') }) as typeof screen.showOverlay
  try {
    assert.throws(() => app.openDeliveredFiles(snap), /mount failed/)
  } finally {
    screen.showOverlay = original as typeof screen.showOverlay
  }
  assert.ok(!(await viewport(vt)).includes('Delivered files · Turn 6'), 'no half-mounted lease survives')
  app.openDeliveredFiles(snap)
  assert.ok((await viewport(vt)).includes('Delivered files · Turn 6'), 'the next open starts from a clean slate')
})

test('a fullscreen swap keeps the SAME panel (state survives, one lease)', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([
    { turn: 6, files: ['/ws/a.md'] },
    { turn: 3, files: ['/ws/b.md'] },
  ])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.openDeliveredFiles(snap)
  await viewport(vt)
  // Move the panel to its Turns page, then swap the whole screen.
  vt.sendInput('T')
  assert.ok((await viewport(vt)).includes('Delivered files · 2 Turns'), 'precondition: the Turns page is painted')
  app.setFullscreen(true)
  const swapped = await viewport(vt)
  assert.ok(swapped.includes('Delivered files · 2 Turns'),
    `the remounted projection keeps the panel state:\n${swapped}`)
  assert.equal(swapped.split('\n').filter(line => line.includes('Delivered files · 2 Turns')).length, 1,
    `one lease is remounted, never duplicated:\n${swapped}`)
})

test('a drag across the Details verb never opens the browser', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 2, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([deliveredAssistant(2, 'answer body', [{ path: '/ws/a.md' }])], new Map())
  app.setFullscreen(true)
  const before = await viewport(vt)
  const row = before.split('\n').findIndex(line => line.includes('a.md') && line.includes('Details'))
  assert.ok(row >= 0, before)
  const column = before.split('\n')[row]!.lastIndexOf('Details') + 2
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  vt.sendInput(`\x1b[<32;${column + 20};${row + 1}M`)
  vt.sendInput(`\x1b[<0;${column + 20};${row + 1}m`)
  const after = await viewport(vt)
  assert.ok(!after.includes('Delivered files · Turn 2'), `a drag is a selection, never a card action:\n${after}`)
})

test('a double click on the Details verb never opens the browser', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 2, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([deliveredAssistant(2, 'answer body', [{ path: '/ws/a.md' }])], new Map())
  app.setFullscreen(true)
  const before = await viewport(vt)
  const row = before.split('\n').findIndex(line => line.includes('a.md') && line.includes('Details'))
  assert.ok(row >= 0, before)
  const column = before.split('\n')[row]!.lastIndexOf('Details') + 2
  clickCell(vt, column, row)
  clickCell(vt, column, row)
  const after = await viewport(vt)
  assert.ok(!after.includes('Delivered files · Turn 2'), `a word-selection click is not a card action:\n${after}`)
})

test('panel keystrokes never reach the composer draft', async () => {
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 3, files: ['/ws/report.md', '/ws/other.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)
  app.setTranscript([deliveredAssistant(3, 'done', [{ path: '/ws/report.md' }])], new Map())
  app.setDraft('keep me')
  const command = deliverablesCommand(app, () => snap)
  command.result()
  await viewport(vt)
  // An input-seat gesture, an edit, a commit and the Esc ladder: every key is
  // the OVERLAY's, never the composer's.
  vt.sendInput('/')
  vt.sendInput('rep')
  await viewport(vt)
  vt.sendInput('\r')
  await viewport(vt)
  vt.sendInput('\x1b[A')
  await viewport(vt)
  vt.sendInput('\r')
  await viewport(vt)
  vt.sendInput('\x1b')
  await viewport(vt)
  vt.sendInput('\x1b')
  await viewport(vt)
  assert.equal(app.getDraft(), 'keep me', 'the overlay owned every keystroke')
})

test('a typed /deliverables is claimed + executed by the production client command plane', async () => {
  // REAL parser → REAL ClientCommandRegistry → the REAL artifacts registrar's
  // definition → the production classification/admission predicates → the
  // production local SINK. No handler is invoked by hand here.
  const { parseCommand } = await import('@deepseek-ai/dsh-commands')
  const { createClientCommandRegistry } = await import('../../src/app/command/client-command-registry.ts')
  const { classifyCommandLine } = await import('../../src/domain/command/policy.ts')
  const { resolveSubmitDelivery } = await import('../../src/app/submission/command-policy.ts')
  const clientCommands = createClientCommandRegistry(parseCommand)
  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 5, files: ['/ws/dispatch-report.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { deliveredFiles: capability(snap) })
  app.start()
  startedApps.add(app)

  // The SAME registration seam the coordinator uses: every TUI-local spec
  // becomes one Client definition per name (aliases register separately).
  const registerOne = (definition: Parameters<typeof clientCommands.register>[0]) => {
    clientCommands.register(definition)
    return () => {}
  }
  const commands = createArtifactsCommands({
    runner: {
      app,
      deliveredFilesSnapshot: () => snap,
    } as unknown as Parameters<typeof createArtifactsCommands>[0]['runner'],
    app,
    composer: () => app,
    registerOne,
    registerTuiCommand: (spec) => {
      registerOne({
        name: spec.name,
        description: spec.description,
        ...(spec.input === undefined ? {} : { input: spec.input }),
        handler: spec.handler,
      })
    },
    detach: () => {},
    notifyOutcome: () => {},
  })
  commands.registerDeliverables()

  const parsed = parseCommand('/deliverables')
  assert.ok(parsed !== undefined)
  assert.equal(clientCommands.claimsLine(parsed), true, 'the live Client registry owns the exact line')
  assert.deepEqual(classifyCommandLine({
    hostOriginClaim: undefined,
    tuiCommand: clientCommands.claimsLine(parsed),
    extensionCommand: false,
    skillInvocation: false,
  }), { kind: 'client-command', source: 'tui' }, 'the production classifier routes it to the Client plane')
  assert.equal(resolveSubmitDelivery(parsed, false, 'enter', undefined, true), 'queue',
    'a claimed local line never follows the prompt delivery policy')

  // The production local SINK executes the registered handler.
  const execution = await clientCommands.execute({ line: '/deliverables', signal: new AbortController().signal })
  assert.equal(execution?.result.kind, 'success', 'the Client plane executed the real handler')
  const view = await viewport(vt)
  assert.ok(view.includes('Delivered files · Turn 5'), `the dispatched command mounted the panel:\n${view}`)

  // An argued line is NOT an invocation of a definition without `input`.
  assert.equal(clientCommands.claimsLine(parseCommand('/deliverables other')), false,
    'an argued line falls through instead of reaching the handler')
})

test('a newer lease survives when the OLD mount itself fails after re-entry', async () => {
  const vt = new VirtualTerminal(100, 30)
  const first = snapshot([{ turn: 4, files: ['/ws/first.md'] }])
  const second = snapshot([{ turn: 8, files: ['/ws/second.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: {
      snapshot: () => second,
      isCurrent: () => true,
    },
  })
  app.start()
  startedApps.add(app)
  // The REAL reentrancy window: `OverlayBroker.commitMount` runs the broker's
  // focus transition (and therefore any plugin onFocus) AFTER the logical node
  // is registered. Simulate a callback that closes A and installs lease B, then
  // make A's own mount fail on its way back.
  const broker = (app as unknown as {
    overlayBroker: { commitMount: (prepared: never, raw: never) => unknown; handles: () => ReadonlySet<unknown> }
  }).overlayBroker
  const originalCommit = broker.commitMount.bind(broker) as (prepared: never, raw: never) => unknown
  let commits = 0
  broker.commitMount = ((prepared: never, raw: never) => {
    const handle = originalCommit(prepared, raw)
    commits += 1
    if (commits === 1) {
      app.closeDeliveredFiles()
      app.openDeliveredFiles(first)
      throw new Error('mount A failed after re-entry')
    }
    return handle
  }) as typeof broker.commitMount
  try {
    assert.throws(() => app.openDeliveredFiles(first), /mount A failed after re-entry/)
  } finally {
    broker.commitMount = originalCommit as typeof broker.commitMount
  }
  // ONE managed overlay node remains, and it is the newer lease.
  assert.equal(broker.handles().size, 1, 'the failed lease released its own broker node')
  const view = await viewport(vt)
  assert.ok(view.includes('Delivered files · Turn 4'), `the newer lease stays mounted:\n${view}`)
  assert.ok(!view.includes('second.md'), 'the failed lease painted nothing')
  // The surviving lease still owns the coalescing identity: a later open must
  // not stack a second panel on top of it.
  const mountsBefore = (app as unknown as { overlayBroker: { handles: () => ReadonlySet<unknown> } }).overlayBroker.handles().size
  app.openDeliveredFiles(first)
  const mountsAfter = (app as unknown as { overlayBroker: { handles: () => ReadonlySet<unknown> } }).overlayBroker.handles().size
  assert.equal(mountsAfter, mountsBefore, 'the later open coalesced onto the surviving lease')
  const after = await viewport(vt)
  assert.equal(after.split('\n').filter(line => line.includes('Delivered files · Turn 4')).length, 1,
    `exactly one live panel:\n${after}`)
})

test('a typed /deliverables reaches the panel through the REAL submission controller', async () => {
  // RFL-003: the previous test proved the Client plane in isolation. THIS test
  // drives the production user entry — TuiApp Enter → `onSubmit` →
  // `createSubmissionController.submit` → `runLocalCommand` (live claim +
  // registered handler) — and asserts the consequence (the panel is painted, no
  // Session is created, nothing reaches the model sink) plus a POSITIVE control
  // that the model sink really is reachable from this fixture.
  const { parseCommand } = await import('@deepseek-ai/dsh-commands')
  const { createClientCommandRegistry } = await import('../../src/app/command/client-command-registry.ts')
  const { createSubmissionController } = await import('../../src/app/submission/controller.ts')
  const { bindSubmissionRuntime } = await import('../../src/app/submission/runtime.ts')
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const { createSessionScopeAuthority } = await import('../../src/app/session/scope.ts')
  const { DraftImageStore } = await import('../../src/client/media/image/draft-store.ts')
  const { DraftFileStore } = await import('../../src/client/media/attachment/file-draft.ts')
  const { mergeDraft } = await import('../../src/app/submission/steer.ts')

  const vt = new VirtualTerminal(100, 30)
  const snap = snapshot([{ turn: 6, files: ['/ws/controller-report.md'] }])
  const modelPrompts: string[] = []
  const sessionsCreated: string[] = []
  const notices: string[] = []
  const draftImages = new DraftImageStore()
  const draftFiles = new DraftFileStore()
  let app!: TuiApp
  const composer = {
    getDraft: () => app.getDraft(),
    setDraft: (text: string) => { app.setDraft(text) },
    setEditorText: (text: string) => { app.setEditorText(text) },
    insertIntoEditor: (text: string) => { app.insertIntoEditor(text) },
    notify: (message: string) => { notices.push(message) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
  }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, 'session-live')
  const scopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = core.subject()
      if (subject === undefined) throw new Error('fixture: the owner is not published')
      return { sessionId: 'session-live', generation: core.generation(), subject }
    },
    isSubjectCurrent: (subject) => core.isSubjectCurrent(subject),
  })
  const clientCommands = createClientCommandRegistry(parseCommand)
  const command = {
    wasAdvertisedClaim: () => false,
    hostClaimOf: () => undefined,
    hostOriginClaimOf: () => undefined,
    hostCatalogResolves: () => false,
    clientClaimsLine: (parsed: { name: string; rawInput?: string } | undefined) => clientCommands.claimsLine(parsed),
    isSkillWrapperName: () => false,
    isSkillInvocation: () => false,
    withCommandDelivery: <T>(_delivery: unknown, run: () => T): T => run(),
    takeCommandDraftDisposition: () => undefined,
    clientCommands,
  }
  const runtimeSurface = {
    withWriter: async <T>(_scope: unknown, task: () => Promise<T> | T) => task(),
    withPromptAdmission: async <T>(_line: string, task: () => Promise<T> | T) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: (text: string) => { app.setEditorText(mergeDraft(app.getDraft(), text)); return true },
    restoreStaleDraftIntoEditor: () => 'merged-verbatim' as const,
    consumeDraftAttachments: () => {},
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: (message: string) => { notices.push(message) },
    refuseByTransitionFence: () => {},
    prepareMessage: async () => ({ message: {}, attachments: [] }),
    prompt: async (_sessionId: string, message: unknown) => {
      modelPrompts.push(JSON.stringify(message))
      return { kind: 'committed' as const, value: undefined }
    },
  }
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface as never })
  interface AgentLike {
    readonly status: string
    readonly session: { readonly id: string }
    readonly options: Record<string, unknown>
    readonly inbox: Record<string, unknown>
  }
  const deps: SubmissionControllerDeps<AgentLike> = {
    app: () => composer,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => undefined,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
    },
    scope: {
      captureLive: () => scopeAuthority.captureLive(),
      isCurrent: (scope) => scopeAuthority.isCurrent(scope),
      requireLive: () => {
        const live = scopeAuthority.captureLive()
        if (live === undefined) throw new Error('fixture: the owner is not live')
        return live
      },
    },
    session: {
      // The sessionless contract: `/deliverables` must never create a Session.
      ensureSession: async () => { sessionsCreated.push('created') },
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: command as never,
    commandPlane: { available: () => false, execute: async () => undefined, findHandler: () => undefined },
    backendKind: 'direct',
    backend: {
      hostFile: { canonicalizeMentions: async (_scope: unknown, text: string) => text } as never,
      pendingInputReader: { snapshot: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed', value: undefined }) } as never,
      hostCommand: { execute: async () => ({ kind: 'committed', matched: false }) } as never,
    },
    drafts: { images: draftImages, files: draftFiles },
    status: { sessionCwd: () => '/ws' },
    surface: { refreshPendingInput: () => {} },
    history: { persist: () => {}, persistAfterSession: async (resolveSession, persist) => { persist(await resolveSession()) } },
    viewer: { isViewing: () => false },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    artifacts: { start: () => {} },
    shell: { run: (text: string) => { modelPrompts.push(`shell:${text}`) }, interrupt: () => {} },
    supportsLocalShellCards: true,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined as never, llm: () => undefined as never },
    tuiSettings: undefined,
    captureMatches: (subject) => core.isSubjectCurrent(subject as never),
    ownerWasReplaced: () => false,
    direct: { withPromptAdmission: async (_agent, _hasImages, task) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
  }
  const controller = createSubmissionController<AgentLike>(deps)

  app = new TuiApp(vt, {
    onSubmit: (text, request, scopeToken) => { controller.submit(text, request, scopeToken) },
    onExit: () => {},
  }, {
    deliveredFiles: {
      snapshot: () => snap,
      isCurrent: () => true,
    },
  })
  app.start()
  startedApps.add(app)
  // The REAL registrar registers `/deliverables` into the registry the
  // controller consults (its LIVE claim source).
  const classifier = createArtifactsCommands({
    runner: { app, deliveredFilesSnapshot: () => snap } as never,
    app,
    composer: () => app,
    registerOne: (definition) => { clientCommands.register(definition); return () => {} },
    registerTuiCommand: (spec) => {
      clientCommands.register({
        name: spec.name,
        description: spec.description,
        ...(spec.input === undefined ? {} : { input: spec.input }),
        handler: spec.handler,
      })
    },
    detach: () => {},
    notifyOutcome: () => {},
  })
  classifier.registerDeliverables()

  // Type the line through the REAL editor + submit gesture.
  vt.sendInput('/deliverables')
  vt.sendInput('\r')
  const view = await viewport(vt)
  assert.ok(view.includes('Delivered files · Turn 6'), `the controller route mounted the panel:\n${view}`)
  assert.deepEqual(sessionsCreated, [], 'a sessionless local command never creates a Session')
  assert.deepEqual(modelPrompts, [], 'the line never reaches the model sink')
  assert.equal(notices.length, 0, 'the local route reported no refusal')
  // POSITIVE CONTROL: this fixture's model path IS reachable, so the empty
  // `modelPrompts` above is a real negative, not a dead sink.
  vt.sendInput('\x1b')
  await viewport(vt)
  vt.sendInput('a plain prompt')
  vt.sendInput('\r')
  await viewport(vt)
  assert.ok(sessionsCreated.length > 0 || modelPrompts.length > 0,
    'the same fixture does deliver an ordinary prompt through the session path')
})

test('the overlay footer buttons run through the real AltScreen pointer path', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([
    { turn: 9, files: [{ path: '/ws/report.md', description: 'Final report' }] },
    { turn: 4, files: ['/ws/old.md'] },
  ])
  const copied: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (_label, task, runOptions) => {
      void Promise.resolve()
        .then(() => task())
        .then(
          result => runOptions.onResult?.(result),
          error => runOptions.onError?.(error),
        )
    },
  }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
    copySelection: async (text) => { copied.push(text); return true },
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.openDeliveredFiles(snap)
  await viewport(vt)

  const clickOn = async (label: string): Promise<void> => {
    const view = await viewport(vt)
    const rows = view.split('\n')
    const row = rows.findLastIndex(line => line.includes(label))
    assert.ok(row >= 0, `${label} is painted:\n${view}`)
    const column = rows[row]!.indexOf(label) + 2
    clickCell(vt, column, row)
    await viewport(vt)
  }

  // [Filter] enters the real filter seat; the painted list really filters.
  await clickOn('[Filter]')
  assert.ok((await viewport(vt)).includes('Filter: '), 'the Filter button enters the filter seat')
  vt.sendInput('rep')
  vt.sendInput('\r')
  assert.ok((await viewport(vt)).includes('report.md'), 'the committed filter keeps the match')

  // [Turns] opens the Turns page; a painted Turn row opens THAT Turn.
  await clickOn('[Turns]')
  assert.ok((await viewport(vt)).includes('Delivered files · 2 Turns'))
  const turnsView = await viewport(vt)
  const turnRow = turnsView.split('\n').findIndex(line => line.includes('Turn 4'))
  assert.ok(turnRow >= 0, turnsView)
  clickCell(vt, turnsView.split('\n')[turnRow]!.indexOf('Turn 4'), turnRow)
  assert.ok((await viewport(vt)).includes('Delivered files · Turn 4'), 'the clicked Turn is the page subject')
  assert.ok((await viewport(vt)).includes('old.md'))

  // Details [Copy path] uses the RAW path and shows the settled outcome; [Back]
  // stays clickable beside the notice.
  vt.sendInput('\r')
  assert.ok((await viewport(vt)).includes('old.md · Details'))
  await clickOn('[Copy path]')
  assert.deepEqual(copied, ['/ws/old.md'], 'the button copies the raw declared path')
  const copiedView = await viewport(vt)
  assert.ok(copiedView.includes('Path copied'), `the real clipboard settlement is painted:\n${copiedView}`)
  await clickOn('[Back]')
  assert.ok((await viewport(vt)).includes('Delivered files · Turn 4'), 'Back returns to the Files page')

  // [Close] really releases the ONE lease.
  await clickOn('[Close]')
  assert.ok(!(await viewport(vt)).includes('Delivered files · Turn 4'), 'the overlay is gone')
})

test('close -> reopen mounts ONE fresh lease and the background transcript stays inert', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 6, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setTranscript([deliveredAssistant(6, 'answer body', [{ path: '/ws/a.md' }])], new Map())
  app.setFullscreen(true)
  const tail = await viewport(vt)
  const tailRow = tail.split('\n').findIndex(line => line.includes('a.md') && line.includes('Details'))
  assert.ok(tailRow >= 0, `fixture: the tail verb is painted:\n${tail}`)

  app.openDeliveredFiles(snap)
  await viewport(vt)
  // A background transcript click behind the capturing overlay opens NOTHING.
  const tailColumn = tail.split('\n')[tailRow]!.lastIndexOf('Details') + 2
  clickCell(vt, tailColumn, tailRow)
  assert.equal((await viewport(vt)).split('\n').filter(line => line.includes('Delivered files · Turn 6')).length, 1,
    'the background click never stacks a second overlay')

  // Close releases the lease; a reopen paints exactly one fresh panel.
  app.closeDeliveredFiles()
  assert.ok(!(await viewport(vt)).includes('Delivered files · Turn 6'), 'close releases the overlay')
  app.openDeliveredFiles(snap)
  const reopened = await viewport(vt)
  assert.equal(reopened.split('\n').filter(line => line.includes('Delivered files · Turn 6')).length, 1,
    `one lease after reopen:\n${reopened}`)
})

test('the ONE overlay paints the frozen percentage geometry at every matrix size', async () => {
  const snap = snapshot([{ turn: 1, files: ['/ws/a.md'] }])
  const cases: readonly [number, number][] = [[44, 20], [72, 24], [80, 10], [80, 24], [120, 40], [160, 50], [200, 50]]
  for (const [columns, rows] of cases) {
    const vt = new VirtualTerminal(columns, rows)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      displayState: { preset: 'full' },
      deliveredFiles: capability(snap),
    })
    app.start()
    startedApps.add(app)
    app.setFullscreen(true)
    app.openDeliveredFiles(snap)
    const lines = (await viewport(vt)).split('\n')
    const top = lines.findIndex(line => line.includes('╭'))
    const bottom = lines.findIndex((line, index) => index > top && line.includes('╰'))
    assert.ok(top >= 0 && bottom > top, `${columns}x${rows}: the frame is painted:\n${lines.join('\n')}`)
    const expected = deliveredFilesOverlayGeometry(columns, rows)
    const left = lines[top]!.indexOf('╭')
    const right = lines[top]!.lastIndexOf('╮')
    assert.equal(right - left + 1, expected.width, `${columns}x${rows}: outer width`)
    assert.equal(bottom - top + 1, expected.maxHeight, `${columns}x${rows}: outer height cap`)
    assert.equal(left, Math.floor((columns - expected.width) / 2),
      `${columns}x${rows}: centered with the default anchor`)
    // The HOST bounds are the visible frame's bounds, never a wider canvas
    // that would overwrite the transcript beside the frame.
    const bounds = (app as unknown as {
      deliveredFilesOverlay: { getBounds(): { width: number; height: number } | undefined }
    }).deliveredFilesOverlay.getBounds()
    assert.equal(bounds?.width, expected.width, `${columns}x${rows}: host bounds width`)
    assert.equal(bounds?.height, expected.maxHeight, `${columns}x${rows}: host bounds height`)
    app.dispose()
    startedApps.delete(app)
  }

  // The SAME frame survives a page switch, and a real terminal resize
  // re-resolves the geometry from the same authority.
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  // A LONG answer body fills the rows the overlay covers, so leftover text at
  // the frame's left/right proves the host projection did not blank a wider
  // canvas over the transcript.
  app.setTranscript([{
    kind: 'assistant',
    turn: 1,
    text: 'BACKGROUND_MARKER '.repeat(400),
    deliverables: [{ path: '/ws/a.md' }],
  }], new Map())
  app.setFullscreen(true)
  app.openDeliveredFiles(snap)
  const frameOf = async (): Promise<{ width: number; maxHeight: number; left: number; lines: string[] }> => {
    // The resize/rebind batcher runs as a microtask before the throttled frame
    // is written, so observe the frame only after it settles.
    for (let step = 0; step < 6; step += 1) await Promise.resolve()
    const lines = (await viewport(vt)).split('\n')
    const top = lines.findIndex(line => line.includes('╭'))
    const bottom = lines.findIndex((line, index) => index > top && line.includes('╰'))
    assert.ok(top >= 0 && bottom > top, lines.join('\n'))
    const left = lines[top]!.indexOf('╭')
    const right = lines[top]!.lastIndexOf('╮')
    return {
      width: right - left + 1,
      maxHeight: bottom - top + 1,
      left,
      lines,
    }
  }
  const hostBounds = () => (app as unknown as {
    deliveredFilesOverlay: { getBounds(): { width: number; height: number } | undefined }
  }).deliveredFilesOverlay.getBounds()
  const assertBackgroundSurvives = async (): Promise<void> => {
    const frame = await frameOf()
    const topLine = frame.lines.find(line => line.includes('╭'))!
    const leftText = topLine.slice(0, frame.left).trim()
    const rightText = topLine.slice(frame.left + frame.width).trim()
    assert.ok(leftText.length > 0, `the transcript beside the frame survives:\n${frame.lines.join('\n')}`)
    assert.ok(rightText.length > 0, `the transcript right of the frame survives:\n${frame.lines.join('\n')}`)
  }
  const initial = await frameOf()
  assert.deepEqual({ width: initial.width, maxHeight: initial.maxHeight, left: initial.left },
    { ...deliveredFilesOverlayGeometry(120, 40), left: 12 })
  assert.equal(hostBounds()?.width, 96, 'host bounds match the 96-column frame')
  await assertBackgroundSurvives()
  vt.sendInput('\r')
  assert.deepEqual((await frameOf()).width, 96, 'Details keeps the Files frame')
  vt.sendInput('\x1b')
  vt.resize(160, 50)
  const resized = await frameOf()
  assert.deepEqual({ width: resized.width, maxHeight: resized.maxHeight }, deliveredFilesOverlayGeometry(160, 50),
    'a resize re-resolves the SAME authority')
  const resizedBounds = deliveredFilesOverlayGeometry(160, 50)
  assert.equal(hostBounds()?.width, resizedBounds.width, 'the rebound host width is the live frame width')
  assert.equal(hostBounds()?.height, resizedBounds.maxHeight, 'the rebound host height is the live frame height')
  await assertBackgroundSurvives()
  // The rebound projection kept the SAME panel and its keyboard owner.
  vt.sendInput('T')
  assert.ok((await viewport(vt)).includes('Delivered files · 1 Turns'),
    `the panel state and keyboard survive the resize rebind:\n${await viewport(vt)}`)
})

test('a real SGR press on a Turns row cannot retarget across a keyboard scroll', async () => {
  const turns = Array.from({ length: 30 }, (_, index) => ({ turn: 30 - index, files: [`/ws/f-${index + 1}.md`] }))
  const snap = snapshot(turns)
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.openDeliveredFiles(snap)
  await viewport(vt)
  vt.sendInput('T')
  const turnsView = await viewport(vt)
  assert.ok(turnsView.includes('Delivered files · 30 Turns'), turnsView)
  const rows = turnsView.split('\n')
  const pressedRow = rows.findIndex(line => line.includes('> Turn'))
  assert.ok(pressedRow >= 0, turnsView)
  const column = rows[pressedRow]!.indexOf('Turn') + 2
  // PRESS, hold, scroll the list with the keyboard until that CELL paints a
  // different Turn, then release: the click must not open the new Turn.
  vt.sendInput(`\x1b[<0;${column + 1};${pressedRow + 1}M`)
  for (let step = 0; step < 25; step += 1) vt.sendInput('\x1b[B')
  await viewport(vt)
  vt.sendInput(`\x1b[<0;${column + 1};${pressedRow + 1}m`)
  const after = await viewport(vt)
  assert.ok(after.includes('Delivered files · 30 Turns'),
    `the stale release must not open a Turn:\n${after}`)
  // Positive control: the panel/keyboard still works after the rejected click.
  vt.sendInput('\r')
  const opened = await viewport(vt)
  assert.ok(opened.includes('Delivered files · Turn'), `Enter still opens the current Turn:\n${opened}`)
})

test('a real SGR hold on Details [Back] cannot retarget to Files [Close]', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 6, files: ['/ws/report.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.openDeliveredFiles(snap)
  await viewport(vt)
  vt.sendInput('\r')
  const details = await viewport(vt)
  assert.ok(details.includes('report.md · Details'), details)
  const rows = details.split('\n')
  const footerRow = rows.findLastIndex(line => line.includes('[Back]') && line.includes('[Copy path]'))
  assert.ok(footerRow >= 0, details)
  const column = rows[footerRow]!.indexOf('[Back]') + 2
  vt.sendInput(`\x1b[<0;${column + 1};${footerRow + 1}M`)
  // Esc is the same Back transition; the Files [Close] now occupies the same
  // right-aligned cells under the held pointer.
  vt.sendInput('\x1b')
  const files = await viewport(vt)
  assert.ok(files.includes('Delivered files · Turn 6'), files)
  vt.sendInput(`\x1b[<0;${column + 1};${footerRow + 1}m`)
  const after = await viewport(vt)
  assert.ok(after.includes('Delivered files · Turn 6'),
    `the held Details Back must not run Files Close:\n${after}`)
})

test('a resize rebind never steals a newer callback focus', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 1, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  let armed = false
  let callbacks = 0
  let newer: ReturnType<typeof app.showAdvancedInteractiveOverlay> | undefined
  const plugin = {
    render: () => ({ kind: 'text' as const, spans: [{ text: 'PLUGIN UNDER' }] }),
    handleInput: () => true,
    dispose: () => {},
    onFocus: () => {
      if (!armed) return
      callbacks += 1
      newer ??= app.showAdvancedInteractiveOverlay({
        render: () => ({ kind: 'text' as const, spans: [{ text: 'NEWER HUD' }] }),
        handleInput: () => true,
        dispose: () => {},
      }, { nonCapturing: true })
      newer.focus()
    },
  }
  const pluginLease = app.showAdvancedInteractiveOverlay(plugin as never)
  await viewport(vt)
  app.openDeliveredFiles(snap)
  await viewport(vt)
  armed = true
  vt.resize(160, 50)
  const view = await viewport(vt)
  assert.equal(callbacks, 0, 'the resize must not focus the suppressed plugin under the panel')
  assert.ok(!view.includes('NEWER HUD'), `no newer overlay may be mounted by a spurious focus:\n${view}`)
  const delivered = (app as unknown as { deliveredFilesOverlay: { isFocused(): boolean } }).deliveredFilesOverlay
  assert.equal(delivered.isFocused(), true, 'the delivered panel keeps its focus after the rebind')
  pluginLease.close()
  newer?.close()
})

test('a covered Delivered files overlay rebinds to live geometry when the cover closes', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 1, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.openDeliveredFiles(snap)
  await viewport(vt)
  const cover = app.showAdvancedInteractiveOverlay({
    render: () => ({ kind: 'text' as const, spans: [{ text: 'TOP COVER' }] }),
    handleInput: () => true,
    dispose: () => {},
  })
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('TOP COVER'), 'fixture: the capturing cover is mounted')
  vt.resize(160, 50)
  await viewport(vt)
  cover.close()
  const view = await viewport(vt)
  assert.ok(!view.includes('TOP COVER'), 'the cover is gone')
  const delivered = (app as unknown as {
    deliveredFilesOverlay: {
      getBounds(): { width: number; height: number } | undefined
      isFocused(): boolean
    }
  }).deliveredFilesOverlay
  const expected = deliveredFilesOverlayGeometry(160, 50)
  assert.equal(delivered.getBounds()?.width, expected.width, 'the revealed frame width is the live formula')
  assert.equal(delivered.getBounds()?.height, expected.maxHeight, 'the revealed frame height is the live formula')
  assert.equal(delivered.isFocused(), true, 'the revealed panel owns the keyboard')
  const rows = view.split('\n')
  const turnsRow = rows.findLastIndex(line => line.includes('[Turns]'))
  assert.ok(turnsRow >= 0, `the revealed footer is painted:\n${view}`)
  const column = rows[turnsRow]!.indexOf('[Turns]') + 2
  clickCell(vt, column, turnsRow)
  assert.ok((await viewport(vt)).includes('Delivered files · 1 Turns'),
    'the revealed footer button is still clickable at the live geometry')
})

test('a Settings workspace lease keeps the delivered overlay on the stopped return screen', async () => {
  const vt = new VirtualTerminal(120, 40)
  const snap = snapshot([{ turn: 1, files: ['/ws/a.md'] }])
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'full' },
    deliveredFiles: capability(snap),
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.openDeliveredFiles(snap)
  assert.ok((await viewport(vt)).includes('Delivered files · Turn 1'), 'fixture: the overlay is open')

  const settings = app.openSettingsWorkspace(
    { readSnapshot: () => ({ configReadiness: 'ready', capturedAt: Date.now(), rows: [] }) },
    { aboutVersionFacts: { tui: 'test', dsh: 'test' } },
  )
  const workspace = await viewport(vt)
  assert.ok(!workspace.includes('Delivered files · Turn 1'),
    `the delivered overlay must not intrude on the temporary workspace screen:\n${workspace}`)

  vt.resize(160, 50)
  const resizedWorkspace = await viewport(vt)
  assert.ok(!resizedWorkspace.includes('Delivered files · Turn 1'),
    `a resize must not move the overlay onto the workspace screen:\n${resizedWorkspace}`)

  settings.close()
  const restored = await viewport(vt)
  assert.ok(restored.includes('Delivered files · Turn 1'),
    `the overlay returns with the restored screen:\n${restored}`)
  const delivered = (app as unknown as {
    deliveredFilesOverlay: {
      getBounds(): { width: number; height: number } | undefined
      isFocused(): boolean
    }
  }).deliveredFilesOverlay
  const expected = deliveredFilesOverlayGeometry(160, 50)
  assert.equal(delivered.getBounds()?.width, expected.width, 'the returned overlay has the live width')
  assert.equal(delivered.getBounds()?.height, expected.maxHeight, 'the returned overlay has the live height')
  assert.equal(delivered.isFocused(), true, 'the returned overlay owns the keyboard again')
  const rows = restored.split('\n')
  const turnsRow = rows.findLastIndex(line => line.includes('[Turns]'))
  assert.ok(turnsRow >= 0, `the restored footer is painted:\n${restored}`)
  clickCell(vt, rows[turnsRow]!.indexOf('[Turns]') + 2, turnsRow)
  assert.ok((await viewport(vt)).includes('Delivered files · 1 Turns'),
    'the restored footer button works at the live geometry')
})
