/**
 * Phase 3B / B1-D — the Job Workspace VISUAL layout (implementation plan v2
 * §10 D-01…D-25).
 *
 * Every case drives the REAL composition — a mounted `TuiApp`, its real
 * fullscreen `TuiAltScreen`, a `VirtualTerminal` and the real `TaskRuntime`
 * selection path — and asserts what the terminal PHYSICALLY painted: row
 * order, cell widths, theme ANSI, native SGR click coordinates, the real
 * clipboard sink, the surviving body/Action-Bar floor and the resize/currentness
 * fences. Only the external Job-observation PORT is replaced by the same
 * acquire/emit/release double the B1-A/B/C suites use (never a second
 * observation model, never a pre-arranged UI mock).
 *
 * Mutation discrimination (checked by hand during the B1-D validation): deleting
 * the tabs painter breaks `D-01`/`D-02`; removing the Action-Bar / body floor
 * breaks `D-11`/`D-12`; weakening the press-time hit guard breaks `D-13`/`D-17`.
 *
 * @module @xmoon76/dsh-pi-tui/job-workspace-visual.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import type { OwnedRunner, TuiAppEvents } from '../../src/tui-app.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import { pituiTaskCenterPresentation } from '../../src/app/surface/task-presentation-pitui.ts'
import { currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import { darkColors } from '../../src/domain/display/theme.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import type { JobObservedSnapshot, JobObservationPort, JobStopOutcome } from '../../src/runtime/job-observation-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import {
  assertBarIsLastRow,
  assertBodyFloor,
  assertNoHalfSegmentInBar,
  assertOneActiveDevice,
  type PaintedFrame,
} from '../support/design-language-frames.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
  // `setTheme` mutates the process-wide palette: leave the dark default behind
  // so a later case never inherits this one's live theme switch.
  setTheme('dark')
})

// ── the real composition + the external observation PORT double ─────────────

interface ObservationRecord {
  readonly jobId: string
  closes: number
  readonly emit: (patch: Partial<JobObservedSnapshot>) => void
}

/** The external selected-Job PORT double (acquire/emit/release only). */
class JobObservationDouble implements JobObservationPort {
  readonly records: ObservationRecord[] = []
  readonly stops: string[] = []
  openFailure: string | undefined
  /** Whether `open` emits its first snapshot synchronously (the official stream
   *  does); `false` leaves the workspace in its real CONNECTING phase. */
  syncEmit = true

  open(_sessionId: string | undefined, jobId: string, listener: (snapshot: JobObservedSnapshot) => void): () => void {
    if (this.openFailure !== undefined) throw new Error(this.openFailure)
    const record: ObservationRecord = {
      jobId,
      closes: 0,
      emit: (patch) => listener({
        jobId,
        kind: 'bash',
        label: `job ${jobId}`,
        status: 'running',
        text: `retained ${jobId}`,
        gapBefore: false,
        settled: false,
        ...patch,
      }),
    }
    this.records.push(record)
    if (this.syncEmit) record.emit({})
    return () => { record.closes += 1 }
  }

  async stop(_sessionId: string, jobId: string): Promise<JobStopOutcome> {
    this.stops.push(jobId)
    return { kind: 'requested' }
  }

  latest(): ObservationRecord | undefined {
    return this.records.at(-1)
  }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly tasks: TaskRuntime
  readonly observation: JobObservationDouble
  /** Every payload the app handed to the Client-local clipboard capability. */
  readonly copied: string[]
}

function startApp(columns = 120, rows = 40, jobIds: readonly string[] = ['job-a']): Harness {
  const vt = new VirtualTerminal(columns, rows)
  const copied: string[] = []
  // A real owned runner: the copy intent must travel the production
  // `runOwned` ownership path instead of a stubbed promise.
  const owned: OwnedRunner = (_label, task, options) => {
    void Promise.resolve()
      .then(() => task())
      .then(
        result => options.onResult?.(result),
        error => options.onError?.(error),
      )
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const app = new TuiApp(vt, events, {
    copySelection: async (text: string) => {
      copied.push(text)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  const snapshots = (): TaskBrowserJobInput[] => jobIds.map((id, index) => ({
    id,
    kind: 'bash',
    label: `job ${id}`,
    status: 'running',
    startedAt: 1_000 + index,
  }))
  const observation = new JobObservationDouble()
  const subject = {} as SessionSubject
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => { throw new Error('not exercised') },
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: observation,
    jobs: { list: () => snapshots(), subscribe: () => () => {} },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({
        parentSessionId: 'sess-main',
        parentAvailable: true,
        descendants: [],
        jobs: snapshots(),
      }),
      activityOf: () => 'running',
    },
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub(),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
    publishActivity: () => {},
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  return { vt, app, tasks, observation, copied }
}

// ── painted-frame helpers ──────────────────────────────────────────────────

const rawView = (vt: VirtualTerminal): string[] => vt.getViewport()
const plainRows = (vt: VirtualTerminal): string[] => rawView(vt).map(stripTerminalSequences)
const view = (vt: VirtualTerminal): string => plainRows(vt).join('\n')
const rowOf = (vt: VirtualTerminal, needle: string): number => plainRows(vt).findIndex(line => line.includes(needle))

const bodyRow = (vt: VirtualTerminal, needle: string): number => {
  const row = rowOf(vt, needle)
  assert.ok(row >= 0, `the painted frame must contain ${JSON.stringify(needle)}:\n${view(vt)}`)
  return row
}

/** The terminal-CELL column of the first painted occurrence of `needle`. */
const cellIndexOf = (vt: VirtualTerminal, row: number, needle: string): number => {
  const plain = plainRows(vt)[row]
  assert.ok(plain !== undefined, `row ${row} must be painted:\n${view(vt)}`)
  const index = plain.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}: ${JSON.stringify(plain)}`)
  return visibleWidth(plain.slice(0, index))
}

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

async function settle(vt: VirtualTerminal, rounds = 4): Promise<void> {
  await vt.waitForRender()
  await flush(rounds)
}

/** Open the first Job of the real `/tasks` browser through the real selection. */
async function openFirstJob(harness: Harness): Promise<void> {
  harness.tasks.openTasksBrowser('full')
  await settle(harness.vt)
  harness.vt.sendInput('\r')
  await settle(harness.vt)
}

/** Close ONE harness before starting the next (the process allows a single
 *  live TuiApp). */
function disposeHarness(harness: Harness): void {
  startedApps.delete(harness.app)
  if (!harness.app.isDisposed()) harness.app.dispose()
}

/** The retained body fixture: one `line NNN` per rendered row. */
const numberedLines = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, index) => `line ${String(from + index).padStart(3, '0')}`).join('\n')

/** One native SGR left-button gesture (1-based terminal cells). */
const press = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const drag = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<32;${col + 1};${row + 1}M`)
}
const release = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}
/** One same-cell click through the native SGR path. */
const click = async (vt: VirtualTerminal, row: number, col: number): Promise<void> => {
  press(vt, row, col)
  release(vt, row, col)
  await settle(vt)
}

/** The 0xRRGGBB a chalk-hex token paints (the VirtualTerminal's own cell
 *  attribute read-back is the real witness for a themed foreground). */
const hexToRgb = (hex: string): number =>
  (parseInt(hex.slice(1, 3), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(5, 7), 16)

/** Every painted row must fit the real terminal width (terminal CELLS). */
const assertRowWidths = (vt: VirtualTerminal, width: number): void => {
  for (const [index, line] of rawView(vt).entries()) {
    assert.ok(visibleWidth(line) <= width,
      `row ${index} must fit ${width} cells: ${JSON.stringify(stripTerminalSequences(line))}`)
  }
}

// ── D-01: the locked standard-size information architecture ────────────────

test('120x40 paints status → metadata → summary → tabs → body → facts → Action Bar in that physical order', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({
    label: 'pnpm build && pnpm test:product',
    progress: '3/8 checks',
    detail: 'Building components',
    text: numberedLines(0, 39),
  })
  await settle(harness.vt)
  // A metadata-row change shrinks the body viewport. onFramePainted() reads the
  // freshly committed viewport, finds it differs from the frame's, and requests
  // one more throttled frame to converge the reading-facts position.
  await harness.vt.waitForRender()

  const status = bodyRow(harness.vt, 'Job · job-a · bash')
  const metadata = bodyRow(harness.vt, 'Progress: 3/8 checks')
  const heading = bodyRow(harness.vt, 'Copy Command · Expand [Tab] · Hide [F2]')
  const preview = bodyRow(harness.vt, 'pnpm build && pnpm test:product')
  const tabs = bodyRow(harness.vt, '[Output]  Command')
  const firstBody = tabs + 1
  const facts = bodyRow(harness.vt, 'Retained preview · not full history')
  const bar = bodyRow(harness.vt, 'Back [Esc]')

  assert.equal(status, 0, 'the status title owns the FIRST physical row')
  assert.equal(metadata, 1, 'the metadata row follows the status title')
  assert.equal(heading, 2, 'the Command preview heading follows the metadata')
  assert.equal(preview, 3, 'the passive Command preview follows its heading')
  assert.equal(tabs, 4, 'the reading tabs follow the preview')
  assert.equal(firstBody, 5, 'the body starts directly under the tabs — no blank separator row')
  assert.match(plainRows(harness.vt)[firstBody]!, /^line \d{3}/, 'the first body row is real retained text')
  assert.equal(facts, 38, 'the reading-facts row closes the body')
  assert.equal(bar, 39, 'the Action Bar is pinned to the physical bottom')
  assert.equal(bodyRow(harness.vt, 'line 039'), facts - 1, 'the followed tail is the LAST body row')
  assert.ok(tabs < firstBody && firstBody < facts && facts < bar, 'the visual order is fixed')

  // Status: identity + the ONE shared marker + the Title Case real status, all on the row.
  assert.match(plainRows(harness.vt)[status]!, /‣ Running/)
  // Heading: explicit Copy Command · Expand [Tab] · Hide [F2] controls.
  assert.match(plainRows(harness.vt)[heading]!, /^Command\s+Copy Command · Expand \[Tab\] · Hide \[F2\]$/)
  // Tabs: the CURRENT page is the only bracketed one.
  assert.match(plainRows(harness.vt)[tabs]!, /^\[Output\] {2}Command ─+$/)
  // Facts: Follow state + bounded disclosure + real measured position.
  assert.match(plainRows(harness.vt)[facts]!, /Follow on · Retained preview · not full history/)
  assert.match(plainRows(harness.vt)[facts]!, /rows 8-40\/40/, 'the position is the REAL preview viewport')
  // Action Bar: Esc + Copy Output + Find + browsing hint, and never repeats the disclosure.
  const barText = plainRows(harness.vt)[bar]!
  assert.match(barText, /Back \[Esc\]/)
  assert.match(barText, /Copy Output \[C\]/)
  assert.match(barText, /PgUp\/PgDn/)
  assert.ok(!/Retained preview/.test(barText), 'the Action Bar never repeats the dedicated facts row')
  assert.ok(!/Follow on/.test(barText), 'the Action Bar never repeats Follow when the dedicated facts row is granted')

  // The body is the terminal's OWN background: no card/second frame. The
  // VirtualTerminal's cell attributes are the witness, not a string guess.
  for (const row of [firstBody, firstBody + 1, facts - 1]) {
    for (let col = 0; col < 20; col += 1) {
      assert.equal(harness.vt.getCellBgRgb(row, col), undefined,
        `the body cell ${row}:${col} must keep the terminal background`)
    }
  }
  assertRowWidths(harness.vt, 120)
  assert.equal(harness.observation.records.length, 1, 'the visual frame never opens a second observer')
})

