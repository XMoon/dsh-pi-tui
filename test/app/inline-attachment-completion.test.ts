/**
 * Image UX PR5 end-to-end: a REAL `TuiApp` + the REAL production command
 * registration (`registerTuiCommands` → `MentionProvider` → the shared
 * artifact intake → `DraftImageStore`/`DraftFileStore`) driven by real key
 * input.
 *
 * What this file exists to prove, and nothing it cannot:
 *  - typing `/image` mid-body opens the inline action rows, and accepting one
 *    continues into the existing Client-local path completion;
 *  - accepting a FILE stages the real bytes and replaces EXACTLY the inline
 *    fragment with the canonical placeholder in place — never submitting,
 *    queueing or steering;
 *  - a DIRECTORY only continues the completion (no store entry, no token);
 *  - one Undo restores the editable inline fragment;
 *  - a draft edited while the read is in flight is never overwritten;
 *  - the first line's leading command seat and the ordinary `@`/skill rows keep
 *    their behavior.
 *
 * The unit grammar is covered by inline-attachment-grammar.test.ts; the intake
 * itself (limits/errors/staleness) by image-command.test.ts.
 * @module @xmoon76/dsh-pi-tui/inline-attachment-completion.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** A 33-byte PNG (magic + IHDR) — enough for the real metadata parser. */
function pngBytes(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const set32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
  set32(16, width)
  set32(20, height)
  return bytes
}

function fakeCommands(): { commands: { register: (def: { name: string; handler?: unknown; description?: string; input?: { hint?: string } }) => () => void; list: () => { name: string; handler?: unknown; description?: string; input?: { hint?: string } }[] } } {
  const defs: { name: string; handler?: unknown; description?: string; input?: { hint?: string } }[] = []
  return {
    commands: {
      register: (def) => {
        defs.push(def)
        return () => {}
      },
      list: () => [...defs],
    },
  }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly imageStore: DraftImageStore
  readonly fileStore: DraftFileStore
  /** The absolute path of the fixture image (the `/`-prefixed-candidate case). */
  readonly absoluteImagePath: string
  /** Submissions the REAL app owner observed (Enter, accelerated, steer). */
  submissions(): number
}

/** A workspace with one image, one plain file and one directory. */
function fixture(life: TestLifecycle): { root: string; image: string; plain: string } {
  const root = life.tempDir('dsh-inline-attach-')
  mkdirSync(join(root, 'pics'))
  writeFileSync(join(root, 'shot.png'), pngBytes())
  writeFileSync(join(root, 'notes.txt'), 'plain notes')
  writeFileSync(join(root, 'pics', 'deep.png'), pngBytes(3, 2))
  return { root, image: join(root, 'shot.png'), plain: join(root, 'notes.txt') }
}

