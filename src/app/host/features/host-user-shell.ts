import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { HostShellCompletionOutcome, HostShellCompletionRequest } from '../../../runtime/host-shell-completion-port.ts'
import {
  executeHostShellOnce,
  HOST_USER_SHELL_GRACE_MS,
  HostShellExecutionVeto,
  hostShellDiagnostic,
  type HostSessionLike,
  type SandboxPolicyServiceLike,
  type SandboxServiceLike,
  type SubprocessServiceLike,
} from '../../../runtime/host-user-shell-execution.ts'
import {
  MAX_HOST_SHELL_COMPLETION_ITEMS,
  MAX_HOST_SHELL_COMPLETION_ITEM_BYTES,
  MAX_HOST_SHELL_COMPLETION_RESULT_BYTES,
  PI_TUI_HOST_USER_SHELL_NAMESPACE,
  parseHostShellCompletionOutcome,
  type HostUserShellRunOutcome,
} from '../../../runtime/remote/pi-tui-host-user-shell-contract.ts'
import type { HostUserShellPolicy } from '../../../runtime/host-user-shell-port.ts'
import type { HostShellPathCompletionBridge } from '../../../runtime/remote/pi-tui-host-user-shell-host-bridge.ts'

export type {
  HostSessionLike,
  SandboxPolicyServiceLike,
  SandboxServiceLike,
  SubprocessServiceLike,
} from '../../../runtime/host-user-shell-execution.ts'

const HOST_COMPLETION_TIMEOUT_MS = 2_000

/** Only this Host service owns F1 process, policy, identity and completion operations. */
const GIT_SUBCOMMAND_FALLBACK = [
  'add', 'am', 'archive', 'bisect', 'branch', 'bundle', 'checkout',
  'cherry-pick', 'clean', 'clone', 'commit', 'config', 'diff', 'fetch',
  'init', 'log', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset',
  'restore', 'revert', 'rm', 'show', 'stash', 'status', 'switch', 'tag',
] as const

export interface HostAgentLike {
  readonly id: string
  readonly session: HostSessionLike
}

export interface WorkingDirectoryLike {
  get(session: HostSessionLike): string
}

export interface PiTuiHostUserShellHostDeps {
  readonly agentFor: (sessionId: string) => HostAgentLike | undefined
  readonly sessionFor: (sessionId: string) => HostSessionLike | undefined
  readonly workingDirectory: () => WorkingDirectoryLike | undefined
  readonly sandboxPolicy: () => SandboxPolicyServiceLike | undefined
  readonly sandbox: () => SandboxServiceLike | undefined
  readonly subprocess: () => SubprocessServiceLike | undefined
  readonly pathCompletion: HostShellPathCompletionBridge
  readonly shellPolicy: () => HostUserShellPolicy
}

interface HelperLines {
  readonly lines: readonly string[]
  readonly capped: boolean
  readonly invalid: boolean
}

type HelperFailure = 'spawn' | 'exit' | 'timeout' | 'output'
type HelperResult =
  | { readonly kind: 'ok'; readonly candidates: readonly string[]; readonly capped: boolean }
  | { readonly kind: 'failed'; readonly reason: string; readonly failure: HelperFailure }

function unavailable(reason: string): HostShellCompletionOutcome {
  return { kind: 'unavailable', reason }
}

function stringBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function refused(reason: Extract<HostUserShellRunOutcome, { kind: 'refused' }>['reason'], message: string): HostUserShellRunOutcome {
  return { kind: 'refused', reason, message: hostShellDiagnostic(new Error(message)) }
}

function failed(phase: Extract<HostUserShellRunOutcome, { kind: 'failed' }>['phase'], message: string): HostUserShellRunOutcome {
  return { kind: 'failed', phase, message: hostShellDiagnostic(new Error(message)) }
}

