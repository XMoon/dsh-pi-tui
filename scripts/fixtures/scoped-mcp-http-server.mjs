/**
 * Test-only Streamable HTTP MCP fixture for the scoped-MCP owner tests and the
 * selected `acp.scoped-mcp-b1` Split case.
 *
 * ONE real `node:http` loopback server speaks the minimum standard MCP
 * Streamable HTTP handshake the official SDK client uses: `server/discover`
 * answers JSON-RPC -32601 so the client negotiates the legacy MCP revision via
 * a real `initialize` (this is NOT the Legacy SSE transport), `initialized`
 * answers 202, `tools/list` advertises echo/hold/fail, requests answer as
 * ordinary JSON, and GET opens a real kept-open `text/event-stream`.
 *
 * It owns only test evidence: request/header matches, real tool calls, stream
 * open/close and a run-owned hold barrier. It never reflects credentials in a
 * failure body and never acts as a product network policy.
 *
 * @module fixtures/scoped-mcp-http-server
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const ECHO_TOOL = {
  name: 'echo',
  description: 'Streamable HTTP fixture echo tool: returns the caller nonce',
  inputSchema: {
    type: 'object',
    properties: { nonce: { type: 'string' } },
    required: ['nonce'],
  },
}

const HOLD_TOOL = {
  name: 'hold',
  description: 'Streamable HTTP fixture hold tool: waits for the run-owned release',
  inputSchema: {
    type: 'object',
    properties: { nonce: { type: 'string' } },
    required: ['nonce'],
  },
}

const FAIL_TOOL = {
  name: 'fail',
  description: 'Streamable HTTP fixture fail tool: returns one MCP isError result',
  inputSchema: { type: 'object', properties: {} },
}

const TOOLS = [ECHO_TOOL, HOLD_TOOL, FAIL_TOOL]

function digestOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function headerFacts(headers, expectedHeaders) {
  const facts = {}
  const values = {}
  for (const [name, expected] of Object.entries(expectedHeaders ?? {})) {
    const actual = headers[name.toLowerCase()]
    facts[name] = actual === expected
    if (typeof actual === 'string') values[name] = digestOf(actual)
  }
  return { headerMatches: facts, headerDigests: values, headerNames: Object.keys(headers).sort() }
}

function headersMatch(facts) {
  return Object.values(facts).every(Boolean)
}

/**
 * Start one real loopback Streamable HTTP MCP fixture.
 *
 * @param {object} [options]
 * @param {string} [options.tag] stable fixture tag used in every proof event.
 * @param {Record<string,string>} [options.expectedHeaders] virtual header values
 *   whose exact presence is recorded (never echoed).
 * @param {string} [options.host] loopback host, default 127.0.0.1.
 * @param {(message: object) => void} [options.observe] optional in-memory event
 *   observer used by a test to await a fact without polling.
 * @returns {Promise<object>} fixture handle.
 */
