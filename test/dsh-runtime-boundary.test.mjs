import assert from 'node:assert/strict'
import test from 'node:test'
import { assertBoundary } from '../scripts/dsh-runtime-boundary-smoke.mjs'

test('runtime boundary accepts the friendly advisory notice', () => {
  const output = [
    'dsh-pi-tui v0.4.0-alpha.1 requires DeepSeek Harness 0.1.2-alpha.1 or later,',
    'but this installation is running dsh 0.1.1-rc.2.',
    'npm install -g @deepseek-ai/dsh@0.1.2-alpha.1',
    'npm install -g @xmoon76/dsh-pi-tui@0.3',
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1))
})

test('runtime boundary accepts a concurrent-loader raw import failure', () => {
  const output = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-authorization' imported from /tmp/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/index.mjs"
  assert.doesNotThrow(() => assertBoundary(output, 1))
})

test('runtime boundary rejects an unrelated import failure', () => {
  assert.throws(
    () => assertBoundary('Error [ERR_MODULE_NOT_FOUND]: Cannot find package unrelated-dependency', 1),
    /expected TUI\/DSH import boundary/u,
  )
})

test('runtime boundary still rejects a successful old-runtime start', () => {
  assert.throws(() => assertBoundary('', 0), /unexpectedly started/u)
})
