/**
 * Host-only Agent-scoped MCP lease for the local ACP Session View.
 *
 * One ACP `session/new|resume` MCP declaration list becomes ONE lease owned by
 * the exact View claim that admitted it. The lease mounts the official
 * `@deepseek-ai/dsh-mcp-client` plugin on the exact live Agent context during
 * its true idle maintenance phase, records only the official Fiber handles, and
 * retires those same Fiber handles through one singleflight async terminal.
 *
 * This module owns no registry, no Session store and no second Agent lifecycle:
 * the ACP View claim remains the sole reservation/retention authority. It never
 * imports the upstream private ACP adapter; it reproduces only the already
 * verified standard ACP stdio mapping within this repository boundary.
 *
 * @module app/remote-process/local-acp-scoped-mcp
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type * as McpClientModule from '@deepseek-ai/dsh-mcp-client'

/** The stable internal failure codes of the Host-only scoped MCP kernel. */
export type AcpScopedMcpErrorCode =
  | 'INVALID_DECLARATION'
  | 'AGENT_BUSY'
  | 'NAME_CONFLICT'
  | 'START_FAILED'
  | 'CLEANUP_UNCONFIRMED'
  | 'STALE'

/**
 * One classified scoped-MCP rejection. Messages are fixed and never contain a
 * command, argument, environment value, header, private path or spawn error.
 * `lease` is present only when at least one created Fiber's cleanup could not
 * be confirmed; the caller must keep that lease fenced until it is retired.
 */
export class AcpScopedMcpError extends Error {
  readonly code: AcpScopedMcpErrorCode
  readonly lease?: AcpScopedMcpLease

  constructor(code: AcpScopedMcpErrorCode, message: string, lease?: AcpScopedMcpLease) {
    super(message)
    this.name = 'AcpScopedMcpError'
    this.code = code
    if (lease !== undefined) this.lease = lease
  }
}

/** One validated standard ACP stdio server declaration. */
export interface AcpScopedMcpDeclaration {
  /** The official normalized DSH server namespace. */
  readonly serverName: string
  /** Absolute executable path. */
  readonly command: string
  readonly args: readonly string[]
  /** Null-prototype environment map built from the ordered ACP entries. */
  readonly env: Readonly<Record<string, string>>
}

/** The exact live Agent surface the Host-only kernel may touch. */
export interface AcpScopedMcpAgent {
  readonly id: string
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
  }
  readonly status: 'idle' | 'running'
  readonly ctx: Context
  /** Claim the true idle phase; throws synchronously when it is not available. */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Resolve when the whole Agent reaches quiescence. */
  whenIdle(): Promise<void>
}

/** One official visible tool definition field this boundary reads. */
export interface AcpScopedMcpToolDefinition {
  readonly name: string
}

/**
 * The official ToolService readback boundary. `definitions(agent)` is the
 * exact Agent view (global + Agent-local shadowing); the argument-less call is
 * the global view, so a restricted-away global name still counts as a
 * conflict.
 */
export interface AcpScopedMcpToolAuthority {
  definitions(scope: object): readonly AcpScopedMcpToolDefinition[]
  definitions(): readonly AcpScopedMcpToolDefinition[]
}

/** Whether the owning View still owns this exact admission. */
export type AcpScopedMcpCurrentness = 'current' | 'stale'

/**
 * ONE Agent-scoped MCP lease. It records only the exact live objects it was
 * admitted against and the official Fiber handles it created; every
 * observable outcome is read back from the official McpClient status/closure
 * and ToolService. `retirePromise` is the singleflight terminal.
 */
export interface AcpScopedMcpLease {
  readonly agent: AcpScopedMcpAgent
  readonly session: object
  readonly serverNames: readonly string[]
  readonly fibers: readonly Fiber[]
  retirePromise?: Promise<void>
}

/** The names this lease caused to become visible; used only for retirement readback. */
const leaseToolNames = new WeakMap<AcpScopedMcpLease, ReadonlySet<string>>()
/** The exact tool authority that admitted the lease; used only for readback. */
const leaseToolAuthority = new WeakMap<AcpScopedMcpLease, AcpScopedMcpToolAuthority>()

/** The standard server-name shape shared with the official ACP adapter. */
const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u

/** The explicit per-Session capacity policy of this phase. */
export const MAX_ACP_MCP_SERVERS = 4

/**
 * The fixed official MCP resource-tool names. A first server in one Agent
 * scope also activates these three shared read-only tools through the
 * official `mcp-resources` service; they belong to the same mount lifecycle
 * and are not part of any server's advertised `toolCount`.
 */
const MCP_RESOURCE_TOOL_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
])

/** Reproduce the official ACP server-name normalization exactly. */
function normalizeServerName(name: string): string {
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw invalidDeclaration('an MCP server name is empty or contains control characters')
  }
  if (VALID_SERVER_NAME.test(name)) return name
  const slug = name.normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

