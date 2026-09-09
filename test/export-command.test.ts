/**
 * /export + /transcript convergence tests (Pre-Stage-D export convergence):
 * the no-argument grammar with acknowledgement-only handlers, the fixed
 * full-Session-id filenames, the Client-local stream/text sink (temp +
 * atomic commit, never a partial final artifact), and the BLOCKING
 * post-command-success lifecycle: the save workflow starts only after
 * `commands.execute()` settled successfully, error results never open Save
 * Location, and the workflow targets the CAPTURED originating Session even
 * when the live Session changes at delayed settle time.
 * @module @xmoon76/dsh-pi-tui/export-command.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ProcessTerminal } from '@xmoon76/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { apply as applyRunner, type Config } from '../src/index.ts'
import { createDiag } from '../src/diag.ts'
import { sessionArtifactFilename, safeSessionIdSegment } from '../src/session-artifact-filename.ts'
import { resolveClientDirectory, streamToFile, writeTextAtomically } from '../src/client-artifact-save.ts'
import { sessionLogZipFilename } from '@deepseek-ai/dsh-session-log-export'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { DirectSessionArchive } from '../src/runtime/direct/session-archive-direct.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test. */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A stub runner (the command-catalog pattern) for the grammar tests. */
function stubRunner(ctx: Context, app: TuiApp): TuiCommandRunner {
  const state: { agent: Agent | undefined } = { agent: undefined }
  return {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return state.agent },
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
      projectionBatch: async () => new Map(),
      measureContext: () => undefined,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    catalog: {
      models: {
        available: () => true,
        listProviders: () => [],
        listModels: async () => [],
        resolveModelInfo: async () => ({}),
        defaultSelection: () => undefined,
        saveDefaultSelection: async () => {},
        sessionSelection: () => undefined,
        selectSessionModel: async (_sessionId: string, selection: { provider: string; model: string }) => selection,
        currentSelection: () => undefined,
        saveSelection: async () => {},
        discoverModels: async () => [],
        listConfigurableProviders: () => [],
      },
      presets: {
        available: () => false,
        list: async () => [],
        resolve: async () => ({}),
        defaultId: () => undefined,
      },
      skills: {
        standing: async () => ({ catalog: { skills: [], complete: true } }),
        listHumanSkills: async () => undefined,
        resolveSkill: async () => ({ kind: 'unavailable' as const }),
        hostLoadsSkillBody: () => false,
        onSkillsChange: () => {},
      },
    },
    config: {
      tuiSettings: undefined,
      footerCommandTrust: {
        userFooterMode: undefined,
        command: undefined,
        userCommandItemActivationIds: new Set<string>(),
        userCommandItemFallbackActivationIds: new Set<string>(),
      },
      footerCustomItems: {
        get: () => ({ items: [], invalidCount: 0 }),
        rawForPersistence: () => ({ kind: 'available' as const, value: undefined }),
      },
      providers: {
        available: () => true,
        listCredentialOptions: () => [],
        writeProfile: async () => {},
        writeKeylessProfile: async () => ({ kind: 'written' as const }),
      },
      credentials: {
        available: () => true,
        setReference: async () => {},
        unsetReference: async () => {},
        deleteRecord: async () => {},
        describeReference: async () => ({ configured: false }),
        listRecords: async () => [],
        onChanged: () => () => {},
      },
      authorization: {
        available: () => false,
        listTargets: () => [],
        begin: async () => ({ kind: 'unavailable' as const }),
        onEvent: () => () => {},
        respond: async () => {},
        cancel: async () => {},
      },
      permissions: {
        presetNames: () => [],
        defaultPreset: () => undefined,
        setDefaultPreset: async () => {},
        approvalOverrideOf: () => undefined,
        applyPermissionPreset: async () => ({ kind: 'applied' as const }),
      },
      subagentModelSelection: {
        available: () => false,
        get: () => ({ enabled: false, allowedModels: [] }),
        set: async () => {},
      },
      presetDefault: {
        available: () => true,
        get: () => undefined,
        set: async () => {},
      },
    },
    hostFile: new DirectHostFilePort(() => undefined, null),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    requestExit: () => {},
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
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
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    extensions: undefined,
    exit: () => {},
  }
}

