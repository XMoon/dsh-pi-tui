import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CompatFailure, writeHeaderProbePackage } from '../../scripts/lib/dsh-smoke-harness.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  assertNoPresetCompatibilityFailures,
  assertOfficialPresetHeader,
  classifyDirectPromptStage,
  classifyOfficialPresetStatus,
  composerContainsExactInput,
  directPromptAnswerVisible,
  directPromptTimeoutDiagnostic,
  officialPresetStatusCommand,
  officialPresetStatusPainted,
  officialPresetStatusResultMatches,
  officialPresetStatusVisible,
  presetDegradationLine,
  settingsSearchSnapshot,
  smokeOfficialPresetMounts,
  writeOfficialPresetFailureEvidence,
} from '../../scripts/official-presets-smoke.mjs'

test('the official preset matrix is independently callable and reports the live preset', () => {
  assert.equal(typeof smokeOfficialPresetMounts, 'function', 'the real official matrix must be independently callable')
  assert.equal(officialPresetStatusCommand(), '/preset status')
  assert.equal(officialPresetStatusVisible('ptc', 'preset: ptc · default: ptc'), true)
  assert.equal(officialPresetStatusVisible('ptc', 'preset: standard · default: ptc'), false)
})

test('the Header Probe records command events only for its confirmed Session', async (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('official-presets-command-probe-')
  const headerPath = join(directory, 'header.json')
  const inputPath = join(directory, 'input.jsonl')
  const commandPath = join(directory, 'command.jsonl')
  const probeDir = writeHeaderProbePackage(directory)
  const envKeys = ['DSH_SMOKE_HEADER_EVIDENCE', 'DSH_SMOKE_INPUT_EVIDENCE', 'DSH_SMOKE_COMMAND_EVIDENCE']
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))
  process.env.DSH_SMOKE_HEADER_EVIDENCE = headerPath
  process.env.DSH_SMOKE_INPUT_EVIDENCE = inputPath
  process.env.DSH_SMOKE_COMMAND_EVIDENCE = commandPath
  try {
    const probe = await import(pathToFileURL(join(probeDir, 'index.mjs')).href)
    const listeners = new Map()
    const listenerOptions = new Map()
    const session = { id: 'session-1', header: {} }
    probe.apply({
      get: name => name === 'sessionQuery' ? {
        observeSession: async () => ({ header: { id: 'session-1', agentPreset: 'cordis' } }),
      } : undefined,
      on: (name, listener, options) => {
        listeners.set(name, listener)
        listenerOptions.set(name, options)
      },
    })
    assert.deepEqual(listenerOptions.get('session/event'), { global: true })
    assert.equal(listeners.has('command/run'), false)
    assert.equal(listeners.has('command/done'), false)
    const installed = readFileSync(commandPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(installed[0].recordType, 'probe-installed')
    listeners.get('agent/created')({ agent: { session } })
    await new Promise(resolve => setImmediate(resolve))
    const eventListener = listeners.get('session/event')
    eventListener(session, {
      type: 'command/run', seq: 10,
      data: { commandId: 'cmd-new', name: 'new', args: '', source: { kind: 'user' } },
    })
    eventListener(session, {
      type: 'command/done', seq: 11,
      data: { commandId: 'cmd-new', kind: 'success', text: 'started a fresh session' },
    })
    eventListener(session, {
      type: 'command/run', seq: 12,
      data: { commandId: 'cmd-status', name: 'preset', args: ' status', source: { kind: 'user' } },
    })
    eventListener(session, {
      type: 'command/done', seq: 13,
      data: { commandId: 'cmd-status', kind: 'success', text: 'preset: cordis · default: cordis' },
    })
    eventListener({ id: 'session-2' }, {
      type: 'command/done', seq: 14,
      data: { commandId: 'cmd-status', kind: 'success', text: 'foreign session' },
    })
    const records = readFileSync(commandPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records[1], {
      recordType: 'session-observed',
      sessionId: 'session-1',
      agentPreset: 'cordis',
      headerConfirmed: true,
      observedAt: records[1].observedAt,
    })
    const events = records.filter(record => record.recordType === 'event')
    assert.equal(events.length, 4)
    assert.deepEqual(events.map(({ sessionId, seq, type, commandId }) => ({ sessionId, seq, type, commandId })), [
      { sessionId: 'session-1', seq: 10, type: 'command/run', commandId: 'cmd-new' },
      { sessionId: 'session-1', seq: 11, type: 'command/done', commandId: 'cmd-new' },
      { sessionId: 'session-1', seq: 12, type: 'command/run', commandId: 'cmd-status' },
      { sessionId: 'session-1', seq: 13, type: 'command/done', commandId: 'cmd-status' },
    ])
    assert.equal(events[2].args, ' status')
    assert.equal(events[3].name, undefined, 'command/done has no command name')
    assert.equal(events[3].pairedRun, true)
    assert.equal(readFileSync(headerPath, 'utf8').includes('session-1'), true)
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('the preset status classifier requires a qualified Session and pairs by commandId', () => {
  const sessionId = 'session-1'
  const installed = { recordType: 'probe-installed', event: 'session/event', global: true, installed: true }
  const observed = { recordType: 'session-observed', sessionId, headerConfirmed: true }
  const run = {
    recordType: 'event', sessionId, seq: 12, type: 'command/run', commandId: 'cmd-status',
    name: 'preset', args: ' status', observedAt: 101, pairedRun: true,
  }
  const done = {
    recordType: 'event', sessionId, seq: 13, type: 'command/done', commandId: 'cmd-status',
    kind: 'success', text: 'preset: cordis · default: cordis', observedAt: 102, pairedRun: true,
  }
  const unrelatedRun = {
    recordType: 'event', sessionId, seq: 14, type: 'command/run', commandId: 'cmd-help',
    name: 'help', args: '', observedAt: 103, pairedRun: true,
  }
  const unrelatedDone = {
    recordType: 'event', sessionId, seq: 15, type: 'command/done', commandId: 'cmd-help',
    kind: 'success', observedAt: 104, pairedRun: true,
  }
  const foreignDone = { ...done, sessionId: 'session-2', seq: 99, observedAt: 105 }
  const qualified = [installed, observed]
  const classify = (events, painted = true, evidence = qualified, baselineSeq = -1) =>
    classifyOfficialPresetStatus(sessionId, 'cordis', [...evidence, ...events], 100, painted, false, baselineSeq)

  assert.equal(classify([done, unrelatedRun, unrelatedDone, foreignDone, run]).stage, undefined,
    'a done record pairs by Session and Command ID, not array order')
  const historyRun = { ...run, seq: 13, commandId: 'cmd-history', observedAt: 100 }
  const historyDone = { ...done, seq: 14, commandId: 'cmd-history', observedAt: 100 }
  const currentRun = { ...run, seq: 15, commandId: 'cmd-current', observedAt: 101 }
  const currentDone = { ...done, seq: 16, commandId: 'cmd-current', observedAt: 102 }
  assert.equal(classify([historyRun, historyDone, currentRun, currentDone], true, qualified, 14).stage, undefined)
  assert.equal(classify([]).stage, 'PRESET_STATUS_NOT_DISPATCHED')
  assert.equal(classify([run]).stage, 'PRESET_STATUS_NOT_SETTLED')
  assert.equal(classify([run, { ...done, kind: 'error', text: 'failed' }]).stage, 'PRESET_STATUS_COMMAND_ERROR')
  assert.equal(classify([run, { ...done, text: 'preset: standard · default: cordis' }]).stage, 'PRESET_STATUS_RESULT_MISMATCH')
  assert.equal(classify([run, done], false).stage, 'PRESET_STATUS_NOT_PAINTED')
  assert.equal(classify([run, done, { ...done, seq: 14, observedAt: 103 }]).stage, 'PRESET_STATUS_DUPLICATE')
  assert.equal(classify([run, run, done]).stage, 'PRESET_STATUS_DUPLICATE')
  assert.equal(classify([run], true, []).stage, 'PRESET_STATUS_PROBE_UNQUALIFIED')
  assert.equal(classify([run], true, [installed]).stage, 'PRESET_STATUS_PROBE_UNQUALIFIED')
  assert.equal(classify([{ ...run, args: undefined }]).stage, 'PRESET_STATUS_PROBE_UNQUALIFIED')
  assert.equal(classify([run, { ...done, commandId: 'cmd-other' }]).stage, 'PRESET_STATUS_NOT_SETTLED')
  assert.equal(classify([run, { ...done, pairedRun: false }]).stage, 'PRESET_STATUS_PROBE_UNQUALIFIED')
  assert.equal(classify([run, done], true, [...qualified, { ...observed, sessionId: 'session-2' }]).stage, undefined)
})

test('the preset status painter requires a newly visible command result in the current pane', () => {
  const before = '🎛 /new [ok]\n────────\n❯\n────────'
  const after = `${before}\n🎛 /preset status [ok]\n  preset: cordis · default: cordis`
  assert.equal(officialPresetStatusResultMatches('cordis', 'preset: cordis · default: cordis'), true)
  assert.equal(officialPresetStatusResultMatches('cordis', 'preset: standard · default: cordis'), false)
  assert.equal(officialPresetStatusPainted('cordis', before, after), true)
  assert.equal(officialPresetStatusPainted('cordis', after, after), false)
})

test('Direct prompt diagnostics expose counts and stable model-request facts only', () => {
  const diagnostic = directPromptTimeoutDiagnostic('ANSWER_NOT_PAINTED', true, {
    sessionId: 'PRIVATE_SESSION_ID',
    agentPreset: 'standard',
  }, [
    { event: 'inserted', sessionId: 'PRIVATE_SESSION_ID', messageId: 'PRIVATE_MESSAGE_ID' },
    { event: 'claimed', sessionId: 'PRIVATE_SESSION_ID', messageId: 'PRIVATE_MESSAGE_ID', turn: 4 },
  ], [{
    purpose: null,
    markerCount: 1,
    presentTool: true,
    presentInstruction: true,
    toolNames: ['/tmp/private-profile', 'present'],
    prompt: 'full prompt with TOKEN_SENTINEL',
    path: '/home/runner/private-session',
    log: 'arbitrary runtime log SECRET_SENTINEL',
  }, {
    purpose: 'session-title',
    markerCount: 0,
    presentTool: false,
    presentInstruction: false,
    toolNames: ['FAKE_SECRET_123'],
    prompt: 'auxiliary title message SECRET_SENTINEL',
  }])
  assert.deepEqual(JSON.parse(diagnostic), {
    stage: 'ANSWER_NOT_PAINTED',
    surfaceAlive: true,
    headerPresent: true,
    inputInserted: 1,
    inputClaimed: 1,
    requestCount: 1,
    auxiliaryTitleRequestCount: 1,
    unexpectedRequestCount: 0,
    modelRequests: [{ markerCount: 1, presentTool: true, presentInstruction: true }],
  })
  assert.doesNotMatch(diagnostic, /PRIVATE_SESSION_ID|PRIVATE_MESSAGE_ID|TOKEN_SENTINEL|SECRET_SENTINEL|FAKE_SECRET_123|private-profile|private-session|full prompt|auxiliary title message|runtime log/u)
})

test('official preset settings snapshots read the filtered /help frame rather than stale pane text', () => {
  const goalPane = [
    'transcript mentioned /goal before the overlay',
    '╭────────────────────────╮',
    '│ > goal                 │',
    '│                        │',
    '│ ❯ /goal               │',
    '│                        │',
    '│ Type to search · Enter/Space to change · Esc to cancel │',
    '╰────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(goalPane), {
    searchVisible: true,
    query: 'goal',
    commandRows: ['/goal'],
    noMatches: false,
  })

  const minimalPane = [
    'transcript mentioned /goal before the overlay',
    '╭────────────────────────╮',
    '│ > goal                 │',
    '│ No matching settings   │',
    '│ Type to search · Enter/Space to change · Esc to cancel │',
    '╰────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(minimalPane), {
    searchVisible: true,
    query: 'goal',
    commandRows: [],
    noMatches: true,
  })

  // A capturing overlay is composited over the host frame, so the overlay's
  // left border can share a line with stale host text. The parser must slice
  // the inner frame before looking for query text or command rows.
  const compositedPane = [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ 🐋  session session-1                                                        │',
    '│ de╭──────────────────────────────────────────────────────────────────────╮   │',
    '│ /h│ >                                                                    │   │',
    '╰───│                                                                      │───╯',
    '    │   (1/48)                                                             │',
    '────│   Type to search · Enter/Space to change · Esc to cancel             │────',
    '❯   ╰──────────────────────────────────────────────────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(compositedPane), {
    searchVisible: true,
    query: '',
    commandRows: [],
    noMatches: false,
  })

  const compositedGoalPane = [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ 🐋  session session-1                                                        │',
    '│ de╭──────────────────────────────────────────────────────────────────────╮   │',
    '│ /h│ > goal                                                               │   │',
    '╰───│ ›/goal                                                             │───╯',
    '    │                                                                      │',
    '────│   Type to search · Enter/Space to change · Esc to cancel             │────',
    '❯   ╰──────────────────────────────────────────────────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(compositedGoalPane), {
    searchVisible: true,
    query: 'goal',
    commandRows: ['/goal'],
    noMatches: false,
  })
})

