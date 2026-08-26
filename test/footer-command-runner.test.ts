/**
 * Headless tests for the footer command runner (plan §17.6–§17.12): real
 * child processes prove success/empty/nonzero/timeout/output-cap/row-cap/
 * sanitization/coalescing/stale-result/fallback/recovery.
 * @module @xmoon76/dsh-pi-tui/footer-command-runner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FooterCommandRunner, KILL_GRACE_MS, type FooterCommandConfig } from '../src/footer/command-runner.ts'
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
  // A generous timeout: the child is a trivial echo, but under the packed
  // packaging chain a spawn can exceed the 300ms PRODUCTION default — the
  // test must not hit the runner's own timeout (the timeout behavior is
  // covered by its own dedicated test).
  const rows = await runOnce({ ...CONFIG, maxRows: 2, timeoutMs: 10000 }, 'process.stdout.write("a\\nb\\nc\\n")')
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

test('a TERM-resistant child is HARD-killed after the grace period (no detached orphan)', async () => {
  // The child traps TERM and would run forever: a plain SIGTERM (the old
  // killChild) leaves it running as a detached orphan — the runner must
  // escalate to SIGKILL within KILL_GRACE_MS. The child records its own
  // pid (the detached group leader) so the test can PROVE the process is
  // actually gone — this assertion fails against the old implementation.
  const dir = mkdtempSync(join(tmpdir(), 'footer-kill-'))
  const marker = join(dir, 'child.pid')
  const rows = await new Promise<string[] | undefined>((resolve) => {
    const runner = new FooterCommandRunner({
      config: {
        ...CONFIG,
        timeoutMs: 150,
        command: `trap "" TERM; echo $$ > ${marker}; while :; do sleep 1; done`,
      },
      snapshot: () => emptyStatusSnapshot(),
      width: () => 100,
      height: () => 30,
      onOutput: (out) => {
        runner.dispose()
        resolve(out)
      },
      signal: new AbortController().signal,
    })
    runner.requestRefresh()
  })
  assert.equal(rows, undefined, 'the timeout must fall back to the native surface')
  // Read the child pid (bounded poll — the spawn is async).
  let pid = -1
  const readDeadline = Date.now() + 3000
  while (pid < 0 && Date.now() < readDeadline) {
    try {
      pid = Number.parseInt(readFileSync(marker, 'utf8').trim(), 10)
    } catch {
      // Not written yet.
    }
    if (pid < 0) await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(pid > 0, 'the child must have written its pid')
  // The process must be ACTUALLY dead within the grace + a margin:
  // kill(pid, 0) throws ESRCH once the process is reaped. A TERM-only
  // kill would leave it alive forever (it traps TERM).
  const deadDeadline = Date.now() + KILL_GRACE_MS + 3000
  let dead = false
  while (!dead && Date.now() < deadDeadline) {
    try {
      process.kill(pid, 0)
      await new Promise(resolve => setTimeout(resolve, 20))
    } catch {
      dead = true
    }
  }
  assert.ok(dead, `the TERM-resistant child must be hard-killed (no orphan), pid ${pid} still alive`)
  rmSync(dir, { recursive: true, force: true })
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
  const runStartedAt: number[] = []
  const runner = new FooterCommandRunner({
    config: { ...CONFIG, refreshIntervalMs: 500, command: 'node -e "process.stdout.write(\'x\\n\')"' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => {
      spawns += 1
      outputs.push(rows)
      // onOutput fires at the child's CLOSE, not its start — record the
      // close time and verify the SPAWN spacing via the runner's own
      // lastStartAt indirectly: a second spawn cannot occur before the
      // interval from the FIRST start. The first output's close time
      // upper-bounds the first start time, so (interval + close latency)
      // is the earliest a second spawn's output can legally arrive.
      runStartedAt.push(Date.now())
    },
    signal: new AbortController().signal,
  })
  runner.requestRefresh()
  runner.requestRefresh()
  runner.requestRefresh()
  // The first request spawns; the others coalesce onto the next interval.
  const deadline = Date.now() + 5000
  while (outputs.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(spawns, 1, `the first start must produce one result, saw ${spawns}`)
  const firstCloseAt = runStartedAt[0]!
  // Wait until WELL PAST the interval from the FIRST START (the close
  // time upper-bounds it): a second spawn (the single coalesced one) may
  // now legally appear — but NEVER more than one, and never before the
  // interval's worth of time has elapsed since the first start.
  const intervalWait = 500 + 300 // interval + generous close-latency margin
  const waitUntil = Date.now() + 3000
  while (spawns < 2 && Date.now() < waitUntil) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  // EXACTLY one coalesced second spawn — never a third. A third spawn
  // could only fire after ANOTHER full interval (500ms) from the second
  // start; the 200ms observation window here (from the second spawn's
  // close) is far inside that, so it cannot produce a false fail (a
  // third spawn would need the 500ms timer to fire ~2.5x early). This
  // is a NEGATIVE assertion — "no event" cannot be event-driven; the
  // window is bounded well under the interval by construction.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(spawns, 2, `two coalesced requests must produce exactly ONE extra spawn, saw ${spawns}: ${JSON.stringify(outputs)}`)
  // The second spawn is the coalesced one: it cannot have STARTED before
  // `firstCloseAt + interval - closeLatency`... the hard assertion is
  // that the second spawn's CLOSE is at least `interval` after the first
  // start. Since firstCloseAt >= firstStart, secondClose - firstCloseAt
  // >= interval - (firstClose - firstStart) — with a fast child
  // (low close latency) this is >= ~interval - closeLatency. Use a
  // tolerant bound (interval - 200ms) to avoid flaking on slow spawns.
  const secondCloseAt = runStartedAt[1]!
  assert.ok(secondCloseAt - firstCloseAt >= 500 - 200,
    `the second (coalesced) spawn must respect the interval spacing: ${secondCloseAt - firstCloseAt}ms`)
  runner.dispose()
})

test('requests within the interval NEVER overlap a running child (coalescing guarantee)', async () => {
  // The interval is the minimum start spacing and the timeout ceiling is
  // the interval minimum, so through requestRefresh a second child can
  // never start while the first is still in flight — the supersede guard
  // is reachable only via setConfig (covered below). A slow child that
  // finishes within its timeout must therefore COMMIT its output: the
  // in-interval request coalesces, it does not kill or shadow the child.
  const outputs: Array<string[] | undefined> = []
  const runner = new FooterCommandRunner({
    // A child that takes ~150ms and a GENEROUS timeout (the production
    // 300ms default is too tight under packed-suite load — the child must
    // never be killed by the runner's own timeout or the test measures
    // timeout behavior instead of the coalescing guarantee).
    config: { ...CONFIG, timeoutMs: 10000, command: 'node -e "setTimeout(() => process.stdout.write(\'slow\\n\'), 150)"' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => outputs.push(rows),
    signal: new AbortController().signal,
  })
  runner.requestRefresh()
  // A second request lands INSIDE the interval (the first child is still
  // in flight): it must COALESCE — never a second spawn, never a kill of
  // the running child. Let the child's spawn settle (microtask turn), then
  // fire the second request while it is clearly still running (~150ms
  // child vs a few-ms settle).
  await Promise.resolve()
  runner.requestRefresh()
  // Wait for the first child's completion EVENT (bounded poll).
  const deadline = Date.now() + 5000
  while (outputs.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(outputs.length, 1, `exactly one child result (no overlap): ${JSON.stringify(outputs)}`)
  assert.deepEqual(outputs[0], ['slow'], 'the in-flight child must commit its own result')
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

test('the output cap is a UTF-8 BYTE cap (multibyte output cannot exceed 16 KiB)', async () => {
  // 6000 CJK chars = 18000 UTF-8 bytes > 16384: the cap must cut it.
  const rows = await runOnce(CONFIG, 'process.stdout.write("\\u4f60".repeat(6000) + "\\n")')
  assert.ok(rows !== undefined)
  const bytes = Buffer.byteLength(rows[0]!, 'utf8')
  assert.ok(bytes <= 16 * 1024, `the byte cap must hold: ${bytes}`)
})

test('command rows are width-truncated ANSI-safely before the sink', async () => {
  const { visibleWidth } = await import('@xmoon76/pi-tui')
  const rows = await runOnce({ ...CONFIG, maxRows: 1 }, 'process.stdout.write("x".repeat(500) + "\\n")')
  assert.ok(rows !== undefined)
  // The runner's width is 100: the row must be truncated to 100 VISIBLE
  // cells (the JS length includes the ANSI resets).
  assert.ok(visibleWidth(rows[0]!) <= 100, `the row must be width-truncated: ${visibleWidth(rows[0]!)}`)
  assert.ok(rows[0]!.includes('…'), 'the truncation must carry the ellipsis')
})

test('a byte-budget slice never emits U+FFFD replacement characters', async () => {
  // A huge width so the width truncation cannot hide the byte-cap issue:
  // 6000 CJK chars = 18000 UTF-8 bytes; the cap cuts mid-stream. The
  // StringDecoder must never emit a replacement char.
  const rows = await new Promise<string[] | undefined>((resolve) => {
    const runner = new FooterCommandRunner({
      config: { ...CONFIG, command: 'node -e "process.stdout.write(\'\\u4f60\'.repeat(6000) + \'\\n\')"' },
      snapshot: () => emptyStatusSnapshot(),
      width: () => 20000,
      height: () => 30,
      onOutput: (out) => {
        runner.dispose()
        resolve(out)
      },
      signal: new AbortController().signal,
    })
    runner.requestRefresh()
  })
  assert.ok(rows !== undefined)
  assert.ok(!rows[0]!.includes('\uFFFD'), 'a split multibyte sequence must never emit U+FFFD')
  assert.ok(Buffer.byteLength(rows[0]!, 'utf8') <= 16 * 1024, 'the byte cap must hold')
})

test('a multibyte sequence split ACROSS stdout chunks never emits U+FFFD and the input budget holds', async () => {
  // The child writes the first byte of a CJK char, pauses, then the rest —
  // two separate stdout chunks. The width is huge so the width truncation
  // cannot hide the byte-cap behavior.
  const rows = await new Promise<string[] | undefined>((resolve) => {
    const runner = new FooterCommandRunner({
      config: { ...CONFIG, command: 'node -e "process.stdout.write(Buffer.from([0xe4])); setTimeout(() => { process.stdout.write(Buffer.from([0xbd, 0xa0])); process.stdout.write(\'\\n\') }, 50)"' },
      snapshot: () => emptyStatusSnapshot(),
      width: () => 20000,
      height: () => 30,
      onOutput: (out) => {
        runner.dispose()
        resolve(out)
      },
      signal: new AbortController().signal,
    })
    runner.requestRefresh()
  })
  assert.ok(rows !== undefined)
  assert.ok(!rows[0]!.includes('\uFFFD'), 'a split multibyte sequence must never emit U+FFFD')
  // The consumed INPUT bytes are bounded; the completed tail may add a few
  // bytes over the raw budget.
  assert.ok(Buffer.byteLength(rows[0]!, 'utf8') <= 16 * 1024 + 4, 'the input budget must hold')
})

test('setConfig invalidates the in-flight child (its result never commits under the new config)', async () => {
  const outputs: Array<string[] | undefined> = []
  const runner = new FooterCommandRunner({
    config: { ...CONFIG, command: 'node -e "setTimeout(() => process.stdout.write(\'old\\n\'), 300)"' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => outputs.push(rows),
    signal: new AbortController().signal,
  })
  runner.requestRefresh()
  // start() spawns synchronously, so the child is in flight after one
  // settle; setConfig supersedes it (generation bump + kill) and starts
  // the new generation immediately.
  await Promise.resolve()
  runner.setConfig({ ...CONFIG, command: 'node -e "process.stdout.write(\'new\\n\')"' })
  const deadline = Date.now() + 5000
  while (!outputs.some(rows => rows?.includes('new')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(outputs.some(rows => rows?.includes('new')), 'the new config must commit')
  assert.ok(!outputs.some(rows => rows?.includes('old')), 'the old child must never commit')
  runner.dispose()
})

test('setConfig clears the OLD config\'s committed rows immediately (no stale surface)', async () => {
  const outputs: Array<string[] | undefined> = []
  let notifyCount = 0
  const runner = new FooterCommandRunner({
    config: { ...CONFIG, command: 'node -e "process.stdout.write(\'first\\n\')"' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => outputs.push(rows),
    onNotifyOnce: () => { notifyCount += 1 },
    signal: new AbortController().signal,
  })
  runner.requestRefresh()
  const deadline = Date.now() + 5000
  while (!outputs.some(rows => rows?.includes('first')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  // Config change: the old rows must be cleared SYNCHRONOUSLY (an
  // explicit undefined from setConfig — not a failure, so no notify),
  // before the new config's result lands.
  const before = outputs.length
  runner.setConfig({ ...CONFIG, command: 'node -e "process.stdout.write(\'second\\n\')"' })
  assert.equal(outputs[before], undefined, 'the old config rows must clear synchronously on setConfig')
  assert.equal(notifyCount, 0, 'a config change is not a failure (no notify)')
  const deadline2 = Date.now() + 5000
  while (!outputs.some(rows => rows?.includes('second')) && Date.now() < deadline2) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(outputs.some(rows => rows?.includes('second')), 'the new config must commit')
  runner.dispose()
})

test('a STALE child timeout never kills the CURRENT child (generation-scoped kill)', async () => {
  // The race: the first child is SIGTERM-resistant (its close event is
  // delayed, so its timeout stays armed); setConfig REPLACES it
  // immediately (refreshIntervalMs 0 forces the start); the OLD child's
  // timeout then fires while the NEW child is already in flight — it
  // must NOT kill the new child. The new child writes LATE (400ms), so
  // it is still running when the old timeout (200ms) fires.
  const outputs: Array<string[] | undefined> = []
  const runner = new FooterCommandRunner({
    // A child that traps TERM and keeps running (the close event never
    // fires promptly, so its timeout stays armed).
    config: { ...CONFIG, refreshIntervalMs: 0, timeoutMs: 200, command: 'trap "" TERM; sleep 3' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => outputs.push(rows),
    signal: new AbortController().signal,
  })
  runner.requestRefresh()
  await Promise.resolve()
  // Replace IMMEDIATELY (interval 0): the new child starts now, before
  // the old timeout (200ms) fires. It writes at 400ms — after the stale
  // timeout — with a generous timeout of its own (10s).
  runner.setConfig({ ...CONFIG, refreshIntervalMs: 0, timeoutMs: 10000, command: 'node -e "setTimeout(() => process.stdout.write(\'new\\n\'), 400)"' })
  const deadline = Date.now() + 5000
  while (!outputs.some(rows => rows?.includes('new')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  // The stale timeout (old generation, 200ms) must NOT have killed the
  // new child: if it had, the new child would have been SIGTERMed before
  // its 400ms write and 'new' would never commit.
  assert.ok(outputs.some(rows => rows?.includes('new')),
    `the new child must commit (the stale timeout must not kill it):\n${JSON.stringify(outputs)}`)
  runner.dispose()
})

test('a config switch to a SHORTER interval never spawns from a stale coalesced timer', async () => {
  // The first refresh starts (lastStartAt set); the second coalesces
  // onto the LONG interval's timer. setConfig switches to interval 0,
  // whose requestRefresh takes the IMMEDIATE start branch — the stale
  // long-interval timer must be cleared there, otherwise it fires later
  // and spawns an EXTRA command.
  const outputs: Array<string[] | undefined> = []
  const runner = new FooterCommandRunner({
    config: { ...CONFIG, refreshIntervalMs: 200, command: 'node -e "process.stdout.write(\'a\\n\')"' },
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: (rows) => outputs.push(rows),
    signal: new AbortController().signal,
  })
  // Two requests on the LONG interval: the first starts, the second
  // coalesces onto a timer 100s away.
  runner.requestRefresh()
  runner.requestRefresh()
  // Wait until the 200ms stale timer is ARMED (100ms in), then switch:
  // the immediate-start branch must clear it, or it fires ~100ms later.
  await new Promise(resolve => setTimeout(resolve, 100))
  runner.setConfig({ ...CONFIG, refreshIntervalMs: 0, command: 'node -e "process.stdout.write(\'b\\n\')"' })
  const deadline = Date.now() + 5000
  while (!outputs.some(rows => rows?.includes('b')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(outputs.some(rows => rows?.includes('b')), 'the new config must commit')
  const countAtCommit = outputs.length
  // A stale 200ms timer would still be armed: if the immediate branch
  // did not clear it, it fires ~100ms after the switch and spawns a
  // THIRD command. The 120ms window here covers that firing point; a
  // correct clear produces no change in the window (a negative
  // assertion — "no event" cannot be event-driven).
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(outputs.length, countAtCommit, `no extra spawn from a stale timer: ${JSON.stringify(outputs)}`)
  runner.dispose()
})

test('an already-aborted signal never spawns a child', async () => {
  const signal = new AbortController()
  signal.abort()
  let outputs = 0
  const runner = new FooterCommandRunner({
    config: CONFIG,
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    onOutput: () => { outputs += 1 },
    signal: signal.signal,
  })
  runner.requestRefresh()
  runner.requestRefresh()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(outputs, 0, 'an aborted runner must never spawn')
  runner.dispose()
})

test('a child writing LOTS of stderr completes (the pipe is drained, never misjudged as a timeout)', async () => {
  const rows = await runOnce(
    { ...CONFIG, timeoutMs: 10000 },
    'for (let i = 0; i < 400; i++) process.stderr.write("s".repeat(4096)); process.stdout.write("ok\\n")',
  )
  assert.deepEqual(rows, ['ok'], `the child must not block on a full stderr pipe:\n${JSON.stringify(rows)}`)
})
