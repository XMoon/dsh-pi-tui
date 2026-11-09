import assert from 'node:assert/strict'
import test from 'node:test'
import {
  innerDisclosureEvidenceTier,
  isPinnedTernBuild,
  isTargetToggle,
  presetFromEnvironment,
  qualificationFromResults,
} from '../../scripts/tern-pane-transcript-inner-disclosure.mjs'

test('inner disclosure Flow defaults to Full and accepts only the three canonical presets', () => {
  assert.equal(presetFromEnvironment(undefined), 'full')
  for (const preset of ['full', 'compact', 'focus']) assert.equal(presetFromEnvironment(preset), preset)
  for (const preset of ['', 'FOCUS', 'inner-disclosure', 't1c']) {
    assert.throws(() => presetFromEnvironment(preset), /must be full, compact or focus/u)
  }
})

test('inner disclosure Flow requires the exact plan-pinned Tern version and binary hash', () => {
  assert.equal(isPinnedTernBuild(
    'tern 0.9.13 (8c6dfbd)',
    'ffa3c7c85cf557b5e0ee690cd62efc32e79dbc77044d475dce0edc3a4ac2cd99',
  ), true)
  assert.equal(isPinnedTernBuild('tern 0.9.13 (8c6dfbd)', 'wrong-hash'), false)
  assert.equal(isPinnedTernBuild('tern 0.9.12 (e498b49)', 'ffa3c7c85cf557b5e0ee690cd62efc32e79dbc77044d475dce0edc3a4ac2cd99'), false)
  assert.equal(isPinnedTernBuild('tern 0.9.13', 'ffa3c7c85cf557b5e0ee690cd62efc32e79dbc77044d475dce0edc3a4ac2cd99'), false)
})

test('inner disclosure click evidence requires the exact client id and collapsed target', () => {
  const event = { ev: 'toggle', id: 'main.s1-msg-3', collapsed: false }
  assert.equal(isTargetToggle(event, 'main.s1-msg-3', false), true)
  assert.equal(isTargetToggle(event, 'main.s1-msg-4', false), false)
  assert.equal(isTargetToggle(event, 'main.s1-msg-3', true), false)
  const subjectRecord = { kind: 'client.toggle', id: 'main.s1-msg-3', collapsed: false, sf: 's1' }
  assert.equal(isTargetToggle(subjectRecord, 'main.s1-msg-3', false), true)
  assert.equal(isTargetToggle(subjectRecord, 'main.s1-msg-4', false), false)
  assert.equal(isTargetToggle(subjectRecord, 'main.s1-msg-3', true), false)
  assert.equal(isTargetToggle({ ...subjectRecord, kind: 'client.other' }, 'main.s1-msg-3', false), false)
  assert.equal(isTargetToggle({ ...event, collapsed: undefined }, 'main.s1-msg-3', false), false)
  assert.equal(isTargetToggle(undefined, 'main.s1-msg-3', false), false)
})

test('the real-pane evidence ledger cannot claim qualification PASS when any assertion fails', () => {
  assert.equal(qualificationFromResults([]), 'FAILED_ASSERTIONS')
  assert.equal(qualificationFromResults([{ label: 'pin matched', ok: true }]), 'REAL_TERN_INNER_DISCLOSURE_PASS')
  assert.equal(qualificationFromResults([
    { label: 'one assertion passed', ok: true },
    { label: 'one native click failed', ok: false },
  ]), 'FAILED_ASSERTIONS')
  assert.equal(qualificationFromResults([
    { label: 'one real assertion passed', ok: true },
    { label: 'visual matrix measurement', ok: true, informational: true },
  ]), 'REAL_TERN_INNER_DISCLOSURE_PASS')
  assert.equal(qualificationFromResults([
    { label: 'visual matrix measurement', ok: true, informational: true },
  ]), 'FAILED_ASSERTIONS')
})

test('inner disclosure Flow distinguishes real GUI evidence from headless client evidence', () => {
  assert.equal(innerDisclosureEvidenceTier(false), 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT')
  assert.equal(innerDisclosureEvidenceTier(true), 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT')
  assert.ok(!innerDisclosureEvidenceTier(true).includes('OS_INPUT_VERIFIED'))
})
