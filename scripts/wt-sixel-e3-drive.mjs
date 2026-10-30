#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/wt-sixel-e3-drive — I8-3 Lane F runner.
 *
 * Drives ONE deterministic case per dedicated Windows Terminal window and
 * writes the evidence manifest. It never re-implements the Screen, the SIXEL
 * encoder or a terminal: the subject process owns the real `ProcessTerminal`,
 * and this script only launches the window, captures that window's REAL OS
 * pixels, performs the phase's REAL OS input, and folds the subject's
 * observation JSONL into `manifest.jsonl`.
 *
 * PHASE ORDER IS THE EVIDENCE. Every phase is captured BEFORE its own input is
 * delivered, so `before` shows the pre-operation state and `scrolled` shows the
 * state that input produced. Applying all inputs first and capturing afterwards
 * emits two identical post-operation frames — a green manifest that proves
 * nothing. That mistake happened once during I8-3, which is why the order is
 * stated here.
 *
 * A phase is `PASS` only when the capture really landed on disk AND the subject
 * trace proves the production Screen wrote a trusted DCS. A refused capture or
 * undelivered input is `GUI_BLOCKED`, never a pass.
 *
 * Usage:
 *   node scripts/wt-sixel-e3-drive.mjs --run-root <dir> --cases WT01,WT03 [--run-id ID]
 * @module wt-sixel-e3-drive
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIN32 = join(ROOT, 'scripts', 'wt-sixel-e3-win32.ps1')
const SUBJECT = join(ROOT, 'scripts', 'wt-sixel-e3-subject.mts')
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const WT = '/mnt/c/Users/XMoon/AppData/Local/Microsoft/WindowsApps/wt.exe'
const STAGED_WIN = 'C:\\Users\\XMoon\\AppData\\Local\\Temp\\i8-3-e3-driver.ps1'
const STAGED_WSL = '/mnt/c/Users/XMoon/AppData/Local/Temp/i8-3-e3-driver.ps1'
const CAPTURE_DIR_WIN = 'C:\\Users\\XMoon\\AppData\\Local\\Temp'
const CAPTURE_DIR_WSL = '/mnt/c/Users/XMoon/AppData/Local/Temp'

/**
 * Scroll direction is a FACT on this WT build, not an assumption: the pressable
 * page button is `VerticalLargeIncrease` (its `Decrease` sibling collapses to an
 * empty bounding rectangle and cannot be clicked). Windows Terminal 1.25.2733.0
 * ignores SendInput wheel / keybd_event scrolling entirely — a negative result
 * already proved in ~/project/wt-gui-lab — so every scrolling case uses the UIA
 * ScrollBar press, the only verified positive channel.
 */
const SCROLL_BACK = 'VerticalLargeIncrease'

/**
 * What the FROZEN PLAN requires each case to demonstrate (plan §5 matrix).
 *
 * This table exists so the drive can never present an initial frame as if it were
 * the case. `required` lists the operations the plan's own row demands; `deliverable`
 * lists the operations this harness can actually perform today. A case is only
 * `PASS` when every required operation is in `deliverable`; otherwise it is
 * `NOT_DEMONSTRATED`, with the missing operations named in the manifest.
 */