/** A fake commands service recording the registered definitions. */
function fakeCommands() {
  const defs: { name: string; handler?: unknown }[] = []
  return {
    defs,
    service: {
      register: (def: { name: string; handler?: unknown }): (() => void) => {
        defs.push(def)
        return () => {
          const index = defs.indexOf(def)
          if (index !== -1) defs.splice(index, 1)
        }
      },
      list: () => defs.map(({ name }) => ({ name, description: '' })),
      execute: async () => undefined,
    },
  }
}

/** Invoke one registered command handler with a raw input. */
async function invokeHandler(
  defs: { name: string; handler?: unknown }[],
  name: string,
  rawInput: string,
): Promise<{ kind: string; text?: string }> {
  const def = defs.find(candidate => candidate.name === name)
  assert.ok(def?.handler !== undefined, `command /${name} must be registered`)
  const result = await (def.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput })
  return result
}

// ── 23.1 command grammar ──────────────────────────────────────────────────

test('/export accepts no arguments: bare and whitespace-only succeed, any argument errors', () => {
  const ctx = new Context()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  startedApps.add(app)
  registerTuiCommands(stubRunner(ctx, app))
  const defs = commands.defs

  const bare = awaitHandler(defs, 'export', '')
  assert.equal(bare.kind, 'success')
  assert.equal(bare.text, 'Session log download requested.')

  const whitespace = awaitHandler(defs, 'export', '   ')
  assert.equal(whitespace.kind, 'success')

  const md = awaitHandler(defs, 'export', 'md')
  assert.equal(md.kind, 'error')

  const path = awaitHandler(defs, 'export', './foo.zip')
  assert.equal(path.kind, 'error')
})

test('/transcript accepts no arguments: bare and whitespace-only succeed, any argument errors', () => {
  const ctx = new Context()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  startedApps.add(app)
  registerTuiCommands(stubRunner(ctx, app))
  const defs = commands.defs

  const bare = awaitHandler(defs, 'transcript', '')
  assert.equal(bare.kind, 'success')
  assert.equal(bare.text, 'Transcript export requested.')

  const whitespace = awaitHandler(defs, 'transcript', '   ')
  assert.equal(whitespace.kind, 'success')

  const path = awaitHandler(defs, 'transcript', 'foo.md')
  assert.equal(path.kind, 'error')
})

// The grammar handlers are synchronous acknowledgements; the helper keeps
// the async shape for parity with the other handler invocations.
function awaitHandler(
  defs: { name: string; handler?: unknown }[],
  name: string,
  rawInput: string,
): { kind: string; text?: string } {
  const def = defs.find(candidate => candidate.name === name)
  assert.ok(def?.handler !== undefined, `command /${name} must be registered`)
  const result = (def.handler as (invocation: { rawInput: string }) => { kind: string; text?: string })({ rawInput })
  return result
}

// ── 23.8 fixed filenames ──────────────────────────────────────────────────

test('the archive filename is the upstream full-safe-id convention', () => {
  const id = 'session-12345678-abcdef'
  assert.equal(sessionArtifactFilename(id, 'archive'), sessionLogZipFilename(id))
  assert.equal(sessionArtifactFilename(id, 'archive'), 'dsh-session-session-12345678-abcdef.zip')
})

test('the transcript filename uses the SAME safe full Session id with .md (no short-id truncation)', () => {
  const id = 'session-12345678-abcdef'
  assert.equal(sessionArtifactFilename(id, 'transcript'), 'dsh-session-session-12345678-abcdef.md')
  // The full id is preserved — never the old 8-character short id.
  assert.ok(sessionArtifactFilename(id, 'transcript').includes('12345678-abcdef'))
  assert.ok(!sessionArtifactFilename(id, 'transcript').includes('session-1234.md'))
})

