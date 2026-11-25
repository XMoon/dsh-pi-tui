/**
 * Host-only Agent-scoped MCP lease contracts.
 *
 * These cases run the REAL official `@deepseek-ai/dsh-mcp-client` plugin on a
 * real `@deepseek-ai/dsh-tools` registry scoped to one test Agent, a real stdio
 * MCP child process and a real loopback Streamable HTTP endpoint. The failure
 * classes owned here are the standard ACP declaration boundary, exact
 * Agent-tool namespace collisions, reverse-order rollback of a partially
 * mounted request, the HTTP-only cwd boundary, and the official Fiber closure
 * readback that retires a lease only after Agent quiescence.
 *
 * This file is NOT a production ACP request/Close wire proof; the View,
 * Listener and packaged Split lanes own those contracts.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-scoped-mcp.test
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import {
  AcpScopedMcpError,
  MAX_ACP_MCP_SERVERS,
  mountAcpScopedMcp,
  parseAcpMcpServers,
  retireAcpScopedMcp,
  type AcpScopedMcpAgent,
  type AcpScopedMcpLease,
} from '../../src/app/remote-process/local-acp-scoped-mcp.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const SERVER_PATH = fileURLToPath(new URL('../../scripts/fixtures/scoped-mcp-b0-server.mjs', import.meta.url))

interface ScopedMcpHttpFixture {
  readonly url: string
  readonly failListUrl: string
  readonly holdStartupUrl: string
  readonly events: Array<Record<string, unknown>>
  readonly requests: Array<Record<string, unknown>>
  readonly sse: Array<{ openedAt: number; closedAt?: number }>
  waitForEvent(predicate: (event: Record<string, unknown>) => boolean, label: string, timeoutMs?: number): Promise<Record<string, unknown>>
  releaseHold(): void
  resetHold(): void
  close(): Promise<void>
}

const { startScopedMcpHttpServer } = await import(
  new URL('../../scripts/fixtures/scoped-mcp-http-server.mjs', import.meta.url).href
) as {
  startScopedMcpHttpServer(options?: {
    tag?: string
    expectedHeaders?: Record<string, string>
  }): Promise<ScopedMcpHttpFixture>
}

/** The official tool registry with the one stub service its constructor needs. */
function createToolHost(): Context {
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string, value: object): void }).provide('systemPrompt', {
    tools: () => {},
    section: () => () => {},
  })
  new ToolRuntime(ctx)
  return ctx
}

/** One test Agent whose scope owns the official MCP Fiber registrations. */
class TestAgent implements AcpScopedMcpAgent {
  readonly id: string
  readonly session: { id: string; header: { cwd: string } }
  status: 'idle' | 'running' = 'idle'
  /** Test hook running while the maintenance phase still owns the Agent. */
  onMaintenanceExit: ((toolNames: string[]) => void) | undefined
  readonly ctx: Context
  private readonly scope: ReturnType<typeof createScope>
  private maintenanceActive = false
  private readonly idleWaiters = new Set<() => void>()

  constructor(root: Context, id: string, cwd: string) {
    // The official Agent implementation uses the Agent object itself as its
    // registration scope key; the official ToolService reads definitions by
    // that same object.
    this.scope = createScope(root, this)
    this.ctx = this.scope.ctx
    this.id = id
    this.session = { id, header: { cwd } }
  }

  dispose(): Promise<void> | void {
    return this.scope.dispose()
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.status !== 'idle' || this.maintenanceActive) {
      throw new Error(`agent "${this.id}" already has active work`)
    }
    this.maintenanceActive = true
    const controller = new AbortController()
    try {
      return await task(controller.signal)
    } finally {
      this.onMaintenanceExit?.(this.ctx.tools.definitions(this).map(definition => definition.name))
      this.maintenanceActive = false
      this.flushIdle()
    }
  }

  whenIdle(): Promise<void> {
    if (this.status === 'idle' && !this.maintenanceActive) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.add(resolve) })
  }

  markRunning(): void {
    this.status = 'running'
  }

  markIdle(): void {
    this.status = 'idle'
    this.flushIdle()
  }

  private flushIdle(): void {
    if (this.status !== 'idle' || this.maintenanceActive) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const waiter of waiters) waiter()
  }
}

