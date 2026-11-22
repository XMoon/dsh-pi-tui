/**
 * Host-only Agent-scoped MCP lease contracts.
 *
 * These cases run the REAL official `@deepseek-ai/dsh-mcp-client` plugin on a
 * real `@deepseek-ai/dsh-tools` registry scoped to one test Agent and a real
 * stdio MCP child process. The failure classes owned here are the standard ACP
 * stdio declaration boundary, exact Agent-tool namespace collisions,
 * reverse-order rollback of a partially mounted request, and the official
 * Fiber closure readback that retires a lease only after Agent quiescence.
 *
 * This file is NOT a production ACP request/Close wire proof; the View,
 * Listener and packaged Split lanes own those contracts.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-scoped-mcp.test
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
}): Record<string, unknown> {
  return {
    name: options.name ?? 'b0scope',
    command: process.execPath,
    args: [SERVER_PATH],
    env: [
      { name: 'B0_FIXTURE_PROOF', value: options.proof },
      { name: 'B0_SERVER_TAG', value: options.tag },
      ...(options.bootFail === true ? [{ name: 'B0_BOOT_FAIL', value: '1' }] : []),
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

function setup(t: Parameters<typeof testLifecycle>[0]): {
  readonly root: Context
  readonly agent: TestAgent
  readonly temp: ReturnType<typeof testLifecycle>
} {
  const temp = testLifecycle(t)
  const root = createToolHost()
  const cwd = temp.tempDir('local-acp-mcp-cwd-')
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
  assert.match(parsed[0].serverName, /^my_server_[0-9a-f]{8}$/u)
  assert.equal(parsed[0].command, process.execPath)
  const env = parsed[0].env as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(env), null)
  assert.equal(Object.hasOwn(env, '__proto__'), true)
  assert.equal(env.PLAIN, 'value')
})

test('the declaration parser rejects capacity, transport, command, argument, environment and duplicate-name faults without echoing values', () => {
  const cases: Array<[string, unknown[]]> = [
    ['capacity', Array.from({ length: MAX_ACP_MCP_SERVERS + 1 }, (_, index) => ({
      name: `s${String(index)}`, command: '/bin/true', args: [], env: [],
    }))],
    ['http transport', [{ name: 's', type: 'http', url: 'https://example.test', headers: [] }]],
    ['sse transport', [{ name: 's', type: 'sse', url: 'https://example.test', headers: [] }]],
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
  try {
    parseAcpMcpServers([{ name: 's', command: 'relative', args: [secret], env: [{ name: 'A', value: secret }] }])
  } catch (error) {
    assert.ok(error instanceof AcpScopedMcpError)
    assert.equal(error.message.includes(secret), false)
  }
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
  // The child really started before the collision was proven; rollback must
  // still terminate it.
  const child = requirePid(namesOfProof(proof, 'server-start').at(-1))
  assert.equal(await waitForGone(child), true)
})

test('a partially mounted request disposes every earlier server in reverse order and reports START_FAILED', async t => {
  const { agent, temp } = setup(t)
  const proof = `${temp.tempDir('local-acp-mcp-partial-')}/proof.jsonl`
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
