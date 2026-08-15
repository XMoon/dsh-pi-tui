/**
 * Headless tests for the exit-time resume hint (pi parity): the command
 * line names the running profile and the live session id.
 * @module @xmoon76/dsh-pi-tui/resume.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resumeCommand, runningProfile } from '../src/index.ts'

test('runningProfile parses the --profile flag in both spellings', () => {
  assert.equal(runningProfile(['dsh', '--profile', 'pi-tui-dev']), 'pi-tui-dev')
  assert.equal(runningProfile(['dsh', '--profile=pi-tui']), 'pi-tui')
  // A later flag wins (dsh takes the last occurrence).
  assert.equal(runningProfile(['dsh', '--profile', 'pi-tui', '--profile', 'web']), 'web')
  // Absent flag falls back.
  assert.equal(runningProfile(['dsh']), 'pi-tui')
  assert.equal(runningProfile(['dsh'], 'custom'), 'custom')
})

test('resumeCommand names the profile and session id', () => {
  assert.equal(
    resumeCommand('pi-tui', 'session-1234-5678'),
    'dsh --profile pi-tui --session session-1234-5678',
  )
  assert.equal(
    resumeCommand('pi-tui-dev', 'session-abc'),
    'dsh --profile pi-tui-dev --session session-abc',
  )
})

test('resumeCommand returns undefined without a session (deferred start)', () => {
  assert.equal(resumeCommand('pi-tui', ''), undefined)
  assert.equal(resumeCommand('pi-tui', '   '), undefined)
})