function serverDeclaration(options: {
  name?: string
  proof: string
  tag: string
  bootFail?: boolean
  hangStartup?: boolean
}): Record<string, unknown> {
  return {
    name: options.name ?? 'b0scope',
    command: process.execPath,
    args: [SERVER_PATH],
    env: [
      { name: 'B0_FIXTURE_PROOF', value: options.proof },
      { name: 'B0_SERVER_TAG', value: options.tag },
      ...(options.bootFail === true ? [{ name: 'B0_BOOT_FAIL', value: '1' }] : []),
      ...(options.hangStartup === true ? [{ name: 'B0_HANG_STARTUP', value: '1' }] : []),
    ],
  }
}

function readProof(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

function toolsOf(agent: TestAgent): string[] {
  return agent.ctx.tools.definitions(agent).map(definition => definition.name)
}

async function waitForProofLine(
  proof: string,
  predicate: (line: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = readProof(proof).find(predicate)
    if (line !== undefined) return line
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function namesOfProof(proof: string, kind: string): number[] {
  return readProof(proof)
    .filter(line => line.kind === kind && typeof line.pid === 'number')
    .map(line => line.pid as number)
}

function requirePid(value: number | undefined): number {
  assert.equal(typeof value, 'number')
  return value as number
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForGone(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return !alive(pid)
}

function setup(t: Parameters<typeof testLifecycle>[0], options: { readonly cwd?: string } = {}): {
  readonly root: Context
  readonly agent: TestAgent
  readonly temp: ReturnType<typeof testLifecycle>
} {
  const temp = testLifecycle(t)
  const root = createToolHost()
  const cwd = options.cwd ?? temp.tempDir('local-acp-mcp-cwd-')
  const agent = new TestAgent(root, 'agent-a', cwd)
  temp.defer(() => agent.dispose())
  return { root, agent, temp }
}

test('the standard ACP stdio declaration parser normalizes names and keeps environment entries as data', () => {
  const parsed = parseAcpMcpServers([{
    name: 'my server!',
    command: process.execPath,
    args: [],
    env: [
      { name: '__proto__', value: 'data' },
      { name: 'PLAIN', value: 'value' },
    ],
  }])
  assert.equal(parsed.length, 1)
  const declaration = parsed[0]
  assert.equal(declaration.transport, 'stdio')
  if (declaration.transport !== 'stdio') throw new Error('expected one stdio declaration')
  assert.match(declaration.serverName, /^my_server_[0-9a-f]{8}$/u)
  assert.equal(declaration.command, process.execPath)
  const env = declaration.env as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(env), null)
  assert.equal(Object.hasOwn(env, '__proto__'), true)
  assert.equal(env.PLAIN, 'value')
})

test('the declaration parser rejects capacity, transport, command, argument, environment and duplicate-name faults without echoing values', () => {
  const cases: Array<[string, unknown[]]> = [
    ['capacity', Array.from({ length: MAX_ACP_MCP_SERVERS + 1 }, (_, index) => ({
      name: `s${String(index)}`, command: '/bin/true', args: [], env: [],
    }))],
    ['sse transport', [{ name: 's', type: 'sse', url: 'https://example.test', headers: [] }]],
    ['explicit stdio transport', [{ name: 's', type: 'stdio', command: '/bin/true', args: [], env: [] }]],
    ['non-http url', [{ name: 's', type: 'http', url: 'ftp://example.test/mcp', headers: [] }]],
    ['relative url', [{ name: 's', type: 'http', url: '/mcp', headers: [] }]],
    ['invalid url', [{ name: 's', type: 'http', url: 'http://', headers: [] }]],
    ['missing url', [{ name: 's', type: 'http', headers: [] }]],
    ['missing headers', [{ name: 's', type: 'http', url: 'https://example.test/mcp' }]],
    ['header entry shape', [{ name: 's', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'A' }] }]],
    ['header name', [{ name: 's', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'Bad Header', value: 'x' }] }]],
    ['header value', [{ name: 's', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'X-Test', value: 'x\r\ny' }] }]],
    ['duplicate header name', [{ name: 's', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'X-Test', value: '1' }, { name: 'x-test', value: '2' }] }]],
    ['mixed duplicate normalized name', [
      { name: 'same', command: '/bin/true', args: [], env: [] },
      { name: 'same', type: 'http', url: 'https://example.test/mcp', headers: [] },
    ]],
    ['acp transport', [{ name: 's', type: 'acp', serverId: 'x' }]],
    ['relative command', [{ name: 's', command: 'bin/true', args: [], env: [] }]],
    ['command NUL', [{ name: 's', command: '/bin/tr\u0000ue', args: [], env: [] }]],
    ['args shape', [{ name: 's', command: '/bin/true', args: [1], env: [] }]],
    ['env shape', [{ name: 's', command: '/bin/true', args: [], env: [{ name: 'A=B', value: 'x' }] }]],
    ['env NUL', [{ name: 's', command: '/bin/true', args: [], env: [{ name: 'A', value: 'x\u0000y' }] }]],
    ['duplicate env', [{ name: 's', command: '/bin/true', args: [], env: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }] }]],
    ['duplicate normalized name', [
      { name: 'same', command: '/bin/true', args: [], env: [] },
      { name: 'same', command: '/bin/true', args: [], env: [] },
    ]],
  ]
  for (const [label, servers] of cases) {
    assert.throws(
      () => parseAcpMcpServers(servers),
      (error: unknown) => error instanceof AcpScopedMcpError && error.code === 'INVALID_DECLARATION',
      label,
    )
  }
  const secret = 'B1_SECRET_VALUE_MUST_NOT_APPEAR'
  for (const servers of [
    [{ name: 's', command: 'relative', args: [secret], env: [{ name: 'A', value: secret }] }],
    [{
      name: 's',
      type: 'http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Bad Header', value: secret }],
    }],
  ]) {
    assert.throws(
      () => parseAcpMcpServers(servers),
      (error: unknown) => {
        assert.ok(error instanceof AcpScopedMcpError)
        assert.equal(error.code, 'INVALID_DECLARATION')
        assert.equal(error.message.includes(secret), false)
        return true
      },
    )
  }
})

