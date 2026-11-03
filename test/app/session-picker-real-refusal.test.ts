/**
 * S2/PR-B §B1 / S2-16 — REAL unreadable stored Sessions on the REAL Session
 * Picker path (L6, no authority stand-in).
 *
 * CONTRACT (the Owner-accepted limited S2 change, recorded in
 * `docs/architecture/host-client.md`): the official JSONL backend LISTs a
 * Session from its HEADER only, which splits the user-visible outcomes in two:
 *
 *  - LIST_EXCLUDED — a log whose header the reader refuses (a newer format
 *    version) is never published, so the Picker cannot present it. The
 *    user-visible sink is a fail-closed OMISSION, and an empty roster states
 *    `No readable sessions` rather than claiming there are no stored Sessions.
 *  - OPEN_REFUSED — a log whose header is readable but whose BODY the reader
 *    refuses (an event type this harness cannot interpret) IS published and IS
 *    presented as a Picker row; selecting it surfaces the OFFICIAL refusal on
 *    the painted surface and never mounts the log as an empty Session.
 *
 * Both artifacts stay byte-identical across the whole interaction.
 *
 * FIXTURE (real): the official agent-loop testkit, the official JSONL
 * persistence + query engine, a real Session artifact tree, the real runner and
 * a real `VirtualTerminal`. STAND-INS: the peripheral registries the runner
 * injects (command registry, loader, default model) only.
 *
 * @module @xmoon76/dsh-pi-tui/session-picker-real-refusal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import { visibleWidth } from '@xmoon76/pi-tui'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { apply as applyRunner, Config as TuiConfigSchema } from '../../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import {
  disposeContext,
  installVirtualProcessTerminal,
  makeHarness,
  settle,
} from '../support/runner-harness.ts'
import { installProbe } from '../support/runner-session-fixtures.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** Bounded wait on a REAL state (the precedent in
 *  `test/app/session-picker-loading.test.ts`): the picker opens immediately and
 *  loads its roster asynchronously, so one painted frame or a fixed sleep
 *  cannot prove the listing committed. */
