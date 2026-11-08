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
  composerContainsExactInput,
  directPromptAnswerVisible,
  directPromptTimeoutDiagnostic,
  officialPresetStatusCommand,
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
  const sensitiveOutput = [
    'Authorization: Bearer bearer-token-value',
    'api_key=api-key-value',
    'password=password-value',
    'https://user:pass@host.invalid/path',
  ].join('\n')
  writeOfficialPresetFailureEvidence(evidencePath, {
    presetId: 'standard',
    stage: 'ANSWER_NOT_PAINTED',
    error: new CompatFailure('COMPAT_BOOT_FAILURE', 'FAKE_SECRET_123 full prompt'),
    surfaceAlive: true,
    version: '0.2.2-rc.1',
    mode: 'npm',
    candidate: '/private/candidate/xmoon76-dsh-pi-tui-0.5.6.tgz',
    header: { sessionId: 'FAKE_SECRET_123', agentPreset: 'standard' },
    inputEvents: [{ event: 'inserted', sessionId: 'FAKE_SECRET_123', messageId: 'FAKE_SECRET_123' }],
    records: [{
      purpose: 'session-title',
      markerCount: 0,
      presentTool: false,
      presentInstruction: false,
      toolNames: ['FAKE_SECRET_123'],
      prompt: 'FAKE_SECRET_123 auxiliary title request',
    }, {
      markerCount: 1,
      presentTool: true,
      presentInstruction: true,
      purpose: null,
      toolNames: ['FAKE_SECRET_123', '/private/home'],
      prompt: 'FAKE_SECRET_123 full prompt',
      messages: [{ content: 'FAKE_SECRET_123 full model message' }],
    }],
    pane: `${sensitiveOutput}\npr-e direct standard prompt\n${'bounded diagnostic line\n'.repeat(60)}`,
    tuiLog: sensitiveOutput,
  })
  const serialized = readFileSync(evidencePath, 'utf8')
  const report = JSON.parse(serialized)
  assert.deepEqual(Object.keys(report).sort(), [
    'candidate', 'failureSummary', 'header', 'inputClaimed', 'inputInserted', 'mode',
    'modelRequests', 'paneTail', 'phase', 'presetId', 'requestCount', 'auxiliaryTitleRequestCount',
    'unexpectedRequestCount', 'stage',
    'surfaceAlive', 'tuiLogTail', 'version',
  ].sort())
  assert.equal(report.candidate, 'xmoon76-dsh-pi-tui-0.5.6.tgz')
  assert.equal(report.requestCount, 1)
  assert.equal(report.auxiliaryTitleRequestCount, 1)
  assert.equal(report.unexpectedRequestCount, 0)
  assert.deepEqual(report.modelRequests, [{ markerCount: 1, presentTool: true, presentInstruction: true }])
  assert.deepEqual(report.header, { present: true, agentPreset: 'standard' })
  assert.doesNotMatch(serialized, /FAKE_SECRET_123|pr-e direct standard prompt|bearer-token-value|api-key-value|password-value|https:\/\/user:pass@|full model message|\/private\/home/u)
  assert.match(serialized, /\[REDACTED\]/u)
  assert.ok(report.paneTail.split('\n').length <= 40)
  assert.ok(report.paneTail.length <= 4_000)
  assert.equal(statSync(evidencePath).mode & 0o777, 0o600)
  assert.equal(statSync(join(directory, 'private')).mode & 0o777, 0o700)

  writeOfficialPresetFailureEvidence(evidencePath, {
    presetId: 'minimal', stage: 'later-failure', error: new Error('later'), surfaceAlive: false,
    version: 'later', mode: 'source', candidate: 'later.tgz', header: undefined,
    inputEvents: [], records: [], pane: '', tuiLog: '',
  })
  assert.equal(JSON.parse(readFileSync(evidencePath, 'utf8')).presetId, 'standard')
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