test('the standard ACP HTTP declaration parser preserves URL and headers as data and keeps mixed request order', () => {
  const parsed = parseAcpMcpServers([
    { name: 'stdio one', command: process.execPath, args: [], env: [] },
    {
      name: 'http one',
      type: 'http',
      url: 'http://127.0.0.1:8765/mcp?tenant=a',
      headers: [
        { name: 'Authorization', value: 'Bearer sentinel' },
        { name: 'X-API-Key', value: 'key sentinel' },
        { name: '__proto__', value: 'data' },
      ],
    },
    { name: 'https one', type: 'http', url: 'https://example.test/mcp', headers: [] },
  ])
  assert.deepEqual(parsed.map(entry => entry.transport), ['stdio', 'streamable-http', 'streamable-http'])
  const http = parsed[1]
  assert.equal(http.transport, 'streamable-http')
  if (http.transport !== 'streamable-http') throw new Error('expected one HTTP declaration')
  assert.match(http.serverName, /^http_one_[0-9a-f]{8}$/u)
  assert.equal(http.url, 'http://127.0.0.1:8765/mcp?tenant=a')
  const headers = http.headers as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(headers), null)
  assert.equal(headers.Authorization, 'Bearer sentinel')
  assert.equal(headers['X-API-Key'], 'key sentinel')
  assert.equal(Object.hasOwn(headers, '__proto__'), true)
  assert.equal(headers.__proto__, 'data')
})

test('an HTTP-only scoped MCP server mounts without a filesystem Session cwd and retires with confirmed Fiber closure', async t => {
  const missingCwd = join(testLifecycle(t).tempDir('local-acp-http-missing-'), 'does-not-exist')
  const { agent, temp } = setup(t, { cwd: missingCwd })
  temp.defer(() => agent.markIdle())
  const server = await startScopedMcpHttpServer({
    tag: 'ownerhttp',
    expectedHeaders: { Authorization: 'Bearer owner-sentinel', 'X-API-Key': 'owner-key' },
  })
  temp.defer(() => server.close())
  const lease = await mountAcpScopedMcp({
    agent,
    session: agent.session,
    servers: [{
      name: 'httpscope',
      type: 'http',
      url: server.url,
      headers: [
        { name: 'Authorization', value: 'Bearer owner-sentinel' },
        { name: 'X-API-Key', value: 'owner-key' },
      ],
    }],
    tools: agent.ctx.tools,
    stillCurrent: () => 'current',
  })
  temp.defer(() => retireAcpScopedMcp(lease))
  assert.deepEqual(toolsOf(agent).filter(name => name.startsWith('mcp__httpscope__')).sort(), [
    'mcp__httpscope__echo',
    'mcp__httpscope__fail',
    'mcp__httpscope__hold',
  ])
  const status = McpClient.connectionStatusOf(lease.fibers[0])?.current()
  assert.equal(status?.state, 'connected')
  assert.equal(status?.toolCount, 3)
  const request = await server.waitForEvent(event => event.kind === 'request' && event.rpcMethod === 'tools/list', 'HTTP tools/list')
  assert.deepEqual((request.headerMatches as Record<string, boolean>), { Authorization: true, 'X-API-Key': true })
  await server.waitForEvent(event => event.kind === 'sse-open', 'HTTP GET stream open')
  await retireAcpScopedMcp(lease)
  assert.equal(toolsOf(agent).some(name => name.startsWith('mcp__httpscope__')), false)
  const closure = McpClient.connectionStatusOf(lease.fibers[0])?.closure()
  assert.equal(closure?.closeConfirmed, true)
  assert.equal(closure?.cleanupError, undefined)
  await server.waitForEvent(event => event.kind === 'sse-close', 'HTTP GET stream close')
})

