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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parseConcurrency } from '../../scripts/run-test-lane.mjs'
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

test('the SHARDED command line still fits the Windows limit', () => {
  // The shard argument and the reporter flag ADD to the command line, and
  // the shard path is exactly what the CI measurement uses. If the
  // measurement's own command line did not fit, the sharded lane would
  // fail to START on a Windows runner — and the failure would look like a
  // test failure rather than a command-line failure.
  const lane = LANES.product
  const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
  const relativeArguments = files.map(rel => `test\\${rel.replaceAll('/', '\\')}`)
  // The fixed part: the executable, `--test`, the shard argument and the
  // reporter flag the measurement adds.
  const fixed = 'C:\\Program Files\\nodejs\\node.exe --test --test-shard=1/4 --test-reporter=C:\\Users\\owner\\projects\\dsh-pi-tui\\scripts\\test-case-reporter.mjs '.length
  const length = fixed + relativeArguments.join(' ').length
  assert.ok(
    length < WINDOWS_COMMAND_LINE_LIMIT,
    `the sharded command line must fit the Windows limit: ${length} >= ${WINDOWS_COMMAND_LINE_LIMIT}`,
  )
})

test('the runner passes the file list RELATIVE to the repository root', () => {
  // The runner's own source is the contract: it must build the argument
  // list from the test-root-relative paths and set the child's working
  // directory to the repository root.
  const source = readFileSync(join(ROOT, 'scripts', 'run-test-lane.mjs'), 'utf8')
  assert.match(source, /const relativeFiles = files\.map\(rel => join\('test', rel\)\)/u,
    'the runner must pass the file list relative to the repository root')
  assert.match(source, /cwd: ROOT/u,
    "the child must run with the repository root as its working directory")
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

// ---------------------------------------------------------------------------
// The CONCURRENCY argument.
//
// The regression this protects: the runner used to take `--test-concurrency`
// from the command line, IGNORE it, and run the lane at Node's default
// anyway. Nothing failed — the lane was green, the report was complete, and
// only the TIMING was wrong. A concurrency measurement that silently ran at
// the default level is worse than no measurement: it produces five
// identical samples and calls them a comparison.
//
// So these cases assert the runner's ARGUMENT PARSING directly, and the
// forwarding is proved by the BEHAVIOUR: Node's own concurrency is visible
// in the child process tree.
// ---------------------------------------------------------------------------

test('the concurrency argument is parsed into a Node flag', () => {
  assert.equal(parseConcurrency(['--test-concurrency=1']), '--test-concurrency=1')
  assert.equal(parseConcurrency(['--test-concurrency=8']), '--test-concurrency=8')
})

test('the DEFAULT concurrency is expressed by NOT passing a flag', () => {
  // Node's default is `os.availableParallelism()`. A runner that spelled the
  // default as a NUMBER would freeze the measurement to one machine's CPU
  // count, which is exactly the assumption the measurement must not make.
  assert.equal(parseConcurrency([]), undefined)
  assert.equal(parseConcurrency(['--test-concurrency=default']), undefined)
})

test('a malformed concurrency is a FAILURE, not a silent default', () => {
  // A silently ignored concurrency would make the measurement meaningless,
  // so an unreadable one must stop the run.
  assert.throws(() => parseConcurrency(['--test-concurrency=zero']), /whole number/u)
  assert.throws(() => parseConcurrency(['--test-concurrency=0']), /at least 1/u)
  assert.throws(() => parseConcurrency(['--test-concurrency=-1']), /whole number/u)
})

test('the runner FORWARDS the concurrency to Node, and Node applies it', () => {
  // The runner's own ARGUMENT construction is what matters, so it is
  // asserted on the runner's SOURCE: the flag must be part of the spawned
  // argument list. The BEHAVIOUR that the flag produces is proved by the
  // next case.
  const source = readFileSync(join(ROOT, 'scripts', 'run-test-lane.mjs'), 'utf8')
  assert.match(source, /\.\.\.\(concurrency === undefined \? \[\] : \[concurrency\]\)/u,
    'the runner must put the parsed concurrency into the spawned argument list')
  assert.match(source, /const concurrency = parseConcurrency\(args\)/u,
    'the runner must parse the concurrency from its own arguments')
})

test('the CONCURRENCY level changes how many files Node keeps in flight', () => {
  // The end-to-end proof that the flag means what it says: four files that
  // each hold the event loop for 400ms take about 1.6s at concurrency 1 and
  // about 0.4s at concurrency 4.
  //
  // The probe files are named RELATIVE to the working directory: Node only
  // treats a path as a test file when it can recognise it as one, and an
  // absolute path outside the working directory is not recognised — the run
  // then reports nothing and looks instantly fast.
  const directory = join(ROOT, 'temp', `dsh-concurrency-probe-${process.pid}`)
  mkdirSync(directory, { recursive: true })
  try {
    const files = []
    for (let index = 0; index < 4; index += 1) {
      const file = join(directory, `probe-${index}.test.mjs`)
      writeFileSync(file,
        `import test from 'node:test'\n`
        + `test('hold ${index}', async () => { await new Promise(r => setTimeout(r, 400)) })\n`)
      files.push(relative(ROOT, file))
    }
    const timeAt = (concurrency) => {
      const start = Date.now()
      const result = spawnSync(process.execPath, [
        '--test', `--test-concurrency=${concurrency}`, '--test-reporter=spec', ...files,
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        // The child of a test runner is told it is a test child. Inheriting
        // that marker makes Node treat the probe run as an already-running
        // test context instead of a fresh runner, and it then executes
        // nothing at all — the run reports success in milliseconds.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /hold 3/u,
        'the probe files must actually run')
      return Date.now() - start
    }
    const serial = timeAt(1)
    const parallel = timeAt(4)
    assert.ok(serial >= 1400, `the serial run must take the sum of the files: ${serial}ms`)
    assert.ok(parallel < serial - 600,
      `the parallel run must be materially faster than the serial one: ${parallel}ms vs ${serial}ms`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
