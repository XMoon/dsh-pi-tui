/**
 * HostUserShellPort output-authority coverage (M3-4 PR3 review P1-3):
 * `output()` is the ONE output authority — `result()` carries exit facts
 * only. These tests pin the two regressions the review found in the first
 * adapter cut:
 *
 * 1. a runaway high-output command must NOT grow an unbounded adapter-side
 *    copy (the bounded tail/disk capture is the caller's policy);
 * 2. the card/capture settle must JOIN the drain — `result()` resolving
 *    first can never cut off a lagging delivery (the settle reads the
 *    caller's own bounded capture only after the stream ended).
 *
 * @module @xmoon76/dsh-pi-tui/host-user-shell-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectHostUserShellPort } from '../src/runtime/direct/host-user-shell-direct.ts'

const abort = new AbortController()

function request(overrides: Partial<Parameters<DirectHostUserShellPort['execute']>[0]> = {}) {
  return {
    sessionId: 's',
    cwd: process.cwd(),
    command: 'true',
    policy: 'bypass' as const,
    signal: abort.signal,
    ...overrides,
  }
}

test('output() is the authority: every chunk arrives exactly once and the stream ends at settle', async () => {
  const port = new DirectHostUserShellPort()
  const admission = await port.execute(request({ command: 'printf a; printf b; printf c' }))
  assert.ok(admission.kind === 'executing')
  const chunks: string[] = []
  for await (const chunk of admission.execution.output()) chunks.push(chunk.text)
  const result = await admission.execution.result()
  assert.equal(chunks.join(''), 'abc')
  assert.deepEqual(result.exit, { kind: 'exit', code: 0 })
  // result() carries NO output payload (exit/settlement facts only).
  assert.equal('output' in result, false)
})

test('a high-output command delivers ZERO silent loss with bounded adapter memory (upstream backpressure)', async () => {
  const port = new DirectHostUserShellPort()
  // ~400k lines x ~11 bytes ≈ 4.4MB streamed through a 256-chunk adapter
  // buffer. The consumer deliberately starts 50ms LATE — the producer is
  // guaranteed to have filled the buffer and PAUSED the child by then — and
  // then pauses every 20k lines (threshold, not modulo: chunk boundaries
  // never align with round numbers).
  const admission = await port.execute(request({ command: 'yes 0123456789 | head -n 400000' }))
  assert.ok(admission.kind === 'executing')
  let lines = 0
  let bytes = 0
  let nextPauseAt = 20_000
  const drain = (async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 50))
    for await (const chunk of admission.execution.output()) {
      bytes += chunk.bytes
      lines += chunk.text.split('\n').length - 1
      if (lines >= nextPauseAt) {
        await new Promise(resolve => setTimeout(resolve, 1))
        nextPauseAt += 20_000
      }
    }
  })()
  const result = await admission.execution.result()
  await drain
  assert.deepEqual(result.exit, { kind: 'exit', code: 0 })
  assert.equal(lines, 400_000, `every line reached the slow consumer with zero transport loss (got ${lines})`)
  assert.ok(bytes > 3_000_000, `the run really was high-output (got ${bytes} bytes)`)
})

test('output() is single-consumer: a second consumer is a contract violation', async () => {
  const port = new DirectHostUserShellPort()
  const admission = await port.execute(request({ command: 'printf hi' }))
  assert.ok(admission.kind === 'executing')
  const first = admission.execution.output()[Symbol.asyncIterator]()
  await first.next()
  await assert.rejects(
    () => admission.execution.output()[Symbol.asyncIterator]().next(),
    /single-consumer/,
  )
  await first.return?.()
})

test('a settle read joins the drain: result() resolving first never cuts off a lagging delivery', async () => {
  const port = new DirectHostUserShellPort()
  const admission = await port.execute(request({ command: 'printf x; sleep 0.05; printf y; sleep 0.05; printf z' }))
  assert.ok(admission.kind === 'executing')
  // Deliberately SLOW subscriber: the result promise is likely resolved (the
  // process may have exited) before this consumer drains its backlog. The
  // application pattern under test: await result(), THEN await the drain —
  // the drain must still observe EVERY chunk (the bus ends only after the
  // tail chunks were pushed).
  const drain = (async (): Promise<string> => {
    await new Promise(resolve => setTimeout(resolve, 120))
    let text = ''
    for await (const chunk of admission.execution.output()) text += chunk.text
    return text
  })()
  const result = await admission.execution.result()
  const drained = await drain
  assert.deepEqual(result.exit, { kind: 'exit', code: 0 })
  assert.equal(drained, 'xyz', 'the late subscriber still receives the complete output')
})

test('the sandbox policy without a composition executor fails closed (no downgrade)', async () => {
  const port = new DirectHostUserShellPort() // no ctx/shell
  const admission = await port.execute(request({ policy: 'sandbox', command: 'echo downgrade-poison' }))
  assert.ok(admission.kind === 'unavailable')
  if (admission.kind === 'unavailable') {
    assert.equal(admission.reason.reason, 'policy-unavailable')
    assert.match(admission.reason.message, /sandbox policy is unavailable/)
  }
})

test('the abort path settles the run and delivers the partial output it produced', async () => {
  const controller = new AbortController()
  const port = new DirectHostUserShellPort()
  const admission = await port.execute(request({ command: 'printf early; sleep 5; printf late', signal: controller.signal }))
  assert.ok(admission.kind === 'executing')
  setTimeout(() => controller.abort(), 150)
  const drain = (async (): Promise<string> => {
    let text = ''
    for await (const chunk of admission.execution.output()) text += chunk.text
    return text
  })()
  const result = await admission.execution.result()
  const drained = await drain
  assert.equal(result.aborted, true)
  assert.equal(drained.includes('early'), true, 'partial output produced before the abort is real')
  assert.equal(drained.includes('late'), false, 'output after the abort never arrives')
})

test('cancel kills the WHOLE command tree, not the shell wrapper (prompt settlement)', async () => {
  const controller = new AbortController()
  const port = new DirectHostUserShellPort()
  // `sleep 2` is a CHILD of the shell wrapper: a wrapper-only kill leaves it
  // running (and holding stdio) until its own 2s exit. The process-group
  // cancel must settle the run promptly.
  const admission = await port.execute(request({ command: 'sleep 2; printf late', signal: controller.signal }))
  assert.ok(admission.kind === 'executing')
  setTimeout(() => controller.abort(), 100)
  const started = Date.now()
  const result = await admission.execution.result()
  const elapsed = Date.now() - started
  assert.equal(result.aborted, true)
  assert.ok(elapsed < 1_000, `the run settles promptly after the cancel (took ${elapsed}ms; the wrapper-only kill would wait out the 2s sleep)`)
})

test('an abandoned consumer does not deadlock teardown: the run still settles after backpressure', async () => {
  const controller = new AbortController()
  const port = new DirectHostUserShellPort()
  // High output with NO eager consumer: the bus fills and pauses the child;
  // the abort must still quiesce the run (the process-group kill ends the
  // producer; the run settles without any subscriber).
  const admission = await port.execute(request({ command: 'yes abandoned-marker; sleep 5', signal: controller.signal }))
  assert.ok(admission.kind === 'executing')
  await new Promise(resolve => setTimeout(resolve, 150))
  controller.abort()
  const started = Date.now()
  const result = await admission.execution.result()
  const elapsed = Date.now() - started
  assert.equal(result.aborted, true)
  assert.ok(elapsed < 1_000, `the aborted run settles without a consumer (took ${elapsed}ms)`)
})

test('the bus really pauses and resumes the producer at its watermark (explicit backpressure proof)', async () => {
  const { OutputBus } = await import('../src/runtime/direct/host-user-shell-direct.ts')
  let paused = 0
  let resumed = 0
  const bus = new OutputBus(() => { paused += 1 }, () => { resumed += 1 })
  // Fill past the watermark with NO consumer: pause must fire.
  for (let i = 0; i < 300; i++) bus.push({ text: `c${i}\n`, bytes: 4, stream: 'stdout' })
  assert.ok(paused >= 1, `the producer was paused when the buffer filled (pauses=${paused})`)
  // A consumer drains below the watermark: resume must fire (once, not per chunk).
  // ONE consumer drains to settle (single-consumer contract); the resume
  // checkpoint is observed INSIDE the same iteration.
  const seen: string[] = []
  let resumedBy = -1
  for await (const chunk of bus.stream()) {
    seen.push(chunk.text)
    if (resumed < 1 && resumedBy === -1) resumedBy = -2 // sentinel while waiting
    if (resumed >= 1 && resumedBy < 0) resumedBy = seen.length
  }
  assert.ok(paused >= 1, `the producer was paused when the buffer filled (pauses=${paused})`)
  assert.ok(resumed >= 1, `the producer resumed after draining below the watermark (resumes=${resumed})`)
  assert.ok(resumedBy > 0 && resumedBy < 300, `the resume happened mid-drain, not at settle (resumedBy=${resumedBy})`)
  // FIFO integrity: every pushed chunk arrives exactly once, in order.
  assert.equal(seen.length, 300, 'all chunks delivered, none dropped')
  assert.equal(seen[0], 'c0\n')
  assert.equal(seen[299], 'c299\n')
  bus.end()
})
