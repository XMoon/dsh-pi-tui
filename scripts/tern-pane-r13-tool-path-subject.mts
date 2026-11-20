/**
 * The R13 real-pane subject: the PRODUCTION TSP renderer in a real pane, whose
 * tool-path root is the CURRENT display-subject workspace.
 *
 * It does NOT hand-roll a surface. It calls the shipped `mountTspRenderer` — the
 * same factory the composition root mounts on the TSP branch — installs the
 * read-only status reader through the shipped `bindStatusReader`, and then
 * drives ONLY the shipped display seam:
 *   - `setTranscript(...)` ONCE at boot (the transcript commit), and
 *   - `commitDisplaySubject({}, {}, undefined)` for the ONE formal display
 *     commit of every status-only change (the cwd commands).
 *
 * The R13 claim under test: once a status reader is bound, the tool-path
 * relativization root is the FORMALLY COMMITTED `StatusSnapshot.workspace` and
 * never the mount-time `options.cwd` — so this mount passes the deliberate
 * COUNTER-EXAMPLE `cwd: '/r13/launch-A'` and the flow proves the painted paths
 * never abbreviate against it.
 *
 * Fixture (measured against the shipped projection, see the rationale below):
 *   - turn 1: a User row, a settled `read` Tool card, and a RUNNING `read`
 *     (its own tool/call, no result) inside one Work/Activity span;
 *   - turn 2: ONE live `StreamingToolPreview` so a standalone Preparing row is
 *     visible in every preset.
 *
 * RATIONALE (recorded again into events.jsonl at boot): a Preparing preview in
 * the SAME turn as the trailing open Work is ADOPTED by that Work, and
 * `compactPreparingSummary()` (the shipped authority) emits only
 * `Preparing <Title>…` — never a path — and the Preparing summary WINS the
 * collapsed Action slot. A turn-1 preview would therefore make every
 * Compact/Focus collapsed head read `Action: Preparing Read…` and the required
 * exact `Action: Read src/a.ts` would be unreachable. The live preview is
 * consequently the in-flight call of the NEXT turn, which is exactly the
 * production state a streaming tool call is in. The settled `read` (with its
 * tool/result) proves the same root applies to a settled card; the RUNNING
 * `read` is what the collapsed Action head names, because a settled card would
 * prefix the Action with `✓ ` and the brief requires the bare `Action: Read …`.
 *
 * Commands arrive via `case.json` in the run directory, `{ seq, cmd }`, with
 * `cmd` one of `cwd=C` | `cwd=B` | `cwd=unavailable`. Each seq is processed
 * EXACTLY ONCE (a processed-seq set): the fixture snapshot is updated, then
 * ONLY `renderer.display.commitDisplaySubject({}, {}, undefined)` is called —
 * no setTranscript, no tool event, no transcript rebuild of the subject's own.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-r13-tool-path-subject.mts
 * @module scripts/tern-pane-r13-tool-path-subject
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import type { StreamingToolPreview } from '../src/app/surface/streaming-tool-preparing.ts'
import { mountTspRenderer, type TspInputHandlers } from '../src/tui/tsp/session.ts'
import type { DisplayPreset } from '../src/domain/display/preset.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(value)}\n`)

/**
 * The ONE SDK wire record of this mount (a production SDK hook: every Session
 * message is recorded as JSONL). The flow folds it to read the REAL node ids of
 * the painted transcript — the client's `tree` does not expose SDK ids, and the
 * "User node key is byte-stable" claim needs the ids the renderer actually
 * committed, not an approximation from DOM paths.
 */
process.env.TERN_TSP_RECORD = join(dir, 'sdk-wire.jsonl')

/** The display preset comes from `preset.json`, written by the flow BEFORE launch. */
const presetPath = join(dir, 'preset.json')
if (!existsSync(presetPath)) throw new Error('preset.json is required before the subject launches')
const preset = (JSON.parse(readFileSync(presetPath, 'utf8')) as { preset: DisplayPreset }).preset
if (preset !== 'full' && preset !== 'compact' && preset !== 'focus') {
  throw new Error(`preset.json must name full|compact|focus, got ${JSON.stringify(preset)}`)
}

/**
 * The deliberate COUNTER-EXAMPLE mount option. Once a status reader is bound
 * this root must NEVER own a displayed tool path: the committed workspace does.
 */