/** One fixed declaration failure with no caller bytes echoed. */
function invalidDeclaration(message: string): AcpScopedMcpError {
  return new AcpScopedMcpError('INVALID_DECLARATION', message)
}

function startFailed(): AcpScopedMcpError {
  return new AcpScopedMcpError('START_FAILED', 'the MCP server could not be started')
}

function staleLease(): AcpScopedMcpError {
  return new AcpScopedMcpError('STALE', 'the ACP scoped MCP admission is no longer current')
}

function cleanupUnconfirmed(lease: AcpScopedMcpLease): AcpScopedMcpError {
  return new AcpScopedMcpError('CLEANUP_UNCONFIRMED', 'the MCP server cleanup could not be confirmed', lease)
}

/**
 * Validate and normalize the complete standard ACP stdio declaration list.
 *
 * Pure and synchronous: capacity, transport, shape, executable absolute path,
 * arguments/environment and duplicate normalized names are all decided before
 * any Host Workspace, Session, Agent or child process is touched. HTTP, SSE and
 * the experimental ACP transport are rejected in this phase.
 *
 * @param servers - the raw SDK `mcpServers` list.
 * @returns the validated declarations in request order.
 */
export function parseAcpMcpServers(servers: readonly unknown[]): readonly AcpScopedMcpDeclaration[] {
  if (!Array.isArray(servers)) throw invalidDeclaration('mcpServers must be an array')
  if (servers.length > MAX_ACP_MCP_SERVERS) {
    throw invalidDeclaration(`at most ${String(MAX_ACP_MCP_SERVERS)} MCP servers are accepted per session`)
  }
  const names = new Set<string>()
  const declarations: AcpScopedMcpDeclaration[] = []
  for (const raw of servers) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidDeclaration('an MCP server declaration must be an object')
    }
    const server = raw as Record<string, unknown>
    // Standard ACP stdio has no `type` discriminator. Any explicit transport
    // discriminator selects a transport this phase does not implement.
    if ('type' in server) {
      throw invalidDeclaration('only the standard ACP stdio MCP transport is supported')
    }
    if (typeof server.name !== 'string') throw invalidDeclaration('an MCP server name must be a string')
    const serverName = normalizeServerName(server.name)
    if (names.has(serverName)) {
      throw invalidDeclaration(`duplicate normalized MCP server name: ${serverName}`)
    }
    names.add(serverName)
    if (typeof server.command !== 'string' || server.command.length === 0
      || !isAbsolute(server.command) || server.command.includes('\u0000')) {
      throw invalidDeclaration(`mcpServers server "${serverName}" requires an absolute command without NUL`)
    }
    if (!Array.isArray(server.args)) {
      throw invalidDeclaration(`mcpServers server "${serverName}" requires a string args array`)
    }
    const args: string[] = []
    for (const arg of server.args) {
      if (typeof arg !== 'string' || arg.includes('\u0000')) {
        throw invalidDeclaration(`mcpServers server "${serverName}" contains an invalid argument`)
      }
      args.push(arg)
    }
    if (!Array.isArray(server.env)) {
      throw invalidDeclaration(`mcpServers server "${serverName}" requires a standard env array`)
    }
    const env = Object.create(null) as Record<string, string>
    const envNames = new Set<string>()
    for (const entry of server.env) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw invalidDeclaration(`mcpServers server "${serverName}" contains an invalid environment entry`)
      }
      const variable = entry as Record<string, unknown>
      if (typeof variable.name !== 'string' || typeof variable.value !== 'string'
        || variable.name.length === 0 || variable.name.includes('=')
        || variable.name.includes('\u0000') || variable.value.includes('\u0000')) {
        throw invalidDeclaration(`mcpServers server "${serverName}" contains an invalid environment entry`)
      }
      if (envNames.has(variable.name)) {
        throw invalidDeclaration(`mcpServers server "${serverName}" contains a duplicate environment name`)
      }
      envNames.add(variable.name)
      env[variable.name] = variable.value
    }
    declarations.push({ serverName, command: server.command, args, env })
  }
  return declarations
}

/** One definition map snapshot of the official Agent view. */
function definitionsOf(tools: AcpScopedMcpToolAuthority, scope?: object): Map<string, AcpScopedMcpToolDefinition> {
  const definitions = scope === undefined ? tools.definitions() : tools.definitions(scope)
  const snapshot = new Map<string, AcpScopedMcpToolDefinition>()
  for (const definition of definitions) {
    if (typeof definition?.name !== 'string') continue
    snapshot.set(definition.name, definition)
  }
  return snapshot
}

/** Read the official names of one lease's exact Fiber set. */
function toolNamesOf(lease: AcpScopedMcpLease): ReadonlySet<string> {
  return leaseToolNames.get(lease) ?? new Set<string>()
}