test('a mixed stdio+HTTP request with a missing stdio cwd fails before the HTTP endpoint receives any request', async t => {
  const missingCwd = join(testLifecycle(t).tempDir('local-acp-mixed-missing-'), 'does-not-exist')
  const { agent, temp } = setup(t, { cwd: missingCwd })
  const server = await startScopedMcpHttpServer({ tag: 'mixedcwd' })
  temp.defer(() => server.close())
  await assert.rejects(
    mountAcpScopedMcp({
      agent,
      session: agent.session,
      servers: [
        { name: 'stdio-one', command: process.execPath, args: [SERVER_PATH], env: [] },
        { name: 'http-one', type: 'http', url: server.url, headers: [] },
      ],
      tools: agent.ctx.tools,
      stillCurrent: () => 'current',
    }),
    (error: unknown) => error instanceof AcpScopedMcpError && error.code === 'START_FAILED',
  )
  assert.equal(server.requests.length, 0)
  assert.equal(toolsOf(agent).some(name => name.startsWith('mcp__')), false)
})

test('a malformed HTTP header declaration is refused before any loopback request', async t => {
  const { agent, temp } = setup(t)
  const server = await startScopedMcpHttpServer({ tag: 'badheader' })
  temp.defer(() => server.close())
  await assert.rejects(
    mountAcpScopedMcp({
      agent,
      session: agent.session,
      servers: [{
        name: 'badheader',
        type: 'http',
        url: server.url,
        headers: [{ name: 'Bad Header', value: 'not-sent' }],
      }],
      tools: agent.ctx.tools,
      stillCurrent: () => 'current',
    }),
    (error: unknown) => error instanceof AcpScopedMcpError && error.code === 'INVALID_DECLARATION',
  )
  assert.equal(server.requests.length, 0)
  assert.equal(toolsOf(agent).some(name => name.startsWith('mcp__')), false)
})

test('a real stdio MCP server mounts on the exact Agent and retires only after quiescence with confirmed Fiber closure', async t => {
  const { agent, temp } = setup(t)
  temp.defer(() => agent.markIdle())
  const proof = `${temp.tempDir('local-acp-mcp-proof-')}/proof.jsonl`
  const lease = await mountAcpScopedMcp({
    agent,
    session: agent.session,
    servers: [serverDeclaration({ proof, tag: 'b0scope' })],
    tools: agent.ctx.tools,
    stillCurrent: () => 'current',
  })
  temp.defer(() => retireAcpScopedMcp(lease))
  assert.deepEqual(toolsOf(agent).filter(name => name.startsWith('mcp__b0scope__')).sort(), [
    'mcp__b0scope__echo',
    'mcp__b0scope__fail',
    'mcp__b0scope__hold',
  ])
  const child = requirePid(namesOfProof(proof, 'server-start').at(-1))
  assert.equal(alive(child), true)

  agent.markRunning()
  const retiring = retireAcpScopedMcp(lease)
  const joining = retireAcpScopedMcp(lease)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(toolsOf(agent).includes('mcp__b0scope__echo'), true)
  assert.equal(alive(child), true)

  agent.markIdle()
  await Promise.all([retiring, joining])
  assert.equal(toolsOf(agent).some(name => name.startsWith('mcp__b0scope__')), false)
  assert.equal(await waitForGone(child), true)
  for (const fiber of lease.fibers) {
    const closure = McpClient.connectionStatusOf(fiber)?.closure()
    assert.equal(closure?.closeConfirmed, true)
    assert.equal(closure?.cleanupError, undefined)
  }
})

