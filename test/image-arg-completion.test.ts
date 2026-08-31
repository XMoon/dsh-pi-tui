/**
 * Headless tests for the REAL /image argument-completion wiring: the
 * registerTuiCommands → installCompletions → MentionProvider chain must end
 * with a working completion menu down in the editor (the natural-typing and
 * Tab flows), exactly like the @ mention menu. The unit tests in
 * mentions.test.ts cover suggestPathArgument in isolation; this file drives
 * the installed completion surface through the real command registration so
 * a broken mapping (e.g. getArgumentCompletions dropped on the way into
 * setCommandCompletions) cannot regress silently.
 * @module @xmoon76/dsh-pi-tui/image-arg-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

/** A fake commands service whose list() returns the registered defs (the
 * real dsh service answers commands.list(undefined) with the global layer —
 * the merge the runner's installCompletions consumes). */
function fakeCommands(): { commands: { register: (def: { name: string; handler?: unknown; description?: string; input?: { hint?: string } }) => () => void; list: () => { name: string; description?: string; input?: { hint?: string } }[] } } {
  const defs: { name: string; handler?: unknown; description?: string; input?: { hint?: string } }[] = []
  const commands = {
    register: (def: { name: string; handler?: unknown; description?: string; input?: { hint?: string } }): (() => void) => {
      defs.push(def)
      return () => {}
    },
    list: () => [...defs],
  }
  return { commands }
}

/** A sessionless runner + a workspace with image-named fixtures; the TUI
 * commands are registered through the real entry (registerTuiCommands). */
function setup(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const ctx = new Context()
  const { commands } = fakeCommands()
  ctx.provide('commands', commands as never)
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-arg-'))
  mkdirSync(join(root, 'subdir'))
  writeFileSync(join(root, 'shot.png'), 'x')
  writeFileSync(join(root, 'notes.txt'), 'x')
  writeFileSync(join(root, 'subdir', 'deep.png'), 'x')
  const store = new DraftImageStore()
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
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
      search: async () => [],
      titles: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort(() => undefined),
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: root,
    sessionCwd: () => root,
    imageStore: store,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: (text) => app.insertIntoEditor(text),
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 1 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommands(runner)
  return { vt, app }
}

/** Poll the viewport until the dropdown row appears (asserts on failure). */
async function waitForDropdownRow(vt: VirtualTerminal, needle: string, label: string): Promise<string> {
  const deadline = Date.now() + 2000
  for (;;) {
    const view = vt.getViewport().join('\n')
    if (view.includes(needle)) return view
    if (Date.now() > deadline) {
      assert.fail(`${label}: dropdown row ${JSON.stringify(needle)} never appeared:\n${view}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('the installed /image completion answers natural typing with a menu', async () => {
  const { vt, app } = setup()
  await vt.waitForRender()
  vt.sendInput('/image sh')
  const view = await waitForDropdownRow(vt, 'shot.png', 'natural typing')
  // The menu row renders exactly like the @ mention menu: item + absolute
  // path description.
  assert.ok(view.includes('shot.png'), 'the candidate row is visible')
  assert.ok(!app.getDraft().includes('shot.png'), 'typing alone must not apply anything')
  app.stop()
})

test('Tab on an empty /image argument lists the workspace through the real chain', async () => {
  const { vt, app } = setup()
  await vt.waitForRender()
  vt.sendInput('/image ')
  await vt.waitForRender()
  vt.sendInput('\t')
  const view = await waitForDropdownRow(vt, 'subdir/', 'Tab on an empty argument')
  assert.ok(view.includes('notes.txt'), 'files are listed alongside directories')
  app.stop()
})
