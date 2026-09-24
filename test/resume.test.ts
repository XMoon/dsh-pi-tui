/**
 * Headless tests for the exit-time resume hint (pi parity): the command
 * line names the running profile and the live session id.
 * @module @xmoon76/dsh-pi-tui/resume.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { hostRunningProfile, resumeCommand, runningProfile } from '../src/index.ts'

test('runningProfile parses the --profile flag in both spellings', () => {
  assert.equal(runningProfile(['dsh', '--profile', 'pi-tui-dev']), 'pi-tui-dev')
  assert.equal(runningProfile(['dsh', '--profile=pi-tui']), 'pi-tui')
  // A later flag wins (dsh takes the last occurrence).
  assert.equal(runningProfile(['dsh', '--profile', 'pi-tui', '--profile', 'web']), 'web')
  // Absent flag falls back.
  assert.equal(runningProfile(['dsh']), 'pi-tui')
  assert.equal(runningProfile(['dsh'], 'custom'), 'custom')
})

/** A structural Host context stand-in publishing `profileContext`. */
function hostWith(name: string | undefined): { get(key: string): unknown } {
  return { get: (key: string) => (key !== 'profileContext' || name === undefined ? undefined : { name }) }
}

test('hostRunningProfile takes the Host profile identity, whichever launch form named it', () => {
  // `dsh <name>` never puts `--profile` into process.argv (the launcher
  // synthesizes it for its own parse only), so the argv scrape answers the
  // pi-tui fallback while the Host knows the real name.
  assert.equal(hostRunningProfile(hostWith('tui-custom'), ['dsh', 'tui-custom']), 'tui-custom')
  assert.equal(hostRunningProfile(hostWith('rescue'), ['dsh', '--profile', 'rescue', '--patch', 'x.yml']), 'rescue')
  // The Host name wins over a conflicting argv flag: profileContext is the
  // profile the process actually booted.
  assert.equal(hostRunningProfile(hostWith('tui-custom'), ['dsh', '--profile', 'pi-tui']), 'tui-custom')
})

test('hostRunningProfile falls back to the argv scrape without a Host profileContext', () => {
  assert.equal(hostRunningProfile(hostWith(undefined), ['dsh', '--profile', 'pi-tui-dev']), 'pi-tui-dev')
  assert.equal(hostRunningProfile(hostWith(undefined), ['dsh']), 'pi-tui')
  assert.equal(hostRunningProfile(hostWith(undefined), ['dsh'], 'custom'), 'custom')
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
  // The command the hint prints for a profile named by `dsh <name>` round-trips
  // through the flag form, which the launcher documents as equivalent.
  assert.equal(
    resumeCommand(hostRunningProfile(hostWith('tui-custom')), 'session-abc'),
    'dsh --profile tui-custom --session session-abc',
  )
})

test('resumeCommand returns undefined without a session (deferred start)', () => {
  assert.equal(resumeCommand('pi-tui', ''), undefined)
  assert.equal(resumeCommand('pi-tui', '   '), undefined)
})