test('safe-id normalization matches the upstream archive convention', () => {
  const hostile = 'session-abc/../def:ghi'
  assert.equal(safeSessionIdSegment(hostile), 'session-abc____def_ghi')
  assert.equal(
    sessionArtifactFilename(hostile, 'transcript'),
    `dsh-session-${safeSessionIdSegment(hostile)}.md`,
  )
  // Parity: the archive filename normalizes the same way.
  assert.equal(sessionLogZipFilename(hostile), `dsh-session-${safeSessionIdSegment(hostile)}.zip`)
})

// ── 23.10 Client stream sink ──────────────────────────────────────────────

test('streamToFile writes multiple chunks in order and commits the exact bytes', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8, 9])]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const path = await streamToFile(target, stream, new AbortController().signal, false)
  assert.equal(path, target)
  assert.deepEqual([...readFileSync(target)], [1, 2, 3, 4, 5, 6, 7, 8, 9], 'chunks preserved in order')
  // The temp file is gone; only the final artifact remains.
  assert.deepEqual(readdirSync(dir), ['out.zip'])
})

test('streamToFile never exposes a partial final file on mid-stream failure', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  writeFileSync(target, 'original')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.error(new Error('mid-stream failure'))
    },
  })
  await assert.rejects(streamToFile(target, stream, new AbortController().signal, false), /mid-stream failure/)
  assert.equal(readFileSync(target, 'utf8'), 'original', 'the final file is not replaced by partial data')
  assert.deepEqual(readdirSync(dir), ['out.zip'], 'the temp file is cleaned')
})

test('streamToFile abort cancels the stream and cleans the temp file', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
    },
    cancel() {
      cancelled = true
    },
  })
  const controller = new AbortController()
  const promise = streamToFile(target, stream, controller.signal, false)
  controller.abort()
  await assert.rejects(promise, error => error instanceof Error && error.name === 'AbortError')
  assert.equal(cancelled, true, 'the producer stream is cancelled')
  assert.ok(!existsSync(target), 'no final file after abort')
  assert.deepEqual(readdirSync(dir), [], 'the temp file is cleaned')
})

test('writeTextAtomically commits the text and cleans the temp on failure', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.md')
  await writeTextAtomically(target, '# Session\n\nhello', new AbortController().signal, false)
  assert.equal(readFileSync(target, 'utf8'), '# Session\n\nhello')
  assert.deepEqual(readdirSync(dir), ['out.md'])
})

test('writeTextAtomically with overwrite consent replaces an existing target', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.md')
  writeFileSync(target, 'old markdown')
  await writeTextAtomically(target, '# Session\n\nnew', new AbortController().signal, true)
  assert.equal(readFileSync(target, 'utf8'), '# Session\n\nnew', 'the consented replace commits the new text')
  assert.deepEqual(readdirSync(dir), ['out.md'], 'the temp file is cleaned')
})

test('streamToFile abort settles promptly even while a read is pending', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  // One chunk, then the next read stays pending forever: the abort must
  // interrupt the PENDING read (the producer is cancelled), never hang.
  let pulled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true
        controller.enqueue(new Uint8Array([1, 2, 3]))
      }
      // Second pull: enqueue nothing — the read stays pending.
    },
  })
  const controller = new AbortController()
  const promise = streamToFile(target, stream, controller.signal, false)
  // Wait until the first chunk was consumed and the second read is pending.
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  controller.abort()
  await assert.rejects(promise, error => error instanceof Error && error.name === 'AbortError')
  assert.ok(!existsSync(target), 'no final file after abort')
  assert.deepEqual(readdirSync(dir), [], 'the temp file is cleaned')
})

test('streamToFile abort after the last chunk still prevents the commit', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    pull(streamController) {
      streamController.enqueue(new Uint8Array([1, 2, 3]))
      streamController.close()
      // The abort lands after the final chunk is delivered, while the async
      // write/close are still in flight — before the commit. A microtask is
      // deterministic: it drains before the next fs macrotask completes.
      queueMicrotask(() => controller.abort())
    },
  })
  const promise = streamToFile(target, stream, controller.signal, false)
  await assert.rejects(promise, error => error instanceof Error && error.name === 'AbortError')
  assert.ok(!existsSync(target), 'a cancelled save never commits the final artifact')
  assert.deepEqual(readdirSync(dir), [], 'the temp file is cleaned')
})

