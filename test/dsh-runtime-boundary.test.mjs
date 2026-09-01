import assert from 'node:assert/strict'
import { symlinkSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { assertBoundary, resolveTarball } from '../scripts/dsh-runtime-boundary-smoke.mjs'

test('runtime boundary rejects explicit and discovered symlinked candidates', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('dsh-runtime-candidate-link-')
  const target = join(directory, 'external.tgz')
  const candidate = join(directory, 'xmoon76-dsh-pi-tui-0.4.0.tgz')
  writeFileSync(target, 'not a tarball')
  symlinkSync(target, candidate)
  assert.throws(() => resolveTarball(candidate), /regular file/u)
  assert.throws(() => resolveTarball(undefined, directory), /no candidate tarball/u)
})

test('runtime boundary accepts the friendly advisory notice', () => {
  const output = [
    'dsh-pi-tui v0.4.0-alpha.1 requires DeepSeek Harness 0.1.2-alpha.2 or later,',
    'but this installation is running dsh 0.1.1-rc.2.',
    'npm install -g @deepseek-ai/dsh@0.1.2-alpha.4',
    'npm install -g @xmoon76/dsh-pi-tui@0.3',
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.1-rc.2'))
})

test('runtime boundary rejects the previous alpha.1 floor with the same advisory', () => {
  const output = [
    'dsh-pi-tui v0.4.0-alpha.1 requires DeepSeek Harness 0.1.2-alpha.2 or later,',
    'but this installation is running dsh 0.1.2-alpha.1.',
    'npm install -g @deepseek-ai/dsh@0.1.2-alpha.4',
    'npm install -g @xmoon76/dsh-pi-tui@0.3',
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.2-alpha.1'))
})

test('runtime boundary rejects the alpha.2/alpha.3 baseline with the 0.4-alpha fallback', () => {
  const output = [
    'dsh-pi-tui v0.4.0-alpha.2 requires DeepSeek Harness 0.1.2-alpha.4 or later,',
    'but this installation is running dsh 0.1.2-alpha.3.',
    'npm install -g @deepseek-ai/dsh@0.1.2-alpha.4',
    'npm install -g @xmoon76/dsh-pi-tui@0.4.0-alpha.1',
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.2-alpha.3'))
})

test('runtime boundary accepts a concurrent-loader raw import failure', () => {
  const output = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-authorization' imported from /tmp/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/index.mjs"
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.1-rc.2'))
})

test('runtime boundary rejects an unrelated import failure', () => {
  assert.throws(
    () => assertBoundary('Error [ERR_MODULE_NOT_FOUND]: Cannot find package unrelated-dependency', 1, '0.1.1-rc.2'),
    /expected TUI\/DSH import boundary/u,
  )
})

test('runtime boundary still rejects a successful old-runtime start', () => {
  assert.throws(() => assertBoundary('', 0, '0.1.1-rc.2'), /unexpectedly started/u)
})