/** Check every exact Fiber's official cleanup result. */
function unconfirmedFibers(mcp: typeof McpClientModule, lease: AcpScopedMcpLease): Fiber[] {
  const unconfirmed: Fiber[] = []
  for (const fiber of lease.fibers) {
    const closure = mcp.connectionStatusOf(fiber)?.closure()
    if (closure === undefined || !closure.closeConfirmed || closure.cleanupError !== undefined) {
      unconfirmed.push(fiber)
    }
  }
  return unconfirmed
}

/** Dispose one created Fiber set in reverse mount order and classify the result. */
async function rollbackFibers(
  mcp: typeof McpClientModule,
  lease: AcpScopedMcpLease,
  original: unknown,
): Promise<never> {
  const disposals: Promise<void>[] = []
  for (const fiber of [...lease.fibers].reverse()) {
    disposals.push(Promise.resolve().then(async () => { await fiber.dispose() }).catch(() => {}))
  }
  await Promise.all(disposals)
  if (unconfirmedFibers(mcp, lease).length > 0) throw cleanupUnconfirmed(lease)
  if (original instanceof AcpScopedMcpError) throw original
  throw startFailed()
}

/** Build one lease and retain its non-authoritative readback witnesses. */
function createLease(
  agent: AcpScopedMcpAgent,
  session: object,
  serverNames: readonly string[],
  fibers: readonly Fiber[],
  toolNames: readonly string[],
  tools: AcpScopedMcpToolAuthority,
): AcpScopedMcpLease {
  const lease: AcpScopedMcpLease = { agent, session, serverNames, fibers }
  leaseToolNames.set(lease, new Set(toolNames))
  leaseToolAuthority.set(lease, tools)
  return lease
}

/**
 * Mount one complete ACP MCP declaration list on the exact live Agent.
 *
 * The mount runs inside ONE `runMaintenance` window. Each server is created and
 * awaited in request order; after every activation the official Agent tool
 * view is diffed against the pre-request snapshot and the current server's
 * advertised count. Any pre-existing global/Agent name (including a
 * restricted-away global), any name from an earlier server in this request, or
 * any unprovable concurrent change fails the whole admission and rolls every
 * created Fiber back in reverse order.
 *
 * @param input - exact Agent/Session, raw declarations, tool readback and
 *   still-current fence.
 * @returns the committed lease.
 */
export async function mountAcpScopedMcp(input: {
  readonly agent: AcpScopedMcpAgent
  readonly session: object
  readonly servers: readonly unknown[]
  readonly tools: AcpScopedMcpToolAuthority
  readonly stillCurrent: () => AcpScopedMcpCurrentness
}): Promise<AcpScopedMcpLease> {
  const { agent, session, tools, stillCurrent } = input
  const declarations = parseAcpMcpServers(input.servers)
  if (declarations.length === 0) throw invalidDeclaration('at least one MCP server is required')
  if (input.session !== agent.session) throw staleLease()
  const rawCwd = agent.session.header.cwd
  if (typeof rawCwd !== 'string' || rawCwd.length === 0 || !isAbsolute(rawCwd) || rawCwd.includes('\u0000')) {
    throw startFailed()
  }
  let cwd: string
  try {
    cwd = realpathSync(rawCwd)
  } catch {
    throw startFailed()
  }
  if (agent.status !== 'idle') throw new AcpScopedMcpError('AGENT_BUSY', 'the session agent is busy')

  const mcp = await import('@deepseek-ai/dsh-mcp-client')
  const serverNames = declarations.map(declaration => declaration.serverName)
  const mounted: Fiber[] = []
  const observedToolNames: string[] = []
  let jobEntered = false
  try {
    return await agent.runMaintenance(async signal => {
      jobEntered = true
      if (signal.aborted) throw staleLease()
      if (stillCurrent() !== 'current') throw staleLease()
      const beforeAgent = definitionsOf(tools, agent)
      const beforeGlobalNames = new Set(definitionsOf(tools).keys())
      const previousNames = new Set(beforeAgent.keys())
      for (const declaration of declarations) {
        if (signal.aborted) throw staleLease()
        if (stillCurrent() !== 'current') throw staleLease()
        let fiber: Fiber
        try {
          const config = mcp.Config({
            transport: 'stdio',
            serverName: declaration.serverName,
            command: declaration.command,
            args: [...declaration.args],
            env: declaration.env as Record<string, string>,
            cwd,
            failOnStartupError: true,
            expandTemplates: false,
            reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 500, maxAttempts: 1 },
          })
          fiber = agent.ctx.plugin(mcp, config)
        } catch {
          throw startFailed()
        }
        mounted.push(fiber)
        try {
          await fiber.await()
        } catch {
          throw startFailed()
        }
        const status = mcp.connectionStatusOf(fiber)?.current()
        if (status?.state !== 'connected') throw startFailed()
        if (signal.aborted || stillCurrent() !== 'current') throw staleLease()
        const after = definitionsOf(tools, agent)
        const changed: string[] = []
        for (const [name, definition] of after) {
          if (previousNames.has(name) && beforeAgent.get(name) === definition) continue
          changed.push(name)
        }
        const removed = [...previousNames].filter(name => !after.has(name))
        const newResourceTools = changed.filter(name => MCP_RESOURCE_TOOL_NAMES.has(name))
        if (removed.length > 0 || changed.length !== status.toolCount + newResourceTools.length) {
          // The official ToolService exposes visible definitions but no
          // per-registration owner; an exact count/name diff plus the fixed
          // official MCP resource-tool set is the only real-metadata proof
          // available in this release. Any unprovable concurrent change fails
          // closed instead of guessing ownership.
          throw startFailed()
        }
        for (const name of changed) {
          if (beforeGlobalNames.has(name) || beforeAgent.has(name) || observedToolNames.includes(name)) {
            throw new AcpScopedMcpError('NAME_CONFLICT', 'an MCP tool name collides with an existing visible tool')
          }
        }
        observedToolNames.push(...changed)
        for (const name of changed) previousNames.add(name)
        for (const [name, definition] of after) beforeAgent.set(name, definition)
      }
      if (signal.aborted || stillCurrent() !== 'current') throw staleLease()
      return createLease(agent, session, serverNames, [...mounted], [...observedToolNames], tools)
    })
  } catch (error) {
    if (!jobEntered) {
      if (error instanceof AcpScopedMcpError) throw error
      throw new AcpScopedMcpError('AGENT_BUSY', 'the session agent is busy')
    }
    if (mounted.length === 0) {
      if (error instanceof AcpScopedMcpError) throw error
      throw startFailed()
    }
    const lease = createLease(agent, session, serverNames, mounted, observedToolNames, tools)
    return await rollbackFibers(mcp, lease, error)
  }
}