// ── D-02: the tabs really switch the reading page ──────────────────────────

test('clicking the Command tab switches the body, keeps ONE observer, and the Output tab returns', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ label: 'pnpm build', text: numberedLines(0, 39) })
  await settle(harness.vt)
  const opensBefore = harness.observation.records.length

  const tabs = bodyRow(harness.vt, '[Output]  Command')
  await click(harness.vt, tabs, cellIndexOf(harness.vt, tabs, 'Command'))

  assert.match(view(harness.vt), /\[Command\]/, 'the Command page marks ITSELF selected')
  assert.match(view(harness.vt), /^Output {2}\[Command\] ─+$/m, 'the Output tab turns plain')
  assert.match(view(harness.vt), /Full command/, 'the Command title replaces the Output summary')
  assert.ok(!/line 000/.test(view(harness.vt)), 'the Output body is not painted on the Command page')

  // The Command page advertises ONLY what it can do: no Stop, no Follow (D-21).
  const commandBar = plainRows(harness.vt).at(-1)!
  assert.ok(!/stop/.test(commandBar), 'the Command page never advertises Stop')
  assert.ok(!/Follow/.test(commandBar), 'the Command page never claims a Follow state')

  const commandTabs = bodyRow(harness.vt, 'Output  [Command]')
  await click(harness.vt, commandTabs, cellIndexOf(harness.vt, commandTabs, 'Output'))
  assert.match(view(harness.vt), /^\[Output\] {2}Command ─+$/m, 'the Output tab is current again')
  assert.match(view(harness.vt), /line 039/, 'the retained body is back, unchanged')
  assert.equal(harness.observation.records.length, opensBefore, 'switching pages never re-opens the observation')
})

// ── D-03: every affordance is a REAL sink ─────────────────────────────────

test('preview Copy Command, Expand [Tab] and Command Copy All [C] reach the original-command clipboard sink', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const label = '  pnpm build --watch  \n'
  harness.observation.latest()!.emit({ label, text: 'out' })
  await settle(harness.vt)

  // (1) Preview body itself is inert; Copy Command copies raw label verbatim.
  const previewRow = bodyRow(harness.vt, 'pnpm build --watch')
  await click(harness.vt, previewRow, 4)
  assert.ok(!/Copy All \[C\]/.test(view(harness.vt)), 'clicking passive preview text does not switch pages')
  assert.deepEqual(harness.copied, [], 'clicking passive preview text copies nothing')

  const heading = bodyRow(harness.vt, 'Copy Command')
  await click(harness.vt, heading, cellIndexOf(harness.vt, heading, 'Copy Command') + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [label], 'Copy Command delivers the official label byte for byte')

  // (2) Expand [Tab] opens the Command page, and Copy All [C] copies the ORIGINAL bytes.
  harness.copied.length = 0
  await click(harness.vt, heading, cellIndexOf(harness.vt, heading, 'Expand [Tab]') + 2)
  assert.match(view(harness.vt), /Copy All \[C\]/, 'Expand [Tab] opens the Command page')
  assert.deepEqual(harness.copied, [], 'opening the page copies nothing by itself')
  const button = bodyRow(harness.vt, 'Copy All [C]')
  await click(harness.vt, button, cellIndexOf(harness.vt, button, 'Copy All [C]') + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [label], 'Copy All [C] delivers the official label byte for byte')
})

test('a 1,500-character command uses adaptive multi-line preview with overflow marker on tall frames and compact summary on short frames', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const longLines = Array.from({ length: 30 }, (_, index) => `cmd-step-${String(index + 1).padStart(2, '0')} ${'--flag=value '.repeat(4)}`).join('\n')
  assert.ok(longLines.length > 1_500, 'the fixture really is plan scale')
  harness.observation.latest()!.emit({ label: longLines, text: 'out' })
  await settle(harness.vt)

  // At 120x40 (no metadata/notice/search): B = 35, cap = min(floor(0.60*35), 35-6) = 21.
  // 30 visual rows > 21 -> 20 command lines + 1 overflow marker `… 10 more rows`.
  const heading = bodyRow(harness.vt, 'Copy Command · Expand [Tab] · Hide [F2]')
  const overflow = bodyRow(harness.vt, '… 10 more rows')
  const tabs = bodyRow(harness.vt, '[Output]  Command')
  assert.equal(overflow - heading, 21, 'preview occupies exactly cap=21 rows (20 lines + 1 marker)')
  assert.equal(tabs, overflow + 1, 'tabs immediately follow the overflow marker with no blank gap')
  assert.ok(plainRows(harness.vt).length - 2 - (tabs + 1) >= 6, 'Output body keeps >= 6 rows floor')

  // Overflow marker is inert.
  await click(harness.vt, overflow, 2)
  assert.ok(!/Copy All \[C\]/.test(view(harness.vt)), 'clicking the overflow marker opens nothing')
  assert.deepEqual(harness.copied, [], 'and never copies')

  // Expand [Tab] opens full Command Reader and Copy All [C] copies the whole original document.
  await click(harness.vt, heading, cellIndexOf(harness.vt, heading, 'Expand [Tab]') + 1)
  assert.match(view(harness.vt), /Copy All \[C\]/)
  const button = bodyRow(harness.vt, 'Copy All [C]')
  await click(harness.vt, button, cellIndexOf(harness.vt, button, 'Copy All [C]') + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [longLines], 'Copy All still delivers the WHOLE original document')
  assert.equal(harness.observation.records.length, 1, 'and never opens a second observer')

  // Return to Output and shrink below R=12: falls back to compact 1-line summary.
  harness.vt.sendInput('\x1b')
  await settle(harness.vt)
  harness.vt.resize(80, 10)
  await settle(harness.vt)
  const compactSummary = bodyRow(harness.vt, 'Command  cmd-step-01')
  const compactTabs = bodyRow(harness.vt, '[Output]  Command')
  assert.equal(compactTabs, compactSummary + 1, 'R < 12 uses compact 1-line summary above tabs')
  assert.match(plainRows(harness.vt)[compactSummary]!, /…/, 'long compact summary is elided')
})

// ── D-05: no faked Command affordance ─────────────────────────────────────

test('a non-shell Job paints Label only: no Command tab, no ↗ entry and no phantom click target', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ kind: 'subagent', label: 'review the diff', text: 'out' })
  await settle(harness.vt)

  const tabs = bodyRow(harness.vt, '[Output]')
  assert.match(plainRows(harness.vt)[tabs]!, /^\[Output\] ─+$/, 'the tab row carries the Output page only')
  assert.match(view(harness.vt), /Label {2}review the diff/, 'the real label is shown as a Label')
  assert.ok(!/↗ Command/.test(view(harness.vt)), 'no Command entry is advertised')
  assert.ok(!/Copy All \[C\]/.test(view(harness.vt)), 'no Copy All is advertised')

  // A click anywhere on the summary row must not switch pages.
  const summary = bodyRow(harness.vt, 'Label  review the diff')
  await click(harness.vt, summary, 6)
  assert.ok(!/Copy All \[C\]/.test(view(harness.vt)), 'the Label summary has no click target')
  // The retired `v` verb is inert here…
  harness.vt.sendInput('v')
  await settle(harness.vt)
  assert.ok(!/Copy All \[C\]/.test(view(harness.vt)), 'the retired `v` verb never opens a Command page')
  // …and the eligibility-gated `Tab` toggle is inert too: a non-shell Job grows no
  // Command page at all, so neither key may switch to one.
  harness.vt.sendInput('\t')
  await settle(harness.vt)
  assert.ok(!/Copy All \[C\]/.test(view(harness.vt)), '`Tab` cannot open a Command page without eligibility')
})

// ── D-06: the independent facts coexist ───────────────────────────────────