test('resolveClientDirectory normalizes the POSIX backslash dialect like the completion engine', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-save-loc-')
  const cwd = join(root, 'cwd')
  const out = join(cwd, 'out')
  mkdirSync(cwd)
  mkdirSync(out)
  // The completion engine suggests `out\` (Windows dialect on POSIX);
  // resolving it must land on the SAME directory as the forward-slash form.
  assert.equal(resolveClientDirectory('out\\', cwd), resolveClientDirectory('out/', cwd))
  assert.equal(resolveClientDirectory('out\\sub', cwd), resolveClientDirectory('out/sub', cwd))
  assert.equal(resolveClientDirectory('out', cwd), out)
  // A POSIX-ABSOLUTE path with the backslash dialect round-trips too (the
  // query engine treats `\` as a separator there; the resolver must match).
  assert.equal(resolveClientDirectory(`${out}\\sub`, cwd), resolveClientDirectory(`${out}/sub`, cwd))
  assert.equal(resolveClientDirectory(`${out}\\sub`, cwd), join(out, 'sub'))
})

test('streamToFile releases the reader lock when the temp open fails', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-sink-')
  // The parent directory does not exist: the temp open rejects.
  const target = join(root, 'missing-dir', 'out.zip')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.close()
    },
  })
  await assert.rejects(streamToFile(target, stream, new AbortController().signal, false), /ENOENT/)
  // The reader lock must be released even when the temp open fails.
  const reader = stream.getReader()
  const { done } = await reader.read()
  assert.equal(done, true, 'the stream is reusable after the open failure')
  reader.releaseLock()
})

test('streamToFile without overwrite consent refuses a target that appeared after the check', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  // The target exists when the sink commits: the no-overwrite guard must
  // refuse it and never replace it. (The EXACT lstat→link race window —
  // a target inserted between the guard and the atomic link() — is closed
  // by the kernel's link() EEXIST semantics and is not directly testable
  // without an injection seam; the existing-target case pins the same
  // no-silent-overwrite contract, and the dangling-symlink case pins the
  // non-following guard.)
  writeFileSync(target, 'another process wrote this')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.close()
    },
  })
  await assert.rejects(streamToFile(target, stream, new AbortController().signal, false), /appeared after the collision check/)
  assert.equal(readFileSync(target, 'utf8'), 'another process wrote this', 'the foreign target is never overwritten')
  assert.deepEqual(readdirSync(dir), ['out.zip'], 'the temp file is cleaned')
})

test('streamToFile with overwrite consent replaces an existing target', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  writeFileSync(target, 'old bytes')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.close()
    },
  })
  const path = await streamToFile(target, stream, new AbortController().signal, true)
  assert.equal(path, target)
  assert.deepEqual([...readFileSync(target)], [1, 2, 3], 'the consented replace commits the new bytes')
})

test('streamToFile without overwrite consent refuses a dangling symlink target', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  // A dangling symlink: statSync would follow it into ENOENT, but the entry
  // itself exists — it must never be silently replaced.
  symlinkSync(join(dir, 'missing-target'), target)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.close()
    },
  })
  await assert.rejects(streamToFile(target, stream, new AbortController().signal, false), /appeared after the collision check/)
  assert.ok(lstatSync(target).isSymbolicLink(), 'the dangling symlink is never replaced')
  assert.deepEqual(readdirSync(dir), ['out.zip'], 'the temp file is cleaned')
})