const MOUNT_CWD = '/r13/launch-A'
/** The committed fixture workspaces the commands drive the reader through. */
const WORKSPACE_B = '/r13/workspace-B'
const WORKSPACE_C = '/r13/workspace-C'
const ABS_B = `${WORKSPACE_B}/src/a.ts`

// ── The canonical fixture: ONE real TranscriptFolder from SessionEvents ─────
const T0 = 1_700_000_000_000
const ev = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
  ({ type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent)

const folder = new TranscriptFolder()
folder.apply([
  ev('turn/start', { turn: 1 }, 0),
  ev('step/start', { turn: 1, step: 0 }, 1),
  ev('user/message', {
    id: MessageId('user-r13'),
    role: 'user',
    content: [{ type: 'text', text: 'inspect the current workspace file' }],
    source: { kind: 'user' },
  }, 2),
  // The settled Read Tool card (its result arrives — the root applies to it too).
  ev('tool/call', {
    turn: 1, step: 0, callId: ToolCallId('call-r13-read'),
    name: 'read', arguments: JSON.stringify({ file_path: ABS_B }),
  }, 3),
  ev('tool/result', {
    turn: 1, step: 0,
    message: {
      id: MessageId('result-call-r13-read'), role: 'tool',
      toolCallId: ToolCallId('call-r13-read'),
      content: [{ type: 'text', text: 'the file body' }],
      source: { kind: 'tool', callId: ToolCallId('call-r13-read') },
    },
  }, 4),
  // The RUNNING Read (no result yet) is the Action the collapsed head names.
  ev('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('call-r13-running'),
    name: 'read', arguments: JSON.stringify({ file_path: ABS_B }),
  }, 5),
])

/** The ONE live Preparing preview of the in-flight NEXT-turn call. */
const PREVIEW: StreamingToolPreview = {
  callId: 'r13-live', turn: 2, step: 0, index: 0,
  name: 'read', summary: ABS_B, argumentBytes: 40,
}

const WINDOW = { mode: 'latest', hasNewer: false } as const
/** ONE stable per-mount source object — the exact seam the repaint passes. */
const SOURCE = { subject: 'r13-tool-path' }

// ── The fixture status snapshots (the ONLY inputs this subject invents) ─────
let current: StatusSnapshot = {
  ...emptyStatusSnapshot(),
  workspace: { cwd: WORKSPACE_B },
}

const snapshotFor = (cwd: string, cwdUnavailable: boolean): StatusSnapshot => ({
  ...emptyStatusSnapshot(),
  workspace: { cwd, ...(cwdUnavailable ? { cwdUnavailable: true } : {}) },
})

const session = await connect({ app: 'r13-tool-path', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')

/** ONE shutdown latch: the renderer's exit intent and the run's signal share it. */
let closing: Promise<void> | undefined
function shutdown(reason: string): Promise<void> {
  closing ??= (async () => {
    note({ closed: true, reason })
    await renderer.dispose()
  })()
  return closing
}

// The PRODUCTION renderer factory: one inline surface, the production dock.
const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  // The production exit intent (the renderer routes its own quit keys here).
  requestExit: () => { process.exitCode = 0; shutdown('exit-requested') },
  // R13: the mount-time root is NEVER the display root once the reader is
  // bound — this is the deliberate counter-example under test.
  cwd: MOUNT_CWD,
  // The live display authority, read at every formal projection.
  displayState: { preset },
})

// The production read-only port, installed the same way the mount installs it.
renderer.bindStatusReader({ snapshot: () => current })

/**
 * The production input binding. The renderer owns the ONE input loop of this
 * session — this subject never iterates the session itself — and the flow's
 * disclosure checks (open an EXISTING collapsed Work/Tool head with a real
 * control-injected click) are only ADMITTED once `inputBound` is true. Every
 * handler is inert: this subject has no application behind it, and the flow
 * only ever sends the disclosure clicks it records as CONTROL_INJECTED_INPUT.
 */