test('GAP + ERROR + SETTLED stay independently visible without squeezing the body or the bar', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({
    status: 'failed',
    // A LONG progress/detail pair: the descriptive facts reserve their own room,
    // so neither the gap nor the error reason may become unreachable.
    progress: `step ${'9'.repeat(200)}`,
    detail: 'd'.repeat(200),
    text: numberedLines(0, 39),
    gapBefore: true,
    settled: true,
    error: 'stream reset',
  })
  await settle(harness.vt)

  const status = bodyRow(harness.vt, '‣ Failed')
  assert.match(plainRows(harness.vt)[status]!, /\[GAP\]/, 'the gap fact is visible on the status row')
  assert.match(plainRows(harness.vt)[status]!, /\[ERROR\]/, 'the error fact is visible on the status row')
  assert.match(plainRows(harness.vt)[status]!, /\[SETTLED\]/, 'the settled fact is visible on the status row')
  assert.match(view(harness.vt), /Earlier output evicted/, 'the descriptive gap fact is readable')
  assert.match(view(harness.vt), /Error: stream reset/, 'the follow-stream reason is readable')
  // The facts never displace the body or the pinned bar.
  assert.ok(bodyRow(harness.vt, 'line 039') > status, 'the body survives below the chrome')
  assert.match(plainRows(harness.vt).at(-1)!, /Back \[Esc\]/, 'the Action Bar stays last')
  assert.ok(!/stop/.test(plainRows(harness.vt).at(-1)!), 'a settled Job never advertises Stop')
})

// ── D-07: the three empty phases are distinct ─────────────────────────────

test('connecting / empty / unavailable paint three DIFFERENT bodies, never a black void', async () => {
  // (1) No snapshot yet: the opening identity is a fallback, not a claim.
  const connecting = startApp()
  connecting.observation.syncEmit = false
  await openFirstJob(connecting)
  assert.match(view(connecting.vt), /Waiting for retained output…/)
  assert.match(view(connecting.vt), /Job · job-a · bash/)
  assert.ok(!/Copy All \[C\]/.test(view(connecting.vt)), 'no Command page before the first observation')
  disposeHarness(connecting)

  // (2) Observed with an empty retained tail: a DIFFERENT statement.
  const empty = startApp()
  await openFirstJob(empty)
  empty.observation.latest()!.emit({ text: '' })
  await settle(empty.vt)
  assert.match(view(empty.vt), /No retained output/)
  assert.ok(!/Waiting for retained output/.test(view(empty.vt)), 'an empty tail is not "still connecting"')
  disposeHarness(empty)

  // (3) The port refused to open: the reason stays visible.
  const unavailable = startApp()
  unavailable.observation.openFailure = 'no job controller'
  await openFirstJob(unavailable)
  await flush(6)
  assert.match(view(unavailable.vt), /Retained output unavailable/)
  assert.match(view(unavailable.vt), /\[ERROR\]/)
  assert.match(view(unavailable.vt), /Error: no job controller/)
  assert.equal(unavailable.observation.records.length, 0, 'a refused open never acquired an observer')
})

// ── D-08: no ghost metadata row ───────────────────────────────────────────

test('80x24 with no real metadata grows no blank row and keeps the bounded disclosure on the bar', async () => {
  const harness = startApp(80, 24)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ text: numberedLines(0, 39) })
  await settle(harness.vt)

  const tabs = bodyRow(harness.vt, '[Output]  Command')
  assert.equal(tabs, 3, 'status + heading + 1 preview row + tabs is the whole chrome above the body')
  assert.match(plainRows(harness.vt)[tabs + 1]!, /^line \d{3}/, 'the body starts directly under the tabs')
  assert.equal(bodyRow(harness.vt, 'line 039'), plainRows(harness.vt).length - 2, 'the tail is the last body row')
  const bar = plainRows(harness.vt).at(-1)!
  assert.match(bar, /Retained preview · not full history/, 'the compact-width bar keeps the bounded disclosure')
  assert.ok(!/rows \d+-\d+\/40/.test(bar),
    'the bar may drop the position when the row is tight — the disclosure never is')
  assert.equal(plainRows(harness.vt).filter(row => /Retained preview/.test(row)).length, 1,
    'no dedicated facts row at this size — the pinned Action Bar is the only disclosure row')
  assertRowWidths(harness.vt, 80)
})

// ── D-09/D-10: compact frames ─────────────────────────────────────────────

test('44x8 compact paints `[Out]  Cmd` on one row and keeps the body readable with a CJK identity', async () => {
  const harness = startApp(44, 8)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({
    jobId: '任务-一',
    label: '一个非常长的命令摘要'.repeat(4),
    detail: '正在构建组件'.repeat(6),
    text: numberedLines(0, 39),
  })
  await settle(harness.vt)

  const tabs = bodyRow(harness.vt, '[Out]  Cmd')
  assert.match(plainRows(harness.vt)[tabs]!, /^\[Out\] {2}Cmd ─+$/, 'the compact labels stay on ONE row')
  assert.ok(bodyRow(harness.vt, 'line 039') > tabs, 'the body keeps at least one readable row')
  assert.match(plainRows(harness.vt).at(-1)!, /Back \[Esc\]/, 'the Action Bar stays last')
  assertRowWidths(harness.vt, 44)
})

test('44x5 with a live Find keeps the SearchRow and one body row, and the tabs yield', async () => {
  const harness = startApp(44, 5)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ label: 'echo one', text: 'needle alpha\nother' })
  await settle(harness.vt)

  harness.vt.sendInput('/')
  await settle(harness.vt)
  const rows = plainRows(harness.vt)
  assert.equal(rows.length, 5)
  assert.match(rows[0]!, /Job · job-a · bash/, 'the status title survives')
  assert.match(rows[1]!, /Command {2}echo one/, 'the summary keeps its row')
  assert.match(rows[2]!, /Find Output:/, 'the SearchRow is physically visible, directly under the summary')
  assert.ok(/needle alpha|other/.test(rows[3]!), 'the body keeps at least one readable row')
  assert.match(rows[4]!, /Leave find \[Esc\]/, 'the Action Bar names the CURRENT Esc outcome while the Find is open')
  assert.ok(!/\[Out\]/.test(rows.join('\n')), 'the tabs yield to the SearchRow at this height')
  assert.equal(harness.app.focusedComponentForTest()?.constructor.name, 'JobOutputSearchRow',
    'the physical focus really sits on the visible SearchRow')
})

// ── D-11/D-12: the short-screen floor ─────────────────────────────────────

test('44x4 keeps status + SearchRow + body + Action Bar, and a live notice yields instead', async () => {
  const harness = startApp(44, 4)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ label: 'echo one', text: 'needle alpha\nother' })
  await settle(harness.vt)
  harness.vt.sendInput('/')
  await settle(harness.vt)

  let rows = plainRows(harness.vt)
  assert.equal(rows.length, 4, 'exactly four physical rows')
  assert.match(rows[0]!, /Job · job-a · bash/)
  assert.match(rows[1]!, /Find Output:/)
  assert.ok(/needle alpha|other/.test(rows[2]!), 'the body keeps its one row')
  assert.match(rows[3]!, /Leave find \[Esc\]/, 'the bar names the CURRENT Esc outcome while the Find is open')
  harness.vt.sendInput('\x1b')
  await settle(harness.vt)

  // A live notice may never take the body's last row: at four rows it yields.
  harness.app.notify('could not stop job job-a: refused', 'error')
  await settle(harness.vt)
  rows = plainRows(harness.vt)
  assert.equal(rows.length, 4)
  assert.ok(!/could not stop/.test(rows.join('\n')), 'the notice yields at four rows')
  assert.match(rows[3]!, /Back \[Esc\]/)
  assert.ok(rows.slice(0, 3).some(row => /needle alpha|other/.test(row)), 'the body row survives')
})

test('80x2 keeps the status + Action Bar, 80x1 keeps the Action Bar alone, and Esc really exits', async () => {
  const harness = startApp(80, 2)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ text: 'retained job-a' })
  await settle(harness.vt)
  let rows = plainRows(harness.vt)
  assert.equal(rows.length, 2, 'two physical rows')
  assert.match(rows[0]!, /Job · job-a · bash/)
  assert.match(rows[1]!, /Back \[Esc\]/)

  harness.vt.resize(80, 1)
  await settle(harness.vt)
  rows = plainRows(harness.vt)
  assert.equal(rows.length, 1, 'ONE physical row')
  assert.match(rows[0]!, /Back \[Esc\]/, 'the Action Bar is never budgeted away')

  // The escape hatch really works at the floor: the workspace closes and the
  // observation is released exactly once.
  harness.vt.sendInput('\x1b')
  await settle(harness.vt)
  assert.ok(!/Job · job-a/.test(view(harness.vt)), 'Esc leaves the workspace')
  assert.deepEqual(harness.observation.records.map(record => record.closes), [1],
    'leaving releases the ONE observer exactly once')
  assertRowWidths(harness.vt, 80)
})

// ── D-13/D-17: hit-map re-projection and stale presses ────────────────────

