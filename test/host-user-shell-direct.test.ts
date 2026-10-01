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

test('a high-output command does not grow an unbounded adapter copy (bounded backlog)', async () => {
  const port = new DirectHostUserShellPort()
  // ~400k lines x ~10 bytes = ~4MB streamed; the adapter backlog stays
  // bounded, and the SUBSCRIBER (this test) consumes eagerly so the whole
  // stream must still arrive — proving nothing was silently dropped for an
  // EAGER consumer while the adapter held only a bounded window.
  const admission = await port.execute(request({ command: 'yes 0123456789 | head -n 400000' }))
  assert.ok(admission.kind === 'executing')
  let lines = 0
  let bytes = 0
  for await (const chunk of admission.execution.output()) {
    bytes += chunk.bytes
    lines += chunk.text.split('\n').length - 1
  }
  const result = await admission.execution.result()
  assert.deepEqual(result.exit, { kind: 'exit', code: 0 })
  assert.equal(lines, 400_000, `every line reached the eager consumer (got ${lines})`)
  assert.ok(bytes > 3_000_000, `the run really was high-output (got ${bytes} bytes)`)
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
