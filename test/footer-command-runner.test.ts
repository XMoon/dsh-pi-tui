/**
 * Headless tests for the footer command runner (plan §17.6–§17.12): real
 * child processes prove success/empty/nonzero/timeout/output-cap/row-cap/
 * sanitization/coalescing/stale-result/fallback/recovery.
 * @module @xmoon76/dsh-pi-tui/footer-command-runner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { FooterCommandRunner, type FooterCommandConfig } from '../src/footer/command-runner.ts'
import { TuiApp } from '../src/tui-app.ts'
import { emptyStatusSnapshot } from '../src/status/types.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const CONFIG: FooterCommandConfig = {
  command: 'node -e "process.stdout.write(\'hello\\n\')"',
  timeoutMs: 300,
  refreshIntervalMs: 1000,
  maxRows: 1,
}

/** Run one refresh and resolve with the first output. */
function runOnce(config: FooterCommandConfig, script: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const runner = new FooterCommandRunner({
      config: { ...config, command: `node -e ${JSON.stringify(script)}` },
      snapshot: () => emptyStatusSnapshot(),
      width: () => 100,
      height: () => 30,
      onOutput: (rows) => {
        runner.dispose()
        resolve(rows)
      },
      signal: new AbortController().signal,
    })
    runner.requestRefresh()
  })
}

test('success: the sanitized rows reach the output sink', async () => {
  const rows = await runOnce({ ...CONFIG, maxRows: 2 }, 'process.stdout.write("line one\\nline two\\n")')
  assert.deepEqual(rows, ['line one', 'line two'])
})

test('maxRows caps the output rows', async () => {
  const rows = await runOnce({ ...CONFIG, maxRows: 2 }, 'process.stdout.write("a\\nb\\nc\\n")')
  assert.deepEqual(rows, ['a', 'b'])
})

test('empty output falls back to the native surface (undefined)', async () => {
  const rows = await runOnce(CONFIG, 'process.stdout.write("\\n  \\n")')
  assert.equal(rows, undefined)
})

test('a non-zero exit falls back', async () => {
  const rows = await runOnce(CONFIG, 'process.exit(1)')
  assert.equal(rows, undefined)
})

test('a timeout kills the child and falls back', async () => {
  const rows = await runOnce({ ...CONFIG, timeoutMs: 100 }, 'setTimeout(() => process.stdout.write("late"), 5000)')
  assert.equal(rows, undefined)
})

test('huge stdout is capped at 16 KiB', async () => {
  const rows = await runOnce(CONFIG, 'process.stdout.write("x".repeat(20000) + "\\n")')
  assert.ok(rows !== undefined)
  assert.ok(rows[0]!.length <= 16 * 1024, `output must be capped: ${rows[0]!.length}`)
})

test('malicious escapes are sanitized before the sink', async () => {
  const rows = await runOnce(CONFIG, 'process.stdout.write("\\x1b[31mred\\x1b[0m\\x1b[2Jclear\\n")')
  assert.deepEqual(rows, ['\x1b[31mred\x1b[0mclear'])
})

test('the trailing newline is removed', async () => {
  const rows = await runOnce(CONFIG, 'process.stdout.write("tail\\n")')
  assert.deepEqual(rows, ['tail'])
})

test('coalescing: requests within the interval produce ONE spawn', async () => {
  let spawns = 0
  const outputs: Array<string[] | undefined> = []
  const runner = new FooterCommandRunner({
    config: { ...CONFIG, command: 'node -e "process.stdout.write(\'x\\n\')"' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => {
      spawns += 1
      outputs.push(rows)
    },
    signal: new AbortController().signal,
  })
  runner.requestRefresh()
  runner.requestRefresh()
  runner.requestRefresh()
  // The first request spawns; the others coalesce onto the next interval.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(spawns, 1, `only one spawn within the interval, saw ${spawns}`)
  runner.dispose()
})

test('a stale child result never commits over a newer generation', async () => {
  const outputs: Array<string[] | undefined> = []
  const runner = new FooterCommandRunner({
    config: { ...CONFIG, command: 'node -e "setTimeout(() => process.stdout.write(\'stale\\n\'), 300)"' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => outputs.push(rows),
    signal: new AbortController().signal,
  })
  runner.requestRefresh()
  // A second request supersedes the slow first child.
  await new Promise(resolve => setTimeout(resolve, 50))
  runner.requestRefresh()
  await new Promise(resolve => setTimeout(resolve, 500))
  // The stale child's result must not commit (its generation is old).
  assert.ok(!outputs.some(rows => rows?.includes('stale')), 'a stale child must never commit')
  runner.dispose()
})

test('failure notifies once per error generation; recovery clears it', async () => {
  let notifyCount = 0
  let fail = true
  const outputs: Array<string[] | undefined> = []
  const runner = new FooterCommandRunner({
    config: {
      ...CONFIG,
      command: 'node -e "process.stdout.write(process.env.FAIL === \'1\' ? \'\' : \'ok\\n\'); process.exit(process.env.FAIL === \'1\' ? 1 : 0)"',
      refreshIntervalMs: 50,
    },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => outputs.push(rows),
    onNotifyOnce: () => { notifyCount += 1 },
    signal: new AbortController().signal,
  })
  // Wait until N outputs have settled (never a fixed delay — the child
  // spawn is async).
  const waitFor = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5000
    while (outputs.length < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(outputs.length >= count, `expected ${count} outputs, saw ${outputs.length}`)
  }
  // First failure: notify once.
  process.env.FAIL = '1'
  runner.requestRefresh()
  await waitFor(1)
  assert.equal(notifyCount, 1, 'the first failure must notify once')
  // Same failure: silent.
  runner.requestRefresh()
  await waitFor(2)
  assert.equal(notifyCount, 1, 'a repeated failure must stay silent')
  // Recovery clears the generation; the next failure notifies again.
  process.env.FAIL = '0'
  runner.requestRefresh()
  await waitFor(3)
  process.env.FAIL = '1'
  runner.requestRefresh()
  await waitFor(4)
  assert.equal(notifyCount, 2, 'a new error generation must notify once')
  delete process.env.FAIL
  runner.dispose()
})

test('the app renders the command surface; the Host instruction still merges on top', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setFooterCommandRows(['\x1b[31mred\x1b[0m line'])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('red line'), `the command surface must render:\n${view}`)
  // The Ctrl+C exit hint (Host-owned) still merges on top of the command
  // surface — the command can never hide it.
  app.setDraft('unsent')
  vt.sendInput('\x03')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Press Ctrl+C again'), `the Host instruction must survive the command surface:\n${view}`)
  // Clearing the command surface restores the native composer.
  app.setFooterCommandRows(undefined)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('t0/s0'), `the native surface must return:\n${view}`)
  app.stop()
})
