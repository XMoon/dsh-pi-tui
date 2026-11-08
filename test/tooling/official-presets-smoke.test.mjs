import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  assertNoPresetCompatibilityFailures,
  assertOfficialPresetHeader,
  directPromptTimeoutDiagnostic,
  officialPresetStatusCommand,
  officialPresetStatusVisible,
  presetDegradationLine,
  settingsSearchSnapshot,
  smokeOfficialPresetMounts,
} from '../../scripts/official-presets-smoke.mjs'

test('the official preset matrix is independently callable and reports the live preset', () => {
  assert.equal(typeof smokeOfficialPresetMounts, 'function', 'the real official matrix must be independently callable')
  assert.equal(officialPresetStatusCommand(), '/preset status')
  assert.equal(officialPresetStatusVisible('ptc', 'preset: ptc · default: ptc'), true)
  assert.equal(officialPresetStatusVisible('ptc', 'preset: standard · default: ptc'), false)
})

test('Direct prompt timeout diagnostics expose only stable model-request facts', () => {
  const diagnostic = directPromptTimeoutDiagnostic('model-answer', true, [{
    markerCount: 1,
    presentTool: true,
    presentInstruction: true,
    toolNames: ['/tmp/private-profile', 'present'],
    prompt: 'full prompt with TOKEN_SENTINEL',
    path: '/home/runner/private-session',
    log: 'arbitrary runtime log SECRET_SENTINEL',
  }])
  assert.deepEqual(JSON.parse(diagnostic), {
    stage: 'model-answer',
    surfaceAlive: true,
    requestCount: 1,
    modelRequests: [{ markerCount: 1, presentTool: true, presentInstruction: true }],
  })
  assert.doesNotMatch(diagnostic, /TOKEN_SENTINEL|SECRET_SENTINEL|private-profile|private-session|full prompt|runtime log/u)
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

test('official preset failures name the official preset gate, not a consumer bridge', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('official-presets-diagnostics-')
  const logPath = join(directory, 'tui.log')
  writeFileSync(logPath, 'fallback to headless mode\n')
  assert.throws(
    () => assertNoPresetCompatibilityFailures(logPath, { capturePane: () => '' }),
    error => error?.phase === 'COMPAT_BOOT_FAILURE'
      && error.message.startsWith('official preset smoke reported an incompatible surface:')
      && !error.message.includes('pi2dsh'),
  )
})