test('a resize re-projects the hit map, keeps the current page AND its query, and rejects the moved press', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const label = Array.from({ length: 30 }, (_, index) => `cmd line ${String(index).padStart(2, '0')}`).join('\n')
  harness.observation.latest()!.emit({ label, text: 'out' })
  await settle(harness.vt)

  // Enter the Command page through the painted tab, verify Copy All [C] before
  // Find, then open a UNIQUE query on THIS page.
  const outputTabs = bodyRow(harness.vt, '[Output]  Command')
  await click(harness.vt, outputTabs, cellIndexOf(harness.vt, outputTabs, 'Command'))
  assert.match(view(harness.vt), /Copy All \[C\]/, 'the exact-copy button is painted while Find is inactive')
  const wideButtonRow = bodyRow(harness.vt, 'Copy All [C]')
  const wideButtonCol = cellIndexOf(harness.vt, wideButtonRow, 'Copy All [C]') + 2
  const wideTabs = bodyRow(harness.vt, 'Output  [Command]')
  const outputCol = cellIndexOf(harness.vt, wideTabs, 'Output') + 1

  // Press the Output TAB in the WIDE frame, then shrink: after the shrink the
  // SAME cell holds a DIFFERENT painted range (`Output` -> `Out`), so the stale
  // press must not switch pages.
  press(harness.vt, wideTabs, outputCol)
  harness.vt.resize(44, 8)
  await settle(harness.vt)
  assert.match(view(harness.vt), /Out {2}\[Cmd\]/, 'the compact tabs are re-projected')
  release(harness.vt, wideTabs, outputCol)
  await flush(6)
  assert.ok(!/\[Out\]  Cmd/.test(view(harness.vt)), 'the moved press never switched the page')
  assert.deepEqual(harness.copied, [], 'and it never copied')

  // The wide-only button cell is OUTSIDE the shrunk frame: hidden affordances keep
  // no target at all.
  press(harness.vt, wideButtonRow, wideButtonCol)
  release(harness.vt, wideButtonRow, wideButtonCol)
  await flush(6)
  assert.deepEqual(harness.copied, [], 'the compact button copies only at its OWN painted cells')

  // Open a Command query and verify it survives resize up and down.
  harness.vt.sendInput('/')
  await settle(harness.vt)
  harness.vt.sendInput('cmd line 07')
  await settle(harness.vt)
  assert.match(view(harness.vt), /1\/1/, 'narrow Input width still matches against the full body width')
  harness.vt.resize(120, 40)
  await settle(harness.vt)
  assert.match(view(harness.vt), /Find Command: cmd line 07/, 'the query is still live after growing back')
  assert.match(view(harness.vt), /Output  \[Command\]/, 'the Command page is still current')
  assert.equal(harness.observation.records.length, 1, 'the resize never re-opened the observation')

  // Leave Find, shrink back to 44x8, and verify the re-projected compact button copies.
  harness.vt.sendInput('\x1b')
  await settle(harness.vt)
  harness.vt.resize(44, 8)
  await settle(harness.vt)
  const compactRow = bodyRow(harness.vt, 'Copy All [C]')
  await click(harness.vt, compactRow, cellIndexOf(harness.vt, compactRow, 'Copy All [C]') + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [label], 'the re-projected button copies the whole original command')
})

test('an 8-column tab row keeps its truncation ellipsis inert (real press/release)', async () => {
  const harness = startApp(8, 24)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ label: 'echo hello', text: 'retained body' })
  await settle(harness.vt)

  // At 8 columns the preview heading fits `Command` alone (no actions) and the
  // tab row is truncated: clicking the truncation ellipsis stays inert.
  const tabs = bodyRow(harness.vt, '[Out]')
  const row = plainRows(harness.vt)[tabs]!
  assert.match(row, /…$/, 'the tab row really is truncated')
  // Press + release on the LAST painted cell — the truncation glyph, not a label.
  press(harness.vt, tabs, visibleWidth(row) - 1)
  release(harness.vt, tabs, visibleWidth(row) - 1)
  await flush(6)
  assert.ok(!/Full co/.test(view(harness.vt)), 'the ellipsis never opens the Command page')
  assert.deepEqual(harness.copied, [], 'a click alone never copies')
  harness.vt.sendInput('c')
  await flush(6)
  assert.deepEqual(harness.copied, ['retained body'],
    'the still-current Output page owns the copy verb (never the command)')
  assert.equal(harness.observation.records.length, 1, 'no second observer')
})

test('a press whose painted frame changed before the release never fires', async () => {
  // (a) SAME panel, SAME cell: the Job's label changes between press and release,
  // so the painted `↗ Command` target now belongs to a DIFFERENT Command source.
  const labelChange = startApp(120, 40)
  await openFirstJob(labelChange)
  labelChange.observation.latest()!.emit({ label: 'echo one', text: 'out' })
  await settle(labelChange.vt)
  const heading = bodyRow(labelChange.vt, 'Expand [Tab]')
  const entryCol = cellIndexOf(labelChange.vt, heading, 'Expand [Tab]') + 1
  press(labelChange.vt, heading, entryCol)
  labelChange.observation.latest()!.emit({ label: 'echo two', text: 'out' })
  await settle(labelChange.vt)
  release(labelChange.vt, heading, entryCol)
  await flush(6)
  assert.ok(!/Copy All \[C\]/.test(view(labelChange.vt)),
    'a press from the previous Command source never opens the new one')
  assert.deepEqual(labelChange.copied, [], 'and it never copies')
  disposeHarness(labelChange)

  // (b) The Job itself is replaced between press and release: the new workspace
  // must never inherit the old press.
  const jobSwap = startApp(120, 40, ['job-a', 'job-b'])
  await openFirstJob(jobSwap)
  jobSwap.observation.latest()!.emit({ label: 'echo one', text: 'out' })
  await settle(jobSwap.vt)
  const tabs = bodyRow(jobSwap.vt, '[Output]  Command')
  const commandCol = cellIndexOf(jobSwap.vt, tabs, 'Command')
  press(jobSwap.vt, tabs, commandCol)
  jobSwap.tasks.openJobView('job-b')
  await settle(jobSwap.vt)
  release(jobSwap.vt, tabs, commandCol)
  await flush(6)
  assert.match(view(jobSwap.vt), /Job · job-b · bash/, 'the NEW Job owns the screen')
  assert.ok(!/Copy All \[C\]/.test(view(jobSwap.vt)), 'the stale press never opens the replaced Job page')
  assert.deepEqual(jobSwap.copied, [], 'and it never copies')
})

// ── D-18/D-24: the per-page native copy-on-select ─────────────────────────

test('the Command page owns the EXACT selection copy; the Output page keeps the native one', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const label = 'echo alpha beta'
  harness.observation.latest()!.emit({ label, text: 'retained job-a' })
  await settle(harness.vt)
  const heading = bodyRow(harness.vt, 'Expand [Tab]')
  await click(harness.vt, heading, cellIndexOf(harness.vt, heading, 'Expand [Tab]') + 1)

  // A native DOUBLE click on Command text must NOT write a word: the Command
  // page suspends the fork's copy-on-select so the exact-copy affordance cannot
  // be raced by a word selection (D-24).
  const commandRow = bodyRow(harness.vt, label)
  press(harness.vt, commandRow, 2)
  release(harness.vt, commandRow, 2)
  press(harness.vt, commandRow, 2)
  release(harness.vt, commandRow, 2)
  await flush(6)
  assert.deepEqual(harness.copied, [], 'a Command double click never produces a native word copy')

  // An explicit DRAG is still the reader's OWN original-bytes selection.
  press(harness.vt, commandRow, 0)
  drag(harness.vt, commandRow, 8)
  release(harness.vt, commandRow, 8)
  await flush(6)
  assert.deepEqual(harness.copied, [label.slice(0, 9)],
    'the drag copies the EXACT original range through the reader mapping')

  // Back on Output the screen's own copy-on-select is live again.
  harness.copied.length = 0
  harness.vt.sendInput('\x1b')
  await settle(harness.vt)
  const body = bodyRow(harness.vt, 'retained job-a')
  press(harness.vt, body, 0)
  drag(harness.vt, body, 7)
  release(harness.vt, body, 7)
  await flush(6)
  assert.ok(harness.copied.length > 0, 'the Output page keeps the native selection copy')
  assert.ok(harness.copied.every(text => text !== label), 'that native copy is screen text, never the Command payload')

  // D-18: the tab interaction never wedges the BODY — entering through the tab and
  // wheeling over the body really scrolls the CURRENT page's viewport.
  harness.copied.length = 0
  const heading2 = bodyRow(harness.vt, 'Expand [Tab]')
  await click(harness.vt, heading2, cellIndexOf(harness.vt, heading2, 'Expand [Tab]') + 1)
  harness.observation.latest()!.emit({
    label: Array.from({ length: 60 }, (_, index) => `cmd wheel ${String(index).padStart(2, '0')}`).join('\n'),
    text: 'retained job-a',
  })
  await settle(harness.vt)
  const firstCommandRow = (): string => rawView(harness.vt).map(line => stripTerminalSequences(line).trim())
    .find(line => /^cmd wheel \d\d/.test(line)) ?? ''
  const beforeWheel = firstCommandRow()
  assert.notEqual(beforeWheel, '', 'the Command body is painted')
  harness.vt.sendInput('\x1b[<65;40;12M') // one wheel notch DOWN over the body
  await settle(harness.vt)
  assert.notEqual(firstCommandRow(), beforeWheel, 'the wheel really moved the Command viewport')
  assert.match(view(harness.vt), /Copy All \[C\]/, 'and the Command page is still the current page')
  assert.deepEqual(harness.copied, [], 'scrolling never copies')
})

test('a TAB-origin rapid double click on Copy All [C] copies only the original label, and Output keeps its native drag', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const label = 'echo hello\nworld'
  harness.observation.latest()!.emit({ label, text: 'retained job-a' })
  await settle(harness.vt)

  // Enter the Command page through the painted TAB (not the `v` key).
  const tabs = bodyRow(harness.vt, '[Output]  Command')
  await click(harness.vt, tabs, cellIndexOf(harness.vt, tabs, 'Command'))
  assert.match(view(harness.vt), /Copy All \[C\]/, 'the tab opened the Command page')

  // TWO same-cell clicks inside the fork's 500 ms double-click window: the second
  // is classified as a word selection, which must never overwrite (or add to) the
  // exact command copy the button made.
  const buttonRow = bodyRow(harness.vt, 'Copy All [C]')
  const buttonCol = cellIndexOf(harness.vt, buttonRow, 'Copy All [C]') + 2
  press(harness.vt, buttonRow, buttonCol)
  release(harness.vt, buttonRow, buttonCol)
  press(harness.vt, buttonRow, buttonCol)
  release(harness.vt, buttonRow, buttonCol)
  await flush(6)
  assert.deepEqual(harness.copied, [label], 'the clipboard holds ONLY the original label')
  assert.ok(!harness.copied.some(text => text === 'Copy' || text === 'All'), 'no native word selection ever ran')

  // Back on Output the screen's OWN copy-on-select is live again.
  harness.copied.length = 0
  harness.vt.sendInput('\x1b')
  await settle(harness.vt)
  const body = bodyRow(harness.vt, 'retained job-a')
  press(harness.vt, body, 0)
  drag(harness.vt, body, 7)
  release(harness.vt, body, 7)
  await flush(6)
  assert.ok(harness.copied.length > 0, 'the Output page keeps the native selection copy')
  assert.ok(harness.copied.every(text => text !== label), 'that native copy is screen text, never the command payload')
})

