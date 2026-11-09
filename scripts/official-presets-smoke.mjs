#!/usr/bin/env node
/**
 * Verify the shipped DSH preset assembly independently of any published
 * consumer bridge. Source Mode installs the supplied pinned source pack; npm
 * Mode installs the exact DSH version declared by this checkout's package.json.
 * The gate then installs the candidate dsh-pi-tui package and durable-header
 * probe, and exercises standard/ptc/minimal/cordis through real Agent/Session
 * creation in tmux.
 *
 * This entry also owns every official-preset assertion: the preset catalog and
 * status checks, degradation detection and the real PTY matrix live here, not
 * in a consumer smoke that merely happens to run them.
 *
 * Usage: node scripts/official-presets-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:official-presets -- [path-to-candidate.tgz]
 *
 * Set OFFICIAL_PRESETS_KEEP=1 to preserve the isolated profile on failure.
 * @module official-presets-smoke
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertNoCompatibilityFailures,
  candidateArgument,
  CompatFailure,
  distributionArgument,
  dshInvocation,
  fail,
  installPlugin,
  isolatedEnvironment,
  PNPM_COMMAND,
  readOptionalJson,
  readText,
  redact,
  redactedJson,
  resultText,
  requireExactVersion,
  resolveTarball,
  run,
  runDsh,
  runPnpmInstall,
  shellQuote,
  tail,
  TIMEOUTS,
  tmuxRunner,
  validateCandidateTarball,
  waitUntil,
  writeHeaderProbePackage,
  writeLauncher,
  writePromptQualificationPackage,
} from './lib/dsh-smoke-harness.mjs'
import {
  DEFAULT_SOURCE_CONFIG,
  loadDshDistribution,
  loadDshSourceConfig,
  npmDshVersion,
  PACKAGE_ROOT,
  validateDshSourceConfig,
} from './lib/dsh-distribution.mjs'

const OFFICIAL_PRESET_IDS = ['standard', 'ptc', 'minimal', 'cordis']
const DIRECT_STANDARD_PROMPT = 'pr-e direct standard prompt'

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

function optionValue(args, option) {
  const index = args.indexOf(option)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

/** Return the single DSH version currently validated by this checkout. */
export function currentValidatedDshVersion(configPath = DEFAULT_SOURCE_CONFIG) {
  return loadDshSourceConfig(configPath).expectedVersion
}

export function sourceConfigForArgs(args, defaultConfig = DEFAULT_SOURCE_CONFIG) {
  const distributionPath = distributionArgument(args)
  const ref = optionValue(args, '--ref')
  const expectedVersion = optionValue(args, '--expected-version')
  const configPath = optionValue(args, '--config')
  if (distributionPath === undefined) {
    if (ref !== undefined || expectedVersion !== undefined || configPath !== undefined) {
      throw new Error('--ref, --expected-version, and --config require --distribution')
    }
    return undefined
  }
  const tracked = loadDshSourceConfig(configPath ?? defaultConfig)
  return validateDshSourceConfig({
    ...tracked,
    ref: ref ?? tracked.ref,
    expectedVersion: expectedVersion ?? tracked.expectedVersion,
  }, tracked.path)
}

const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu
const CURSOR_MARKER = /\u001b_pi:c\u0007/gu

function stripTerminalControl(text) {
  return String(text).replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(CURSOR_MARKER, '')
}

export function composerContainsExactInput(pane, expected) {
  const lines = stripTerminalControl(pane).split(/\r?\n/u)
  const rules = lines.flatMap((line, index) => /^─+$/u.test(line.trim()) ? [index] : [])
  if (rules.length < 2) return false
  return lines.slice(rules.at(-2) + 1, rules.at(-1))
    .some(line => line.trimEnd() === `❯ ${expected}`)
}

export function directPromptAnswerVisible(pane) {
  return stripTerminalControl(pane).split(/\r?\n/u)
    .some(line => line.trimEnd() === '🐋  direct qualification answer')
}

function roundedFrameBodies(pane) {
  const lines = stripTerminalControl(pane).split(/\r?\n/u)
  const bodies = []
  for (let start = 0; start < lines.length; start += 1) {
    const left = lines[start].indexOf('╭')
    if (left < 0) continue
    const right = lines[start].indexOf('╮', left + 1)
    if (right < 0) continue
    const width = right - left + 1
    const end = lines.findIndex((line, index) => index > start
      && line[left] === '╰'
      && line.slice(left, left + width).includes('╯'))
    if (end >= 0) {
      // Overlays are composited over the host frame. Keep only the columns
      // belonging to this box; otherwise stale host text such as `/help`
      // becomes indistinguishable from the filtered command rows.
      bodies.push(lines.slice(start + 1, end).map(line => line.slice(left, left + width)))
    }
  }
  return bodies
}

function roundedFrameBody(pane) {
  const text = stripTerminalControl(pane)
  const lines = text.split(/\r?\n/u)
  const bodies = roundedFrameBodies(text)
  // A later frame can be partially clipped while a settings frame remains
  // visible. Select the frame by its semantic hint instead of letting an
  // unrelated trailing border hide the command catalog.
  const semantic = bodies.findLast(body => body.some(line => line.includes('Type to search')))
  if (semantic !== undefined) return semantic

  // Some terminal captures clip a frame border at the viewport edge. The
  // settings hint is still an unambiguous anchor, so retain the visible frame
  // body up to that line, preserving the overlay's horizontal slice when its
  // top border is available.
  const hint = lines.findLastIndex(line => line.includes('Type to search'))
  if (hint >= 0) {
    const start = lines.findLastIndex((line, index) => index < hint && line.includes('╭'))
    if (start >= 0) {
      const left = lines[start].indexOf('╭')
      const right = lines[start].indexOf('╮', left + 1)
      if (left >= 0 && right >= 0) {
        return lines.slice(start + 1, hint + 1).map(line => line.slice(left, right - left + 1))
      }
    }
    return lines.slice(Math.max(0, hint - 20), hint + 1)
  }
  return bodies.at(-1) ?? []
}