async function readHelperLines(
  readable: NodeJS.ReadableStream,
  signal: AbortSignal,
  onLimit: () => void,
): Promise<HelperLines> {
  const decoder = new StringDecoder('utf8')
  const lines: string[] = []
  let pending = ''
  let totalBytes = stringBytes(JSON.stringify({ kind: 'ok', candidates: [] }))
  let capped = false
  let invalid = false

  const pushLine = (rawLine: string): boolean => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') return true
    const bytes = stringBytes(line)
    if (bytes > MAX_HOST_SHELL_COMPLETION_ITEM_BYTES) {
      invalid = true
      onLimit()
      return false
    }
    const nextTotal = totalBytes + bytes + 3
    if (lines.length >= MAX_HOST_SHELL_COMPLETION_ITEMS || nextTotal > MAX_HOST_SHELL_COMPLETION_RESULT_BYTES) {
      capped = true
      onLimit()
      return false
    }
    lines.push(line)
    totalBytes = nextTotal
    if (lines.length === MAX_HOST_SHELL_COMPLETION_ITEMS) {
      capped = true
      onLimit()
      return false
    }
    return true
  }

  for await (const chunk of readable as AsyncIterable<Uint8Array>) {
    signal.throwIfAborted()
    pending += decoder.write(Buffer.from(chunk))
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (!pushLine(line)) return { lines, capped, invalid }
    }
    if (stringBytes(pending) > MAX_HOST_SHELL_COMPLETION_ITEM_BYTES) {
      invalid = true
      onLimit()
      return { lines, capped, invalid }
    }
  }
  pending += decoder.end()
  if (pending !== '' && !pushLine(pending)) return { lines, capped, invalid }
  return { lines, capped, invalid }
}

async function drainHelperStream(readable: NodeJS.ReadableStream, signal: AbortSignal): Promise<void> {
  for await (const _chunk of readable as AsyncIterable<Uint8Array>) signal.throwIfAborted()
}

async function runCompletionHelper(
  subprocess: SubprocessServiceLike,
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<HelperResult> {
  const timeout = AbortSignal.timeout(HOST_COMPLETION_TIMEOUT_MS)
  const helperSignal = AbortSignal.any([signal, timeout])
  let handle: SubprocessHandle | undefined
  let terminationIssued = false
  let stdout: Promise<HelperLines> | undefined
  let stderr: Promise<void> | undefined
  const done = { outcome: undefined as SubprocessOutcome | undefined, error: undefined as unknown, rejected: false }
  const terminate = (): void => {
    if (handle === undefined || terminationIssued) return
    terminationIssued = true
    handle.terminate()
  }
  try {
    handle = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: HOST_USER_SHELL_GRACE_MS,
      signal: helperSignal,
    })
    if (handle.stdout === undefined || handle.stderr === undefined) {
      terminate()
      await handle.waitForExit()
      return { kind: 'failed', reason: 'Host helper pipes are unavailable', failure: 'spawn' }
    }
    stdout = readHelperLines(handle.stdout, helperSignal, terminate)
    stderr = drainHelperStream(handle.stderr, helperSignal)
    const observedDone = handle.done.then(
      outcome => { done.outcome = outcome },
      error => { done.error = error; done.rejected = true },
    )
    const [captured] = await Promise.all([stdout, stderr, observedDone])
    const rangeEmpty = await handle.waitForExit()
    if (!rangeEmpty) throw new Error('Host completion helper process range did not close')
    if (signal.aborted) signal.throwIfAborted()
    if (timeout.aborted) return { kind: 'failed', reason: 'Host shell completion timed out', failure: 'timeout' }
    if (captured.invalid) return { kind: 'failed', reason: 'Host completion candidate exceeded the DTO bound', failure: 'output' }
    if (captured.capped) return { kind: 'ok', candidates: captured.lines, capped: true }
    if (done.rejected) {
      return {
        kind: 'failed',
        reason: isRunnerSpawnFailure(done.error, argv[0], cwd)
          ? 'the Host helper executable is unavailable'
          : 'the Host helper failed to start',
        failure: 'spawn',
      }
    }
    if (done.outcome?.exitCode !== 0) {
      return { kind: 'failed', reason: 'the Host helper exited unsuccessfully', failure: 'exit' }
    }
    return { kind: 'ok', candidates: captured.lines, capped: false }
  } catch (error) {
    terminate()
    const pending = []
    if (stdout !== undefined) pending.push(stdout)
    if (stderr !== undefined) pending.push(stderr)
    await Promise.allSettled(pending)
    if (handle !== undefined) {
      const empty = await handle.waitForExit()
      if (!empty) throw new Error('Host completion helper process range did not close after failure')
    }
    if (signal.aborted) signal.throwIfAborted()
    if (timeout.aborted) return { kind: 'failed', reason: 'Host shell completion timed out', failure: 'timeout' }
    return {
      kind: 'failed',
      reason: isRunnerSpawnFailure(error, argv[0], cwd)
        ? 'the Host helper executable is unavailable'
        : 'the Host helper failed',
      failure: 'spawn',
    }
  }
}