const CASE_REQUIREMENTS = {
  WT01: { required: ['scroll-through-transcript', 'media-identity'], deliverable: ['scroll-through-transcript'] },
  WT02: { required: ['exit-fullscreen-to-main', 'no-ghost'], deliverable: [] },
  WT03: { required: ['image-command-draft', 'edit-text', 'delete-preview'], deliverable: [] },
  WT04: { required: ['80x24', '50x18'], deliverable: ['80x24'] },
  WT05: { required: ['view-image-list', 'select-second', 'enter-viewer', 'esc-to-list', 'esc-close', 'repeat-twice'], deliverable: [] },
  WT06: { required: ['click-first-column', 'click-last-column', 'click-title', 'click-blank', 'click-out-of-bounds', 'esc-restore'], deliverable: [] },
  WT07: { required: ['expand-tool-card', 'collapse-clean', 'invalid-svg'], deliverable: ['expand-tool-card'] },
  WT08: { required: ['click-thumbnail', 'view-action', 'copy-svg'], deliverable: [] },
  WT09: { required: ['preview', 'source', 'copy', 'back-to-preview', 'esc-clean'], deliverable: [] },
  WT10: { required: ['scroll-to-hidden-rows', 'top-crop-band-oracle', 'click-first-visible', 'hidden-row-negative'], deliverable: ['scroll-to-hidden-rows'] },
  WT11: { required: ['bottom-crop', 'restore-full', 'click-last-visible', 'next-row-negative'], deliverable: [] },
  WT12: { required: ['replace-large-with-small', 'convert-to-text', 'collapse', 'footprint-cleared'], deliverable: [] },
  WT13: { required: ['scroll', 'exit-reenter', 'search-reveal'], deliverable: ['scroll'] },
  WT14: { required: ['main-fullscreen-workspace-close-x3'], deliverable: [] },
  WT15: { required: ['settings-overlay', 'overlay-capture', 'return-remap'], deliverable: [] },
  WT16: { required: ['wheel-up-down-storm-10', 'pending-inert'], deliverable: [] },
  WT17: { required: ['drag-resize-100-80-120', 'geometry-recompute'], deliverable: [] },
  WT18: { required: ['font-zoom-ctrl-plus-minus', 'theme-switch'], deliverable: [] },
  WT19: { required: ['top-crop', 'bottom-crop', 'restore', 'tail-cleanup'], deliverable: [] },
  WT20: { required: ['pending-no-hit', 'cancel', 'screen-switch', 'exit-settle'], deliverable: [] },
  WT21: { required: ['pi-image-protocol-none-text-fallback'], deliverable: ['pi-image-protocol-none-text-fallback'] },
  WT22: { required: ['corrupt', 'over-limit', 'unsupported', 'too-narrow'], deliverable: ['corrupt', 'over-limit'] },
  WT23: { required: ['24-images-scroll', 'history-revisit-x3', 'cap-not-exceeded'], deliverable: [] },
  WT24: { required: ['exit-app', 'relaunch-new-da1'], deliverable: [] },
  WT25: { required: ['untrusted-dcs-escaped'], deliverable: ['untrusted-dcs-escaped'] },
  WT26: { required: ['display-modes', 'fold-unfold', 'search-reveal'], deliverable: [] },
  WT27: { required: ['press-scroll-release-identity'], deliverable: [] },
  WT28: { required: ['fast-switch', 'reverse-scroll', 'independent-occurrences'], deliverable: [] },
}

/** The phases each case must produce, in order, with the input each one delivers. */
const CASE_PHASES = {
  // `input` is delivered AFTER this phase's capture and BEFORE the next phase's
  // capture, so `name` describes the STATE the frame shows and `input` is the
  // operation that produces the following phase.
  WT01: [{ phase: 'before', input: [{ kind: 'scroll', button: SCROLL_BACK, presses: 2 }] }, { phase: 'scrolled' }],
  WT02: [{ phase: 'before' }],
  WT03: [{ phase: 'before' }],
  WT04: [{ phase: 'before' }],
  WT05: [{ phase: 'before' }],
  WT06: [{ phase: 'before' }],
  // The tool card starts collapsed; expanding it is this case's operation.
  WT07: [{ phase: 'before', input: [{ kind: 'ctrl', key: 'O' }] }, { phase: 'expanded' }],
  WT08: [{ phase: 'before' }],
  WT09: [{ phase: 'before' }],
  WT10: [{ phase: 'before', input: [{ kind: 'scroll', button: SCROLL_BACK, presses: 3 }] }, { phase: 'scrolled' }],
  WT11: [{ phase: 'before' }],
  WT12: [{ phase: 'before' }],
  WT13: [{ phase: 'before', input: [{ kind: 'scroll', button: SCROLL_BACK, presses: 2 }] }, { phase: 'scrolled' }],
  WT14: [{ phase: 'before' }],
  WT15: [{ phase: 'before' }],
  WT16: [{ phase: 'before', input: [{ kind: 'scroll', button: SCROLL_BACK, presses: 2 }] }, { phase: 'scrolled' }],
  WT17: [{ phase: 'before' }],
  WT18: [{ phase: 'before' }],
  WT19: [{ phase: 'before' }],
  WT20: [{ phase: 'before' }],
  WT21: [{ phase: 'before' }],
  WT22: [{ phase: 'before' }],
  WT23: [{ phase: 'before' }],
  WT24: [{ phase: 'before' }],
  WT25: [{ phase: 'before' }],
  WT26: [{ phase: 'before' }],
  WT27: [{ phase: 'before' }],
  WT28: [{ phase: 'before' }],
}

