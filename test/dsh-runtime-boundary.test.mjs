import assert from 'node:assert/strict'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { assertBoundary, resolveTarball } from '../scripts/dsh-runtime-boundary-smoke.mjs'
import { COMPAT_MATRIX, dshInstallTarget, matrixUpgradeCommandError } from '../scripts/lib/dsh-compat.mjs'

/** The CURRENT bundle version, read the way the real smoke reads it from the
 * candidate tarball — a version bump cannot leave these fixtures stale. */
const bundleVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
/** The notice lines the boundary accepts, derived from the compat matrix the
 * same way the smoke derives them (floor and recovery target included). */
const floorVersion = COMPAT_MATRIX.matrix[COMPAT_MATRIX.matrix.length - 1].dshFrom
const upgradeCommand = COMPAT_MATRIX.current.upgradeCommand

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

test('the recommended upgrade command installs the exact matrix target', () => {
  assert.equal(
    dshInstallTarget(upgradeCommand),
    COMPAT_MATRIX.current.upgradeDsh,
    'current.upgradeCommand must install current.upgradeDsh',
  )
  assert.equal(matrixUpgradeCommandError(), null, 'the real matrix must satisfy the gate cross-check')

  // Negative controls: the same check the installation gate applies must
  // reject a different target or an ambiguous command.
  const wrongTarget = {
    current: { upgradeDsh: COMPAT_MATRIX.current.upgradeDsh, upgradeCommand: 'npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.0-rc.2' },
  }
  assert.match(matrixUpgradeCommandError(wrongTarget), /must target @deepseek-ai\/dsh@/u)

  const ambiguous = {
    current: { upgradeDsh: COMPAT_MATRIX.current.upgradeDsh, upgradeCommand: 'npm install -g @deepseek-ai/dsh@0.2.1-rc.2 @deepseek-ai/dsh@0.2.0-rc.2' },
  }
  assert.match(matrixUpgradeCommandError(ambiguous), /no unique DSH target/u)
})

test('runtime boundary accepts the recommended npm advisory notice', () => {
  const output = [
    `dsh-pi-tui v${bundleVersion} requires DeepSeek Harness ${floorVersion} or later,`,
    'but this installation is running dsh 0.1.1-rc.2.',
    'Upgrade DeepSeek Harness:',
    `  ${upgradeCommand}`,
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.1-rc.2', bundleVersion))
  assert.doesNotMatch(output, /pinned master source|pinned DSH master source distribution/u)
})

test('runtime boundary rejects a stale candidate bundle-version label', () => {
  // The real smoke passes the candidate tarball's version: a packed bundle
  // built before a version bump must fail instead of passing silently.
  const output = [
    `dsh-pi-tui v0.0.1 requires DeepSeek Harness ${floorVersion} or later,`,
    'but this installation is running dsh 0.1.1-rc.2.',
    'Upgrade DeepSeek Harness:',
    `  ${upgradeCommand}`,
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.throws(() => assertBoundary(output, 1, '0.1.1-rc.2', bundleVersion), /boundary output is missing/u)})

test('runtime boundary applies the same npm floor to an earlier runtime', () => {
  const output = [
    `dsh-pi-tui v${bundleVersion} requires DeepSeek Harness ${floorVersion} or later,`,
    'but this installation is running dsh 0.1.3-alpha.0.',
    'Upgrade DeepSeek Harness:',
    `  ${upgradeCommand}`,
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.3-alpha.0', bundleVersion))
})

test('runtime boundary accepts a concurrent-loader raw import failure', () => {
  const output = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-authorization' imported from /tmp/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/index.mjs"
  assert.doesNotThrow(() => assertBoundary(output, 1, '0.1.1-rc.2'))
})

test('runtime boundary rejects stale Source Mode wording even on a raw import failure', () => {
  // The forbidden wording must be rejected on EVERY outcome path, not only
  // the friendly advisory branch: a raw import failure carrying old Source
  // Mode text must not pass.
  const output = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-agent' imported from /tmp/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/index.mjs\npinned master source"
  assert.throws(() => assertBoundary(output, 1, '0.1.1-rc.2'), /must not keep Source Mode wording/u)
})

test('runtime boundary rejects an unrelated import failure', () => {
  assert.throws(
    () => assertBoundary('Error [ERR_MODULE_NOT_FOUND]: Cannot find package unrelated-dependency', 1, '0.1.1-rc.2'),
    /expected TUI\/DSH import boundary/u,
  )
})

test('runtime boundary rejects an unrelated DSH-family import failure', () => {
  assert.throws(
    () => assertBoundary("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-unrelated'", 1, '0.1.1-rc.2'),
    /expected TUI\/DSH import boundary/u,
  )
})

test('runtime boundary still rejects a successful old-runtime start', () => {
  assert.throws(() => assertBoundary('', 0, '0.1.1-rc.2'), /unexpectedly started/u)
})
