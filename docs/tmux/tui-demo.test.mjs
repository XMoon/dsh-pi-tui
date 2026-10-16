/**
 * Structural safety gates for the interactive tmux demo. The demo itself is
 * intentionally manual, but every run owns a unique output directory and
 * isolated DSH_HOME so concurrent runs cannot share runtime state.
 * @module docs/tmux/tui-demo.test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const script = await readFile(new URL('./tui-demo.sh', import.meta.url), 'utf8')

test('each tmux demo owns a private output directory and DSH_HOME', () => {
  assert.match(script, /OUT=\$\(mktemp -d \/tmp\/tui-demo\.XXXXXX\)/)
  assert.match(script, /DSH_HOME="\$OUT\/dsh-home"/)
  assert.match(script, /mkdir -p "\$DSH_HOME"/)
  assert.match(script, /tmux capture-pane -t "\$S" -p > "\$OUT\/\$1\.txt"/)
  assert.match(script, /tmux capture-pane -t "\$S" -e -p > "\$OUT\/\$1\.ansi"/)
  assert.match(script, /node "\$\(dirname "\$0"\)\/ansi2html\.mjs" "\$ansi" "\$OUT\/\$base\.html"/)
  assert.doesNotMatch(script, /^OUT=\/tmp\/tui-demo$/m, 'fixed output directory would be shared')
  assert.doesNotMatch(script, /rm -f "\$OUT"\/\*/, 'one run must never clear another run\'s captures')
})

test('the linked worktree profile and every tmux launch use isolated DSH_HOME', () => {
  assert.match(script, /env DSH_HOME="\$DSH_HOME" "\$DSH" plugin --profile "\$PROFILE" -- add 'link:\.'/)
  assert.match(script, /DSH_HOME=%q COLORFGBG=%q %q --profile %q/)
  assert.match(script, /printf 'env -u NO_COLOR DSH_HOME=%q COLORFGBG=%q %q --profile %q' \\\s*"\$DSH_HOME" "\$1" "\$DSH" "\$PROFILE"/)
  const sessionStarts = script.match(/tmux new-session -d -s "\$S"/g) ?? []
  const isolatedLaunches = script.match(/send "\$\(dsh_command '[^']+'\)" 0\.3/g) ?? []
  assert.ok(sessionStarts.length > 0, 'the demo must contain a tmux session start')
  assert.equal(isolatedLaunches.length, sessionStarts.length, 'each tmux session must launch through dsh_command')
})