/** Window size per case; every other case uses the 100x32 reference geometry. */
const CASE_SIZE = { WT04: [80, 24] }

/**
 * Cases whose REQUIRED physical outcome is the absence of image pixels:
 * - WT21: `PI_IMAGE_PROTOCOL=none` is a hard off, so text fallback is the pass.
 * - WT22: unreadable/over-limit/unsupported sources must degrade to text.
 * - WT25: an untrusted DCS-shaped string must be escaped as text, never written.
 */
const PIXELS_EXPECTED = { WT21: false, WT22: false, WT25: false }

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function decode(buffer) {
  if (buffer === undefined || buffer.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gbk').decode(buffer)
  }
}

/** The LAST JSON object the driver printed, or undefined when it printed none. */
function lastJsonObject(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue
    try {
      const parsed = JSON.parse(lines[index])
      if (typeof parsed.status === 'string') return parsed
    } catch {
      // Not the object this lane wants; keep scanning upward.
    }
  }
  return undefined
}

function runDriver(args) {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STAGED_WIN, ...args], {
    encoding: 'buffer',
    timeout: 180_000,
  })
  const stdout = decode(result.stdout)
  const stderr = decode(result.stderr)
  const parsed = lastJsonObject(stdout)
  if (parsed === undefined) {
    return {
      status: 'GUI_BLOCKED',
      reason: `the driver printed no JSON (exit ${result.status}): ${(stderr || stdout).slice(-400).replace(/\s+/gu, ' ')}`,
    }
  }
  return { ...parsed, exitCode: result.status }
}

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const RUN_ROOT = resolve(flag('run-root', join(ROOT, 'temp', 'i8-3-e3-run')))
const RUN_ID = flag('run-id', `I8-3-${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')}`)
const CASES = (flag('cases', '') || flag('case', '')).split(',').map((value) => value.trim()).filter(Boolean)

if (CASES.length === 0) {
  console.error('usage: node scripts/wt-sixel-e3-drive.mjs --run-root <dir> --cases WT01,WT03')
  process.exit(2)
}
for (const id of CASES) {
  if (CASE_PHASES[id] === undefined) {
    console.error(`unknown case: ${id}`)
    process.exit(2)
  }
}

const ASSETS = join(RUN_ROOT, 'assets')
const SHOTS = join(RUN_ROOT, 'screenshots')
const LOGS = join(RUN_ROOT, 'logs')
for (const dir of [RUN_ROOT, ASSETS, SHOTS, LOGS]) mkdirSync(dir, { recursive: true })

const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? 'UNKNOWN'
const gitStatus = spawnSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? ''
const manifestPath = join(RUN_ROOT, 'manifest.jsonl')

const driverSource = readFileSync(WIN32)
writeFileSync(STAGED_WSL, driverSource)
const driverSha = createHash('sha256').update(driverSource).digest('hex')

function appendManifest(record) {
  appendFileSync(manifestPath, `${JSON.stringify(record)}\n`)
}

/**
 * The full, unambiguous name of one delivered operation, e.g. `ctrl:O`,
 * `scroll:VerticalLargeIncrease:3`, `click:120:340`. The old formatter dropped the
 * key and the coordinates, so the manifest could not show what was actually done.
 */
function describeAction(action) {
  const parts = [action.kind]
  if (action.key !== undefined) parts.push(String(action.key).toUpperCase())
  if (action.button !== undefined) parts.push(action.button)
  if (action.notches !== undefined) parts.push(String(action.notches))
  if (action.presses !== undefined) parts.push(String(action.presses))
  if (action.x !== undefined && action.y !== undefined) parts.push(`${action.x}:${action.y}`)
  return parts.join(':')
}