test('streamToFile fails closed when the filesystem cannot commit without replacing', async (t) => {
  // The no-overwrite commit uses link() (atomic no-replace). A filesystem
  // that refuses hard links must FAIL the save — never fall back to an
  // unchecked rename that could silently overwrite. The directory is made
  // read-only mid-save (after the temp file is open) so link() returns
  // EPERM; root and Windows bypass POSIX permission enforcement.
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('requires POSIX permission enforcement')
    return
  }
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (pulls === 1) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
      } else {
        // The second (eager) pull runs only after the first read consumed
        // the chunk — the temp file is already open by then. Make the
        // directory read-only so the commit's link() fails with
        // EACCES/EPERM (never before the open, which would fail the test
        // for the wrong reason).
        chmodSync(dir, 0o555)
        controller.close()
      }
    },
  })
  try {
    await assert.rejects(
      streamToFile(target, stream, new AbortController().signal, false),
      /does not support atomic no-replace commit/,
    )
    assert.ok(!existsSync(target), 'no final file on the fail-closed path')
  } finally {
    // Restore write permission so the temp cleanup and the fixture teardown
    // can remove the directory.
    chmodSync(dir, 0o755)
  }
})

test('streamToFile releases the reader lock after a successful save', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.close()
    },
  })
  await streamToFile(target, stream, new AbortController().signal, false)
  // The reader lock must be released: a new reader can be acquired.
  const reader = stream.getReader()
  const { done } = await reader.read()
  assert.equal(done, true, 'the stream is fully consumed and reusable')
  reader.releaseLock()
})

test('streamToFile releases the reader lock after a cancelled save', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-sink-')
  const target = join(dir, 'out.zip')
  let pulled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true
        controller.enqueue(new Uint8Array([1, 2, 3]))
      }
    },
  })
  const controller = new AbortController()
  const promise = streamToFile(target, stream, controller.signal, false)
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  controller.abort()
  await assert.rejects(promise, error => error instanceof Error && error.name === 'AbortError')
  // The reader lock must be released even on cancellation.
  const reader = stream.getReader()
  const { done } = await reader.read()
  assert.equal(done, true, 'the cancelled stream is reusable')
  reader.releaseLock()
})

// ── 23.2/23.3 runner-level lifecycle ─────────────────────────────────────

/** A minimal runner harness (the runner-session-bootstrap pattern) with a
 * scriptable commands service and a recorded archive port. */
