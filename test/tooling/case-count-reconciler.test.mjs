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
  assert.match(result.output, /PARTIAL|DIFFERENT number of cases/u,
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

test('a report pair that attributes a DIFFERENT number of cases is rejected', () => {
  // The review's finding: two reports that both declare 100 cases, but
  // attribute 96 and 95 of them to a file, reconciled as a -1 delta even
  // though the declared totals are equal. The unattributed remainder
  // changed, so the per-file reconciliation cannot explain the lane.
  const report = (attributed, unfiled) => {
    const cases = []
    for (let index = 0; index < attributed; index += 1) {
      cases.push(`\t<testcase name="c${index}" file="/repo/test/f${index % 10}.test.ts"/>`)
    }
    for (let index = 0; index < unfiled; index += 1) {
      cases.push(`\t<testcase name="u${index}"/>`)
    }
    return `<?xml version="1.0"?>\n<testsuites>\n<!-- tests 100 -->\n${cases.join('\n')}\n</testsuites>\n`
  }
  const result = reconcile(report(96, 4), report(95, 5))
  assert.notEqual(result.status, 0, 'a varying unattributed count must not reconcile')
  assert.match(result.output, /DIFFERENT number of cases/u,
    'the rejection must say the per-file reconciliation cannot explain the delta')
})

test('the reported totals are the DECLARED totals, not the attributed part', () => {
  // The lane's case count is the report's own declared total. The
  // per-file counts explain the attributed part, and the unattributed
  // remainder is shown as its own line.
  const before = report(3, [['a.test.ts', 3]])
  const after = report(4, [['tui/a.test.ts', 3], ['new.test.ts', 1]])
  const result = reconcile(before, after)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /before: 1 files, 3 cases \(3 attributed, 0 unattributed\)/u)
  assert.match(result.output, /after:  2 files, 4 cases \(4 attributed, 0 unattributed\)/u)
})

test('an ambiguous move is reported as an addition and removals, never as two moves', () => {
  // Two old paths compete for ONE new path. The mapping is not one-to-one,
  // so neither old path is a MOVE: the report must show one addition and
  // two removals.
  const before = report(2, [['one/foo.test.ts', 1], ['two/foo.test.ts', 1]])
  const after = report(1, [['new/foo.test.ts', 1]])
  const result = reconcile(before, after)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /=== moved \(0\) ===/u,
    'an ambiguous pair must not be claimed as a move')
  assert.match(result.output, /=== added \(1\) ===/u)
  assert.match(result.output, /=== removed \(2\) ===/u)
})