export function settingsSearchSnapshot(pane) {
  const body = roundedFrameBody(pane)
  const searchVisible = body.some(line => line.includes('Type to search'))
  const queryLine = body.find(line => /(?:^|│)\s*>\s*/u.test(line))
  const query = queryLine
    ?.replace(/^\s*│?\s*>\s*/u, '')
    .replace(/\s*│\s*$/u, '')
    .trim() ?? ''
  const commandRows = body.flatMap(line => {
    const match = line.match(/(?:^|│)\s*(?:❯|›|>)?\s*(\/[A-Za-z][A-Za-z0-9_-]*)(?=\s|│|$)/u)
    return match === null ? [] : [match[1]]
  })
  return {
    searchVisible,
    query,
    commandRows,
    noMatches: body.some(line => line.includes('No matching settings')),
  }
}

const PRESET_DEGRADATION_PATTERNS = [
  /\blaunch preset unavailable\b/iu,
  /\bpreset resolution failed at startup\b/iu,
  /\bskill catalog unavailable for preset\b/iu,
  /\bpreset\b[^\n]*(?:did not mount|failed to mount|mount failed)\b/iu,
  /\b(?:fallback|falling back)\b[^\n]*\bdefault\b/iu,
  /\bstanding\b[^\n]*(?:mount|preset)[^\n]*(?:fail|unavailable|error)\b/iu,
]

export function presetDegradationLine(text) {
  return stripTerminalControl(text).split(/\r?\n/u).find(line =>
    PRESET_DEGRADATION_PATTERNS.some(pattern => pattern.test(line)))
}