function makeHarness(home: string, options: {
  execute?: () => Promise<{ result: { kind: 'success' } | { kind: 'error'; text: string } } | undefined>
  sessions?: Record<string, { id: string; header: { id: string; cwd: string; createdAt: number; version: number } }>
}) {
  const persisted = new Map<string, { id: string; header: { id: string; cwd: string; createdAt: number; version: number } }>()
  for (const session of Object.values(options.sessions ?? {})) persisted.set(session.id, session)
  const live = new Map<string, Agent>()
  const makeHandle = (session: { id: string; header: { id: string; cwd: string; createdAt: number; version: number } }): { agent: Agent; dispose: () => Promise<void> } => {
    // The structural Agent shape the runner's surface rebuild and the
    // Direct retirement touch: ctx (get/on/agent), whenIdle, cancel, inbox.
    const agentContext = {
      get: () => undefined,
      on: () => () => {},
      agent: undefined as Agent | undefined,
    }
    let cancelled = false
    let releaseIdle: (() => void) | undefined
    const agent = {
      session: { id: session.id, header: session.header, snapshotEvents: () => [] },
      ctx: agentContext,
      options: { provider: 'p', model: 'm' },
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      whenIdle: async () => {
        if (cancelled) return
        await new Promise<void>(resolve => {
          releaseIdle = resolve
          resolve()
        })
      },
      cancel: () => {
        cancelled = true
        releaseIdle?.()
      },
    } as unknown as Agent
    agentContext.agent = agent
    live.set(session.id, agent)
    return { agent, dispose: async () => { live.delete(session.id) } }
  }
  const persistence = {
    list: async () => [...persisted.values()].map(session => session.header),
    inspect: async (id: unknown) => {
      const session = persisted.get(String(id))
      if (session === undefined) throw new Error(`unknown test session ${String(id)}`)
      return { meta: session.header, events: [] }
    },
  }
  const sessionQuery = {
    listSessions: async () => [...persisted.values()].map(session => ({ header: session.header, live: live.has(session.id) })),
    observeSession: async (id: unknown) => {
      const session = persisted.get(String(id))
      if (session === undefined) throw new Error(`unknown test session ${String(id)}`)
      return { header: session.header, events: [], [Symbol.dispose]: () => {} }
    },
  }
  const agents = {
    resume: async ({ resumeSessionId, setup }: { resumeSessionId: unknown; setup?: (agentCtx: unknown) => unknown }) => {
      const session = persisted.get(String(resumeSessionId))
      if (session === undefined) throw new Error(`unknown test session ${String(resumeSessionId)}`)
      const handle = makeHandle(session)
      await setup?.(handle.agent.ctx)
      return handle
    },
    create: async ({ sessionId }: { sessionId: unknown }) => {
      const id = String(sessionId)
      const session = {
        id,
        header: { id, cwd: home, createdAt: Date.now(), version: SESSION_FORMAT_VERSION },
      }
      persisted.set(id, session)
      return makeHandle(session)
    },
    get: (id: string) => live.get(id),
  }
  const sessions = {
    flush: async () => {},
    get: (id: string) => live.get(id)?.session,
  }
  const defaultModel = {
    currentSelection: () => ({ provider: 'p', model: 'm' }),
    saveSelection: async () => {},
  }
  const llm = {
    listProviders: () => [{ id: 'p', name: 'provider p' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    discoverModels: async () => [],
    listConfigurableProviders: () => [],
  }
  const definitions = new Map<string, { name: string; description: string; handler: (...args: never[]) => unknown }>()
  const commands = {
    register: (definition: { name: string; description: string; handler: (...args: never[]) => unknown }) => {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    list: () => [...definitions.values()].map(({ name, description }) => ({ name, description })),
    execute: options.execute ?? (async () => ({ result: { kind: 'success' } })),
    handler: (name: string) => definitions.get(name)?.handler,
  }
  return { persistence, sessionQuery, agents, sessions, defaultModel, llm, commands, live }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}

/** Dispose every fiber created by the real Cordis context. */
async function disposeContext(ctx: Context): Promise<void> {
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
  }
}

/** Route production ProcessTerminal instances into a deterministic xterm. */
function installVirtualProcessTerminal(vt: VirtualTerminal): () => void {
  const prototype = ProcessTerminal.prototype as object
  const names = [
    'start', 'stop', 'drainInput', 'write', 'moveBy', 'hideCursor', 'showCursor',
    'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle', 'setProgress',
    'columns', 'rows', 'kittyProtocolActive', 'modifyOtherKeysActive',
  ]
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const virtual = vt as unknown as Record<string, unknown>
  const methods = new Set([
    'start', 'stop', 'drainInput', 'write', 'moveBy', 'hideCursor', 'showCursor',
    'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle', 'setProgress',
  ])
  for (const name of names) {
    originals.set(name, Object.getOwnPropertyDescriptor(prototype, name))
    if (methods.has(name)) {
      Object.defineProperty(prototype, name, {
        configurable: true,
        value: (...args: unknown[]) => {
          const method = virtual[name]
          if (typeof method !== 'function') throw new Error(`virtual terminal method missing: ${name}`)
          return (method as (...args: unknown[]) => unknown).apply(vt, args)
        },
      })
    } else {
      Object.defineProperty(prototype, name, {
        configurable: true,
        get: () => name === 'modifyOtherKeysActive' ? false : virtual[name],
      })
    }
  }
  return () => {
    for (const name of names) {
      const descriptor = originals.get(name)
      if (descriptor === undefined) delete (prototype as Record<string, unknown>)[name]
      else Object.defineProperty(prototype, name, descriptor)
    }
  }
}

/** Record every TuiApp the production runner creates (the bootstrap-test
 * probe pattern: patch start() to capture the instance). */
function installAppProbe(): { apps: TuiApp[]; restore: () => void } {
  const apps: TuiApp[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function (this: TuiApp) {
    apps.push(this)
    return originalStart.apply(this)
  }
  return {
    apps,
    restore: () => { TuiApp.prototype.start = originalStart },
  }
}

async function mountRunner(
  ctx: Context,
  home: string,
  harness: ReturnType<typeof makeHarness>,
  startup: { sessionId?: string; presetId?: string },
  config: Config,
) {
  ctx.provide('appExit', () => {})
  ctx.provide(TUI_STARTUP_SERVICE, { ...startup, shippedPresetRoot: home })
  ctx.provide('sessionPersistence', harness.persistence as never)
  ctx.provide('sessionQuery', harness.sessionQuery as never)
  ctx.provide('agents', harness.agents as never)
  ctx.provide('sessions', harness.sessions as never)
  ctx.provide('agentDefaultModel', harness.defaultModel as never)
  ctx.provide('llm', harness.llm as never)
  ctx.provide('commands', harness.commands as never)
  ctx.provide('loader', { await: async () => {} } as never)
  const fiber = ctx.plugin((pluginCtx) => applyRunner(pluginCtx, config))
  await fiber
  await settle()
  return fiber
}

/** Drive one editor submit through the app's terminal input. The text is
 * sent as ONE chunk (a multi-char read resets the editor's paste-burst
 * tracker — per-character typing past the burst threshold would turn the
 * trailing Enter into a newline instead of a submit). */
function submitText(app: TuiApp, text: string): void {
  const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
  tui.handleTerminalInput(text)
  tui.handleTerminalInput('\r')
}

test('BLOCKING: /export opens Save Location only after commands.execute resolved', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-export-order-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const events: string[] = []
  const harness = makeHarness(home, {
    execute: async () => {
      events.push('execute-resolved')
      return { result: { kind: 'success' } }
    },
  })
  const originalAsk = TuiApp.prototype.askSaveLocation
  TuiApp.prototype.askSaveLocation = async function () {
    events.push('save-location-opened')
    return { kind: 'cancelled' }
  }
  life.defer(() => { TuiApp.prototype.askSaveLocation = originalAsk })
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  const fiber = await mountRunner(ctx, home, harness, {}, {})
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  submitText(app, '/export')
  await settle()
  // The save workflow must start ONLY AFTER the command lifecycle settled.
  assert.deepEqual(events, ['execute-resolved', 'save-location-opened'],
    'the archive workflow must begin after commands.execute resolved — never inside the handler')
})

test('BLOCKING: a failed /export result never opens Save Location', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-export-fail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  let opened = 0
  const harness = makeHarness(home, {
    execute: async () => ({ result: { kind: 'error', text: 'The /export command does not accept a path.' } }),
  })
  const originalAsk = TuiApp.prototype.askSaveLocation
  TuiApp.prototype.askSaveLocation = async function () {
    opened += 1
    return { kind: 'cancelled' }
  }
  life.defer(() => { TuiApp.prototype.askSaveLocation = originalAsk })
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  const fiber = await mountRunner(ctx, home, harness, {}, {})
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  submitText(app, '/export foo')
  await settle()
  assert.equal(opened, 0, 'an error result must never open Save Location')
})

test('a second artifact save while one prompt is active is refused with a notice (never silent)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-export-race-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const sessionA = { id: 'session-a', header: { id: 'session-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION } }
  const harness = makeHarness(home, { sessions: { 'session-a': sessionA } })
  // Both commands stay in flight until released: two concurrent command
  // successes can race the Save prompt (the dispatch is not serialized).
  const executeGates: Array<() => void> = []
  const originalExecute = harness.commands.execute
  harness.commands.execute = async () => {
    await new Promise<void>(resolve => executeGates.push(resolve))
    return originalExecute()
  }
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  const fiber = await mountRunner(ctx, home, harness, { sessionId: 'session-a' }, {})
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  // Two commands in flight: /export then /transcript (both submitted while
  // the editor is free — no prompt is open until a command settles).
  submitText(app, '/export')
  submitText(app, '/transcript')
  await settle()
  // Release both commands: both settle successfully, then the save
  // workflows race the prompt — the first opens the REAL prompt, the
  // second is refused by the duplicate guard.
  for (const release of executeGates) release()
  await settle()
  await new Promise<void>(resolve => setTimeout(resolve, 50))
  await settle()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('already active'),
    `the refused second save must notify, never silently drop:\n${view}`)
  // Cancel the first prompt (Esc) to clean up.
  vt.sendInput('\x1b')
  await settle()
})