/**
 * Retire one lease exactly once.
 *
 * The singleflight waits for whole-Agent quiescence, regains the true idle
 * maintenance phase exactly once per attempt, disposes every exact Fiber in
 * reverse order and reads the official closure for each. A busy Agent is not a
 * terminal fact: the task waits on `whenIdle()` and retries. A real cleanup
 * failure keeps the lease and its fence instead of pretending retirement.
 *
 * @param lease - the exact lease returned by {@link mountAcpScopedMcp}.
 */
export async function retireAcpScopedMcp(lease: AcpScopedMcpLease): Promise<void> {
  lease.retirePromise ??= (async () => {
    const mcp = await import('@deepseek-ai/dsh-mcp-client')
    const tools = leaseToolAuthority.get(lease)
    const expectedNames = toolNamesOf(lease)
    // A disposed Agent cannot run maintenance again; its scoped Fibers were
    // released by the Agent context itself, so only the official closure and
    // tool absence remain to be checked.
    if (lease.agent.ctx.fiber.uid === null) {
      if (unconfirmedFibers(mcp, lease).length > 0) throw cleanupUnconfirmed(lease)
      verifyToolAbsence(lease, tools, expectedNames)
      return
    }
    for (;;) {
      let entered = false
      try {
        await lease.agent.runMaintenance(async signal => {
          entered = true
          if (signal.aborted) throw staleLease()
          for (const fiber of [...lease.fibers].reverse()) await fiber.dispose()
        })
      } catch (error) {
        if (!entered) {
          if (lease.agent.ctx.fiber.uid === null) break
          await lease.agent.whenIdle()
          continue
        }
        if (unconfirmedFibers(mcp, lease).length > 0) throw cleanupUnconfirmed(lease)
        if (error instanceof AcpScopedMcpError) throw error
      }
      if (unconfirmedFibers(mcp, lease).length > 0) throw cleanupUnconfirmed(lease)
      verifyToolAbsence(lease, tools, expectedNames)
      return
    }
    if (unconfirmedFibers(mcp, lease).length > 0) throw cleanupUnconfirmed(lease)
    verifyToolAbsence(lease, tools, expectedNames)
  })()
  return await lease.retirePromise
}

/** Confirm every tool name the lease published is absent from the exact Agent view. */
function verifyToolAbsence(
  lease: AcpScopedMcpLease,
  tools: AcpScopedMcpToolAuthority | undefined,
  expectedNames: ReadonlySet<string>,
): void {
  if (tools === undefined || expectedNames.size === 0) return
  const visible = definitionsOf(tools, lease.agent)
  for (const name of expectedNames) {
    if (visible.has(name)) throw cleanupUnconfirmed(lease)
  }
}