function setup(life: TestLifecycle, options: { attachFileStore?: boolean } = {}): Harness {
  const { root, image } = fixture(life)
  const vt = new VirtualTerminal(100, 24)
  let submissions = 0
  const app = new TuiApp(vt, {
    onSubmit: () => { submissions += 1 },
    onExit: () => {},
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  const imageStore = new DraftImageStore()
  const fileStore = new DraftFileStore()
  const ctx = new Context()
  const { commands } = fakeCommands()
  ctx.provide('commands', commands as never)
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    currentSessionId: undefined,
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
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
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
    cwd: root,
    sessionCwd: () => root,
    imageStore,
    fileStore: options.attachFileStore === false ? undefined : fileStore,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: (text) => app.insertIntoEditor(text),
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
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
    openTasksBrowser: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  return {
    vt,
    app,
    imageStore,
    fileStore,
    absoluteImagePath: image,
    submissions: () => submissions,
  }
}

/** Poll the viewport until `needle` is painted (asserts on failure). */
async function waitForViewport(vt: VirtualTerminal, needle: string, label: string): Promise<string> {
  const deadline = Date.now() + 3000
  for (;;) {
    const view = vt.getViewport().join('\n')
    if (view.includes(needle)) return view
    if (Date.now() > deadline) assert.fail(`${label}: ${JSON.stringify(needle)} never appeared:\n${view}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Poll until `predicate` holds (asserts on failure with the raw draft). */
async function waitForDraft(app: TuiApp, predicate: (draft: string) => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (predicate(app.seatTextForTest())) return
    if (Date.now() > deadline) assert.fail(`${label}: draft stayed ${JSON.stringify(app.seatTextForTest())}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Wait until the dropdown paints `needle` for the CURRENT draft (a request
 *  round trip may still be in flight right after typing). */
async function waitForCandidate(vt: VirtualTerminal, app: TuiApp, needle: string, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    const view = vt.getViewport().join('\n')
    if (app.isShowingAutocompleteForTest() && view.includes(needle)) return
    if (Date.now() > deadline) {
      assert.fail(`${label}: candidate ${JSON.stringify(needle)} never appeared for ${JSON.stringify(app.seatTextForTest())}:\n${view}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The dropdown rows the CURRENT frame paints (the `→ ` row is the default
 *  selection). The menu paints one row per line between the editor box and the
 *  footer, so the rows are read off the painted viewport. */
function dropdownRows(vt: VirtualTerminal): { selected: string | undefined; rows: string[] } {
  const rows: string[] = []
  let selected: string | undefined
  for (const line of vt.getViewport()) {
    const match = /^\s{2}(→ | {2})(\S.*?)\s*$/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''))
    if (match === null) continue
    const text = match[2]!
    rows.push(text)
    if (match[1]!.startsWith('→')) selected = text
  }
  return { selected, rows }
}

/** Wait until the dropdown's DEFAULT SELECTED row is `needle` (the ranking's
 *  top row — what a bare Enter/Tab accepts). */
async function waitForSelectedRow(vt: VirtualTerminal, app: TuiApp, needle: string, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    const { selected, rows } = dropdownRows(vt)
    // The FILTERED list is what matters: while the unfiltered cwd listing is
    // still painted, its own default selection may coincidentally be the same
    // row, and the request for the typed filter is still in flight.
    const unrelated = rows.filter(row => !row.startsWith(needle.replace(/\/$/, '')))
    if (app.isShowingAutocompleteForTest() && selected !== undefined && selected.includes(needle) && unrelated.length === 0) return
    if (Date.now() > deadline) {
      assert.fail(`${label}: expected the selected row to be ${JSON.stringify(needle)} for ${JSON.stringify(app.seatTextForTest())}, saw ${JSON.stringify(dropdownRows(vt))}:\n${vt.getViewport().join('\n')}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Wait until exactly ONE row is offered and it is `needle` — then the
 *  default selection is unambiguous and a single Enter/Tab accepts it. */
async function waitForOnlyRow(vt: VirtualTerminal, app: TuiApp, needle: string, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    const { rows } = dropdownRows(vt)
    if (app.isShowingAutocompleteForTest() && rows.length === 1 && rows[0]!.includes(needle)) return
    if (Date.now() > deadline) {
      assert.fail(`${label}: expected exactly ${JSON.stringify(needle)} for ${JSON.stringify(app.seatTextForTest())}, saw ${JSON.stringify(rows)}:\n${vt.getViewport().join('\n')}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Send one printable character per input event, like a real terminal. */
function type(vt: VirtualTerminal, text: string): void {
  for (const character of text) vt.sendInput(character)
}

test('mid-body /image: action row → path rows → FILE accept inserts the token in place', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'please look at ')
  await vt.waitForRender()
  type(vt, '/ima')
  // The inline dropdown offers the FIXED attachment actions.
  await waitForViewport(vt, 'Insert local image', 'the attachment action row')
  assert.equal(app.isShowingAutocompleteForTest(), true, 'the inline dropdown is open')

  // Accept the action: the draft becomes `please look at /image ` and the
  // EXISTING Client-local path candidates open at the argument seat.
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft === 'please look at /image ', 'the action inserts the token in place')
  const pathView = await waitForViewport(vt, 'shot.png', 'the path candidates after the action')
  assert.ok(pathView.includes('notes.txt'), 'the cwd listing shows files')
  assert.equal(h.submissions(), 0, 'accepting the ACTION never submits the draft')
  assert.equal(h.imageStore.size(), 0, 'accepting the action reads nothing')

  // Accept the FILE explicitly: the rows are the cwd's children
  // (`pics/`, `notes.txt`, `shot.png`), so move the selection to shot.png.
  await waitForDraft(app, draft => draft === 'please look at /image ', 'the argument seat is stable')
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')

  // The canonical placeholder replaces exactly the inline fragment.
  await waitForDraft(app, draft => draft.includes('[image #1 (1×1)]'), 'the placeholder lands in place')
  const draft = app.seatTextForTest()
  assert.match(draft, /^please look at \[image #1 \(1×1\)\]$/,
    `the accepted fragment became the token and the prefix survived: ${JSON.stringify(draft)}`)
  assert.equal(h.imageStore.size(), 1, 'the real intake staged exactly one image')
  assert.equal(h.imageStore.values()[0]!.placeholder, '[image #1 (1×1)]')
  assert.equal(h.submissions(), 0, 'no confirm gesture submits, queues or steers the draft')
})

test('mid-body /attach: a generic FILE lands as its own token; the prose survives', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'see ')
  await vt.waitForRender()
  type(vt, '/att')
  await waitForViewport(vt, 'Attach local file or image', 'the attach action row')
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft === 'see /attach ', 'the attach action inserts its token')
  await waitForCandidate(vt, app, 'notes.txt', 'the attach path candidates')
  // Narrow to the plain file: the filtered list must be the ONE row, so the
  // default selection is the file (never the directory).
  type(vt, 'notes')
  await waitForDraft(app, draft => draft === 'see /attach notes', 'the filter lands in the draft')
  await waitForOnlyRow(vt, app, 'notes.txt', 'the single filtered candidate')
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft.includes('[file #1'), 'the file token lands in place')
  const draft = app.seatTextForTest()
  assert.match(draft, /^see \[file #1 \(11 B\)\]$/, `only the fragment changed: ${JSON.stringify(draft)}`)
  assert.equal(h.fileStore.values().length, 1, 'the generic file went into the FILE store')
  assert.equal(h.imageStore.size(), 0, 'a generic file never enters the image store')
  assert.equal(h.submissions(), 0, 'no confirm gesture submits')
})

test('a DIRECTORY only continues the path seat (no store entry, no token)', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'look /image ')
  await vt.waitForRender()
  // An empty argument lists the cwd on an explicit Tab (the natural trigger
  // does not fire on a trailing separator).
  type(vt, 'pics')
  await waitForDraft(app, draft => draft === 'look /image pics', 'the filter lands in the draft')
  await waitForSelectedRow(vt, app, 'pics/', 'the directory row is the default selection')
  assert.equal(app.isShowingAutocompleteForTest(), true, 'the dropdown must still be open when Tab lands')
  vt.sendInput('\t')
  await vt.waitForRender()

  // The directory is applied and its CHILDREN open — the draft still holds the
  // command fragment, and nothing was staged.
  await waitForDraft(app, draft => draft.endsWith('/image pics/'), 'the directory continues the seat')
  await waitForViewport(vt, 'deep.png', 'the children after the directory accept')
  assert.equal(h.imageStore.size(), 0, 'a directory stages nothing')
  assert.equal(h.fileStore.values().length, 0, 'a directory never enters the file store')
  assert.equal(h.submissions(), 0, 'a directory accept never submits')
})

test("the FIRST line's leading /image keeps the legacy command seat", async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, '/ima')
  // The leading token is the command-NAME seat: the slash-command completion
  // answers it (the attachment actions are an INLINE seat only).
  const view = await waitForViewport(vt, 'image-only compatibility command', 'the command completion row')
  assert.ok(!view.includes('Insert local image'), 'the inline attachment actions must not claim line 0 leading')
  assert.equal(app.seatTextForTest(), '/ima', 'nothing applied by typing')
})

test('ordinary prose and paths open no attachment plane', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'see /usr/bin and weird/image /x')
  await vt.waitForRender()
  assert.equal(app.isShowingAutocompleteForTest(), false, 'neither a path segment nor a URL opens completion')
  assert.equal(h.imageStore.size(), 0)
  assert.equal(h.submissions(), 0)
})

test('one Undo restores the editable inline fragment (a REAL undoable edit)', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'why ')
  await vt.waitForRender()
  type(vt, '/image ')
  await vt.waitForRender()
  type(vt, 'shot')
  await waitForDraft(app, draft => draft === 'why /image shot', 'the filter lands in the draft')
  await waitForOnlyRow(vt, app, 'shot.png', 'the single filtered image candidate')
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft.includes('[image #1 (1×1)]'), 'the placeholder')
  assert.equal(app.seatTextForTest(), 'why [image #1 (1×1)]', 'the fragment became the token')
  assert.equal(h.imageStore.size(), 1)

  // ONE Undo returns the TEXT user wrote — the `/image <path>` fragment — and
  // the store keeps its lease while the editor's history can still restore it
  // (the existing DraftStore ownership decides retention; no second mechanism).
  vt.sendInput('\x1b[45;5u')
  await vt.waitForRender()
  // Fallback for terminals that deliver plain Ctrl+Z (`\x1a`) instead of CSI-u.
  if (app.seatTextForTest() === 'why [image #1 (1×1)]') vt.sendInput('\x1a')
  await waitForDraft(app, draft => draft !== 'why [image #1 (1×1)]', 'Undo changes the draft')
  assert.equal(app.seatTextForTest(), 'why /image shot.png',
    'one Undo restores the editable inline fragment exactly')
  assert.equal(h.submissions(), 0, 'Undo never submits')
})

test('a draft edited while the read is in flight is never overwritten', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'a /image ')
  await vt.waitForRender()
  type(vt, 'shot')
  await waitForDraft(app, draft => draft === 'a /image shot', 'the filter lands in the draft')
  await waitForOnlyRow(vt, app, 'shot.png', 'the single filtered image candidate')
  vt.sendInput('\r')
  // The accept is settled in a microtask; edit the draft IMMEDIATELY. The
  // placeholder write must refuse rather than overwrite the newer text.
  type(vt, 'X')
  await vt.waitForRender()
  const afterEdit = app.seatTextForTest()
  assert.ok(afterEdit.endsWith('X'), `the user's edit survives: ${JSON.stringify(afterEdit)}`)
  assert.equal(h.imageStore.size(), 0, 'a refused intake stages no bytes')
  assert.equal(h.submissions(), 0, 'never submits')
})

test('Escape closes the inline dropdown without reading any file', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'hi /image ')
  await vt.waitForRender()
  type(vt, 'sh')
  await waitForDraft(app, draft => draft === 'hi /image sh', 'the filter lands in the draft')
  await waitForViewport(vt, 'shot.png', 'the candidate before Escape')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.isShowingAutocompleteForTest(), false, 'Escape closes the dropdown')
  assert.equal(app.seatTextForTest(), 'hi /image sh', 'the text is untouched')
  assert.equal(h.imageStore.size(), 0, 'no file read, no token')
})

test('ENTER on the opened dropdown is accept-only (never submits the draft)', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, 'body /image ')
  await vt.waitForRender()
  type(vt, 'shot')
  await waitForDraft(app, draft => draft === 'body /image shot', 'the filter lands')
  await waitForOnlyRow(vt, app, 'shot.png', 'the single filtered image candidate')
  // A FILE acceptance is exactly the gesture whose `prefix` would otherwise be
  // `/`-prefixed (an absolute-path candidate); it must still be accept-only.
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft.includes('[image #1'), 'the placeholder lands')
  assert.equal(h.submissions(), 0, 'the file confirm gesture never submits, queues or steers')
})

test('an ABSOLUTE-path candidate is accept-only on ENTER too', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  const absolute = h.absoluteImagePath
  await vt.waitForRender()
  type(vt, 'abs /image ')
  await vt.waitForRender()
  type(vt, absolute)
  await waitForDraft(app, draft => draft === `abs /image ${absolute}`, 'the absolute path lands in the draft')
  await waitForOnlyRow(vt, app, absolute.split('/').pop()!, 'the absolute candidate')
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft.includes('[image #1'), 'the placeholder lands for an absolute path')
  assert.equal(h.submissions(), 0, 'an absolute-path confirm is accept-only (the / prefix trap)')
})

test('CJK body text around the fragment survives byte for byte', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  type(vt, '帮我分析这个报错，重点看看 ')
  type(vt, '/image ')
  await vt.waitForRender()
  type(vt, 'shot')
  await waitForDraft(app, draft => draft === '帮我分析这个报错，重点看看 /image shot', 'the CJK body with the filter')
  await waitForOnlyRow(vt, app, 'shot.png', 'the image candidate after CJK prose')
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft.includes('[image #1 (1×1)]'), 'the placeholder after CJK prose')
  assert.equal(app.seatTextForTest(), '帮我分析这个报错，重点看看 [image #1 (1×1)]',
    'the CJK prefix and the suffix survive; only the fragment changed')
  assert.equal(h.submissions(), 0)
})

