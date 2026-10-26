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
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { DeliveredFilesCapability, DeliveredFilesSnapshot } from '../../src/domain/deliverables/catalog.ts'
import type { TranscriptMessage } from '../../src/transcript.ts'
import { createArtifactsCommands } from '../../src/tui/commands/artifacts.ts'
import { TuiApp } from '../../src/tui-app.ts'
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
  readonly result: () => ReturnType<typeof runHandler>
  readonly runHandler: (rawInput: string) => unknown
  readonly invocations: CommandInvocation[]
} {
  const invocations: CommandInvocation[] = []
  const runHandler = (rawInput: string): unknown => {
    const definitions: CommandDefinition[] = []
    const commands = createArtifactsCommands({
      runner: {
        app,
        deliveredFilesSnapshot: readSnapshot,
      } as unknown as Parameters<typeof createArtifactsCommands>[0]['runner'],
      app,
      composer: () => app,
      registerOne: () => {},
      registerTuiCommand: (definition) => { definitions.push(definition as CommandDefinition) },
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
  return { result: () => runHandler(''), runHandler, invocations }
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
  assert.ok(view.includes('↑↓ Select · Enter Details'), `the real key path is advertised:\n${view}`)
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
