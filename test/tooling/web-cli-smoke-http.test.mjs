/**
 * The packed Web CLI smoke driver must not hang when a server starts a response
 * and then loses its socket before `end`. This is a tooling reliability test,
 * not product Web behavior.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/web-cli-smoke-http.test
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { requestFresh } from '../../scripts/smoke/split-process/web-cli-m6.mjs'

test('requestFresh rejects a partial response close instead of hanging', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.flushHeaders()
    response.write('partial body')
    // bounded negative observation: the server must close after the partial body window
    setTimeout(() => { response.socket?.destroy() }, 10)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => { server.close(() => resolve()) }))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  let timeoutTimer
  const timeout = new Promise(resolve => {
    // bounded negative deadline: a hanging request must fail this test, not block the lane
    timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), 5_000)
  })
  const outcome = await Promise.race([
    requestFresh(`http://127.0.0.1:${String(address.port)}/partial`).then(
      () => ({ kind: 'resolved' }),
      error => ({ kind: 'rejected', error }),
    ),
    timeout,
  ])
  clearTimeout(timeoutTimer)
  assert.equal(outcome.kind, 'rejected', 'a partial response close must reject, not hang')
  assert.match(String(outcome.error?.message), /HTTP request failed during the Web CLI case/u)
})
