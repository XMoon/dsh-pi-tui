/**
 * The native launchd test can leave a loaded job whose plist/child/log files
 * live under its fixture root. If that cleanup is unproven, the root must
 * survive so the job's source and evidence remain recoverable. This drives the
 * real TestLifecycle teardown in a child test process and checks the retained
 * files after the child has failed its disposer.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'

test('a cleanup-disposer failure retains the test root when retention is requested', t => {
  const base = testLifecycle(t).tempDir('lifecycle-retention-')
  const childFile = join(base, 'retention.test.mjs')
  const lifecycleUrl = new URL('../support/temp-lifecycle.ts', import.meta.url).href
  writeFileSync(childFile, [
    "import { writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import test from 'node:test'",
    `import { testLifecycle } from ${JSON.stringify(lifecycleUrl)}`,
    "test('requested root retention', t => {",
    "  const life = testLifecycle(t)",
    "  const root = life.tempDir('retention-')",
    "  writeFileSync(join(root, 'plist-source.txt'), 'owned-evidence\\n', { mode: 0o600 })",
    "  process.stdout.write('ROOT=' + root + '\\n')",
    "  life.retainOnCleanupFailure()",
    "  life.defer(() => { throw new Error('cleanup refused') })",
    "})",
    '',
  ].join('\n'), { mode: 0o600 })
  try {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', childFile], { encoding: 'utf8', timeout: 10_000, env })
    assert.notEqual(child.status, 0, `the deliberately failing disposer must fail the child test; stdout=${child.stdout}; stderr=${child.stderr}`)
    const line = child.stdout.split('\n').find(value => value.startsWith('ROOT='))
    assert.ok(line, `the child did not report its root: ${child.stderr}`)
    const root = line.slice('ROOT='.length)
    try {
      assert.equal(existsSync(join(root, 'plist-source.txt')), true, 'the cleanup failure must retain the owned root and its evidence file')
      assert.equal(readFileSync(join(root, 'plist-source.txt'), 'utf8'), 'owned-evidence\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