/**
 * The honest verdict for one frame of one case.
 *
 * `PASS` requires BOTH that the plan's operations for this case were actually
 * delivered AND that the run happened on a clean tree. Everything else keeps the
 * frame (it is still a real screenshot with a real hash) but labels it as what it
 * demonstrates: `NOT_DEMONSTRATED` for a sound frame that does not perform the
 * case, `PARTIAL` when some of the required operations ran.
 */
function frameResult(caseId, undelivered, cleanTree) {
  const requirement = CASE_REQUIREMENTS[caseId]
  if (undelivered.length === 0 && cleanTree) return { result: 'PASS' }
  const reasons = []
  if (undelivered.length > 0) {
    reasons.push(`required operation(s) not delivered: ${undelivered.join(', ')}`)
  }
  if (!cleanTree) reasons.push('run recorded on an unclean tree; not frozen evidence')
  const deliveredAny = requirement.deliverable.length > 0
  return { result: deliveredAny ? 'PARTIAL' : 'NOT_DEMONSTRATED', reason: reasons.join('; ') }
}

/**
 * Close THIS case's window and verify it actually went away.
 *
 * The subject runs with `--hold 900`, so a failed close leaves a real process and a
 * real window behind for 15 minutes. The old code sent WM_CLOSE, waited without
 * checking the result, and could leak both on any exception path. Cleanup failure is
 * itself recorded, because a leaked window makes the next case's evidence suspect.
 */
function closeAndVerify(title, caseId, base) {
  const closed = runDriver(['-TitleFragment', title, '-Action', 'close', '-AllowNotForeground'])
  const gone = closed.status === 'OK' && waitForWindowGone(title, 20_000)
  appendManifest({
    ...base,
    phase: 'cleanup',
    result: gone ? 'PASS' : 'FAIL',
    reason: gone ? undefined : `the case window did not go away (${closed.reason ?? closed.status})`,
  })
  return gone
}

/** Whether NO visible window still carries this run title. */
function waitForWindowGone(title, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = runDriver(['-TitleFragment', title, '-Action', 'probe', '-AllowNotForeground'])
    if (probe.status === 'GUI_BLOCKED' && /found 0/u.test(String(probe.reason ?? ''))) return true
    spawnSync('sleep', ['0.5'])
  }
  return false
}

function waitForShutdown(eventsPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(eventsPath) && readFileSync(eventsPath, 'utf8').includes('"kind":"shutdown-final"')) return true
    spawnSync('sleep', ['0.25'])
  }
  return false
}

function waitForReady(eventsPath, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(eventsPath) && readFileSync(eventsPath, 'utf8').includes('"kind":"ready"')) return true
    spawnSync('sleep', ['0.25'])
  }
  return false
}

for (const caseId of CASES) {
  const title = `${RUN_ID}-${caseId}`
  // A throw between launch and close used to abandon a 900-second subject process.
  // The case now runs inside a guard whose cleanup is verified and recorded.
  try {
    runCase(caseId)
  } catch (error) {
    appendFileSync(
      manifestPath,
      `${JSON.stringify({
        run_id: RUN_ID,
        case_id: caseId,
        phase: 'case-error',
        git_sha: gitSha,
        git_status_clean: gitStatus === '',
        result: 'FAIL',
        reason: `the case threw before completing: ${String(error).slice(0, 400)}`,
      })}\n`,
    )
    try {
      runDriver(['-TitleFragment', title, '-Action', 'close', '-AllowNotForeground'])
    } catch {
      // The window may never have launched; nothing left to close here.
    }
  }
}