test('a multi-line draft keeps every other line untouched (third line, leading command)', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  // Ctrl+J is the editor's newline (Enter SUBMITS — that is the policy this
  // feature must never change).
  type(vt, 'first line')
  vt.sendInput('\n')
  type(vt, 'second stays')
  vt.sendInput('\n')
  // The THIRD line's leading `/attach` is an INLINE seat (only the first
  // line's leading token is the legacy command).
  type(vt, '/attach ')
  await vt.waitForRender()
  type(vt, 'notes')
  await waitForDraft(app, draft => draft.endsWith('/attach notes'), 'the third-line filter')
  await waitForOnlyRow(vt, app, 'notes.txt', 'the file candidate on line 3')
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft.includes('[file #1'), 'the file token on line 3')
  assert.equal(app.seatTextForTest(), `first line\nsecond stays\n[file #1 (11 B)]`,
    'the earlier lines are byte-identical; only the third-line fragment changed')
  assert.equal(h.imageStore.size(), 0)
  assert.equal(h.fileStore.values().length, 1)
  assert.equal(h.submissions(), 0)
})

test('a large pasted block keeps its marker text and the fragment edits in place', async (t) => {
  const life = testLifecycle(t)
  const h = setup(life)
  const { vt, app } = h
  await vt.waitForRender()
  // A bracketed paste long enough for the fork's paste REGISTRY (>10 lines).
  const block = Array.from({ length: 12 }, (_, index) => `pasted line ${index + 1}`).join('\r\n')
  vt.sendInput(`\x1b[200~${block}\x1b[201~`)
  await vt.waitForRender()
  assert.ok(app.seatTextForTest().includes('[paste #'), 'the large paste stays a registry marker in the raw draft')
  type(vt, ' append /image ')
  await vt.waitForRender()
  type(vt, 'shot')
  await waitForDraft(app, draft => draft.endsWith('/image shot'), 'the filter after a pasted block')
  await waitForOnlyRow(vt, app, 'shot.png', 'the candidate after a pasted block')
  vt.sendInput('\r')
  await waitForDraft(app, draft => draft.includes('[image #1 (1×1)]'), 'the placeholder after a pasted block')
  const draft = app.seatTextForTest()
  assert.ok(draft.includes('[paste #'), 'the paste marker text is preserved (the raw draft was sliced, never rebuilt)')
  assert.ok(draft.endsWith('append [image #1 (1×1)]'), `the fragment was replaced in place: ${JSON.stringify(draft)}`)
  assert.equal(h.submissions(), 0)
})