test('official preset degradation diagnostics never count as a healthy mount', () => {
  assert.equal(presetDegradationLine('preset mounted successfully'), undefined)
  assert.equal(
    presetDegradationLine('tui-runner: launch preset unavailable; falling back to default'),
    'tui-runner: launch preset unavailable; falling back to default',
  )
  assert.equal(
    presetDegradationLine('skill catalog unavailable for preset standard'),
    'skill catalog unavailable for preset standard',
  )
})

test('the official preset smoke requires a durable canonical session header', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('official-presets-header-')
  const evidencePath = join(directory, 'header.json')
  writeFileSync(evidencePath, JSON.stringify({ sessionId: 'session-1', agentPreset: 'minimal' }))
  assert.doesNotThrow(() => assertOfficialPresetHeader('minimal', evidencePath))
  writeFileSync(evidencePath, JSON.stringify({ sessionId: 'session-1', agentPreset: 'standard' }))
  assert.throws(
    () => assertOfficialPresetHeader('minimal', evidencePath),
    error => error?.phase === 'COMPAT_BOOT_FAILURE' && error.message.includes('durable header mismatch'),
  )
  writeFileSync(evidencePath, JSON.stringify({ sessionId: 'session-1', error: 'inspect failed' }))
  assert.throws(
    () => assertOfficialPresetHeader('minimal', evidencePath),
    error => error?.phase === 'COMPAT_BOOT_FAILURE' && error.message.includes('durable header probe failed'),
  )
})

