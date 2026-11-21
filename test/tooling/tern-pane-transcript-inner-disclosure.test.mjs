import assert from 'node:assert/strict'
import test from 'node:test'
import {
  innerDisclosureEvidenceTier,
  isTargetToggle,
  presetFromEnvironment,
  qualificationFromResults,
  scenarioFromEnvironment,
} from '../../scripts/tern-pane-transcript-inner-disclosure.mjs'

test('inner disclosure Flow defaults to Full and accepts only the three canonical presets', () => {
  assert.equal(presetFromEnvironment(undefined), 'full')
  for (const preset of ['full', 'compact', 'focus']) assert.equal(presetFromEnvironment(preset), preset)
  for (const preset of ['', 'FOCUS', 'inner-disclosure', 't1c']) {
    assert.throws(() => presetFromEnvironment(preset), /must be full, compact or focus/u)
  }
})

test('inner disclosure Flow defaults to its existing scenario and allows only the PTC note evidence branch', () => {
  assert.equal(scenarioFromEnvironment(undefined), 'inner-disclosure')
  assert.equal(scenarioFromEnvironment('inner-disclosure'), 'inner-disclosure')
  assert.equal(scenarioFromEnvironment('ptc-error-note'), 'ptc-error-note')
  assert.throws(() => scenarioFromEnvironment('ptc'), /must be inner-disclosure or ptc-error-note/u)
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