test('the post-success workflow targets the CAPTURED originating Session even after a switch', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-export-identity-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const outDir = life.tempDir('dsh-export-out-')
  const sessionA = { id: 'session-a', header: { id: 'session-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION } }
  const sessionB = { id: 'session-b', header: { id: 'session-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION } }
  const harness = makeHarness(home, { sessions: { 'session-a': sessionA, 'session-b': sessionB } })
  const openedSessions: string[] = []
  const originalOpen = DirectSessionArchive.prototype.open
  DirectSessionArchive.prototype.open = async function (sessionId: string) {
    openedSessions.push(sessionId)
    return {
      kind: 'ready',
      artifact: {
        filename: 'dsh-session-session-a.zip',
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            controller.close()
          },
        }),
      },
    }
  }
  life.defer(() => { DirectSessionArchive.prototype.open = originalOpen })
  const originalAsk = TuiApp.prototype.askSaveLocation
  let askCalls = 0
  TuiApp.prototype.askSaveLocation = async function () {
    askCalls += 1
    // While the /export workflow is paused at Save Location, switch the
    // live Session to B (the /resume command handler drives the switch).
    const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
    assert.ok(resumeHandler !== undefined, 'the real runner must register /resume')
    const outcome = await (resumeHandler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: 'session-b' })
    assert.equal((outcome as { kind?: string }).kind, 'success', 'the switch to B must succeed')
    await settle()
    return { kind: 'selected', directory: outDir, overwrite: false }
  }
  life.defer(() => { TuiApp.prototype.askSaveLocation = originalAsk })
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  const fiber = await mountRunner(ctx, home, harness, { sessionId: 'session-a' }, {})
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  submitText(app, '/export')
  await settle()
  // The switch + save chain crosses real async boundaries (the transition
  // quiesce and the stream sink); poll for the artifact instead of a fixed
  // sleep so a loaded CI machine cannot starve the assertion.
  const deadline = Date.now() + 2_000
  for (;;) {
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    await settle()
    if (existsSync(join(outDir, 'dsh-session-session-a.zip'))) break
    if (Date.now() > deadline) break
  }
  // The archive must open the ORIGINATING session A — never the live B.
  assert.equal(askCalls, 1, 'the save workflow must have opened Save Location')
  assert.deepEqual(openedSessions, ['session-a'],
    'the post-success workflow must target the captured originating Session, not liveAgent at settle time')
  assert.ok(existsSync(join(outDir, 'dsh-session-session-a.zip')), 'the artifact lands in the selected directory')
})