test('the official preset smoke requires an exact current composer line before sending Enter', () => {
  const expected = 'pr-e direct standard prompt'
  const frame = input => `transcript mentions ${expected}\n❯ ${expected}\n────────\n❯ ${input}\n────────\nstatus`
  assert.equal(composerContainsExactInput(frame(`${expected}   `), expected), true)
  assert.equal(composerContainsExactInput(frame(''), expected), false)
  assert.equal(composerContainsExactInput(`❯ ${expected}\nstatus`, expected), false)
  assert.equal(composerContainsExactInput(frame(expected.slice(0, -1)), expected), false)
})

test('the Direct answer must be an assistant transcript row rather than a session title', () => {
  assert.equal(directPromptAnswerVisible('🐋  direct qualification answer  \n─────\n❯'), true)
  assert.equal(directPromptAnswerVisible('🐋  dsh-pi-tui · direct qualification answer\n─────\n❯'), false)
  assert.equal(directPromptAnswerVisible('│ session title: direct qualification answer │\n─────\n❯'), false)
  assert.equal(directPromptAnswerVisible('🐋  controlled answer intentionally withheld\n─────\n❯'), false)
})

test('the Direct prompt stage classifier preserves the same-session Inbox identity chain', () => {
  const sessionId = 'session-1'
  const inserted = { event: 'inserted', sessionId, messageId: 'message-1' }
  const claimed = { event: 'claimed', sessionId, messageId: 'message-1', turn: 2 }
  const chain = [inserted, claimed]
  const request = { purpose: null, presentTool: true, markerCount: 1, presentInstruction: true }
  const titleRequest = {
    purpose: 'session-title',
    presentTool: false,
    markerCount: 0,
    presentInstruction: false,
  }
  const stages = [
    [[], [], false, 'INPUT_NOT_ADMITTED'],
    [[inserted], [], false, 'INBOX_NOT_CLAIMED'],
    [chain, [titleRequest], false, 'MODEL_STREAM_NOT_REACHED'],
    [chain, [request, titleRequest], false, 'ANSWER_NOT_PAINTED'],
    [chain, [request, titleRequest], true, undefined],
    [chain, [request, titleRequest, titleRequest], true, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [chain, [{ ...request, purpose: 'unexpected-purpose' }], true, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [chain, [request, { ...request }], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [[claimed], [request], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [[inserted, { ...claimed, messageId: 'message-2' }], [], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [[inserted, { ...claimed, sessionId: 'session-2' }], [], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [[claimed, inserted], [], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [[inserted, inserted, claimed], [], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [[inserted, claimed, claimed], [], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [[], [request], false, 'PROBE_NOT_QUALIFIED'],
    [chain, [request, request], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [chain, [{ ...request, presentTool: false }], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [chain, [{ ...request, markerCount: 0 }], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
    [chain, [{ ...request, presentInstruction: false }], false, 'DUPLICATE_OR_MISMATCHED_PROMPT'],
  ]
  for (const [events, records, painted, expected] of stages) {
    assert.equal(classifyDirectPromptStage(sessionId, events, records, painted).stage, expected)
  }
})

test('the header probe records only user Inbox identities for the observed standard session', async (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('official-presets-inbox-probe-')
  const headerPath = join(directory, 'header.json')
  const inputPath = join(directory, 'input.jsonl')
  const probeDir = writeHeaderProbePackage(directory)
  writeFileSync(inputPath, '', { encoding: 'utf8', mode: 0o600 })
  const envKeys = ['DSH_SMOKE_HEADER_EVIDENCE', 'DSH_SMOKE_INPUT_EVIDENCE']
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))
  process.env.DSH_SMOKE_HEADER_EVIDENCE = headerPath
  process.env.DSH_SMOKE_INPUT_EVIDENCE = inputPath
  try {
    const probe = await import(pathToFileURL(join(probeDir, 'index.mjs')).href)
    const listeners = new Map()
    const query = {
      observeSession: async () => ({ header: { id: 'session-1', agentPreset: 'standard' } }),
    }
    probe.apply({
      get: name => name === 'sessionQuery' ? query : undefined,
      on: (event, listener) => listeners.set(event, listener),
    })
    listeners.get('agent/created')({ agent: { session: { id: 'session-1', header: {} } } })
    await new Promise(resolve => setImmediate(resolve))
    listeners.get('agent/inbox/inserted')({
      agent: { session: { id: 'session-1' } },
      message: { id: 'message-1', source: { kind: 'user' }, content: 'FAKE_SECRET_123' },
    })
    listeners.get('agent/inbox/inserted')({
      agent: { session: { id: 'session-1' } },
      message: { id: 'message-context', source: { kind: 'system' }, content: 'context' },
    })
    listeners.get('agent/inbox/claimed')({
      agent: { session: { id: 'session-2' } },
      message: { id: 'other-session', source: { kind: 'user' }, content: 'other' },
      turn: 3,
    })
    listeners.get('agent/inbox/claimed')({
      agent: { session: { id: 'session-1' } },
      message: { id: 'message-1', source: { kind: 'user' }, content: 'FAKE_SECRET_123' },
      turn: 4,
    })
    const serialized = readFileSync(inputPath, 'utf8')
    assert.deepEqual(serialized.trim().split('\n').map(line => JSON.parse(line)), [
      { event: 'inserted', sessionId: 'session-1', messageId: 'message-1' },
      { event: 'claimed', sessionId: 'session-1', messageId: 'message-1', turn: 4 },
    ])
    assert.doesNotMatch(serialized, /FAKE_SECRET_123|message-context|other-session|content|agent/u)
    assert.equal(statSync(inputPath).mode & 0o777, 0o600)
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('official preset failure evidence is private, bounded, redacted and allowlisted', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('official-presets-failure-evidence-')
  const evidencePath = join(directory, 'private', 'failure.json')
  const sessionId = 'session-uuid-123'
  const commandId = 'cmd-full-123'
  const sensitiveOutput = [
    'Authorization: Bearer bearer-token-value',
    'api_key=api-key-value',
    'password=password-value',
    'https://user:pass@host.invalid/path',
  ].join('\n')
  const run = {
    recordType: 'event', sessionId, seq: 12, type: 'command/run', commandId,
    name: 'preset', args: ' status', observedAt: 1_700_000_000_100, pairedRun: true,
  }
  const done = {
    recordType: 'event', sessionId, seq: 13, type: 'command/done', commandId,
    kind: 'success', text: 'preset: cordis · default: cordis', observedAt: 1_700_000_000_120, pairedRun: true,
  }
  writeOfficialPresetFailureEvidence(evidencePath, {
    presetId: 'cordis',
    stage: 'PRESET_STATUS_NOT_PAINTED',
    error: new CompatFailure('PRESET_STATUS_NOT_PAINTED', 'terminal result not painted'),
    surfaceAlive: true,
    version: '0.2.2-rc.1',
    mode: 'npm',
    candidate: '/private/candidate/xmoon76-dsh-pi-tui-0.5.6.tgz',
    header: { sessionId, agentPreset: 'cordis' },
    inputEvents: [{ event: 'inserted', sessionId, messageId: 'message-1' }],
    records: [{
      purpose: null,
      markerCount: 1,
      presentTool: true,
      presentInstruction: true,
      prompt: 'FAKE_SECRET_123 full prompt',
    }],
    pane: `${sensitiveOutput}\npr-e direct standard prompt\n${'bounded diagnostic line\n'.repeat(60)}`,
    scrollback: { text: `${'scrollback evidence line\n'.repeat(500)}`, totalHistoryLines: 350, truncated: true },
    tuiLog: `${sensitiveOutput}\n\u001b[31mcommand evidence\u001b[0m\npr-e direct standard prompt`,
    commandEvidence: [
      { recordType: 'probe-installed', event: 'session/event', global: true, installed: true },
      { recordType: 'session-observed', sessionId, headerConfirmed: true },
      run,
      done,
      { ...done, sessionId: 'other-session', commandId: 'other-command', seq: 90 },
    ],
    commandStatus: {
      stage: 'PRESET_STATUS_NOT_PAINTED',
      qualification: { probeInstalled: true, sessionObserved: true, observedSessionId: sessionId, expectedSessionId: sessionId, probeWriteFailed: false },
      run,
      done,
      resultMatches: true,
      painted: false,
    },
    timeline: {
      startedAt: 1_700_000_000_000,
      composerVisibleAt: 1_700_000_000_010,
      enterSendStartedAt: 1_700_000_000_020,
      enterSentAt: 1_700_000_000_021,
      commandRunAt: run.observedAt,
      commandDoneAt: done.observedAt,
      resultValidatedAt: 1_700_000_000_121,
    },
  })
  const serialized = readFileSync(evidencePath, 'utf8')
  const report = JSON.parse(serialized)
  assert.deepEqual(Object.keys(report).sort(), [
    'candidate', 'commandLifecycle', 'commandLifecycleTruncated', 'commandStatus', 'diagnosticErrors',
    'failureSummary', 'header', 'inputClaimed', 'inputInserted', 'mode', 'modelRequests', 'paneTail',
    'paneTailTotalChars', 'paneTailTruncated', 'phase', 'presetId', 'probeQualification', 'requestCount', 'auxiliaryTitleRequestCount',
    'unexpectedRequestCount', 'scrollbackHistoryLines', 'scrollbackTail', 'scrollbackTotalChars',
    'scrollbackTruncated', 'sessionId', 'stage', 'surfaceAlive', 'timingMs', 'timeline', 'tuiLogTail',
    'tuiLogTailPlain', 'tuiLogTailPlainTotalChars', 'tuiLogTailPlainTruncated', 'tuiLogTailTotalChars',
    'tuiLogTailTruncated', 'version',
  ].sort())
  assert.equal(report.candidate, 'xmoon76-dsh-pi-tui-0.5.6.tgz')
  assert.equal(report.sessionId, sessionId)
  assert.equal(report.header.sessionId, sessionId)
  assert.equal(report.requestCount, 1)
  assert.deepEqual(report.modelRequests, [{ markerCount: 1, presentTool: true, presentInstruction: true }])
  assert.deepEqual(report.probeQualification, {
    probeInstalled: true, sessionObserved: true, observedSessionId: sessionId, expectedSessionId: sessionId, probeWriteFailed: false,
  })
  assert.deepEqual(report.commandLifecycle.map(event => ({ sessionId: event.sessionId, seq: event.seq, type: event.type, commandId: event.commandId })), [
    { sessionId, seq: 12, type: 'command/run', commandId },
    { sessionId, seq: 13, type: 'command/done', commandId },
  ])
  assert.equal(report.commandLifecycle[0].args, ' status')
  assert.equal(report.commandStatus.doneKind, 'success')
  assert.equal(report.commandStatus.commandId, commandId)
  assert.equal(report.scrollbackHistoryLines, 350)
  assert.equal(report.scrollbackTruncated, true)
  assert.ok(report.scrollbackTail.length <= 12_000)
  assert.ok(report.tuiLogTail.length <= 12_000)
  assert.ok(report.tuiLogTailPlain.length <= 12_000)
  assert.doesNotMatch(report.tuiLogTailPlain, /\u001b/u)
  assert.ok(report.paneTail.split('\n').length <= 40)
  assert.ok(report.paneTail.length <= 4_000)
  assert.match(serialized, /session-uuid-123|cmd-full-123|pr-e direct standard prompt/u)
  assert.doesNotMatch(serialized, /bearer-token-value|api-key-value|password-value|https:\/\/user:pass@|other-session|FAKE_SECRET_123|full prompt/u)
  assert.match(serialized, /\[REDACTED\]/u)
  assert.equal(statSync(evidencePath).mode & 0o777, 0o600)
  assert.equal(statSync(join(directory, 'private')).mode & 0o777, 0o700)

  writeOfficialPresetFailureEvidence(evidencePath, {
    presetId: 'minimal', stage: 'later-failure', error: new Error('later'), surfaceAlive: false,
    version: 'later', mode: 'source', candidate: 'later.tgz', header: undefined,
    inputEvents: [], records: [], pane: '', tuiLog: '',
  })
  assert.equal(JSON.parse(readFileSync(evidencePath, 'utf8')).presetId, 'cordis')
})

test('a successful mocked preset matrix creates no failure artifact', async (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('official-presets-success-evidence-')
  const evidencePath = join(directory, 'failure.json')
  const commandPath = join(directory, 'command.jsonl')
  const headerPath = join(directory, 'header.json')
  const env = {
    HOME: join(directory, 'home'),
    DSH_HOME: join(directory, 'dsh-home'),
    DSH_SMOKE_EVIDENCE: join(directory, 'evidence.json'),
    DSH_SMOKE_HEADER_EVIDENCE: headerPath,
    DSH_SMOKE_COMMAND_EVIDENCE: commandPath,
    npm_config_registry: 'https://registry.npmjs.org',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
    npm_config_userconfig: join(directory, 'npmrc'),
    NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'),
    OFFICIAL_PRESETS_FAILURE_EVIDENCE: evidencePath,
  }
  const fakeTmuxFactory = (_socket, tmuxSession) => {
    const presetId = tmuxSession.split('-').at(-1)
    const sessionId = `test-${presetId}-session`
    let alive = false
    let line = ''
    let searchVisible = false
    let searchQuery = ''
    let statusText
    const pane = () => {
      if (!alive) return ''
      if (searchVisible) {
        return [
          '╭────────────────────────╮',
          `│ > ${searchQuery.padEnd(18)} │`,
          ...(presetId === 'minimal' && searchQuery === 'goal'
            ? ['│ No matching settings   │']
            : ['│ ❯ /goal                │']),
          '│ Type to search · Enter/Space to change · Esc to cancel │',
          '╰────────────────────────╯',
        ].join('\n')
      }
      return [
        '🎛 /new [ok]',
        ...(statusText === undefined ? [] : [`🎛 /preset status [ok]`, `  ${statusText}`]),
        '────────',
        `❯ ${line}`,
        '────────',
      ].join('\n')
    }
    return {
      tmux: () => { alive = true; return { status: 0, stdout: '', stderr: '' } },
      hasSession: () => alive,
      capturePane: pane,
      sendLiteral: text => {
        if (searchVisible) searchQuery += text
        else line = text
      },
      sendKey: key => {
        if (key === 'Escape') { searchVisible = false; return }
        if (key !== 'Enter') return
        const submitted = line
        line = ''
        if (submitted === '/new') {
          writeFileSync(headerPath, JSON.stringify({ sessionId, agentPreset: presetId }))
        } else if (submitted === '/preset status') {
          const runAt = Date.now()
          statusText = `preset: ${presetId} · default: ${presetId}`
          writeFileSync(commandPath, [
            { recordType: 'probe-installed', event: 'session/event', global: true, installed: true },
            { recordType: 'session-observed', sessionId, headerConfirmed: true },
            { recordType: 'event', sessionId, seq: 12, type: 'command/run', commandId: `cmd-${presetId}`, name: 'preset', args: ' status', observedAt: runAt, pairedRun: true },
            { recordType: 'event', sessionId, seq: 13, type: 'command/done', commandId: `cmd-${presetId}`, kind: 'success', text: statusText, observedAt: runAt, pairedRun: true },
          ].map(record => JSON.stringify(record)).join('\n') + '\n')
        } else if (submitted === '/help') {
          searchVisible = true
          searchQuery = ''
        } else if (submitted === '/exit') {
          alive = false
        }
      },
      stop: () => { alive = false },
    }
  }
  await smokeOfficialPresetMounts([], directory, env, undefined,
    { candidate: 'candidate.tgz', version: '0.2.2-rc.1', mode: 'npm' }, fakeTmuxFactory)
  assert.equal(existsSync(evidencePath), false)
})

test('official preset failure evidence is written before tmux teardown without replacing the smoke error', async (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('official-presets-failure-order-')
  const evidencePath = join(directory, 'failure.json')
  let reportExistedAtStop = false
  const fakeTmux = {
    tmux: () => ({ status: 1, stdout: '', stderr: '' }),
    capturePane: () => 'boot frame',
    hasSession: () => false,
    stop: () => { reportExistedAtStop = existsSync(evidencePath) },
  }
  const env = {
    HOME: join(directory, 'home'),
    DSH_HOME: join(directory, 'dsh-home'),
    DSH_SMOKE_EVIDENCE: join(directory, 'evidence.json'),
    DSH_SMOKE_HEADER_EVIDENCE: join(directory, 'header.json'),
    DSH_SMOKE_COMMAND_EVIDENCE: join(directory, 'command.jsonl'),
    npm_config_registry: 'https://registry.npmjs.org',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
    npm_config_userconfig: join(directory, 'npmrc'),
    NPM_CONFIG_USERCONFIG: join(directory, 'npmrc'),
    OFFICIAL_PRESETS_FAILURE_EVIDENCE: evidencePath,
  }
  const failure = await smokeOfficialPresetMounts([], directory, env, undefined,
    { candidate: 'candidate.tgz', version: '0.2.2-rc.1', mode: 'npm' }, () => fakeTmux)
    .then(() => undefined, error => error)
  assert.equal(failure?.phase, 'COMPAT_BOOT_FAILURE')
  assert.match(failure.message, /could not start/u)
  assert.equal(reportExistedAtStop, true)
  assert.equal(JSON.parse(readFileSync(evidencePath, 'utf8')).phase, 'COMPAT_BOOT_FAILURE')
})
