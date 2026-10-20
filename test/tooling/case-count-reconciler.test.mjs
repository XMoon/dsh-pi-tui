/**
 * The case-count RECONCILER's own contract.
 *
 * The reconciler explains every case-count change between two trees. A
 * tool that can report a FALSE reconciliation proves nothing, so the cases
 * below are the ones that would make it lie.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/case-count-reconciler.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const RECONCILER = fileURLToPath(new URL('../../scripts/reconcile-case-counts.mjs', import.meta.url))

/** Run the reconciler over two synthetic reports. */
function reconcile(beforeXml, afterXml) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reconcile-'))
  try {
    const beforePath = join(root, 'before.xml')
    const afterPath = join(root, 'after.xml')
    writeFileSync(beforePath, beforeXml)
    writeFileSync(afterPath, afterXml)
    const result = spawnSync(process.execPath, [RECONCILER, beforePath, afterPath], { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A report with one file's cases. */
function report(total, files) {
  const cases = files.map(([file, count]) => {
    let out = ''
    for (let index = 0; index < count; index += 1) {
      out += `\t<testcase name="case ${index}" file="/repo/test/${file}"/>\n`
    }
    return out
  }).join('')
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n<!-- tests ${total} -->\n${cases}</testsuites>\n`
}

test('a report whose declared total exceeds its attributable cases is rejected', () => {
  // The review's false-reconciliation case: the report declares two tests
  // but only one carries a file. A reconciler that silently attributes
  // one case would report a tidy zero delta over an incomplete report.
  const before = '<?xml version="1.0"?>\n<testsuites>\n<!-- tests 2 -->\n<testcase name="a" file="/x/test/a.test.ts"/>\n<testcase name="b"/>\n</testsuites>\n'
  const after = '<?xml version="1.0"?>\n<testsuites>\n<!-- tests 3 -->\n<testcase name="a" file="/x/test/a.test.ts"/>\n<testcase name="b"/>\n<testcase name="c"/>\n</testsuites>\n'
  const result = reconcile(before, after)
  assert.notEqual(result.status, 0, 'a partial report must not reconcile')
  assert.match(result.output, /PARTIAL|attributes only/u,
    'the rejection must say why the report cannot explain the lane')
})

test('a move is reported as a move, and contributes NOTHING to the delta', () => {
  // The same cases under a different path: the delta is zero, and the tool
  // must not claim the move added or removed cases.
  const before = report(3, [['a.test.ts', 3]])
  const after = report(3, [['tui/a.test.ts', 3]])
  const result = reconcile(before, after)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /=== moved \(1\) ===/u)
  assert.match(result.output, /a\.test\.ts -> tui\/a\.test\.ts/u)
  assert.match(result.output, /explained delta: 0 \(measured 0\)/u)
})

test('an addition and a removal are reported separately from a move', () => {
  const before = report(3, [['a.test.ts', 3]])
  const after = report(4, [['tui/a.test.ts', 3], ['new.test.ts', 1]])
  const result = reconcile(before, after)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /=== moved \(1\) ===/u)
  assert.match(result.output, /=== added \(1\) ===/u)
  assert.match(result.output, /\+   1  new\.test\.ts/u)
  assert.match(result.output, /explained delta: 1 \(measured 1\)/u)
})

test('a changed case count is reported as a change', () => {
  const before = report(3, [['a.test.ts', 3]])
  const after = report(2, [['a.test.ts', 2]])
  const result = reconcile(before, after)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /=== case count CHANGED \(1\) ===/u)
  assert.match(result.output, /explained delta: -1 \(measured -1\)/u)
})