// ── D-16/D-19: live theme + real statuses ─────────────────────────────────

test('D-16/D-19 the status follows the LIVE theme and every real status keeps its own text', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ text: 'out' })
  await settle(harness.vt)

  // running maps to the palette's primary token, in the CURRENT palette.
  const statusRow = bodyRow(harness.vt, '‣ Running')
  const darkDot = harness.vt.getCellFgRgb(statusRow, cellIndexOf(harness.vt, statusRow, '‣'))
  assert.equal(darkDot, hexToRgb(currentPalette.primary), 'the running dot uses the live primary token')

  // The WHOLE chrome follows the token, not just the dot: the selected tab, the
  // plain tab and the rule each carry their own palette colour.
  const chromeColors = (): { selected?: number; plain?: number; rule?: number; bar: number } => {
    const row = bodyRow(harness.vt, 'Output') // matches both the wide and the compact tab row
    const plain = plainRows(harness.vt)[row]!
    if (plain.includes('[Output]')) {
      return {
        selected: harness.vt.getCellFgRgb(row, cellIndexOf(harness.vt, row, '[Output]')),
        plain: harness.vt.getCellFgRgb(row, cellIndexOf(harness.vt, row, 'Command')),
        rule: harness.vt.getCellFgRgb(row, cellIndexOf(harness.vt, row, '─')),
        bar: harness.vt.getCellFgRgb(plainRows(harness.vt).length - 1, 0) ?? -1,
      }
    }
    return {
      selected: harness.vt.getCellFgRgb(row, cellIndexOf(harness.vt, row, '[Out]')),
      plain: harness.vt.getCellFgRgb(row, cellIndexOf(harness.vt, row, 'Cmd')),
      rule: harness.vt.getCellFgRgb(row, cellIndexOf(harness.vt, row, '─')),
      bar: harness.vt.getCellFgRgb(plainRows(harness.vt).length - 1, 0) ?? -1,
    }
  }
  const darkChrome = chromeColors()
  assert.equal(darkChrome.selected, hexToRgb(currentPalette.primary), 'the current tab uses the primary token')
  assert.equal(darkChrome.plain, hexToRgb(currentPalette.textDim), 'the other tab uses the dim token')
  assert.equal(darkChrome.rule, hexToRgb(currentPalette.border), 'the rule uses the border token')
  assert.equal(darkChrome.bar, hexToRgb(currentPalette.textMuted), 'the Action Bar uses the muted token (role 13)')

  harness.app.applyTheme('light')
  await settle(harness.vt)
  const lightStatusRow = bodyRow(harness.vt, '‣ Running')
  assert.match(plainRows(harness.vt)[lightStatusRow]!, /‣ Running/, 'the status TEXT survives the switch')
  assert.equal(harness.vt.getCellFgRgb(lightStatusRow, cellIndexOf(harness.vt, lightStatusRow, '‣')),
    hexToRgb(currentPalette.primary), 'the dot follows the LIGHT palette after the live switch')
  assert.notEqual(hexToRgb(currentPalette.primary), darkDot, 'the two palettes really differ')
  const lightChrome = chromeColors()
  assert.equal(lightChrome.selected, hexToRgb(currentPalette.primary), 'the current tab follows the light palette')
  assert.equal(lightChrome.plain, hexToRgb(currentPalette.textDim), 'the plain tab follows the light palette')
  assert.equal(lightChrome.rule, hexToRgb(currentPalette.border), 'the rule follows the light palette')
  assert.equal(lightChrome.bar, hexToRgb(currentPalette.textMuted), 'the Action Bar follows the light palette')
  assert.notEqual(lightChrome.bar, darkChrome.bar, 'the Action Bar is really repainted, never cached')

  // A CUSTOM palette is just as live: every chrome cell takes the custom tokens
  // (the resolved palette is what the renderers read per frame).
  const custom = { ...darkColors, primary: '#FF2FD0', textDim: '#123456', textMuted: '#654321', border: '#00FF66' }
  harness.app.applyPalette(custom)
  await settle(harness.vt)
  assert.equal(currentPalette.primary, '#FF2FD0', 'the custom palette really is active')
  const customChrome = chromeColors()
  assert.equal(customChrome.selected, hexToRgb('#FF2FD0'), 'the tab follows the CUSTOM primary')
  assert.equal(customChrome.plain, hexToRgb('#123456'), 'the plain tab follows the CUSTOM dim')
  assert.equal(customChrome.rule, hexToRgb('#00FF66'), 'the rule follows the CUSTOM border')
  assert.equal(customChrome.bar, hexToRgb('#654321'), 'the Action Bar follows the CUSTOM muted token')
  assert.notEqual(customChrome.selected, lightChrome.selected, 'and it is not a cached light render')

  // A failed Job uses the warning token (never a hard-coded red) and an unknown
  // status renders without crashing.
  harness.app.applyTheme('dark')
  harness.observation.latest()!.emit({ status: 'failed', text: 'out' })
  await settle(harness.vt)
  const failedRow = bodyRow(harness.vt, '‣ Failed')
  assert.equal(harness.vt.getCellFgRgb(failedRow, cellIndexOf(harness.vt, failedRow, '‣')),
    hexToRgb(currentPalette.warning), 'taskStatusColor(failed) is the warning token, not a hard-coded red')
  // Every real terminal status keeps its OWN token (completed = dim, killed =
  // warning) and its own Title Case word; an unknown wire status renders as
  // itself and never crashes.
  for (const [status, token, word] of [
    ['completed', currentPalette.textDim, 'Completed'],
    ['killed', currentPalette.warning, 'Killed'],
    ['future-status', currentPalette.textMuted, 'future-status'],
  ] as const) {
    harness.observation.latest()!.emit({ status, text: 'out' })
    await settle(harness.vt)
    const row = bodyRow(harness.vt, `‣ ${word}`)
    assert.equal(harness.vt.getCellFgRgb(row, cellIndexOf(harness.vt, row, '‣')), hexToRgb(token),
      `taskStatusColor(${status}) must be the ${word} token`)
  }
})

// ── D-20/D-25: cell-exact wide text and a single disclosure ───────────────

test('CJK/wide identity and label stay terminal-cell exact at 120x40, 200x60 and 80x24', async () => {
  for (const [width, height] of [[120, 40], [200, 60], [80, 24]] as const) {
    const harness = startApp(width, height)
    await openFirstJob(harness)
    harness.observation.latest()!.emit({
      jobId: '作业-一二三',
      label: '构建并测试整个项目'.repeat(8),
      detail: '正在处理'.repeat(20),
      text: numberedLines(0, 39),
    })
    await settle(harness.vt)
    assertRowWidths(harness.vt, width)
    const tabs = bodyRow(harness.vt, '[Output]  Command')
    assert.match(plainRows(harness.vt)[tabs]!, /^\[Output\] {2}Command ─+$/, 'the rule fills the row exactly')
    assert.match(view(harness.vt), /‣ Running/)
    harness.app.dispose()
    startedApps.delete(harness.app)
  }
})

test('an emoji/combining identity and label stay terminal-cell exact', async () => {
  for (const [width, height] of [[120, 40], [44, 8]] as const) {
    const harness = startApp(width, height)
    await openFirstJob(harness)
    harness.observation.latest()!.emit({
      jobId: '👨‍👩‍👧-e\u0301',
      label: 'a\u0301b👨‍👩‍👧c'.repeat(20),
      text: numberedLines(0, 39),
    })
    await settle(harness.vt)
    assertRowWidths(harness.vt, width)
    const tabs = bodyRow(harness.vt, width >= 80 ? '[Output]  Command' : '[Out]  Cmd')
    const row = plainRows(harness.vt)[tabs]!.trimEnd()
    assert.equal(visibleWidth(row), width, `the tab row fills exactly ${width} cells`)
    const rule = row.slice(row.lastIndexOf('─'))
    assert.match(rule, /^─+$/, 'the row ends in one uninterrupted rule run')
    assert.equal(rule.length, visibleWidth(rule), 'every rule glyph is exactly one terminal cell')
    harness.app.dispose()
    startedApps.delete(harness.app)
  }
})

test('the bounded-preview disclosure is advertised EXACTLY once per frame', async () => {
  // Standard width: the dedicated facts row owns it, the bar does not repeat it.
  const standard = startApp(120, 40)
  await openFirstJob(standard)
  standard.observation.latest()!.emit({ text: numberedLines(0, 39) })
  await settle(standard.vt)
  const standardRows = plainRows(standard.vt)
  assert.equal(standardRows.filter(row => /Retained preview · not full history/.test(row)).length, 1,
    'one disclosure on a standard frame')
  assert.match(standardRows.at(-1)!, /Back \[Esc\]/)
  assert.ok(!/Retained preview/.test(standardRows.at(-1)!), 'the bar does not repeat the facts row')
  disposeHarness(standard)

  // Compact width: no facts row exists, so the BAR must carry the bounded
  // disclosure — never a claim of full history.
  const compact = startApp(80, 24)
  await openFirstJob(compact)
  compact.observation.latest()!.emit({ text: numberedLines(0, 39) })
  await settle(compact.vt)
  const compactRows = plainRows(compact.vt)
  assert.equal(compactRows.filter(row => /Retained preview · not full history/.test(row)).length, 1,
    'one disclosure on a compact frame')
  assert.match(compactRows.at(-1)!, /Retained preview · not full history/)
  assert.ok(!/full history\b/.test(compactRows.at(-1)!.replace('not full history', '')), 'never a full-history claim')
})

// ── D-23: the chrome safety boundary survives the new layout ──────────────

