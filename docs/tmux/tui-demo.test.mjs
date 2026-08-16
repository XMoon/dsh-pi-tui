/**
 * Structural safety gates for the interactive tmux demo. The demo itself is
 * intentionally manual, but these invariants prevent concurrent runs from
 * sharing/deleting one another's backups or racing on the real settings file.
 * @module docs/tmux/tui-demo.test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const script = await readFile(new URL('./tui-demo.sh', import.meta.url), 'utf8')

test('each tmux demo owns a private output and backup directory', () => {
  assert.match(script, /OUT=\$\(mktemp -d \/tmp\/tui-demo\.XXXXXX\)/)
  assert.match(script, /BACKUP="\$OUT\/settings\.yaml\.bak"/)
  assert.doesNotMatch(script, /^OUT=\/tmp\/tui-demo$/m, 'fixed output directory would be shared')
  assert.doesNotMatch(script, /rm -f "\$OUT"\/\*/, 'one run must never clear another run\'s captures')
})

test('the settings backup and temporary writes are serialized across runs', () => {
  const lockIndex = script.indexOf('flock -n 9')
  const backupIndex = script.indexOf('cp -p "$SETTINGS" "$BACKUP"')
  const firstWriteIndex = script.indexOf('settheme auto')
  assert.ok(lockIndex >= 0, 'settings lock missing')
  assert.ok(backupIndex > lockIndex, 'lock must be acquired before backing up settings')
  assert.ok(firstWriteIndex > backupIndex, 'settings may only change after the private backup exists')
})