export async function startScopedMcpHttpServer(options = {}) {
  const tag = options.tag ?? 'b1http'
  const expectedHeaders = options.expectedHeaders ?? {}
  const host = options.host ?? '127.0.0.1'
  const events = []
  const requests = []
  const sse = []
  const openResponses = new Set()
  const sockets = new Set()
  const heldResponses = new Set()
  let requestSequence = 0
  let holdReleased = false
  const holdWaiters = []
  let closed = false

  function record(kind, fields = {}) {
    const event = { kind, tag, time: Date.now(), ...fields }
    events.push(event)
    options.observe?.(event)
    return event
  }

  function releaseHold() {
    holdReleased = true
    for (const resolve of holdWaiters.splice(0)) resolve()
  }

  function resetHold() {
    holdReleased = false
  }

  async function waitForHold() {
    if (holdReleased) return
    await new Promise(resolve => { holdWaiters.push(resolve) })
  }

  function sendJson(response, status, payload, extraHeaders = {}) {
    const text = JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
      ...extraHeaders,
    })
    response.end(text)
  }

  function sendRpcResult(response, id, result, extraHeaders) {
    sendJson(response, 200, { jsonrpc: '2.0', id, result }, extraHeaders)
  }

  function sendRpcError(response, id, code, message) {
    sendJson(response, 200, { jsonrpc: '2.0', id, error: { code, message } })
  }

  async function callTool(response, id, params) {
    const name = typeof params?.name === 'string' ? params.name : ''
    const args = params?.arguments ?? {}
    const nonce = typeof args?.nonce === 'string' ? args.nonce : ''
    const callId = `http-call-${++requestSequence}`
    record('tools/call', { rpcId: id, name, nonceDigest: nonce === '' ? undefined : digestOf(nonce), callId })
    if (name === 'echo') {
      if (nonce === '') {
        sendRpcError(response, id, -32602, 'the fixture echo tool requires a nonce')
        return
      }
      sendRpcResult(response, id, { content: [{ type: 'text', text: `b0-echo:${nonce}` }] })
      return
    }
    if (name === 'hold') {
      record('hold-received', { rpcId: id, nonceDigest: digestOf(nonce) })
      await waitForHold()
      record('hold-released', { rpcId: id })
      sendRpcResult(response, id, { content: [{ type: 'text', text: `b0-hold:${nonce}` }] })
      return
    }
    if (name === 'fail') {
      sendRpcResult(response, id, { content: [{ type: 'text', text: 'b0-fail:isError' }], isError: true })
      return
    }
    sendRpcError(response, id, -32602, 'the fixture does not know that tool')
  }

  function handleGet(request, response, path) {
    if (closed) {
      response.destroy()
      return
    }
    const facts = headerFacts(request.headers, expectedHeaders)
    record('request', { path, rpcMethod: 'GET', ...facts })
    if (!headersMatch(facts.headerMatches)) {
      record('header-rejected', { path, rpcMethod: 'GET', ...facts })
      sendJson(response, 401, { error: 'fixture header mismatch' })
      return
    }
    const recordEntry = { id: sse.length + 1, path, openedAt: Date.now() }
    sse.push(recordEntry)
    record('sse-open', { path, streamId: recordEntry.id })
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    response.write(': fixture stream open\n\n')
    openResponses.add(response)
    response.on('close', () => {
      openResponses.delete(response)
      recordEntry.closedAt = Date.now()
      record('sse-close', { path, streamId: recordEntry.id })
    })
  }

  function handlePost(request, response, path) {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > 1_000_000) {
        request.destroy(new Error('fixture request body too large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let message
      try {
        message = JSON.parse(text)
      } catch {
        sendJson(response, 400, { error: 'invalid JSON' })
        return
      }
      const method = typeof message?.method === 'string' ? message.method : undefined
      const id = message?.id
      const facts = headerFacts(request.headers, expectedHeaders)
      requests.push({
        path,
        method,
        at: Date.now(),
        rpcId: id,
        ...facts,
        ...typeof request.headers['mcp-session-id'] === 'string' ? { sessionHeader: request.headers['mcp-session-id'] } : {},
      })
      record('request', { path, rpcMethod: method, rpcId: id, ...facts })

      if (!headersMatch(facts.headerMatches)) {
        record('header-rejected', { path, rpcMethod: method, rpcId: id, ...facts })
        sendJson(response, 401, { error: 'fixture header mismatch' })
        return
      }

      if (path === '/hold-startup') {
        record('startup-held', { rpcMethod: method, rpcId: id })
        heldResponses.add(response)
        response.on('close', () => {
          heldResponses.delete(response)
          record('startup-held-closed', { rpcMethod: method, rpcId: id })
        })
        return
      }

      if (method === 'server/discover') {
        sendRpcError(response, id, -32601, 'Method not found')
        return
      }
      if (method === 'initialize') {
        sendRpcResult(response, id, {
          protocolVersion: typeof message?.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `pr4c-http-${tag}`, version: '1.0.0' },
        }, { 'mcp-session-id': `fixture-session-${tag}-${++requestSequence}` })
        return
      }
      if (method === 'notifications/initialized') {
        response.writeHead(202)
        response.end()
        return
      }
      if (method === 'tools/list') {
        if (path === '/fail-list') {
          // Fixed failure body: never reflect a header, URL or credential value.
          sendJson(response, 500, { error: 'fixture tools/list failure' })
          return
        }
        sendRpcResult(response, id, { tools: TOOLS })
        return
      }
      if (method === 'tools/call') {
        if (path === '/fail-call') {
          sendJson(response, 500, { error: 'fixture tools/call failure' })
          return
        }
        void callTool(response, id, message?.params).catch(error => {
          record('tool-call-failed', { rpcId: id, message: error instanceof Error ? error.message : String(error) })
          if (!response.headersSent) sendRpcError(response, id, -32603, 'fixture tool call failed')
        })
        return
      }
      if (method === 'ping') {
        sendRpcResult(response, id, {})
        return
      }
      sendRpcError(response, id, -32601, `Method not found: ${String(method)}`)
    })
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method === 'GET') {
      if (path === '/mcp') {
        handleGet(request, response, path)
        return
      }
      response.writeHead(405, { 'content-type': 'text/plain' })
      response.end('no stream')
      return
    }
    if (request.method === 'DELETE') {
      response.writeHead(405, { 'content-type': 'text/plain' })
      response.end('session termination not supported')
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'text/plain' })
      response.end('method not allowed')
      return
    }
    if (path !== '/mcp' && path !== '/fail-list' && path !== '/fail-call' && path !== '/hold-startup') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    handlePost(request, response, path)
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, host, () => resolveListen())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind a TCP address')
  const origin = `http://${host}:${String(address.port)}`

  function waitForEvent(predicate, label, timeoutMs = 60_000) {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const check = () => {
        const match = events.find(predicate)
        if (match !== undefined) {
          resolve(match)
          return
        }
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`timed out waiting for ${label}`))
          return
        }
        setTimeout(check, 20)
      }
      check()
    })
  }

  return {
    tag,
    origin,
    port: address.port,
    url: `${origin}/mcp`,
    failListUrl: `${origin}/fail-list`,
    failCallUrl: `${origin}/fail-call`,
    holdStartupUrl: `${origin}/hold-startup`,
    events,
    requests,
    sse,
    waitForEvent,
    releaseHold,
    resetHold,
    async close() {
      if (closed) return
      closed = true
      for (const response of [...openResponses, ...heldResponses]) {
        try { response.destroy() } catch { /* run-owned response already gone */ }
      }
      openResponses.clear()
      heldResponses.clear()
      for (const socket of [...sockets]) {
        try { socket.destroy() } catch { /* run-owned socket already gone */ }
      }
      sockets.clear()
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(() => resolveClose()))
    },
  }
}