test('a hostile label is sanitized on the NEW header rows and never reaches the terminal stream', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const written: string[] = []
  const originalWrite = harness.vt.write.bind(harness.vt)
  harness.vt.write = (data: string) => {
    written.push(data)
    originalWrite(data)
  }
  // OSC 52 + CSI + a raw 8-bit CSI (C1) + DEL: the C1/DEL bytes have no ESC
  // prefix, so only the control-byte strip can keep them off the terminal.
  const hostile = `\u001b]52;c;${Buffer.from('PWNED').toString('base64')}\u0007echo ok\u001b[2J\u009b31m\u007f`
  assert.ok(hostile.includes('\u009b') && hostile.includes('\u007f'), 'the fixture really carries raw C1/DEL bytes')
  harness.observation.latest()!.emit({ label: hostile, detail: hostile, progress: hostile, text: 'tail' })
  await settle(harness.vt)

  const stream = written.join('')
  assert.ok(!stream.includes('\u001b]52;c;'), 'no raw Host OSC reaches the terminal stream')
  assert.ok(!stream.includes('\u009b'), 'no raw C1 control byte reaches the terminal stream')
  assert.ok(!stream.includes('\u007f'), 'no raw DEL control byte reaches the terminal stream')
  const rows = plainRows(harness.vt)
  const metaRow = rows.find(line => line.includes('Progress: echo ok')) ?? ''
  assert.match(metaRow, /Progress: echo ok/, 'the metadata row shows the sanitized progress')
  assert.match(metaRow, /Detail: echo ok/, 'the metadata row shows the sanitized detail')
  assert.ok(!/\]52;c;|\[2J/.test(metaRow), 'no escape payload text leaks into the painted metadata chrome')
  assert.match(view(harness.vt), /\\x1b\]52;c;.*echo ok/, 'the Command preview displays escaped safe text with zero raw controls')

  // The official bytes still reach the Command copy verb untouched.
  const heading = bodyRow(harness.vt, 'Copy Command')
  await click(harness.vt, heading, cellIndexOf(harness.vt, heading, 'Copy Command') + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [hostile], 'the copy payload stays the official original')
})

// ── D-23b: hostile RETAINED OUTPUT is projected at the body seam ───────────

test('hostile retained output reaches the TTY only as safe text, keeps whitelisted SGR and copies byte-exact', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const hostile = [
    '\u001b]52;c;YXR0YWNr\u0007', // clipboard OSC 52
    '\u001b]0;hijacked-title\u001b\\', // title OSC 0 (ST-terminated)
    '\u001b[2J\u001b[H', // screen / cursor
    '\u001b[?1049h', // alternate screen (payload copy of an app-owned sequence)
    '\u001b[?1000h', // mouse mode
    '\u001bPbad\u001b\\', // DCS
    '\u009b2J', // raw 8-bit C1 CSI
    '\u001b[38;2;999;1;1m', // invalid SGR must be dropped whole
    'ok ', // plain text survives
    '\u001b[38;5;196mred\u001b[0m', // whitelisted 256-color SGR survives
    ' end\r10%\r100%\n', // CR progress frames read as separate records
  ].join('')
  harness.observation.latest()!.emit({ text: hostile })
  await settle(harness.vt)
  await harness.vt.waitForRender()

  const painted = view(harness.vt)
  assert.match(painted, /ok/, 'the plain payload text is painted')
  assert.match(painted, /red/, 'the colored payload text is painted')
  assert.match(painted, /end/)
  assert.match(painted, /10%/, 'a CR frame is a readable record')
  assert.match(painted, /100%/, 'the trailing CR frame too')
  assert.ok(!painted.includes('[38;5;196m') && !painted.includes('[38;2;999;1;1m'),
    'no escape payload leaks as literal text into the painted body')

  const stream = harness.vt.writes.join('')
  // App-owned protocol (alt screen / mouse / clear) legitimately appears; the
  // payload's OWN bytes must never ride along.
  assert.ok(!stream.includes('YXR0YWNr'), 'no OSC 52 clipboard payload reaches the terminal stream')
  assert.ok(!stream.includes('hijacked-title'), 'no OSC 0 title payload reaches the terminal stream')
  assert.ok(!stream.includes('\u001bPbad'), 'no DCS payload reaches the terminal stream')
  assert.ok(!stream.includes('\u009b'), 'no raw C1 control byte reaches the terminal stream')
  assert.ok(!stream.includes('\u001b[38;2;999;1;1m'), 'the malformed SGR is never forwarded')
  assert.ok(stream.includes('\u001b[38;5;196m'), 'the whitelisted 256-color SGR really reaches the TTY')

  // C on the Output page copies the RAW observation, not the display projection.
  harness.copied.length = 0
  harness.vt.sendInput('c')
  await flush(6)
  assert.deepEqual(harness.copied, [hostile], 'the output copy stays the official original bytes')
})

// ── C-19: the `Tab` page toggle is symmetric and `v` is inert ──────────────

test('Tab switches Output <-> Command in BOTH directions and v is inert', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({ label: 'pnpm build --watch', text: numberedLines(0, 39) })
  await settle(harness.vt)

  // (1) The Output header advertises Expand [Tab], and the retired `v command`
  // hint does not exist anywhere on the frame any more.
  assert.match(view(harness.vt), /Expand \[Tab\]/, 'the Output header advertises Expand [Tab]')
  assert.ok(!/v command/.test(view(harness.vt)), 'the retired `v command` hint is never painted')
  // The Output page's OWN body rows, remembered before the round trip.
  const tabsBefore = bodyRow(harness.vt, '[Output]  Command')
  const factsBefore = bodyRow(harness.vt, 'Retained preview · not full history')
  const outputBody = plainRows(harness.vt).slice(tabsBefore + 1, factsBefore)
  assert.ok(outputBody.length > 0 && /^line \d{3}/.test(outputBody[0]!), 'the Output body is really painted')

  // (2) `Tab` opens the Command page: Command-page-only chrome is painted.
  harness.vt.sendInput('\t')
  await settle(harness.vt)
  assert.match(view(harness.vt), /^Output {2}\[Command\] ─+$/m, 'the Command tab is the focused one')
  assert.match(plainRows(harness.vt).at(-1)!, /Output \[Esc\]/, 'the Command bar advertises `Output [Esc]`')
  assert.match(view(harness.vt), /Full command/, 'the Full command summary row is painted')
  assert.ok(!/line \d{3}/.test(view(harness.vt)), 'the Output body is not painted on the Command page')

  // (3) `Tab` again returns to Output: the Output-only chrome and exactly the
  // SAME body rows that were painted before the round trip come back.
  harness.vt.sendInput('\t')
  await settle(harness.vt)
  assert.match(view(harness.vt), /^\[Output\] {2}Command ─+$/m, 'the Output tab is focused again')
  assert.match(plainRows(harness.vt).at(-1)!, /Back \[Esc\]/, 'the Output bar advertises `Back [Esc]`')
  const tabsAfter = bodyRow(harness.vt, '[Output]  Command')
  const factsAfter = bodyRow(harness.vt, 'Retained preview · not full history')
  assert.deepEqual(plainRows(harness.vt).slice(tabsAfter + 1, factsAfter), outputBody,
    'the Output body rows are exactly the ones painted before the round trip')

  // (4) `v` is now completely inert: the page stays on Output with its own body.
  harness.vt.sendInput('v')
  await settle(harness.vt)
  assert.match(view(harness.vt), /^\[Output\] {2}Command ─+$/m, '`v` did not leave the Output page')
  assert.match(plainRows(harness.vt).at(-1)!, /Back \[Esc\]/, 'the Output bar is still the painted one')
  assert.ok(!/Output \[Esc\]/.test(view(harness.vt)), 'the Command page was never entered by `v`')
})

// ── B-18: BOTH metadata groups drop a fact WHOLE before truncating ─────────

test('the metadata row drops a long Detail whole and truncates only a lone fact', async () => {
  const harness = startApp(100, 40)
  await openFirstJob(harness)
  harness.observation.latest()!.emit({
    label: 'pnpm build',
    progress: '3/8 checks',
    detail: `building ${'d'.repeat(160)}`,
    text: numberedLines(1, 20),
  })
  await settle(harness.vt)
  await harness.vt.waitForRender()
  assert.match(view(harness.vt), /Progress: 3\/8 checks/,
    'the higher-priority progress fact is kept whole')
  assert.ok(!/Detail:/.test(view(harness.vt)),
    `a Detail that cannot fit whole is DROPPED, never cut mid-word:\n${view(harness.vt)}`)

  // A LONE fact is the exception the rule allows: with nothing else to keep it
  // truncates rather than disappearing, and the ellipsis is the only partial text a
  // chrome row may ever show.
  harness.observation.latest()!.emit({
    label: 'pnpm build',
    detail: `building ${'d'.repeat(160)}`,
    text: numberedLines(1, 20),
  })
  await settle(harness.vt)
  await harness.vt.waitForRender()
  assert.ok(!/Progress:/.test(view(harness.vt)), 'the progress fact is gone with the newer snapshot')
  assert.match(view(harness.vt), /^Detail: .*…$/m, 'a lone Detail truncates with the ellipsis')
})

// ── D-26: the frozen §11.2 degradation-ladder matrix (rollout PR4) ──────────
//
// D-08/D-11/D-12 pin the compact/floor frames and D-25 pins the single
// disclosure at 120x40/80x24; this walks the frozen §11.2 matrix and asserts the
// §8 ladder-derived chrome at every size. The metadata snapshot is emitted so
// the metadata grant is really exercised; a live notice is added in a second
// pass to exercise the notice row's own grant.

interface JobLadder {
  readonly compact: boolean
  readonly metadataRows: number
  readonly summaryRows: number
  readonly previewRows: number
  readonly tabRows: number
  readonly noticeRows: number
  readonly readingFactsRows: number
  readonly bodyRows: number
}