function assertOfficialPresetMounted(presetId, tuiLog, tmux) {
  const text = `${readText(tuiLog)}\n${tmux.capturePane()}`
  const degradation = presetDegradationLine(text)
  if (degradation !== undefined) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} degraded instead of mounting: ${degradation.trim()}`)
  }
}

function officialPresetCatalogDiagnostic(presetId, tuiLog, tmux) {
  const pane = stripTerminalControl(tmux.capturePane())
  return [
    `official preset ${presetId} settings snapshot: ${JSON.stringify(settingsSearchSnapshot(pane))}`,
    'tmux pane tail:',
    redact(tail(pane, 24)),
    'TUI log tail:',
    redact(tail(readText(tuiLog), 24)),
  ].join('\\n')
}

// The official preset gate owns its own diagnostic wording; the shared
// harness only detects a generic incompatible surface.
export function assertNoPresetCompatibilityFailures(tuiLog, tmux) {
  assertNoCompatibilityFailures(tuiLog, tmux, line => `official preset smoke reported an incompatible surface: ${line}`)
}

function modelRequestSummary(records) {
  return records.map(record => ({
    markerCount: record.markerCount,
    presentTool: record.presentTool === true,
    presentInstruction: record.presentInstruction === true,
  }))
}

function modelRequestFacts(records) {
  const agentRequests = records.filter(record => record.purpose === null)
  const auxiliaryTitleRequests = records.filter(record => record.purpose === 'session-title')
  return {
    agentRequests,
    requestCount: agentRequests.length,
    auxiliaryTitleRequestCount: auxiliaryTitleRequests.length,
    unexpectedRequestCount: records.length - agentRequests.length - auxiliaryTitleRequests.length,
  }
}

export function classifyDirectPromptStage(sessionId, inputEvents, records, painted) {
  const requests = modelRequestFacts(records)
  const inserted = inputEvents.filter(event => event.event === 'inserted')
  const claimed = inputEvents.filter(event => event.event === 'claimed')
  const malformedEvents = inputEvents.some(event =>
    !['inserted', 'claimed'].includes(event.event)
    || event.sessionId !== sessionId
    || typeof event.messageId !== 'string'
    || event.messageId.length === 0)
  const chainMismatch = claimed.length > 0 && (
    inserted.length !== 1
    || claimed.length !== 1
    || inserted[0].sessionId !== claimed[0].sessionId
    || inserted[0].messageId !== claimed[0].messageId
    || inputEvents.indexOf(inserted[0]) > inputEvents.indexOf(claimed[0])
  )
  let stage
  if (malformedEvents || chainMismatch || inserted.length > 1 || claimed.length > 1
    || requests.requestCount > 1 || requests.auxiliaryTitleRequestCount > 1 || requests.unexpectedRequestCount > 0) {
    stage = 'DUPLICATE_OR_MISMATCHED_PROMPT'
  } else if (requests.requestCount === 1 && (inserted.length !== 1 || claimed.length !== 1)) {
    stage = 'PROBE_NOT_QUALIFIED'
  } else if (inserted.length === 0) {
    stage = 'INPUT_NOT_ADMITTED'
  } else if (claimed.length === 0) {
    stage = 'INBOX_NOT_CLAIMED'
  } else if (requests.requestCount === 0) {
    stage = 'MODEL_STREAM_NOT_REACHED'
  } else if (requests.agentRequests[0].presentTool !== true || requests.agentRequests[0].markerCount !== 1 || requests.agentRequests[0].presentInstruction !== true) {
    stage = 'DUPLICATE_OR_MISMATCHED_PROMPT'
  } else if (!painted) {
    stage = 'ANSWER_NOT_PAINTED'
  }
  return {
    stage,
    inputInserted: inserted.length,
    inputClaimed: claimed.length,
    requestCount: requests.requestCount,
    auxiliaryTitleRequestCount: requests.auxiliaryTitleRequestCount,
    unexpectedRequestCount: requests.unexpectedRequestCount,
    modelRequests: modelRequestSummary(requests.agentRequests),
  }
}

export function directPromptTimeoutDiagnostic(stage, surfaceAlive, header, inputEvents, records) {
  const requests = modelRequestFacts(records)
  return JSON.stringify({
    stage,
    surfaceAlive,
    headerPresent: typeof header?.sessionId === 'string' && header.sessionId.length > 0,
    inputInserted: inputEvents.filter(event => event.event === 'inserted').length,
    inputClaimed: inputEvents.filter(event => event.event === 'claimed').length,
    requestCount: requests.requestCount,
    auxiliaryTitleRequestCount: requests.auxiliaryTitleRequestCount,
    unexpectedRequestCount: requests.unexpectedRequestCount,
    modelRequests: modelRequestSummary(requests.agentRequests),
  })
}

export function writeOfficialPresetFailureEvidence(path, {
  presetId,
  stage,
  error,
  surfaceAlive,
  version,
  mode,
  candidate,
  header,
  inputEvents,
  records,
  pane,
  scrollback,
  tuiLog,
  commandEvidence = [],
  commandStatus,
  probeWriteFailed = false,
  timeline = {},
  diagnosticErrors = [],
}) {
  if (path === undefined) return
  try {
    if (existsSync(path)) return
    const requests = modelRequestFacts(records)
    const sessionId = header?.sessionId
      ?? commandEvidence.find(record => record?.recordType === 'session-observed')?.sessionId
      ?? null
    const sessionEvents = commandEvidence
      .filter(record => record?.recordType === 'event' && record.sessionId === sessionId)
    const maxEvents = 32
    const commandLifecycle = sessionEvents.slice(-maxEvents).map(record => ({
      ...record,
      ...(typeof record.text === 'string' ? { text: redact(record.text) } : {}),
    }))
    const tuiLogRedacted = redact(tuiLog)
    const plainLog = stripTerminalControl(tuiLogRedacted)
    const scrollbackText = typeof scrollback === 'string'
      ? scrollback
      : typeof scrollback?.text === 'string' ? scrollback.text : ''
    const boundedTail = (text, maxChars) => ({
      text: text.slice(-maxChars),
      truncated: text.length > maxChars,
      totalChars: text.length,
    })
    const rawLogTail = boundedTail(tuiLogRedacted, 12_000)
    const plainLogTail = boundedTail(plainLog, 12_000)
    const scrollbackTail = boundedTail(redact(scrollbackText), 12_000)
    const paneRedacted = redact(pane)
    const paneTailSource = tail(paneRedacted, 40)
    const paneTail = paneTailSource.slice(-4_000)
    const elapsed = (start, end) => Number.isSafeInteger(start) && Number.isSafeInteger(end)
      ? end - start
      : null
    const timingMs = {
      inputToEnter: elapsed(timeline.composerVisibleAt, timeline.enterSentAt),
      enterToRun: elapsed(timeline.enterSendStartedAt, timeline.commandRunAt),
      runToDone: elapsed(timeline.commandRunAt, timeline.commandDoneAt),
      doneToResultValidation: elapsed(timeline.commandDoneAt, timeline.resultValidatedAt),
      doneToPaint: elapsed(timeline.commandDoneAt, timeline.terminalObservedAt),
      enterToPaint: elapsed(timeline.enterSendStartedAt, timeline.terminalObservedAt),
    }
    const report = {
      presetId,
      stage,
      phase: error instanceof CompatFailure ? error.phase : 'UNEXPECTED_FAILURE',
      failureSummary: ({
        PRESET_STATUS_NOT_DISPATCHED: 'The qualified session/event probe observed no /preset status command/run after Enter.',
        PRESET_STATUS_NOT_SETTLED: 'The /preset status command/run has no matching command/done.',
        PRESET_STATUS_COMMAND_ERROR: 'The matching /preset status command/done settled with kind error.',
        PRESET_STATUS_RESULT_MISMATCH: 'The successful /preset status result did not report the expected preset.',
        PRESET_STATUS_NOT_PAINTED: 'The successful /preset status result was not newly visible in the current terminal pane.',
        PRESET_STATUS_PROBE_UNQUALIFIED: 'The command lifecycle probe or its Session/event evidence was not qualified.',
        PRESET_STATUS_DUPLICATE: 'The current /preset status lifecycle contained duplicate or ambiguous command events.',
        INPUT_NOT_ADMITTED: 'The standard user input did not reach the Agent Inbox.',
        INBOX_NOT_CLAIMED: 'The inserted standard user message was not claimed by the Agent Loop.',
        MODEL_STREAM_NOT_REACHED: 'The claimed standard user message did not reach the mock model stream.',
        ANSWER_NOT_PAINTED: 'The mock model answer was not painted in the terminal.',
        DUPLICATE_OR_MISMATCHED_PROMPT: 'The Inbox identity chain or unique mock request did not match.',
        PROBE_NOT_QUALIFIED: 'A model request occurred without a complete observed Inbox identity chain.',
      })[stage] ?? (error instanceof CompatFailure ? 'official preset smoke assertion failed' : 'official preset smoke threw an unexpected error'),
      surfaceAlive,
      mode,
      version,
      candidate: basename(candidate ?? '(unknown)'),
      sessionId,
      header: {
        present: typeof header?.sessionId === 'string' && header.sessionId.length > 0,
        sessionId: header?.sessionId ?? null,
        agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : null,
      },
      probeQualification: commandStatus?.qualification ?? {
        probeInstalled: commandEvidence.some(record => record?.recordType === 'probe-installed' && record.installed === true),
        sessionObserved: commandEvidence.some(record => record?.recordType === 'session-observed' && record.headerConfirmed === true),
        observedSessionId: commandEvidence.find(record => record?.recordType === 'session-observed')?.sessionId ?? null,
        expectedSessionId: sessionId,
        probeWriteFailed,
      },
      commandStatus: commandStatus === undefined ? null : {
        stage: commandStatus.stage ?? 'completed',
        commandId: commandStatus.run?.commandId ?? null,
        runSeq: commandStatus.run?.seq ?? null,
        doneSeq: commandStatus.done?.seq ?? null,
        doneKind: commandStatus.done?.kind ?? null,
        resultText: typeof commandStatus.done?.text === 'string' ? redact(commandStatus.done.text) : null,
        resultMatches: commandStatus.resultMatches === true,
        painted: commandStatus.painted === true,
      },
      commandLifecycle,
      commandLifecycleTruncated: sessionEvents.length > maxEvents,
      inputInserted: inputEvents.filter(event => event.event === 'inserted').length,
      inputClaimed: inputEvents.filter(event => event.event === 'claimed').length,
      requestCount: requests.requestCount,
      auxiliaryTitleRequestCount: requests.auxiliaryTitleRequestCount,
      unexpectedRequestCount: requests.unexpectedRequestCount,
      modelRequests: modelRequestSummary(requests.agentRequests),
      timeline,
      timingMs,
      paneTail,
      paneTailTruncated: paneRedacted.split(/\r?\n/u).length > 40 || paneTailSource.length > 4_000,
      paneTailTotalChars: paneRedacted.length,
      scrollbackTail: scrollbackTail.text,
      scrollbackTruncated: scrollbackTail.truncated || scrollback?.truncated === true,
      scrollbackTotalChars: scrollbackTail.totalChars,
      scrollbackHistoryLines: scrollback?.totalHistoryLines ?? null,
      tuiLogTail: rawLogTail.text,
      tuiLogTailTruncated: rawLogTail.truncated,
      tuiLogTailTotalChars: rawLogTail.totalChars,
      tuiLogTailPlain: plainLogTail.text,
      tuiLogTailPlainTruncated: plainLogTail.truncated,
      tuiLogTailPlainTotalChars: plainLogTail.totalChars,
      diagnosticErrors: diagnosticErrors.map(message => redact(message)),
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, redactedJson(report), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch {
    console.error('OFFICIAL_PRESETS_DIAGNOSTIC_WRITE_FAILURE')
  }
}

function readJsonLines(path) {
  const text = readFileSync(path, 'utf8').trim()
  return text === '' ? [] : text.split(/\r?\n/u).map(line => JSON.parse(line))
}

export function assertOfficialPresetHeader(presetId, evidencePath) {
  const evidence = readOptionalJson(evidencePath)
  if (evidence?.error !== undefined) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header probe failed: ${String(evidence.error)}`)
  }
  if (evidence?.agentPreset !== presetId) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header mismatch: ${String(evidence?.agentPreset ?? '(missing)')}`)
  }
  if (typeof evidence?.sessionId !== 'string' || evidence.sessionId.length === 0) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header probe returned no session id`)
  }
}

