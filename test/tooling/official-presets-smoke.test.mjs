import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  assertOfficialPresetHeader,
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