const handlers: TspInputHandlers = {
  exit() {},
  cancel() {},
  submit() {},
  shouldRememberInput: () => false,
  steer() {},
  pasteMedia() {},
  pastedPath() {},
  admitPastedPathDelivery: () => false,
  noteUserInput() {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  openModelPicker() {},
  openModelQuick() {},
  openSessionBrowser() {},
  sessionBrowserAvailable: () => false,
  openTasksBrowserUi() {},
  tasksBrowserUiAvailable: () => false,
}
renderer.bindInput(handlers)

/**
 * The transcript commit count. Exactly ONE call site exists below, so this
 * counter is the evidence that the status-only cwd commits never re-committed
 * the transcript — `case-result.json` records it before/after every commit.
 */
let setTranscriptCalls = 0
function commitTranscript(): void {
  setTranscriptCalls += 1
  renderer.display.setTranscript(
    folder.messages(),
    folder.turnActivities(),
    WINDOW,
    [PREVIEW],
    undefined,
    SOURCE,
    undefined,
  )
}

// ONE transcript commit at boot; the cwd commands never call it again.
commitTranscript()
note({
  kind: 'transcript.committed', calls: setTranscriptCalls,
  preview: PREVIEW, mountCwd: MOUNT_CWD, preset,
  fixture: {
    rationale: 'turn-2 live preview: a turn-1 preview is ADOPTED by the trailing open Work and the shipped compactPreparingSummary() (Prepared <Title> only, no path) would own the collapsed Action slot, so the required exact `Action: Read src/a.ts` would be unreachable; the settled read + the running read are in one turn-1 Work span',
    userMessageId: 'user-r13',
    settledRead: 'call-r13-read', runningRead: 'call-r13-running', livePreview: 'r13-live',
  },
})

// The ONE formal display commit of the INITIAL committed workspace (B).
const bootBefore = setTranscriptCalls
renderer.display.commitDisplaySubject({}, {}, undefined)
note({ kind: 'display.committed', trigger: 'boot', seq: 0, setTranscriptCallsBefore: bootBefore, setTranscriptCallsAfter: setTranscriptCalls })
note({ kind: 'subject.ready', preset, mountCwd: MOUNT_CWD, statusCwd: current.workspace.cwd })

// ── The cwd commands: ONE formal commit each, exactly once per seq ──────────
const processed = new Set<number>()
function applyCommand(seq: number, cmd: string): void {
  if (processed.has(seq)) return
  processed.add(seq)
  const before = setTranscriptCalls
  if (cmd === 'cwd=C') current = snapshotFor(WORKSPACE_C, false)
  else if (cmd === 'cwd=B') current = snapshotFor(WORKSPACE_B, false)
  else if (cmd === 'unavailable' || cmd === 'cwd=unavailable') current = snapshotFor('', true)
  else {
    note({ kind: 'command.unknown', seq, cmd })
    return
  }
  // The ONE formal display commit: samples the reader, re-derives the blocks
  // whose effective root changed, repaints. Never a transcript rebuild.
  renderer.display.commitDisplaySubject({}, {}, undefined)
  const result = {
    seq, cmd,
    statusCwd: current.workspace.cwd,
    setTranscriptCallsBefore: before,
    setTranscriptCallsAfter: setTranscriptCalls,
    commitDone: true,
  }
  // ATOMIC: write the temp in the same dir, then rename over the result.
  const tmp = join(dir, 'case-result.json.tmp')
  writeFileSync(tmp, `${JSON.stringify(result)}\n`)
  renameSync(tmp, join(dir, 'case-result.json'))
  note({ kind: 'command.applied', ...result })
}

/**
 * The command file the flow rewrites atomically (tmp + rename), so a poller can
 * never observe a torn JSON. Polling is the ONLY file activity this subject
 * performs; the renderer's own input loop stays the ONE session input owner.
 */
const casePath = join(dir, 'case.json')
function pollCase(): void {
  if (!existsSync(casePath)) return
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(casePath, 'utf8'))
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object') return
  const { seq, cmd } = parsed as { seq?: unknown; cmd?: unknown }
  if (typeof seq !== 'number' || typeof cmd !== 'string') return
  applyCommand(seq, cmd)
}
const poll = setInterval(() => {
  pollCase()
  // The pane can close under the subject (the driver quits the serve) before a
  // signal arrives: the END of the run must still close the renderer ONCE
  // through the SAME latch, so the session-closed fact is a shutdown trigger.
  if (session.closed) void shutdown('session-closed').finally(() => { clearInterval(poll) })
}, 60)

// The process stays alive until the flow ends the run; the renderer's loop
// drives everything, and the shutdown latch closes the renderer once.
process.once('SIGTERM', () => { void shutdown('SIGTERM').finally(() => { clearInterval(poll) }) })
process.once('SIGINT', () => { void shutdown('SIGINT').finally(() => { clearInterval(poll) }) })
note({ inputLoop: 'renderer-owned', commands: 'case.json' })
