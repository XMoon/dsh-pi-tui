/**
 * The direct-empty-retirement smoke's profile user-patch parser: the ONLY
 * acceptable `cordis.patch.yml` user layer is the empty list or the
 * candidate's own shipped `tui-app` config row. The parser is a positive
 * allowlist, so an unrecognized patch operation (including `override`) fails
 * instead of slipping through an enumeration of known keys.
 * @module @xmoon76/dsh-pi-tui/tooling/direct-empty-retirement-smoke.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { userPatchViolations } from '../../scripts/direct-empty-session-retirement-smoke.mjs'

test('the empty user patch layer is clean', () => {
  assert.deepEqual(userPatchViolations('[]\n'), [])
  assert.deepEqual(userPatchViolations('# only comments\n\n'), [])
})

test("the candidate's own shipped tui-app config row is clean", () => {
  const shipped = [
    '# Your patch layer for this dsh profile.',
    '- id: tui-app',
    '  name: "@xmoon76/dsh-pi-tui"',
    '  config:',
    '    sessionId: ""',
    '    legacySettingsMigrationVersion: 1',
    '',
  ].join('\n')
  assert.deepEqual(userPatchViolations(shipped), [])
})

test('an insert row is rejected', () => {
  // The rejected row's own lines are reported too; what matters is that the
  // layer is NOT accepted.
  const violations = userPatchViolations('- insert:\n    - id: evil\n      name: evil-plugin\n')
  assert.ok(violations.includes('- insert:'), JSON.stringify(violations))
  assert.ok(violations.length > 0)
})

test('a disabled row is rejected', () => {
  assert.deepEqual(userPatchViolations('- id: tui-app\n- disabled: true\n'), ['- disabled: true'])
})

test('an override row is rejected (top-level)', () => {
  const violations = userPatchViolations('- override:\n    id: tui-app\n')
  assert.ok(violations.includes('- override:'), JSON.stringify(violations))
  assert.ok(violations.length > 0)
})

test('an override key is rejected even when indented under the allowed row', () => {
  assert.deepEqual(userPatchViolations('- id: tui-app\n  override: everything\n'), ['override: everything'])
})

test('a foreign plugin row is rejected', () => {
  const foreign = '- id: other-plugin\n  name: "other-plugin"\n'
  const violations = userPatchViolations(foreign)
  assert.ok(violations.includes('- id: other-plugin'), JSON.stringify(violations))
  assert.ok(violations.includes('name: "other-plugin"'), JSON.stringify(violations))
})

test('an unknown row key is rejected rather than silently allowed', () => {
  const violations = userPatchViolations('- whatever:\n    id: tui-app\n')
  assert.ok(violations.includes('- whatever:'), JSON.stringify(violations))
  assert.ok(violations.length > 0)
})

test('a foreign name on the allowed row id is rejected', () => {
  assert.deepEqual(
    userPatchViolations('- id: tui-app\n  name: "@xmoon76/dsh-pi-tui/evil"\n'),
    ['name: "@xmoon76/dsh-pi-tui/evil"'],
  )
})