/** Query the live preset without mutating it through the /preset picker. */
export function officialPresetStatusCommand() {
  return '/preset status'
}

export function officialPresetStatusVisible(presetId, pane) {
  return pane.includes(`preset: ${presetId} ·`)
}

export function officialPresetStatusResultMatches(presetId, text) {
  return typeof text === 'string'
    && text.startsWith(`preset: ${presetId} · default: `)
}

function occurrenceCount(text, value) {
  return text.split(value).length - 1
}

export function officialPresetStatusPainted(presetId, previousPane, pane) {
  const previous = stripTerminalControl(previousPane)
  const current = stripTerminalControl(pane)
  const result = `preset: ${presetId} · default: `
  const commandVisible = current.split(/\r?\n/u).some(line => /\/preset\s+status(?:\s|$)/u.test(line))
  return commandVisible
    && current.includes(result)
    && occurrenceCount(current, result) > occurrenceCount(previous, result)
}

const TERMINAL_PRESET_STATUS_STAGES = new Set([
  'PRESET_STATUS_PROBE_UNQUALIFIED',
  'PRESET_STATUS_COMMAND_ERROR',
  'PRESET_STATUS_RESULT_MISMATCH',
  'PRESET_STATUS_DUPLICATE',
])

export function classifyOfficialPresetStatus(sessionId, presetId, evidence, enteredAt, painted, probeWriteFailed = false, baselineSeq = -1) {
  const probeInstalled = evidence.some(record => record?.recordType === 'probe-installed'
    && record.installed === true
    && record.event === 'session/event'
    && record.global === true)
  const sessionObserved = evidence.some(record => record?.recordType === 'session-observed'
    && record.headerConfirmed === true
    && record.sessionId === sessionId)
  const qualification = {
    probeInstalled,
    sessionObserved,
    observedSessionId: evidence.find(record => record?.recordType === 'session-observed')?.sessionId ?? null,
    expectedSessionId: sessionId,
    probeWriteFailed,
  }
  if (!probeInstalled || !sessionObserved || probeWriteFailed || typeof sessionId !== 'string' || sessionId.length === 0) {
    return { stage: 'PRESET_STATUS_PROBE_UNQUALIFIED', qualification }
  }

  const events = evidence.filter(record => record?.recordType === 'event' && record.sessionId === sessionId)
  const malformed = events.some(record => !Number.isSafeInteger(record.seq)
    || typeof record.commandId !== 'string'
    || record.commandId.length === 0
    || !Number.isSafeInteger(record.observedAt)
    || (record.type === 'command/run' && typeof record.name !== 'string')
    || (record.type === 'command/done' && !['success', 'error'].includes(record.kind))
    || !['command/run', 'command/done'].includes(record.type))
  if (malformed) return { stage: 'PRESET_STATUS_PROBE_UNQUALIFIED', qualification }

  const enteredEvents = events.filter(record => record.observedAt >= enteredAt && record.seq > baselineSeq)
  const runs = enteredEvents.filter(record => record.type === 'command/run' && record.name === 'preset')
  if (runs.some(record => typeof record.args !== 'string')) {
    return { stage: 'PRESET_STATUS_PROBE_UNQUALIFIED', qualification, runs }
  }
  const targetRuns = runs.filter(record => record.args === ' status')
  if (enteredEvents.some(record => record.type === 'command/done' && record.pairedRun !== true)) {
    return { stage: 'PRESET_STATUS_PROBE_UNQUALIFIED', qualification, runs }
  }
  if (runs.length > 1 || targetRuns.length > 1) {
    return { stage: 'PRESET_STATUS_DUPLICATE', qualification, runs }
  }
  const run = targetRuns[0]
  if (run === undefined) {
    return { stage: 'PRESET_STATUS_NOT_DISPATCHED', qualification, runs }
  }
  if (enteredEvents.filter(record => record.type === 'command/run' && record.commandId === run.commandId).length !== 1) {
    return { stage: 'PRESET_STATUS_DUPLICATE', qualification, run }
  }

  const completions = events.filter(record => record.type === 'command/done' && record.commandId === run.commandId)
  if (completions.length > 1) return { stage: 'PRESET_STATUS_DUPLICATE', qualification, run, completions }
  const done = completions[0]
  if (done === undefined) return { stage: 'PRESET_STATUS_NOT_SETTLED', qualification, run }
  if (done.pairedRun !== true || done.seq <= run.seq || done.observedAt < run.observedAt) {
    return { stage: 'PRESET_STATUS_PROBE_UNQUALIFIED', qualification, run, done }
  }
  if (done.kind !== 'success') return { stage: 'PRESET_STATUS_COMMAND_ERROR', qualification, run, done }
  if (!officialPresetStatusResultMatches(presetId, done.text)) {
    return { stage: 'PRESET_STATUS_RESULT_MISMATCH', qualification, run, done }
  }
  if (!painted) return { stage: 'PRESET_STATUS_NOT_PAINTED', qualification, run, done, resultMatches: true }
  return { stage: undefined, qualification, run, done, resultMatches: true, painted: true }
}

