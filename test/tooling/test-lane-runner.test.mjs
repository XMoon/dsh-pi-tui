/**
 * The test LANE RUNNER's cross-platform command-line contract.
 *
 * The runner passes the lane's file list to Node's test runner as command
 * line arguments. The ABSOLUTE form of that list exceeds the Windows
 * command-line limit: the product lane is ~491 files, and absolute paths in a
 * typical Windows checkout total ~60,000 characters against
 * `CreateProcessW`'s 32,767 — so `pnpm test:product` would fail to start
 * on a common Windows development directory, and only the Linux CI would
 * miss it.
 *
 * The runner therefore passes the list RELATIVE to the repository root and
 * runs the child with that root as its working directory. These cases prove
 * the CONTRACT, not one platform's spelling: the length bound, the relative
 * form, and the working directory the tests depend on.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/test-lane-runner.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { resolveLane } from '../../scripts/test-discovery.mjs'
import { LANES } from '../../scripts/test-lanes.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const TEST_ROOT = join(ROOT, 'test')

/**
 * The Windows command-line limit: `CreateProcessW` caps the command line at
 * 32,767 characters, including the executable and every argument.
 */
const WINDOWS_COMMAND_LINE_LIMIT = 32_767

/**
 * The command line the runner builds for a lane, in the WINDOWS spelling:
 * a checkout under `C:\Users\<name>\projects\<repo>\`.
 */
function windowsCommandLineLength(lane) {
  const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
  const checkout = 'C:\\\\Users\\\\owner\\\\projects\\\\dsh-pi-tui\\\\'
  const commandArguments = files.map(rel => `${checkout}test\\\\${rel.replaceAll('/', '\\\\')}`)
  return {
    // The executable and the fixed flags take a little room too.
    length: 'C:\\\\Program Files\\\\nodejs\\\\node.exe --test '.length
      + commandArguments.join(' ').length,
    fileCount: files.length,
  }
}

test('the product lane command line fits the Windows limit in the RELATIVE form', () => {
  const lane = LANES.product
  const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
  const checkout = 'C:\\\\Users\\\\owner\\\\projects\\\\dsh-pi-tui\\\\'
  // The RELATIVE form the runner uses: the path under the repository root.
  const relativeArguments = files.map(rel => `test\\\\${rel.replaceAll('/', '\\\\')}`)
  const length = 'C:\\\\Program Files\\\\nodejs\\\\node.exe --test '.length
    + relativeArguments.join(' ').length
  assert.ok(
    length < WINDOWS_COMMAND_LINE_LIMIT,
    `the relative command line must fit the Windows limit: ${length} > ${WINDOWS_COMMAND_LINE_LIMIT}`,
  )
})

test('the ABSOLUTE form would NOT fit the Windows limit, so the relative form is required', () => {
  // The regression this protects: if the runner ever goes back to the
  // absolute form, this case shows the breakage is real.
  const lane = LANES.product
  const { length, fileCount } = windowsCommandLineLength(lane)
  assert.ok(fileCount > 400, `the product lane is the large one: ${fileCount} files`)
  assert.ok(
    length > WINDOWS_COMMAND_LINE_LIMIT,
    `the absolute form must exceed the Windows limit for this case to be meaningful: ${length} <= ${WINDOWS_COMMAND_LINE_LIMIT}`,
  )
})

test('the runner passes the file list RELATIVE to the repository root', () => {
  // The runner's own source is the contract: it must build the argument
  // list from the test-root-relative paths and set the child's working
  // directory to the repository root.
  //
  // The assertion is about the CONTRACT — a relative path, and the
  // repository root as the working directory — not about one literal
  // spelling of it. The test root's own NAME is used as the prefix, so an
  // overridden root keeps the same shape; pinning the literal would make
  // a legitimate change look like a regression.
  const source = readFileSync(join(ROOT, 'scripts', 'run-test-lane.mjs'), 'utf8')
  assert.match(source, /const relativeFiles = files\.map\(rel => join\(testRootName, rel\)\)/u,
    'the runner must pass the file list relative to the test root')
  assert.match(source, /cwd: workingDirectory/u,
    "the child must run with the working directory the relative paths are based on")
  assert.match(source, /const workingDirectory = TEST_ROOT === join\(ROOT, 'test'\) \? ROOT : testRootParent/u,
    'the default working directory must be the repository root')
  assert.doesNotMatch(source, /files\.map\(rel => join\(TEST_ROOT, rel\)\)/u,
    'the runner must not pass absolute paths')
})

test('the child runs with the repository root as its working directory', (t) => {
  // The tests depend on it: 22 of them read `process.cwd()`.
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(resolve(result.stdout), resolve(ROOT),
    'the child must see the repository root as its working directory')
})
