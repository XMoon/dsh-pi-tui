import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { HostUserShellAckWindow, HostUserShellOutputMux, HOST_USER_SHELL_ACK_WINDOW } from '../../src/app/host/features/host-user-shell-stream.ts'

const requestId = '550e8400-e29b-41d4-a716-446655440000'
const signal = new AbortController().signal

test('the Host ACK window holds at eight outputs until real cumulative consumption ACKs arrive', async () => {
  const window = new HostUserShellAckWindow(requestId)
  for (let index = 0; index < HOST_USER_SHELL_ACK_WINDOW; index += 1) {
    await window.waitForCapacity(signal)
    assert.equal(window.markSent(), index)
  }
  assert.equal(window.outstanding, 8)
  let ninthReady = false
  const ninth = window.waitForCapacity(signal).then(() => { ninthReady = true })
  await Promise.resolve()
  assert.equal(ninthReady, false, 'the producer remains blocked while all eight frames are unconsumed')
  window.accept({ kind: 'ack', requestId, seq: 3 })
  await ninth
  assert.equal(ninthReady, true)
  assert.equal(window.outstanding, 4)
})

test('ACKs are cumulative and reject repeats, wrong identities, and unsent sequence numbers', () => {
  const window = new HostUserShellAckWindow(requestId)
  window.markSent()
  window.markSent()
  assert.equal(window.accept({ kind: 'ack', requestId, seq: 1 }).seq, 1)
  assert.throws(() => window.accept({ kind: 'ack', requestId, seq: 1 }), /repeated/)
  assert.throws(() => window.accept({ kind: 'ack', requestId: '550e8400-e29b-41d4-a716-446655440001', seq: 1 }), /requestId/)
  assert.throws(() => window.accept({ kind: 'ack', requestId, seq: 2 }), /beyond/)
})

test('the Host mux keeps stdout and stderr distinct and emits raw chunks no larger than 32 KiB', async () => {
  const stdoutBytes = Buffer.alloc(70 * 1024, 0xff)
  const stderrBytes = Buffer.from([0xc3, 0x28, 0x00])
  const mux = new HostUserShellOutputMux(
    Readable.from([stdoutBytes]),
    Readable.from([stderrBytes]),
  )
  const received = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  for (;;) {
    const next = await mux.next(signal)
    if (next === undefined) break
    assert.ok(next.bytes.length <= 32 * 1024)
    received[next.stream] = Buffer.concat([received[next.stream], next.bytes])
  }
  await mux.close()
  assert.deepEqual(received.stdout, stdoutBytes)
  assert.deepEqual(received.stderr, stderrBytes)
})
