/**
 * `waitForFileLine`'s readiness contract: the FILE CONTENT is the authority and
 * the watcher is armed before the first read, so a write between the two is
 * still observed by the post-registration read or by an event that follows it.
 *
 * A registration-gap regression runs in an ISOLATED child: it injects a write
 * immediately before the real `watch()` call, and the same probe is also run
 * against the frozen read-then-watch implementation as a negative control.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/wait-for-file.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { waitForFileLine } from '../support/wait-for-file.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/**
 * The probe that makes the registration gap deterministic. It patches
 * `node:fs`'s `watch` to write the marker synchronously BEFORE the real watcher
 * is installed, exports the patched builtin so the helper's named `watch`
 * import receives it, and only then imports the helper under test.
 */
const REGISTRATION_GAP_PROBE = `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'

const [helperPath, marker] = process.argv.slice(2)
const realWatch = fs.watch
fs.watch = (directory, options, listener) => {
  // The write happens while NO watcher exists for this directory. A helper that
  // reads the current content after registering still sees it; a helper that
  // reads first and registers second misses it, and no later event can deliver
  // the write the first read did not see.
  fs.writeFileSync(marker, 'ready\\n')
  return realWatch(directory, options, listener)
}
syncBuiltinESMExports()

const { waitForFileLine } = await import(pathToFileURL(helperPath).href)
try {
  const line = await waitForFileLine(marker, /^ready$/u, 200)
  process.stdout.write('resolved ' + line + '\\n')
  process.exit(0)
} catch (error) {
  process.stderr.write('rejected ' + error.message + '\\n')
  process.exit(3)
}
`

/** The frozen read-then-watch implementation this regression must reject. */
const FROZEN_OLD_WAIT_FOR_FILE = [
  "import { existsSync, readFileSync, watch } from 'node:fs'",
  "import { basename, dirname } from 'node:path'",
  '',
  'function matchingLine(file, pattern) {',
  '  if (!existsSync(file)) return undefined',
  "  return readFileSync(file, 'utf8').split('\\n').find((line) => pattern.test(line))",
  '}',
  '',
  'export function waitForFileLine(file, pattern, deadlineMs) {',
  '  return new Promise((resolve, reject) => {',
  '    const initial = matchingLine(file, pattern)',
  '    if (initial !== undefined) {',
  '      resolve(initial)',
  '      return',
  '    }',
  '    let watcher',
  '    const timer = setTimeout(() => {',
  '      watcher?.close()',
  "      const content = existsSync(file) ? readFileSync(file, 'utf8') : '(the file does not exist)'",
  '      reject(new Error(`no line matching ${String(pattern)} within ${deadlineMs}ms; the log is:\\n${content}`))',
  '    }, deadlineMs)',
  '    watcher = watch(dirname(file), { persistent: false }, (_event, name) => {',
  '      if (name !== undefined && String(name) !== basename(file)) return',
  '      const line = matchingLine(file, pattern)',
  '      if (line === undefined) return',
  '      clearTimeout(timer)',
  '      watcher?.close()',
  '      resolve(line)',
  '    })',
  '  })',
  '}',
  '',
].join('\n')

test('a marker line already present is read without waiting for an event', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('wait-file-ready-')
  const marker = join(dir, 'evidence.log')
  writeFileSync(marker, 'unrelated first\nready\n')
  assert.equal(await waitForFileLine(marker, /^ready$/u, 2_000), 'ready')
})

test('a line written after the waiter is armed resolves from the file content', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('wait-file-later-')
  const marker = join(dir, 'evidence.log')
  writeFileSync(marker, 'unrelated first\n')
  const waiting = waitForFileLine(marker, /^ready$/u, 2_000)
  // The waiter has registered its watcher by the time it returns; this write
  // must be observed by that registration, not by a clock.
  writeFileSync(marker, 'unrelated first\nready\n')
  assert.equal(await waiting, 'ready')
})

test('an unrelated filename event cannot settle the waiter', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('wait-file-unrelated-')
  const marker = join(dir, 'evidence.log')
  writeFileSync(marker, 'not yet\n')
  const waiting = waitForFileLine(marker, /^ready$/u, 2_000)
  let resolved = false
  waiting.then(() => { resolved = true }, () => {})
  // The unrelated file even CONTAINS the pattern: a waiter that treated an
  // event as readiness, or read the wrong file, would settle here.
  writeFileSync(join(dir, 'other.log'), 'ready\n')
  // The bound covers delivery of the unrelated event just raised; reason: a
  // NEGATIVE fact has no event to wait for.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(resolved, false, 'an unrelated filename event must not settle the waiter')
  writeFileSync(marker, 'ready\n')
  assert.equal(await waiting, 'ready')
})

test('a marker that never appears rejects with the observed file content', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('wait-file-timeout-')
  const marker = join(dir, 'evidence.log')
  await assert.rejects(
    waitForFileLine(marker, /^ready$/u, 100),
    /no line matching \/\^ready\$\/u within 100ms; the log is:\n\(the file does not exist\)/u,
  )
  // The diagnostic carries the content the file DID have, not just the pattern.
  writeFileSync(marker, 'observed line\n')
  await assert.rejects(
    waitForFileLine(marker, /^ready$/u, 100),
    /the log is:\nobserved line\n/u,
  )
})

test('the waiter closes the registration gap between its first read and the watcher', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('wait-file-registration-')
  const probe = join(dir, 'registration-gap-probe.mjs')
  writeFileSync(probe, REGISTRATION_GAP_PROBE)
  const realHelper = fileURLToPath(new URL('../support/wait-for-file.ts', import.meta.url))
  const runProbe = (helperPath, marker) => spawnSync(process.execPath, [probe, helperPath, marker], { encoding: 'utf8' })

  // The real helper sees the injected write through its post-registration read.
  const live = runProbe(realHelper, join(dir, 'real-marker.log'))
  assert.equal(live.status, 0, live.stdout + live.stderr)
  assert.match(live.stdout, /^resolved ready$/mu)

  // Negative control: the SAME probe against the frozen read-then-watch
  // implementation must time out, so this case fails for the old algorithm
  // instead of passing on superficial output shape.
  const frozenHelper = join(dir, 'frozen-old-wait-for-file.mjs')
  writeFileSync(frozenHelper, FROZEN_OLD_WAIT_FOR_FILE)
  const stale = runProbe(frozenHelper, join(dir, 'frozen-marker.log'))
  assert.equal(stale.status, 3, stale.stdout + stale.stderr)
  assert.match(stale.stderr, /no line matching/u)
})