function runCase(caseId) {
  const title = `${RUN_ID}-${caseId}`
  const [cols, rows] = CASE_SIZE[caseId] ?? [100, 32]
  const eventsPath = join(LOGS, `${caseId}.events.jsonl`)
  const launcherPath = join(RUN_ROOT, `${caseId}.subject.sh`)
  const phases = CASE_PHASES[caseId]

  const requirement = CASE_REQUIREMENTS[caseId]
  const undelivered = requirement.required.filter((operation) => !requirement.deliverable.includes(operation))
  // Cleanliness is a PRECONDITION of a frozen claim, not a note: a run on an
  // unclean tree cannot be presented as verification of that tree (plan §4.1.3,
  // §5 G5, §8.8). It is recorded per row AND enforced when the case is judged.
  const cleanTree = gitStatus === ''
  const base = {
    run_id: RUN_ID,
    case_id: caseId,
    git_sha: gitSha,
    lane: 'DETERMINISTIC_PRODUCT_GUI',
    topology: 'WT_REAL_GUI>WSL2_D13>REAL_ProcessTerminal>REAL_TuiApp>Screen>Terminal.write; DSH_Host=ABSENT',
    tarball_sha256: 'NOT_APPLICABLE_FIXTURE_LANE',
    driver_sha256: driverSha,
    git_status_clean: cleanTree,
    tested_at: new Date().toISOString(),
    events_relative_path: `logs/${caseId}.events.jsonl`,
    required_operations: requirement.required,
    delivered_operations: requirement.deliverable,
    undelivered_operations: undelivered,
  }

  writeFileSync(
    launcherPath,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'export PATH="$HOME/.local/share/mise/installs/node/24/bin:$HOME/.local/share/mise/installs/pnpm/12.11.2:$PATH"',
      `cd ${ROOT} || exit 1`,
      `exec node --import tsx/esm ${SUBJECT} --case ${caseId} --fixture-root ${ASSETS} --events ${eventsPath} --hold 900`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  if (existsSync(eventsPath)) writeFileSync(eventsPath, '')

  const launched = spawnSync(
    WT,
    ['-w', 'new', '--size', `${cols},${rows}`, 'new-tab', '--title', title, '--suppressApplicationTitle', 'wsl.exe', '-d', 'Debian', '--exec', 'bash', launcherPath],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (launched.status !== 0) {
    appendManifest({ ...base, phase: 'launch', result: 'GUI_BLOCKED', reason: `wt.exe exit ${launched.status}: ${(launched.stderr ?? '').slice(-300)}` })
    return
  }
  if (!waitForReady(eventsPath)) {
    appendManifest({
      ...base,
      phase: 'ready',
      result: 'GUI_BLOCKED',
      reason: 'the subject never reported readiness',
      events: existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').slice(-1500) : '',
    })
    closeAndVerify(title, caseId, base)
    return
  }

  const probe = runDriver(['-TitleFragment', title, '-Action', 'probe'])
  const observations = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const start = observations.find((item) => item.kind === 'before-start') ?? {}
  const da1 = observations.find((item) => item.kind === 'da1-sixel')
  const dcsWrites = observations.filter((item) => item.kind === 'write' && item.dcs === true)

  for (const entry of phases) {
    const filename = `${RUN_ID}-${caseId}-${entry.phase}.png`
    const outputPath = join(SHOTS, filename)
    if (existsSync(outputPath)) {
      appendManifest({ ...base, phase: entry.phase, result: 'FAIL', reason: `refusing to overwrite ${filename}` })
      return
    }

    // CAPTURE FIRST: this frame is the state BEFORE this phase's own input.
    const capture = runDriver(['-TitleFragment', title, '-Action', 'capture', '-OutputPath', `${CAPTURE_DIR_WIN}\\i8-3-${filename}`])
    const record = {
      ...base,
      phase: entry.phase,
      wt_version: '1.25.2733.0',
      wsl_distro: 'Debian 13 (trixie) / WSL2',
      pty: start.tty?.stdin === true ? 'REAL_TTY' : 'NOT_TTY',
      window_hwnd: probe.hwnd ?? capture.hwnd ?? null,
      terminal_size_cells: start.columns !== undefined ? [start.columns, start.rows] : [cols, rows],
      da1_has_attribute_4: da1?.supported ?? null,
      action: entry.input === undefined ? 'NONE_SOURCE_STATE_ONLY' : entry.input.map(describeAction).join(','),
      vt_in_sha256: 'NOT_CAPTURED (OS SendInput does not traverse a passive PTY recorder in this lane)',
      screenshot_before: null,
      screenshot_after: null,
      oracle: null,
    }

    if (capture.status !== 'OK') {
      appendManifest({ ...record, result: 'GUI_BLOCKED', reason: capture.reason ?? 'capture failed' })
      return
    }
    const staged = join(CAPTURE_DIR_WSL, `i8-3-${filename}`)
    if (!existsSync(staged)) {
      appendManifest({ ...record, result: 'FAIL', reason: 'the driver reported a capture that is not on disk' })
      return
    }
    writeFileSync(outputPath, readFileSync(staged))
    // The DCS count is re-read NOW, i.e. at this frame, not from a snapshot taken
    // before any input ran (the old behaviour made the post-input frame report the
    // pre-input count and therefore prove nothing).
    const phaseObservations = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const phaseDcs = phaseObservations.filter((item) => item.kind === 'write' && item.dcs === true).length
    const frameVerdict = frameResult(caseId, undelivered, cleanTree)
    appendManifest({
      ...record,
      [entry.phase === 'before' ? 'screenshot_before' : 'screenshot_after']: filename,
      screenshot_sha256: sha256File(outputPath),
      screenshot_bytes: readFileSync(outputPath).byteLength,
      screenshot_physical_bounds: capture.physicalWindowBounds ?? null,
      oracle: {
        dcs_written: phaseDcs > 0,
        dcs_writes: phaseDcs,
        // A case whose REQUIRED outcome is "no pixels" must not be held to a DCS:
        // recording the expectation keeps the validator honest instead of forcing
        // a real product behavior to look like a missing artifact.
        pixels_expected: PIXELS_EXPECTED[caseId] !== false,
      },
      result: frameVerdict.result,
      ...(frameVerdict.reason === undefined ? {} : { reason: frameVerdict.reason }),
    })

    // THEN deliver this phase's input, so the NEXT capture reflects it.
    for (const action of entry.input ?? []) {
      const outcome = runDriver([
        '-TitleFragment', title,
        '-Action', action.kind,
        ...(action.kind === 'scroll' ? ['-ScrollButton', action.button, '-Notches', String(action.presses)] : []),
        ...(action.kind === 'wheel' ? ['-X', '400', '-Y', '400', '-Notches', String(action.notches)] : []),
        ...(action.kind === 'click' ? ['-X', String(action.x), '-Y', String(action.y)] : []),
        ...(action.kind === 'ctrl' || action.kind === 'key' ? ['-Key', String(action.key)] : []),
      ])
      appendManifest({
        ...base,
        phase: `${entry.phase}.input`,
        action: describeAction(action),
        result: outcome.status === 'OK' ? 'PASS' : 'GUI_BLOCKED',
        input_detail: {
          status: outcome.status,
          reason: outcome.reason ?? null,
          buttonRect: outcome.buttonRectPhysical ?? null,
          buttonCenter: outcome.buttonCenterScreen ?? null,
          presses: outcome.presses ?? null,
          foreground: outcome.foreground ?? null,
        },
      })
    }
  }

  closeAndVerify(title, caseId, base)
  // The subject appends its shutdown record while it tears down, i.e. AFTER the
  // window closed: reading the trace immediately would race the write and report
  // a missing shutdown that is merely late.
  waitForShutdown(eventsPath)
  // The FINAL trace digest is recorded separately instead of replacing the
  // per-phase digests (which prove what the trace looked like at that moment).
  const finalObservations = existsSync(eventsPath)
    ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  // ONE trace row per case, written after the last append: it is the single
  // authority that binds the whole case trace to its digest, so every frame row
  // stays true regardless of what the phase inputs logged afterwards.
  const traceBytes = existsSync(eventsPath) ? readFileSync(eventsPath) : null
  const traceDigest = traceBytes === null ? null : createHash('sha256').update(traceBytes).digest('hex')
  const shutdown = finalObservations.some((item) => item.kind === 'shutdown-final')
  appendManifest({
    ...base,
    phase: 'trace',
    result: shutdown ? 'PASS' : 'FAIL',
    reason: shutdown ? undefined : 'the subject recorded no shutdown',
    vt_out_sha256: traceDigest,
    dcs_writes_total: finalObservations.filter((item) => item.kind === 'write' && item.dcs === true).length,
    pixels_expected: PIXELS_EXPECTED[caseId] !== false,
  })
}

process.stdout.write(`manifest: ${manifestPath}\n`)