function jobLadder(
  width: number,
  rows: number,
  options: { readonly noticeLive: boolean; readonly metadataAvailable: boolean; readonly commandVisualRows?: number },
): JobLadder {
  const safeRows = Math.max(1, Math.floor(rows))
  const compact = width < 80 || safeRows < 10
  let remaining = safeRows - 1 // the pinned Action Bar
  const minBodyRows = safeRows >= 3 ? 1 : 0
  if (safeRows >= 2) remaining -= 1 // the status title
  const grant = (minRows: number, condition: boolean, minBody = minBodyRows): number => {
    if (!condition || safeRows < minRows || remaining - 1 < minBody) return 0
    remaining -= 1
    return 1
  }
  const summaryRows = grant(5, true)
  const tabRows = grant(5, true)
  const noticeRows = grant(6, options.noticeLive)
  const metadataRows = grant(10, !compact && options.metadataAvailable, Math.max(minBodyRows, 4))
  const readingFactsRows = grant(12, width >= 100, Math.max(minBodyRows, 6))
  const commandVisualRows = options.commandVisualRows ?? 1
  const cap = Math.max(0, Math.min(Math.floor(remaining * 0.6), remaining - 6))
  const previewRows = safeRows >= 12 && summaryRows === 1 && tabRows === 1 && cap >= 2 && commandVisualRows > 0
    ? Math.min(commandVisualRows, cap)
    : 0
  remaining -= previewRows
  return { compact, metadataRows, summaryRows, previewRows, tabRows, noticeRows, readingFactsRows, bodyRows: remaining }
}

/** The frozen §11.2 matrix. */
const JOB_MATRIX = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const

test('the frozen §11.2 matrix keeps the §8 ladder-derived chrome at every size', async () => {
  for (const [width, height] of JOB_MATRIX) {
    for (const noticeLive of [false, true]) {
      const harness = startApp(width, height)
      await openFirstJob(harness)
      harness.observation.latest()!.emit({
        progress: '3/8 checks',
        detail: 'Building components',
        text: numberedLines(0, 39),
      })
      await settle(harness.vt)
      await harness.vt.waitForRender()
      if (noticeLive) {
        harness.app.notify('governance notice', 'info')
        await settle(harness.vt)
      }
      const ladder = jobLadder(width, height, { noticeLive, metadataAvailable: true })
      const painted = plainRows(harness.vt)
      assert.equal(painted.length, height, `the frame must paint exactly ${height} rows at ${width}x${height}`)
      const frame: PaintedFrame = {
        rows: painted,
        readColor: (row, col) => harness.vt.getCellFgRgb(row, col),
        primaryRgb: hexToRgb(currentPalette.primary),
      }

      // §8 invariants 1 + 2 (shared helper): the bar is last and the PREDICTED body
      // rows (from the ladder, not from the painted text) must carry the Job's OWN
      // retained text (`line NNN` from the fixture), so a blanked body cannot pass on
      // plausible indexes alone.
      assertBarIsLastRow(painted, frame.readColor, 'Back [Esc]')
      assertNoHalfSegmentInBar(painted, painted.length - 1, ' · ')
      assertRowWidths(harness.vt, width)
      const tabsRow = 1 + ladder.metadataRows + ladder.summaryRows + ladder.previewRows
      const bodyTop = tabsRow + ladder.tabRows
      const bodyIndexes = Array.from({ length: ladder.bodyRows }, (_, index) => bodyTop + index)
      assertBodyFloor(painted, bodyIndexes, line => /^line \d{3}/.test(line), `Job ${width}x${height}`)

      // §11.3.2/§4.5: the tab row owns exactly ONE active device — the focused tab
      // (`[Output]` wide, `[Out]` compact). A primary badge (`Copy All [C]`) or a
      // bracket in the Host body is not a chrome device; only the tab row is scanned.
      const expectedTab = ladder.compact ? '[Out]' : '[Output]'
      const activeDevice = assertOneActiveDevice(frame, {
        rows: ladder.tabRows === 1 ? [tabsRow] : [],
        labelPrefixes: ['[Output]', '[Command]', '[Out]', '[Cmd]'],
      })
      assert.deepEqual(activeDevice, ladder.tabRows === 1 ? [expectedTab] : [],
        `the focused reading tab at ${width}x${height}:\n${view(harness.vt)}`)

      // §8 step 5: the reading-tab row and the Command/Label summary row follow the
      // body floor (and the tab row follows the compactness).
      assert.equal(painted.some(line => line.includes(expectedTab)), ladder.tabRows === 1,
        `the tab row at ${width}x${height}:\n${view(harness.vt)}`)
      const otherTabToken = ladder.compact ? '[Output]' : '[Out]'
      assert.ok(!painted.some(line => line.includes(otherTabToken)),
        `the tab row's compactness at ${width}x${height}:\n${view(harness.vt)}`)
      assert.equal(
        painted.some(line => ladder.previewRows > 0 ? /^Command\b/.test(line) : /^(Command|Label) {2}\S/.test(line)),
        ladder.summaryRows === 1,
        `the Command/Label summary row at ${width}x${height}:\n${view(harness.vt)}`,
      )

      // §8 step 3: the metadata row holds only with its own grant.
      assert.equal(painted.some(line => line.includes('Progress: 3/8 checks')), ladder.metadataRows === 1,
        `the metadata row at ${width}x${height}:\n${view(harness.vt)}`)

      // §8 step 6/§7.3: the reading-facts row only at its width/height/body grant,
      // and then the bar must NOT repeat the disclosure — one fact is never
      // advertised twice. The dedicated row is the one ABOVE the pinned bar.
      const dedicatedFacts = painted.slice(0, -1).some(line => line.includes('Retained preview · not full history'))
      const totalDisclosure = painted.filter(line => line.includes('Retained preview · not full history')).length
      assert.equal(dedicatedFacts, ladder.readingFactsRows === 1,
        `the reading-facts row at ${width}x${height}:\n${view(harness.vt)}`)
      assert.ok(totalDisclosure <= 1, `the disclosure is advertised at most once at ${width}x${height}:\n${view(harness.vt)}`)
      if (ladder.readingFactsRows === 1) {
        assert.ok(!painted.at(-1)!.includes('Retained preview'),
          `the bar never repeats the granted facts row at ${width}x${height}`)
      }

      // §8 step 4: the notice row has its own grant.
      assert.equal(painted.some(line => line.includes('governance notice')), ladder.noticeRows === 1,
        `the notice row at ${width}x${height}:\n${view(harness.vt)}`)

      // §11.3.2/§4.1 (D5+D7): a status group paints the shared `‣` and no other
      // per-status glyph.
      const statusRow = painted.find(line => line.includes('‣'))
      assert.notEqual(statusRow, undefined, `the status group must be painted at ${width}x${height}`)
      for (const glyph of ['●', '○', '◐', '×', '✓', '✕', '⊘']) {
        assert.ok(!statusRow!.includes(glyph),
          `the status row must not paint the per-status glyph ${glyph} at ${width}x${height}: ${JSON.stringify(statusRow)}`)
      }
      disposeHarness(harness)
    }
  }
})

// ── JUX-01 / JUX-02: adaptive preview budget, log invariance & F2 collapse ──

test('JUX-01/02: preview height ignores log growth, F2/Hide/Show toggles per-open intent across resize and Tab', async () => {
  const harness = startApp(120, 40, ['job-a', 'job-b'])
  await openFirstJob(harness)
  const label = 'cd /repo &&\npnpm build &&\npnpm test:product'
  harness.observation.latest()!.emit({ label, text: '' })
  await settle(harness.vt)

  // Empty log: 3-line command takes exactly 3 preview rows (no padding).
  const headingRow = bodyRow(harness.vt, 'Copy Command · Expand [Tab] · Hide [F2]')
  const tabsEmpty = bodyRow(harness.vt, '[Output]  Command')
  assert.equal(tabsEmpty - headingRow - 1, 3, 'short 3-line command occupies exactly 3 preview rows')
  assert.match(view(harness.vt), /No retained output/)

  // Log grows from empty to 80 lines: preview height does NOT change.
  harness.observation.latest()!.emit({ label, text: numberedLines(0, 79) })
  await settle(harness.vt)
  assert.equal(bodyRow(harness.vt, '[Output]  Command'), tabsEmpty,
    'log growth never changes the Command preview row grant')

  // F2 collapses preview -> P = 0 and heading shows Show [F2].
  harness.vt.sendInput('\x1bOQ') // F2
  await settle(harness.vt)
  assert.match(view(harness.vt), /Copy Command · Expand \[Tab\] · Show \[F2\]/)
  assert.ok(!/pnpm build &&/.test(view(harness.vt)), 'collapsed preview hides command rows')
  assert.equal(bodyRow(harness.vt, '[Output]  Command'), headingRow + 1, 'tabs immediately follow collapsed heading')

  // Tab -> Command -> Esc preserves user's collapsed intent.
  harness.vt.sendInput('\t')
  await settle(harness.vt)
  assert.match(view(harness.vt), /Full command/)
  harness.vt.sendInput('\x1b')
  await settle(harness.vt)
  assert.match(view(harness.vt), /Show \[F2\]/, 'returning from Command preserves collapsed intent')

  // Resize below R=12 and back to 120x40 preserves collapsed intent; automatic
  // degradation when expanded also preserves expanded intent.
  harness.vt.resize(80, 10)
  await settle(harness.vt)
  harness.vt.resize(120, 40)
  await settle(harness.vt)
  assert.match(view(harness.vt), /Show \[F2\]/, 'resize round-trip preserves explicit collapsed intent')

  // Click Show [F2] restores multi-line preview.
  const showRow = bodyRow(harness.vt, 'Show [F2]')
  await click(harness.vt, showRow, cellIndexOf(harness.vt, showRow, 'Show [F2]') + 1)
  assert.match(view(harness.vt), /Hide \[F2\]/)
  assert.match(view(harness.vt), /pnpm build &&/)

  // Resize down to R=10 (auto-compact) and back up: expanded intent survives!
  harness.vt.resize(80, 10)
  await settle(harness.vt)
  assert.match(view(harness.vt), /Command {2}cd \/repo/)
  harness.vt.resize(120, 40)
  await settle(harness.vt)
  assert.match(view(harness.vt), /Hide \[F2\]/, 'automatic short-screen fallback never writes collapsed intent')
  assert.match(view(harness.vt), /pnpm build &&/)

  // Collapse again, then open a different Job: new Job does NOT inherit collapsed intent.
  harness.vt.sendInput('\x1bOQ')
  await settle(harness.vt)
  assert.match(view(harness.vt), /Show \[F2\]/)
  harness.tasks.openJobView('job-b')
  await settle(harness.vt)
  harness.observation.latest()!.emit({ label: 'echo b1\necho b2', text: 'out-b' })
  await settle(harness.vt)
  assert.match(view(harness.vt), /Hide \[F2\]/, 'a new Job starts with preview expanded')
  assert.match(view(harness.vt), /echo b2/)
})

