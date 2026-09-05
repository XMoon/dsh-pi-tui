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

test('runtime boundary accepts the Source Mode advisory notice', () => {
  const output = [
    'dsh-pi-tui v0.4.1 requires DeepSeek Harness 0.1.3-alpha.1 pinned master source baseline or later,',
    'but this installation is running dsh 0.1.1-rc.2.',
    'This next Source Mode build is validated only with the pinned DSH master source distribution; see docs/dsh-compatibility.md.',
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.1-rc.2'))
  assert.doesNotMatch(output, /npm install .*0\.1\.3-alpha\.1/u)
})

test('runtime boundary applies the same Source Mode floor to an earlier alpha', () => {
  const output = [
    'dsh-pi-tui v0.4.1 requires DeepSeek Harness 0.1.3-alpha.1 pinned master source baseline or later,',
    'but this installation is running dsh 0.1.3-alpha.0.',
    'pinned DSH master source distribution',
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.3-alpha.0'))
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
