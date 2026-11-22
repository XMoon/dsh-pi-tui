/**
 * G-ACP1B/B0 run-owned stdio MCP server.
 *
 * This file is copied into the isolated profile and spawned as a REAL child
 * process by the official `@deepseek-ai/dsh-mcp-client` loader. It speaks the
 * MCP JSON-RPC line protocol on stdin/stdout and owns exactly three harmless
 * tools used by `acp.scoped-mcp-b0`:
 *
 *   echo  - answers with the caller-supplied nonce
 *   hold  - records the received call, then waits for the run-owned release
 *   fail  - returns an MCP `isError: true` result
 *
 * The process keeps stdout protocol-only; every proof line goes to the
 * run-owned JSONL file named by `B0_FIXTURE_PROOF`. `B0_BOOT_FAIL=1` makes the
 * process exit before the MCP handshake so the caller can qualify a failed
 * initial connection and Cordis rollback.
 *
 * @module fixtures/scoped-mcp-b0-server
 */

import { appendFileSync, chmodSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'

const proofPath = process.env.B0_FIXTURE_PROOF
if (typeof proofPath !== 'string' || proofPath === '') {
  process.stderr.write('b0-scoped-mcp: B0_FIXTURE_PROOF is required\n')
  process.exit(2)
}

const tag = process.env.B0_SERVER_TAG ?? 'b0scope'
const runNonce = process.env.B0_RUN_NONCE ?? ''
const nonceDigest = runNonce === ''
  ? undefined
  : createHash('sha256').update(runNonce).digest('hex').slice(0, 16)

function record(kind, fields = {}) {
  appendFileSync(proofPath, `${JSON.stringify({
    kind,
    tag,
    pid: process.pid,
    ppid: process.ppid,
    time: Date.now(),
    nonceDigest,
    ...fields,
  })}\n`, { mode: 0o600 })
}

if (process.env.B0_BOOT_FAIL === '1') {
  record('server-boot-fail', { stage: 'before-handshake' })
  process.exit(23)
}

record('server-start', { argv: ['scoped-mcp-b0-server.mjs'], cwd: process.cwd() })
chmodSync(proofPath, 0o600)

const TOOLS = [
  {
    name: 'echo',
    description: 'B0 scoped echo tool: returns the caller nonce',
    inputSchema: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
    },
  },
  {
    name: 'hold',
    description: 'B0 scoped hold tool: waits for the run-owned release barrier',
    inputSchema: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
    },
  },
  {
    name: 'fail',
    description: 'B0 scoped fail tool: returns one MCP isError result',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForFile(path, label) {
  if (typeof path !== 'string' || path === '') {
    throw new Error(`b0-scoped-mcp: missing ${label} path`)
  }
  while (!existsSync(path)) await sleep(20)
}

async function callTool(id, params) {
  const rawName = params?.name
  const args = params?.arguments ?? {}
  const nonce = typeof args?.nonce === 'string' ? args.nonce : ''
  record('tools/call', { rpcId: id, rawName, nonceDigest: nonce === '' ? undefined : createHash('sha256').update(nonce).digest('hex').slice(0, 16) })
  if (rawName === 'echo') {
    if (nonce === '') throw new Error('b0-scoped-mcp: echo requires a nonce')
    result(id, { content: [{ type: 'text', text: `b0-echo:${nonce}` }] })
    return
  }
  if (rawName === 'hold') {
    record('hold-received', { rpcId: id })
    await waitForFile(process.env.B0_HOLD_ARM, 'B0_HOLD_ARM')
    record('hold-armed', { rpcId: id })
    await waitForFile(process.env.B0_HOLD_RELEASE, 'B0_HOLD_RELEASE')
    record('hold-released', { rpcId: id })
    result(id, { content: [{ type: 'text', text: `b0-hold:${nonce}` }] })
    return
  }
  if (rawName === 'fail') {
    result(id, { content: [{ type: 'text', text: 'b0-fail:isError' }], isError: true })
    return
  }
  error(id, -32602, `b0-scoped-mcp: unknown tool ${JSON.stringify(rawName)}`)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

lines.on('line', line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    record('protocol-invalid-json')
    return
  }
  if (message?.id === undefined || message?.method === undefined) return
  const { id, method, params } = message
  if (method === 'initialize') {
    record('initialize', { protocolVersion: params?.protocolVersion })
    result(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'b0-scoped-mcp', version: '1.0.0' },
    })
    return
  }
  if (method === 'tools/list') {
    record('tools/list', { count: TOOLS.length })
    result(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    void callTool(id, params).catch(caught => {
      record('tool-call-failed', { rpcId: id, message: caught instanceof Error ? caught.message : String(caught) })
      error(id, -32603, caught instanceof Error ? caught.message : String(caught))
    })
    return
  }
  if (method === 'ping') {
    result(id, {})
    return
  }
  record('unsupported-method', { method })
  error(id, -32601, `b0-scoped-mcp: method not found: ${String(method)}`)
})

process.on('SIGTERM', () => {
  record('server-sigterm')
  process.exit(0)
})

// The parent owns lifecycle; an unexpected stdin end is a real close.
lines.on('close', () => {
  record('server-stdin-closed')
  process.exit(0)
})