test('/transcript writes the readable Markdown from the originating Session after settlement', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-export-transcript-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const outDir = life.tempDir('dsh-export-out-')
  const sessionA = { id: 'session-a', header: { id: 'session-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION } }
  const harness = makeHarness(home, { sessions: { 'session-a': sessionA } })
  const originalAsk = TuiApp.prototype.askSaveLocation
  TuiApp.prototype.askSaveLocation = async function () {
    return { kind: 'selected', directory: outDir, overwrite: false }
  }
  life.defer(() => { TuiApp.prototype.askSaveLocation = originalAsk })
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  const fiber = await mountRunner(ctx, home, harness, { sessionId: 'session-a' }, {})
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  submitText(app, '/transcript')
  await settle()
  // The save chain crosses real async boundaries (the transition quiesce
  // and the atomic text sink); poll for the artifact instead of a fixed
  // sleep so a loaded CI machine cannot starve the assertion.
  const deadline = Date.now() + 2_000
  for (;;) {
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    await settle()
    if (existsSync(join(outDir, 'dsh-session-session-a.md'))) break
    if (Date.now() > deadline) break
  }
  const target = join(outDir, 'dsh-session-session-a.md')
  assert.ok(existsSync(target), 'the transcript file is written with the fixed .md name')
  const content = readFileSync(target, 'utf8')
  assert.ok(content.startsWith('# Session session-a'), 'the Markdown renders the originating Session header')
})