/** Only this Host service owns F1 process, policy, identity and completion operations. */
export class PiTuiHostUserShellService extends TypertRemoteService {
  static readonly inject = ['typert']

  private readonly deps: PiTuiHostUserShellHostDeps
  private readonly lifecycle = new AbortController()
  private readonly activeRuns = new Set<Promise<void>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, deps: PiTuiHostUserShellHostDeps) {
    super(ctx, PI_TUI_HOST_USER_SHELL_NAMESPACE)
    this.deps = deps
    ctx.effect(() => () => this.dispose(), 'pi-tui-host-user-shell-runs')
  }

  /**
   * Run one authenticated, exact-Session ONE-SHOT Shell command in the Host.
   * Owner and exact Agent/Session identity are validated before preparation
   * and again synchronously immediately before the one official subprocess
   * spawn; the official subprocess provider owns bounded collection, spill
   * files, cancellation and managed-range cleanup.
   */
  async run(
    sessionId: string,
    expectedCwd: string,
    command: string,
    policy: HostUserShellPolicy,
    signal: AbortSignal,
  ): Promise<HostUserShellRunOutcome> {
    signal.throwIfAborted()
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      return refused('invalid-request', 'Host shell execution is restricted to the authenticated Owner peer')
    }
    if (this.disposed || this.lifecycle.signal.aborted) {
      return refused('scope-unavailable', 'Host shell service is stopping')
    }
    if (process.platform === 'win32') {
      return refused('policy-unavailable', 'Host Bash execution is unsupported on Windows in this version — nothing was executed')
    }
    const exact = this.exactIdentity(sessionId)
    if (exact === undefined) {
      return refused('scope-unavailable', 'the requested live Host Session is unavailable')
    }
    const cwd = this.effectiveCwd(exact.session)
    if (cwd === undefined || cwd !== expectedCwd) {
      return refused('scope-unavailable', 'the expected Host working directory does not match the live Session')
    }
    const hostPolicy = this.deps.shellPolicy()
    if (policy !== hostPolicy) {
      return refused('policy-unavailable', 'the requested shell policy does not match the current Host preference — refresh settings and retry')
    }
    const subprocess = this.deps.subprocess()
    if (subprocess === undefined) {
      return refused('policy-unavailable', 'the Host subprocess provider is unavailable — nothing was executed')
    }
    const runSignal = AbortSignal.any([signal, invocation.signal, invocation.peer.signal, this.lifecycle.signal])
    const completion = this.executeOneShot({ sessionId, exact, cwd, command, policy: hostPolicy, subprocess, runSignal })
    const tracked = completion.then(() => undefined, () => undefined)
    this.activeRuns.add(tracked)
    try {
      return await completion
    } finally {
      this.activeRuns.delete(tracked)
    }
  }

  private async executeOneShot(input: {
    readonly sessionId: string
    readonly exact: { readonly agent: HostAgentLike; readonly session: HostSessionLike }
    readonly cwd: string
    readonly command: string
    readonly policy: HostUserShellPolicy
    readonly subprocess: SubprocessServiceLike
    readonly runSignal: AbortSignal
  }): Promise<HostUserShellRunOutcome> {
    const { sessionId, exact, cwd, command, policy, subprocess, runSignal } = input
    let execution
    try {
      execution = await executeHostShellOnce({
        command,
        cwd,
        policy,
        signal: runSignal,
        subprocess,
        session: exact.session,
        sandboxPolicy: this.deps.sandboxPolicy(),
        sandbox: this.deps.sandbox(),
        beforeSpawn: () => {
          // The final Host gate: Owner invocation, exact Agent/Session object
          // identity and Host policy are rechecked synchronously here, after
          // every preparation await and immediately before the one spawn.
          runSignal.throwIfAborted()
          if (!this.isOwnerInvocation(this.ctx.invocation)) {
            throw new HostShellExecutionVeto('invalid-request', 'the Owner invocation ended during shell preparation — nothing was executed')
          }
          if (!this.isSameIdentity(sessionId, exact) || this.effectiveCwd(exact.session) !== cwd) {
            throw new HostShellExecutionVeto('scope-unavailable', 'the Host Session or working directory changed during shell preparation')
          }
          if (this.deps.shellPolicy() !== policy) {
            throw new HostShellExecutionVeto('policy-unavailable', 'the Host shell policy changed during preparation — nothing was executed')
          }
        },
      })
    } catch (error) {
      if (error instanceof HostShellExecutionVeto) return refused(error.reason, error.message)
      throw error
    }
    if (execution.kind === 'settled') return { kind: 'settled', result: execution.result }
    if (execution.kind === 'refused') return refused('policy-unavailable', execution.message)
    return failed(execution.phase, execution.message)
  }

  async complete(
    sessionId: string,
    request: HostShellCompletionRequest,
    signal: AbortSignal,
  ): Promise<HostShellCompletionOutcome> {
    signal.throwIfAborted()
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) return unavailable('Host shell completion is restricted to the authenticated Owner peer')
    if (this.disposed || this.lifecycle.signal.aborted) return unavailable('Host shell service is stopping')
    const exact = this.exactIdentity(sessionId)
    if (exact === undefined) return unavailable('the requested live Host Session is unavailable')
    const cwd = this.effectiveCwd(exact.session)
    if (cwd === undefined) return unavailable('the Host Session working directory is unavailable')
    const operationSignal = AbortSignal.any([signal, invocation.signal, invocation.peer.signal, this.lifecycle.signal])
    let result: HostShellCompletionOutcome
    if (request.kind === 'paths') {
      result = await this.deps.pathCompletion.complete(cwd, request.prefix, operationSignal)
    } else {
      const subprocess = this.deps.subprocess()
      if (subprocess === undefined) return unavailable('the Host subprocess provider is unavailable')
      const argv = request.kind === 'commands'
        ? ['bash', '-c', 'compgen -A command -- "$1"', 'dsh-pi-tui-compgen', request.prefix]
        : request.kind === 'variables'
          ? ['bash', '-c', 'compgen -A variable -- "$1"', 'dsh-pi-tui-compgen', request.prefix]
          : ['git', '--list-cmds=main']
      const helper = await runCompletionHelper(subprocess, argv, cwd, operationSignal)
      if (helper.kind === 'failed') {
        if (request.kind === 'subcommands' && (helper.failure === 'exit' || helper.failure === 'spawn')) {
          result = { kind: 'ok', candidates: [...GIT_SUBCOMMAND_FALLBACK] }
        } else {
          return unavailable(helper.reason)
        }
      } else if (request.kind === 'subcommands' && helper.candidates.length === 0) {
        result = { kind: 'ok', candidates: [...GIT_SUBCOMMAND_FALLBACK] }
      } else {
        result = {
          kind: 'ok',
          candidates: request.kind === 'subcommands'
            ? helper.candidates.flatMap(line => line.split(/\s+/u)).filter(Boolean)
            : helper.candidates,
        }
      }
    }
    operationSignal.throwIfAborted()
    if (!this.isSameIdentity(sessionId, exact) || this.effectiveCwd(exact.session) !== cwd) {
      return unavailable('the Host Session changed during completion')
    }
    return parseHostShellCompletionOutcome(result)
  }

  private isOwnerInvocation(invocation: RemoteInvocation | undefined): invocation is RemoteInvocation {
    return invocation !== undefined
      && invocation.peer.principal.kind === 'owner'
      && !invocation.signal.aborted
      && !invocation.peer.signal.aborted
  }

  private exactIdentity(sessionId: string): { readonly agent: HostAgentLike; readonly session: HostSessionLike } | undefined {
    const agent = this.deps.agentFor(sessionId)
    const session = this.deps.sessionFor(sessionId)
    if (agent === undefined || session === undefined || agent.id !== sessionId || session.id !== sessionId || agent.session !== session) {
      return undefined
    }
    return { agent, session }
  }

  private isSameIdentity(
    sessionId: string,
    exact: { readonly agent: HostAgentLike; readonly session: HostSessionLike },
  ): boolean {
    return this.deps.agentFor(sessionId) === exact.agent
      && this.deps.sessionFor(sessionId) === exact.session
      && exact.agent.session === exact.session
  }

  private effectiveCwd(session: HostSessionLike): string | undefined {
    const service = this.deps.workingDirectory()
    if (service === undefined) return undefined
    const cwd = service.get(session)
    return typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd) && isHostDirectory(cwd) ? cwd : undefined
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.lifecycle.abort()
    this.disposal = Promise.all([...this.activeRuns]).then(() => undefined)
    return this.disposal
  }
}

function isHostDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && accessSync(path, fsConstants.R_OK | fsConstants.X_OK) === undefined
  } catch {
    return false
  }
}