test('an existing global tool name makes the mount fail closed and leaves the pre-existing tool visible', async t => {
  const { root, agent, temp } = setup(t)
  const proof = `${temp.tempDir('local-acp-mcp-global-')}/proof.jsonl`
  root.tools.register(defineTool({
    name: 'mcp__b0scope__echo',
    description: 'pre-existing global tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'GLOBAL' }] },
    async execute() { return 'GLOBAL' },
  }))
  let toolsAtMaintenanceExit: string[] = []
  agent.onMaintenanceExit = names => { toolsAtMaintenanceExit = names }
  const before = toolsOf(agent)
  await assert.rejects(
    mountAcpScopedMcp({
      agent,
      session: agent.session,
      servers: [serverDeclaration({ proof, tag: 'b0scope' })],
      tools: agent.ctx.tools,
      stillCurrent: () => 'current',
    }),
    (error: unknown) => error instanceof AcpScopedMcpError && error.code === 'NAME_CONFLICT',
  )
  assert.deepEqual(toolsOf(agent), before)
  assert.deepEqual([...toolsAtMaintenanceExit].sort(), [...before].sort(),
    'a collision rollback must be complete before the maintenance phase releases the Agent')
  // The child really started before the collision was proven; rollback must
  // still terminate it.
  const child = requirePid(namesOfProof(proof, 'server-start').at(-1))
  assert.equal(await waitForGone(child), true)
})

test('a partially mounted request disposes every earlier server in reverse order and reports START_FAILED', async t => {
  const { agent, temp } = setup(t)
  const proof = `${temp.tempDir('local-acp-mcp-partial-')}/proof.jsonl`
  let toolsAtMaintenanceExit: string[] = []
  agent.onMaintenanceExit = names => { toolsAtMaintenanceExit = names }
  await assert.rejects(
    mountAcpScopedMcp({
      agent,
      session: agent.session,
      servers: [
        serverDeclaration({ proof, tag: 'b0scope' }),
        serverDeclaration({ proof, tag: 'b0fail', name: 'b0fail', bootFail: true }),
      ],
      tools: agent.ctx.tools,
      stillCurrent: () => 'current',
    }),
    (error: unknown) => error instanceof AcpScopedMcpError && error.code === 'START_FAILED',
  )
  assert.equal(toolsOf(agent).some(name => name.startsWith('mcp__')), false)
  assert.equal(toolsAtMaintenanceExit.some(name => name.startsWith('mcp__')), false,
    'every rejected server tool must be disposed before the maintenance phase can release the Agent')
  const firstChild = requirePid(namesOfProof(proof, 'server-start').at(-1))
  assert.equal(await waitForGone(firstChild), true)
  const bootFail = requirePid(namesOfProof(proof, 'server-boot-fail').at(-1))
  assert.equal(await waitForGone(bootFail), true)
})

test('a stale View admission spawns no MCP child and leaves no tool', async t => {
  const { agent, temp } = setup(t)
  const proof = `${temp.tempDir('local-acp-mcp-stale-')}/proof.jsonl`
  await assert.rejects(
    mountAcpScopedMcp({
      agent,
      session: agent.session,
      servers: [serverDeclaration({ proof, tag: 'b0scope' })],
      tools: agent.ctx.tools,
      stillCurrent: () => 'stale',
    }),
    (error: unknown) => error instanceof AcpScopedMcpError && error.code === 'STALE',
  )
  assert.equal(existsSync(proof), false)
  assert.equal(toolsOf(agent).some(name => name.startsWith('mcp__')), false)
})

test('an aborted pending MCP startup disposes the Fiber before maintenance releases the Agent', async t => {
  const { agent, temp } = setup(t)
  const proof = `${temp.tempDir('local-acp-mcp-abort-')}/proof.jsonl`
  const controller = new AbortController()
  const mounting = mountAcpScopedMcp({
    agent,
    session: agent.session,
    servers: [serverDeclaration({ proof, tag: 'b0hang', hangStartup: true })],
    tools: agent.ctx.tools,
    stillCurrent: () => controller.signal.aborted ? 'stale' : 'current',
    signal: controller.signal,
  })
  await waitForProofLine(proof, line => line.kind === 'startup-hang', 'aborted pending startup')
  controller.abort()
  await assert.rejects(mounting, (error: unknown) => error instanceof AcpScopedMcpError && error.code === 'STALE')
  assert.equal(toolsOf(agent).some(name => name.startsWith('mcp__')), false)
  const child = requirePid(namesOfProof(proof, 'server-start').at(-1))
  assert.equal(await waitForGone(child), true)
  assert.equal(agent.status, 'idle', 'the maintenance phase must be released after abort')

  // The same Agent must accept a normal server after the aborted attempt.
  const retryProof = `${temp.tempDir('local-acp-mcp-abort-retry-')}/proof.jsonl`
  const lease = await mountAcpScopedMcp({
    agent,
    session: agent.session,
    servers: [serverDeclaration({ proof: retryProof, tag: 'b0scope' })],
    tools: agent.ctx.tools,
    stillCurrent: () => 'current',
  })
  await retireAcpScopedMcp(lease)
})