async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000,
  stepMs = 10,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`${label}: waitUntil timed out after ${timeoutMs}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
}

/** Ids stay within the picker's 8-cell display label, so a painted row is
 *  unambiguous (the row label is the shortened id). */
const READABLE = SessionId('readable')
/** A current-version artifact whose HEADER lists while its BODY is refused. */
const REFUSED = SessionId('refusedx')
/** A newer-format artifact: the reader refuses its header, so it never lists. */
const NEWER = SessionId('newerfmt')
/** The body event type no released harness knows: the official refusal names it. */
const UNKNOWN_EVENT = 'totally/unknown-event'

/** The backend roots each Session under exactly one project directory. */
function sessionDirOf(root: string, sessionId: string): string {
  for (const project of readdirSync(root)) {
    const candidate = join(root, project, sessionId)
    if (readdirSync(join(root, project)).includes(sessionId)) return candidate
  }
  throw new Error(`no session directory for ${sessionId} under ${root}`)
}

/** Write one generation artifact exactly like the backend does (zstd frames:
 *  the header record is the first frame, the event batch the next). */
function placeArtifact(path: string, plainJsonl: string): void {
  const newline = plainJsonl.indexOf('\n')
  const head = zstdCompressSync(Buffer.from(plainJsonl.slice(0, newline + 1)))
  const rest = zstdCompressSync(Buffer.from(plainJsonl.slice(newline + 1)))
  writeFileSync(path, Buffer.concat([head, rest]))
}

/**
 * The frozen sizes with the fragments the MEASURED frames actually paint: the
 * 80x10 viewport scrolls the transcript to the refusal's tail (so its card is
 * above the viewport while the tail fragment is on screen), while 120/44 keep
 * the beginning of the official sentence and the Session card.
 */
const SIZES = [
  { columns: 120, rows: 40, cardVisible: true, fragments: ['transition failed', 'contains event type', 'refusing to interpret the log'] },
  { columns: 80, rows: 10, cardVisible: false, fragments: ['not marked ignorable', 'refusing to interpret the log'] },
  { columns: 44, rows: 20, cardVisible: true, fragments: ['transition failed', 'contains event type', '"totally/unknown-event"', 'this harness', 'refusing to interpret the log'] },
] as const

for (const { columns, rows, cardVisible, fragments } of SIZES) test(`the REAL Session Picker excludes an unlistable log and surfaces a refused body at ${columns}x${rows}`, async t => {
  // The 44x20 case also runs under a LONG PARENTHESIZED temp root: the
  // official persistence error appends an unescaped path, so a legal ')' in a
  // storage directory must not truncate the raw-log suffix removal and leave a
  // path fragment that scrolls the Session card out.
  const previousTmp = process.env.TMPDIR
  const life = testLifecycle(t)
  // A UNIQUE lifecycle-owned root (never a fixed shared path): two test
  // processes must not share a temp directory, or one process's cleanup could
  // delete the other's real Session artifacts. The prefix keeps the legal
  // parentheses; the long subdirectory keeps the path shape that the raw-log
  // suffix budget must survive.
  const usesParenthesizedRoot = columns === 44 && rows === 20
  if (usesParenthesizedRoot) {
    const parenthesizedRoot = life.tempDir('dsh-prb(archive)-')
    const longRoot = join(parenthesizedRoot, 'dsh-pi-tui-test-run-bZMkpP-' + 'x'.repeat(150))
    mkdirSync(longRoot, { recursive: true })
    process.env.TMPDIR = longRoot
  }
  life.defer(() => {
    if (!usesParenthesizedRoot) return
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  })
  const root = life.tempDir('dsh-s2b-real-picker-')
  const home = life.tempDir('dsh-s2b-real-picker-home-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(columns, rows)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)

  // ── Boot 1: write the real artifact tree through the official persistence ──
  const first = new Context()
  // Failure-path teardown: every step below can throw before the inline
  // `dispose()` at the end of this block, and `testLifecycle` only cleans the
  // resources it was given. Cordis fiber disposal is idempotent, so the
  // success path simply disposes an already-disposed fiber again.
  life.defer(() => disposeContext(first))
  await mountAgentLoopTestDependencies(first, { workingDirectory: true })
  await first.plugin(JsonlSessionPersistence, { root })
  const persistence = first.get('sessionPersistence') as unknown as {
    create(init: {
      readonly id: ReturnType<typeof SessionId>
      readonly createdAt: number
      readonly version: number
      readonly cwd: string
      readonly isSeeded: boolean
      readonly delegationDepth: number
    }): Promise<{ flush(): Promise<void>; close(): Promise<void> }>
  }
  for (const [index, id] of [READABLE, REFUSED, NEWER].entries()) {
    const handle = await persistence.create({
      id,
      createdAt: 1_700_000_000_000 + index,
      version: SESSION_FORMAT_VERSION,
      cwd: '/work',
      isSeeded: false,
      delegationDepth: 0,
    })
    await handle.flush()
    await handle.close()
  }
  await first.fiber.dispose()

  const replaceArtifact = (id: string, plainJsonl: string, version: number): string => {
    const dir = sessionDirOf(root, id)
    for (const name of readdirSync(dir)) {
      if (name.startsWith('session.') && name !== 'session.lock') rmSync(join(dir, name), { force: true })
    }
    const path = join(dir, `session.v${version}.jsonl.zstd`)
    placeArtifact(path, plainJsonl)
    return path
  }
  const headerLine = (id: string, version: number): string => `${JSON.stringify({
    type: 'session', version, id, createdAt: 1_700_000_000_000, cwd: '/work', isSeeded: false, delegationDepth: 0,
  })}\n`
  // OPEN_REFUSED: a CURRENT-format header whose body event type this harness
  // does not know. The listing publishes the header, so the picker shows a row.
  const refusedPath = replaceArtifact(String(REFUSED), `${headerLine(String(REFUSED), SESSION_FORMAT_VERSION)}${JSON.stringify({ type: UNKNOWN_EVENT, seq: 0, time: 1, data: {} })}\n`, SESSION_FORMAT_VERSION)
  // LIST_EXCLUDED: a log written by a newer harness. Its header is refused, so
  // the official listing never publishes it.
  const newerVersion = SESSION_FORMAT_VERSION + 1
  const newerPath = replaceArtifact(String(NEWER), `${headerLine(String(NEWER), newerVersion)}${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } })}\n`, newerVersion)
  const bytesBefore = new Map([[refusedPath, readFileSync(refusedPath)], [newerPath, readFileSync(newerPath)]])

  // ── Boot 2: the real stack + the real runner, over the SAME artifact tree ──
  const context = new Context()
  life.defer(() => disposeContext(context))
  await mountAgentLoopTestDependencies(context, { workingDirectory: true })
  await context.plugin(JsonlSessionPersistence, { root })
  await context.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  context.provide('appExit', () => {})
  context.provide(TUI_STARTUP_SERVICE, { sessionId: String(READABLE), shippedPresetRoot: home } as never)
  // The PERIPHERAL registries (command registry + default model) are stand-ins:
  // the authority under test (persistence, agent loop, session query, runner) is
  // real. The OFFICIAL command runtime resolves the session-scoped `/sessions`.
  await context.plugin(CommandRuntime)
  const peripherals = makeHarness(home, [], { provider: 'p', model: 'm' })
  context.provide('loader', { await: async () => {} } as never)
  // The production AgentLoop row itself (the agent factory `agents.resume`
  // needs); the testkit mounts it after its prerequisites are in place.
  await mountAgentLoopTestHarness(context)
  context.provide('agentDefaultModel', peripherals.defaultModel as never)
  const fiber = await context.plugin(pluginCtx => applyRunner(pluginCtx, TuiConfigSchema({ sessionId: String(READABLE) } as never)))
  life.defer(() => fiber.dispose())
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  // The REAL agent loop resumes the stored Session: wait (bounded) for the
  // runner's first painted frame instead of assuming a fixed number of ticks.
  for (let attempt = 0; attempt < 80 && !view().includes('dsh-pi-tui'); attempt += 1) {
    await settle()
    await new Promise(resolve => setTimeout(resolve, 25))
    await vt.waitForRender()
  }
  assert.match(view(), /dsh-pi-tui/u, `the real runner painted:\n${view()}`)

  // ── The SOURCE fact: the same tree, opened by id ──
  const persistence2 = context.get('sessionPersistence') as unknown as {
    open(id: unknown, mode: string): Promise<unknown>
  }
  const refusedOfficial = await persistence2.open(REFUSED, 'read').then(() => undefined, (error: unknown) => error as Error)
  assert.ok(refusedOfficial !== undefined, 'the unreadable body is refused by the official open')
  assert.match(refusedOfficial.message, new RegExp(`${UNKNOWN_EVENT}.*unknown to this harness`),
    `the official refusal names the unreadable body: ${refusedOfficial.message}`)

  // ── The real picker: the excluded log is NEVER presented, the refused body IS ──
  vt.sendInput('/sessions')
  await settle()
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  // `waitForRender()` proves a FRAME, not that the async Session listing
  // committed: the picker opens immediately and `Loading sessions…` is a
  // legitimate intermediate state. Wait for the FINAL roster before judging it.
  await waitUntil(
    () => view().includes('2/2') && view().includes('readable') && !view().includes('newerfmt'),
    `the Session Picker roster at ${columns}x${rows}`,
  )
  await vt.waitForRender()
  const listed = view()
  for (const line of vt.getViewport()) {
    assert.ok(visibleWidth(line) <= columns, `no listed frame row overflows ${columns} cells: ${JSON.stringify(line)}`)
  }
  assert.match(listed, /2\/2/u, `the picker knows both readable logs:\n${listed}`)
  assert.ok(listed.includes('readable'), `the live readable Session is painted:\n${listed}`)
  assert.ok(!listed.includes('newerfmt'),
    `the LIST_EXCLUDED log is never presented (and never shown as an empty Session):\n${listed}`)

  // ── Selecting the refused row: the OFFICIAL refusal reaches the surface ──
  // The filter narrows the roster to the one row, so Enter is unambiguous.
  vt.sendInput('refusedx')
  // The browse roster ALREADY contained `refusedx`, so a bare row match
  // proves nothing about the filter. The external-filter projection paints
  // the Search-results category header and its single-row group count; it
  // deliberately has NO internal `filtered/total` header (search is off in
  // external mode), so the group count is the count evidence at every size.
  await waitUntil(
    () => {
      const frame = view()
      return frame.includes('sessions · Search results')
        && frame.includes('/work · 1')
        && frame.includes('refusedx')
    },
    `the filtered refused row at ${columns}x${rows}`,
  )
  await vt.waitForRender()
  assert.ok(view().includes('refusedx'), `the refused row is reachable:\n${view()}`)
  vt.sendInput('\r')
  await settle()
  // The refusal arrives through the production notice slot; a fixed 60 ms is
  // not a guarantee under CI load. Wait for the OFFICIAL message itself.
  const currentNoticeText = (): string | undefined =>
    (probe.apps.at(-1) as unknown as {
      currentNotice?: () => { readonly text: string } | undefined
    }).currentNotice?.()?.text
  await waitUntil(
    () => {
      const notice = currentNoticeText()
      return notice !== undefined && notice.includes(UNKNOWN_EVENT) && notice.includes('unknown to this harness')
    },
    `the official refusal notice at ${columns}x${rows}`,
  )
  await vt.waitForRender()
  const after = view()
  for (const line of vt.getViewport()) {
    assert.ok(visibleWidth(line) <= columns, `no refused frame row overflows ${columns} cells: ${JSON.stringify(line)}`)
  }
  // The production notice slot carries the official refusal body (the raw
  // diagnostic log path is logged separately, never part of the narrow-width
  // card-visibility contract).
  const noticeText = currentNoticeText()
  assert.ok(noticeText !== undefined && noticeText.includes(UNKNOWN_EVENT) && noticeText.includes('unknown to this harness'),
    `the refusal notice is the official message, got: ${String(noticeText)}`)
  assert.ok(noticeText !== undefined && noticeText.includes('old turn stopped (cannot resume)'),
    `the notice preserves the old-turn stopped fact, got: ${String(noticeText)}`)
  for (const fragment of fragments) {
    assert.ok(after.includes(fragment),
      `the painted refusal carries "${fragment}" at ${columns} columns:\n${after}`)
  }
  // The unreadable log is never mounted as an empty Session, and the readable
  // Session still owns the surface.
  assert.doesNotMatch(after, /type a message to start a session/u,
    'a refused log is never presented as an empty Session')
  if (cardVisible) {
    assert.match(after, /session\s+readable/u, `the readable Session still owns the surface:\n${after}`)
  } else {
    // The viewport scrolled past the card; the positive fact is the roster's
    // live readable row (asserted above) plus the refusal naming ONLY the
    // refused log, and the empty-Session negative asserted here.
    assert.ok(after.includes('refusing to interpret the log'),
      `the refusal is the one this Enter produced at ${columns} columns:\n${after}`)
  }
  assert.match(after, /refusedx/u, 'the refused row is the one this Enter selected')

  // ── The artifacts are never rewritten by listing or by a refused open ──
  for (const [path, before] of bytesBefore) {
    assert.ok(readFileSync(path).equals(before), `the stored log is byte-identical: ${path}`)
  }
})