// ── JUX-03/04/07/08: full §12 pointer journey + negative controls ──────────

test('JUX-03/04/07/08: complete 120x40 pointer journey, chrome wheel isolation, native drag handoff, Stop inert and blur revoke', async () => {
  const harness = startApp(120, 40)
  await openFirstJob(harness)
  const label = '  echo "step1"\t&&\r\necho "step2"  '
  const outLines = Array.from({ length: 80 }, (_, index) =>
    index === 5 || index === 30 ? `needle-hit-${index}` : `log-row-${String(index).padStart(3, '0')}`).join('\n')
  harness.observation.latest()!.emit({ label, text: outLines })
  await settle(harness.vt)

  // 1. Copy Command from preview heading + rapid double-click dedup (clickCount === 1).
  const headingRow = bodyRow(harness.vt, 'Copy Command')
  const copyCmdCol = cellIndexOf(harness.vt, headingRow, 'Copy Command') + 2
  press(harness.vt, headingRow, copyCmdCol)
  release(harness.vt, headingRow, copyCmdCol)
  press(harness.vt, headingRow, copyCmdCol)
  release(harness.vt, headingRow, copyCmdCol)
  await flush(6)
  assert.deepEqual(harness.copied, [label], 'rapid double-click on Copy Command executes once with exact raw bytes')

  // 2. Chrome wheel over preview/header/facts/bar is consumed and never pauses Follow.
  const previewRow = bodyRow(harness.vt, 'echo "step1"')
  harness.vt.sendInput(`\x1b[<64;5;${previewRow + 1}M`)
  harness.vt.sendInput(`\x1b[<64;5;${headingRow + 1}M`)
  harness.vt.sendInput(`\x1b[<64;5;40M`)
  await settle(harness.vt)
  assert.match(view(harness.vt), /Follow on/, 'wheel over chrome never pauses Output Follow')

  // 3. Expand [Tab] -> Command -> Copy All [C] -> Find -> Search -> Next -> Edit -> Leave find -> Output [Esc].
  harness.copied.length = 0
  await click(harness.vt, headingRow, cellIndexOf(harness.vt, headingRow, 'Expand [Tab]') + 2)
  assert.match(view(harness.vt), /Copy All \[C\]/)
  const copyAllRow = bodyRow(harness.vt, 'Copy All [C]')
  await click(harness.vt, copyAllRow, cellIndexOf(harness.vt, copyAllRow, 'Copy All [C]') + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [label])

  // Click live Find span on Command Action Bar -> type -> click Search [Enter] -> click Edit -> Leave find [Esc].
  const cmdBarRow = plainRows(harness.vt).length - 1
  await click(harness.vt, cmdBarRow, cellIndexOf(harness.vt, cmdBarRow, 'Ctrl+F find') + 1)
  assert.match(view(harness.vt), /Find Command:/)
  harness.vt.sendInput('step')
  await settle(harness.vt)
  const cmdSearchRow = bodyRow(harness.vt, 'Search [Enter]')
  await click(harness.vt, cmdSearchRow, cellIndexOf(harness.vt, cmdSearchRow, 'Search [Enter]') + 1)
  assert.match(view(harness.vt), /Next \[N\]/)
  const navSearchRow = bodyRow(harness.vt, 'Next [N]')
  await click(harness.vt, navSearchRow, cellIndexOf(harness.vt, navSearchRow, 'Next [N]') + 1)
  assert.match(view(harness.vt), /2\/2/)
  await click(harness.vt, navSearchRow, cellIndexOf(harness.vt, navSearchRow, 'Edit') + 1)
  assert.match(view(harness.vt), /Search \[Enter\]/, 'Edit button re-enters EDIT preserving query')
  assert.match(view(harness.vt), /Find Command: step/)
  await click(harness.vt, cmdBarRow, cellIndexOf(harness.vt, cmdBarRow, 'Leave find [Esc]') + 1)
  assert.ok(!/Find Command:/.test(view(harness.vt)))
  await click(harness.vt, cmdBarRow, cellIndexOf(harness.vt, cmdBarRow, 'Output [Esc]') + 1)
  assert.match(view(harness.vt), /\[Output\]  Command/)

  // 4. Hide [F2] -> Show [F2] by mouse (use a neighboring cell so two rapid
  // headless clicks 15ms apart are distinct clicks rather than a double-click).
  const hideRow = bodyRow(harness.vt, 'Hide [F2]')
  await click(harness.vt, hideRow, cellIndexOf(harness.vt, hideRow, 'Hide [F2]') + 1)
  assert.match(view(harness.vt), /Show \[F2\]/)
  const showRow = bodyRow(harness.vt, 'Show [F2]')
  await click(harness.vt, showRow, cellIndexOf(harness.vt, showRow, 'Show [F2]') + 2)
  assert.match(view(harness.vt), /Hide \[F2\]/)

  // 5. Output native wheel pauses Follow; Resume [End] resumes Follow and tracks newer snapshot.
  const logRow = bodyRow(harness.vt, 'log-row-079')
  harness.vt.sendInput(`\x1b[<64;10;${logRow + 1}M`)
  await settle(harness.vt)
  assert.match(view(harness.vt), /Follow paused/)
  const outBarRow = plainRows(harness.vt).length - 1
  await click(harness.vt, outBarRow, cellIndexOf(harness.vt, outBarRow, 'Resume [End]') + 1)
  assert.match(view(harness.vt), /Follow on/)
  const grown = `${outLines}\nlog-row-080`
  harness.observation.latest()!.emit({ label, text: grown })
  await settle(harness.vt)
  assert.match(view(harness.vt), /log-row-080/, 'resumed Follow tracks subsequent snapshot')

  // 6. Output-origin native drag into preview completes Output selection without triggering preview action.
  harness.copied.length = 0
  const dragStartRow = bodyRow(harness.vt, 'log-row-080')
  const previewDragTarget = bodyRow(harness.vt, 'echo "step1"')
  press(harness.vt, dragStartRow, 0)
  drag(harness.vt, previewDragTarget, 5)
  release(harness.vt, previewDragTarget, 5)
  await flush(6)
  assert.ok(!/Copy All \[C\]/.test(view(harness.vt)), 'dragging from Output into preview never opens Command')
  assert.equal(harness.copied.length, 1, 'Output-origin drag into preview still copies the clamped Output selection')
  assert.match(harness.copied[0]!, /log-row-/, 'copied text comes from the Output body selection')
  assert.notEqual(harness.copied[0], label, 'dragging from Output into preview never copies Command')

  // 6b. R948-01: a NEW press+release on old A's Copy Command span after observation updates to B
  //     but BEFORE the next frame paints must be refused (never copy B); once B paints, clicking copies B.
  harness.copied.length = 0
  const staleCopyRow = bodyRow(harness.vt, 'Copy Command')
  const staleCopyCol = cellIndexOf(harness.vt, staleCopyRow, 'Copy Command') + 2
  const updatedLabel = 'echo "command-B-updated"\necho "command-B-line2"'
  harness.observation.latest()!.emit({ label: updatedLabel, text: grown })
  press(harness.vt, staleCopyRow, staleCopyCol)
  release(harness.vt, staleCopyRow, staleCopyCol)
  await flush(6)
  assert.deepEqual(harness.copied, [], 'a new press on an unpainted stale frame must never copy the newer command B')
  await settle(harness.vt)
  assert.match(view(harness.vt), /command-B-updated/, 'the updated command B is now painted')
  const freshCopyRow = bodyRow(harness.vt, 'Copy Command')
  const freshCopyCol = cellIndexOf(harness.vt, freshCopyRow, 'Copy Command') + 3
  await click(harness.vt, freshCopyRow, freshCopyCol)
  await flush(6)
  assert.deepEqual(harness.copied, [updatedLabel], 'once B is painted, clicking Copy Command copies B')

  // 7. Copy Output [C] copies exact retained snapshot; Stop hint click is inert (keyboard-only).
  harness.copied.length = 0
  await click(harness.vt, outBarRow, cellIndexOf(harness.vt, outBarRow, 'Copy Output [C]') + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [grown], 'Copy Output [C] delivers exact retained snapshot')
  const stopCol = cellIndexOf(harness.vt, outBarRow, 's stop')
  await click(harness.vt, outBarRow, stopCol + 1)
  assert.deepEqual(harness.observation.stops, [], 'clicking Stop hint is inert (keyboard-only contract)')

  // 8. Terminal blur (\x1b[O) revokes an in-flight Back [Esc] press.
  const backCol = cellIndexOf(harness.vt, outBarRow, 'Back [Esc]') + 1
  press(harness.vt, outBarRow, backCol)
  harness.vt.sendInput('\x1b[O')
  release(harness.vt, outBarRow, backCol)
  await flush(6)
  assert.match(view(harness.vt), /Job · job-a · bash/, 'terminal blur revokes in-flight chrome press')

  // 9. Fresh Back [Esc] click closes workspace and releases observer once.
  await click(harness.vt, outBarRow, backCol + 1)
  assert.ok(!/Job · job-a · bash/.test(view(harness.vt)), 'Back [Esc] closes the workspace')
  assert.deepEqual(harness.observation.records.map(r => r.closes), [1], 'observer released exactly once')
})