/**
 * Exercise every DSH-shipped preset in two stages. Stage 1 boots the requested
 * `--preset` sessionless surface. Stage 2 creates a real session without a
 * model request, verifies the live projection reports the requested preset,
 * and checks the scoped command catalog. A standing fallback or mount error is
 * always a failure rather than a successful degraded boot.
 */
export async function smokeOfficialPresetMounts(
  invocation,
  workDir,
  env,
  promptEvidencePath,
  { candidate = '(unknown)', version = '(unknown)', mode = process.env.DSH_MODE ?? 'npm' } = {},
  tmuxFactory = tmuxRunner,
) {
  for (const presetId of OFFICIAL_PRESET_IDS) {
    const socket = `dsh-preset-health-${process.pid}-${presetId}`
    const session = `preset-health-${process.pid}-${presetId}`
    const tmux = tmuxFactory(socket, session, env)
    const launcher = join(workDir, `run-preset-${presetId}.sh`)
    const tuiLog = join(workDir, `preset-${presetId}.tui.log`)
    let failureStage = 'boot'
    let header
    let inputEvents = []
    let records = []
    let commandEvidence = []
    let commandStatus
    let presetStatusTimeline = {}
    let presetStatusPaneBefore = ''
    let probeWriteFailed = false
    let diagnosticErrors = []
    writeLauncher(launcher, invocation, env, presetId)
    const sendComposerLine = async (text, label, timing) => {
      if (timing !== undefined) timing.startedAt = Date.now()
      failureStage = `${label}-composer-visible`
      tmux.sendLiteral(text)
      await waitUntil(`official preset ${presetId} ${label} composer line`, TIMEOUTS.command, () => {
        if (!tmux.hasSession()) return false
        const visible = composerContainsExactInput(tmux.capturePane(), text)
        if (visible && timing !== undefined) timing.composerVisibleAt = Date.now()
        return visible
      }, 'COMPAT_INPUT_FAILURE')
      failureStage = `${label}-enter`
      if (timing !== undefined) timing.enterSendStartedAt = Date.now()
      tmux.sendKey('Enter')
      if (timing !== undefined) timing.enterSentAt = Date.now()
    }
    try {
      rmSync(env.DSH_SMOKE_HEADER_EVIDENCE, { force: true })
      if (typeof env.DSH_SMOKE_COMMAND_EVIDENCE === 'string') {
        rmSync(env.DSH_SMOKE_COMMAND_EVIDENCE, { force: true })
        writeFileSync(env.DSH_SMOKE_COMMAND_EVIDENCE, '', { encoding: 'utf8', mode: 0o600 })
      }
      const started = tmux.tmux([
        'new-session', '-d', '-s', session, '-x', '80', '-y', '24',
        `script -qefc ${shellQuote(launcher)} ${shellQuote(tuiLog)}`,
      ])
      if (started.status !== 0) {
        fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} could not start:\n${resultText(started)}`)
      }
      await waitUntil(`official preset ${presetId} boot`, TIMEOUTS.boot, () => {
        if (!tmux.hasSession()) return false
        return tmux.capturePane().includes('❯')
      }, 'COMPAT_BOOT_FAILURE')
      assertNoPresetCompatibilityFailures(tuiLog, tmux)
      assertOfficialPresetMounted(presetId, tuiLog, tmux)

      // No pending /preset override is installed here: /new must carry the
      // launch-time --preset through the effective-preset path. This makes the
      // matrix prove the actual launch contract instead of retesting a manual
      // sessionless override.
      await sendComposerLine('/new', 'session-create')
      // The command result is a transient UI line; the durable probe below is
      // the canonical evidence that /new created the requested session.
      failureStage = 'session-header'
      await waitUntil(`official preset ${presetId} durable header`, TIMEOUTS.command, () => {
        const evidence = readOptionalJson(env.DSH_SMOKE_HEADER_EVIDENCE)
        if (evidence?.error !== undefined) {
          fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header probe failed: ${String(evidence.error)}`)
        }
        if (evidence?.agentPreset !== undefined && evidence.agentPreset !== presetId) {
          fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header mismatch: ${String(evidence.agentPreset)}`)
        }
        return evidence?.agentPreset === presetId
          && typeof evidence?.sessionId === 'string'
          && evidence.sessionId.length > 0
      }, 'COMPAT_BOOT_FAILURE')
      header = readOptionalJson(env.DSH_SMOKE_HEADER_EVIDENCE)
      assertOfficialPresetHeader(presetId, env.DSH_SMOKE_HEADER_EVIDENCE)

      failureStage = 'preset-status-input'
      presetStatusTimeline = {}
      try {
        commandEvidence = readJsonLines(env.DSH_SMOKE_COMMAND_EVIDENCE)
      } catch (readError) {
        probeWriteFailed = true
        diagnosticErrors.push(`command evidence baseline could not be read: ${readError instanceof Error ? readError.message : String(readError)}`)
      }
      const priorSessionEvents = commandEvidence.filter(record => record?.recordType === 'event'
        && record.sessionId === header.sessionId
        && Number.isSafeInteger(record.seq))
      presetStatusTimeline.previousCommandSeq = priorSessionEvents.reduce((max, record) => Math.max(max, record.seq), -1)
      presetStatusPaneBefore = tmux.capturePane()
      await sendComposerLine(officialPresetStatusCommand(), 'preset-status', presetStatusTimeline)
      failureStage = 'preset-status-lifecycle'
      const updateStatusTimeline = (diagnostic, painted) => {
        if (diagnostic.run !== undefined) presetStatusTimeline.commandRunAt ??= diagnostic.run.observedAt
        if (diagnostic.done !== undefined) presetStatusTimeline.commandDoneAt ??= diagnostic.done.observedAt
        if (diagnostic.resultMatches === true) presetStatusTimeline.resultValidatedAt ??= Date.now()
        if (painted) presetStatusTimeline.terminalObservedAt ??= Date.now()
      }
      try {
        await waitUntil(`official preset ${presetId} command lifecycle and terminal result`, TIMEOUTS.command, () => {
          if (!tmux.hasSession()) return false
          try {
            commandEvidence = readJsonLines(env.DSH_SMOKE_COMMAND_EVIDENCE)
          } catch {
            return false
          }
          const pane = tmux.capturePane()
          const painted = officialPresetStatusPainted(presetId, presetStatusPaneBefore, pane)
          commandStatus = classifyOfficialPresetStatus(
            header.sessionId,
            presetId,
            commandEvidence,
            presetStatusTimeline.enterSendStartedAt,
            painted,
            probeWriteFailed,
            presetStatusTimeline.previousCommandSeq,
          )
          updateStatusTimeline(commandStatus, painted)
          if (TERMINAL_PRESET_STATUS_STAGES.has(commandStatus.stage)) {
            fail(commandStatus.stage, `official preset ${presetId} command lifecycle: ${redact(JSON.stringify(commandStatus))}`)
          }
          return commandStatus.stage === undefined
        }, 'COMPAT_BOOT_FAILURE')
      } catch (error) {
        if (!(error instanceof CompatFailure)) throw error
        try {
          commandEvidence = readJsonLines(env.DSH_SMOKE_COMMAND_EVIDENCE)
        } catch (readError) {
          diagnosticErrors.push(`command evidence could not be read: ${readError instanceof Error ? readError.message : String(readError)}`)
        }
        let pane = ''
        try {
          pane = tmux.capturePane()
        } catch (captureError) {
          diagnosticErrors.push(`tmux pane could not be captured: ${captureError instanceof Error ? captureError.message : String(captureError)}`)
        }
        probeWriteFailed = readText(tuiLog).includes('OFFICIAL_PRESET_COMMAND_PROBE_WRITE_FAILURE')
        commandStatus = classifyOfficialPresetStatus(
          header.sessionId,
          presetId,
          commandEvidence,
          presetStatusTimeline.enterSendStartedAt,
          officialPresetStatusPainted(presetId, presetStatusPaneBefore, pane),
          probeWriteFailed || diagnosticErrors.length > 0,
          presetStatusTimeline.previousCommandSeq,
        )
        updateStatusTimeline(commandStatus, commandStatus.painted === true)
        failureStage = commandStatus.stage ?? 'PRESET_STATUS_PROBE_UNQUALIFIED'
        fail(failureStage, `${error.message}; lifecycle=${redact(JSON.stringify(commandStatus))}`)
      }
      assertNoPresetCompatibilityFailures(tuiLog, tmux)
      assertOfficialPresetMounted(presetId, tuiLog, tmux)
      console.log(`OFFICIAL_PRESET_COMMAND_EVIDENCE ${JSON.stringify({
        presetId,
        sessionId: header.sessionId,
        commandId: commandStatus.run.commandId,
        run: {
          seq: commandStatus.run.seq,
          type: commandStatus.run.type,
          name: commandStatus.run.name,
          args: commandStatus.run.args,
        },
        done: {
          seq: commandStatus.done.seq,
          type: commandStatus.done.type,
          kind: commandStatus.done.kind,
          text: redact(commandStatus.done.text),
        },
        probeQualification: commandStatus.qualification,
        painted: commandStatus.painted === true,
        timeline: presetStatusTimeline,
        timingMs: {
          inputToEnter: presetStatusTimeline.enterSentAt - presetStatusTimeline.composerVisibleAt,
          enterToRun: commandStatus.run.observedAt - presetStatusTimeline.enterSendStartedAt,
          runToDone: commandStatus.done.observedAt - commandStatus.run.observedAt,
          doneToResultAndPaint: presetStatusTimeline.terminalObservedAt - commandStatus.done.observedAt,
        },
      })}`)

      if (presetId === 'standard' && promptEvidencePath !== undefined && env.DSH_SMOKE_INPUT_EVIDENCE !== undefined) {
        const directPrompt = DIRECT_STANDARD_PROMPT
        writeFileSync(env.DSH_SMOKE_INPUT_EVIDENCE, '', { encoding: 'utf8', mode: 0o600 })
        await sendComposerLine(directPrompt, 'standard-prompt')
        failureStage = 'standard-prompt-inbox-and-stream'
        try {
          await waitUntil('Direct standard prompt Inbox admission and model stream', TIMEOUTS.command, () => {
            inputEvents = readJsonLines(env.DSH_SMOKE_INPUT_EVIDENCE)
            records = readJsonLines(promptEvidencePath)
            const diagnostic = classifyDirectPromptStage(header.sessionId, inputEvents, records, false)
            if (diagnostic.stage === 'DUPLICATE_OR_MISMATCHED_PROMPT') {
              fail('COMPAT_BOOT_FAILURE', `Direct standard prompt qualification mismatch: ${directPromptTimeoutDiagnostic(diagnostic.stage, tmux.hasSession(), header, inputEvents, records)}`)
            }
            return diagnostic.stage === 'ANSWER_NOT_PAINTED'
          }, 'COMPAT_BOOT_FAILURE')
        } catch (error) {
          if (!(error instanceof CompatFailure)) throw error
          const diagnostic = classifyDirectPromptStage(header.sessionId, inputEvents, records, false)
          failureStage = diagnostic.stage ?? 'MODEL_STREAM_NOT_REACHED'
          fail(error.phase, `${error.message}; qualification=${directPromptTimeoutDiagnostic(failureStage, tmux.hasSession(), header, inputEvents, records)}`)
        }

        failureStage = 'ANSWER_NOT_PAINTED'
        try {
          await waitUntil('Direct standard prompt answer', TIMEOUTS.command, () => {
            inputEvents = readJsonLines(env.DSH_SMOKE_INPUT_EVIDENCE)
            records = readJsonLines(promptEvidencePath)
            const diagnostic = classifyDirectPromptStage(header.sessionId, inputEvents, records, false)
            if (diagnostic.stage !== 'ANSWER_NOT_PAINTED') {
              failureStage = diagnostic.stage
              fail('COMPAT_BOOT_FAILURE', `Direct standard prompt qualification changed: ${directPromptTimeoutDiagnostic(failureStage, tmux.hasSession(), header, inputEvents, records)}`)
            }
            return tmux.hasSession() && directPromptAnswerVisible(tmux.capturePane())
          }, 'COMPAT_BOOT_FAILURE')
        } catch (error) {
          if (!(error instanceof CompatFailure)) throw error
          fail(error.phase, `${error.message}; qualification=${directPromptTimeoutDiagnostic(failureStage, tmux.hasSession(), header, inputEvents, records)}`)
        }
        const completed = classifyDirectPromptStage(header.sessionId, inputEvents, records, true)
        if (completed.stage !== undefined) {
          failureStage = completed.stage
          fail('COMPAT_BOOT_FAILURE', `Direct standard prompt qualification failed: ${directPromptTimeoutDiagnostic(failureStage, tmux.hasSession(), header, inputEvents, records)}`)
        }
      }

      await sendComposerLine('/help', 'help')
      failureStage = 'command-catalog'
      try {
        await waitUntil(`official preset ${presetId} command catalog`, TIMEOUTS.command, () => {
          if (!tmux.hasSession()) return false
          const snapshot = settingsSearchSnapshot(tmux.capturePane())
          return snapshot.searchVisible && snapshot.query === ''
        }, 'COMPAT_BOOT_FAILURE')
      } catch (error) {
        if (!(error instanceof CompatFailure)) throw error
        fail(error.phase, `${error.message}\n${officialPresetCatalogDiagnostic(presetId, tuiLog, tmux)}`)
      }
      tmux.sendLiteral('goal')
      const shouldHaveGoal = presetId !== 'minimal'
      try {
        await waitUntil(`official preset ${presetId} goal command isolation`, TIMEOUTS.command, () => {
          if (!tmux.hasSession()) return false
          const pane = tmux.capturePane()
          const snapshot = settingsSearchSnapshot(pane)
          const hasOnlyGoal = snapshot.commandRows.length === 1 && snapshot.commandRows[0] === '/goal'
          return snapshot.searchVisible
            && snapshot.query === 'goal'
            && hasOnlyGoal === shouldHaveGoal
            && snapshot.noMatches === !shouldHaveGoal
        }, 'COMPAT_BOOT_FAILURE')
      } catch (error) {
        if (!(error instanceof CompatFailure)) throw error
        fail(error.phase, `${error.message}\n${officialPresetCatalogDiagnostic(presetId, tuiLog, tmux)}`)
      }
      tmux.sendKey('Escape')
      await waitUntil(`official preset ${presetId} command catalog close`, TIMEOUTS.input, () => {
        if (!tmux.hasSession()) return false
        return !settingsSearchSnapshot(tmux.capturePane()).searchVisible
      }, 'COMPAT_BOOT_FAILURE')
      await sendComposerLine('/exit', 'exit')
      failureStage = 'shutdown'
      await waitUntil(`official preset ${presetId} shutdown`, TIMEOUTS.dispose, () => !tmux.hasSession(), 'COMPAT_DISPOSE_FAILURE')
    } catch (error) {
      const latestHeader = header ?? readOptionalJson(env.DSH_SMOKE_HEADER_EVIDENCE)
      let pane = ''
      try {
        pane = tmux.capturePane()
      } catch (captureError) {
        diagnosticErrors.push(`tmux pane could not be captured: ${captureError instanceof Error ? captureError.message : String(captureError)}`)
      }
      let scrollback
      try {
        scrollback = tmux.captureScrollback(200)
      } catch (captureError) {
        diagnosticErrors.push(`tmux scrollback could not be captured: ${captureError instanceof Error ? captureError.message : String(captureError)}`)
      }
      let surfaceAlive = false
      try {
        surfaceAlive = tmux.hasSession()
      } catch (captureError) {
        diagnosticErrors.push(`tmux session status could not be read: ${captureError instanceof Error ? captureError.message : String(captureError)}`)
      }
      const log = readText(tuiLog)
      probeWriteFailed ||= log.includes('OFFICIAL_PRESET_COMMAND_PROBE_WRITE_FAILURE')
      writeOfficialPresetFailureEvidence(env.OFFICIAL_PRESETS_FAILURE_EVIDENCE, {
        presetId,
        stage: failureStage,
        error,
        surfaceAlive,
        version,
        mode,
        candidate,
        header: latestHeader,
        inputEvents,
        records,
        pane,
        scrollback,
        tuiLog: log,
        commandEvidence,
        commandStatus,
        probeWriteFailed,
        timeline: presetStatusTimeline,
        diagnosticErrors,
      })
      throw error
    } finally {
      tmux.stop()
    }
  }
}

async function main() {
  const smokeArgs = process.argv.slice(2)
  const tarball = resolveTarball(candidateArgument(smokeArgs))
  validateCandidateTarball(tarball)
  const distributionPath = distributionArgument(smokeArgs)
  const configuredMode = process.env.DSH_MODE
  if (configuredMode !== undefined && configuredMode !== 'source' && configuredMode !== 'npm') {
    throw new Error(`unsupported DSH_MODE ${JSON.stringify(configuredMode)}; expected source or npm`)
  }
  if (configuredMode === 'source' && distributionPath === undefined) {
    throw new Error('DSH_MODE=source requires --distribution')
  }
  if (configuredMode === 'npm' && distributionPath !== undefined) {
    throw new Error('DSH_MODE=npm must not receive --distribution')
  }
  const sourceConfig = sourceConfigForArgs(smokeArgs)
  const targetDshVersion = sourceConfig?.expectedVersion ?? npmDshVersion()
  const distribution = distributionPath === undefined
    ? loadDshDistribution({ mode: 'npm', version: targetDshVersion })
    : loadDshDistribution({
      mode: 'source',
      manifest: resolve(distributionPath),
      packageJson: join(PACKAGE_ROOT, 'package.json'),
      sourceConfig,
    })
  if (distribution.version !== targetDshVersion) {
    throw new Error(`DSH distribution version mismatch: expected ${targetDshVersion}, got ${distribution.version}`)
  }
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-official-presets-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  mkdirSync(home, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(harnessDir, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const evidencePath = join(workDir, 'evidence.json')
  const promptEvidencePath = join(workDir, 'prompt-evidence.jsonl')
  const inputEvidencePath = join(workDir, 'input-evidence.jsonl')
  writeFileSync(promptEvidencePath, '', { encoding: 'utf8', mode: 0o600 })
  writeFileSync(inputEvidencePath, '', { encoding: 'utf8', mode: 0o600 })
  const env = {
    ...isolatedEnvironment(workDir, home, dshHome, evidencePath),
    DSH_SMOKE_PROMPT_EVIDENCE: promptEvidencePath,
    DSH_SMOKE_INPUT_EVIDENCE: inputEvidencePath,
    OFFICIAL_PRESETS_FAILURE_EVIDENCE: process.env.OFFICIAL_PRESETS_FAILURE_EVIDENCE,
  }

  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-official-presets-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': targetDshVersion,
      },
    }, null, 2) + '\n', 'utf8')
    const pnpm = run(PNPM_COMMAND, ['--version'], { cwd: harnessDir, env })
    if (pnpm.status !== 0) throw new Error(`pnpm is unavailable:\n${commandOutput(pnpm)}`)
    runPnpmInstall(harnessDir, env, distribution)

    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    if (version.status !== 0) throw new Error(`installed DSH --version failed:\n${commandOutput(version)}`)
    requireExactVersion('DSH', commandOutput(version).split(/\r?\n/u).find(line => line.trim() !== '')?.trim(), targetDshVersion)

    const promptPackage = writePromptQualificationPackage(workDir, targetDshVersion)
    runPnpmInstall(promptPackage, env, distribution)
    const promptLlmManifest = createRequire(join(promptPackage, 'package.json')).resolve('@deepseek-ai/dsh-llm/package.json')
    requireExactVersion('@deepseek-ai/dsh-llm qualification dependency', readOptionalJson(promptLlmManifest)?.version, targetDshVersion)
    installPlugin(dsh, tarball, harnessDir, env, false)
    installPlugin(dsh, promptPackage, harnessDir, env, false)
    installPlugin(dsh, writeHeaderProbePackage(workDir), harnessDir, env, false)
    await smokeOfficialPresetMounts(dsh, workDir, env, promptEvidencePath, {
      candidate: tarball,
      version: targetDshVersion,
      mode: distributionPath === undefined ? 'npm' : 'source',
    })
    console.log(`official preset assembly smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
  } finally {
    if (process.env.OFFICIAL_PRESETS_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved official preset environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`OFFICIAL_PRESETS_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
