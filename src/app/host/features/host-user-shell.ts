import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import {
  classifyRunnerFailure,
  isRunnerSpawnFailure,
  matchesSignature,
  type ConfinedArgv,
  type RunnerFailureRule,
  type SandboxExecutionPolicy,
  type SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { HostShellCompletionOutcome, HostShellCompletionRequest } from '../../../runtime/host-shell-completion-port.ts'
import {
  MAX_HOST_SHELL_COMPLETION_ITEMS,
  MAX_HOST_SHELL_COMPLETION_ITEM_BYTES,
  MAX_HOST_SHELL_COMPLETION_RESULT_BYTES,
  PI_TUI_HOST_USER_SHELL_NAMESPACE,
  parseHostShellCompletionOutcome,
  type HostUserShellAck,
  type HostUserShellFrame,
} from '../../../runtime/remote/pi-tui-host-user-shell-contract.ts'
import type { HostUserShellPolicy } from '../../../runtime/host-user-shell-port.ts'
import { HostUserShellAckWindow, HostUserShellOutputMux, startHostUserShellAckPump } from './host-user-shell-stream.ts'
import type { HostShellPathCompletionBridge } from '../../../runtime/remote/pi-tui-host-user-shell-host-bridge.ts'

const HOST_SANDBOX_RUNNER_CLASSIFICATION = 'Host sandbox runner failure'
const HOST_COMPLETION_TIMEOUT_MS = 2_000

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function hostShellCommand(command: string): string {
  return [
    'exec 3>&2',
    `exec 2> >(${shellWord(process.execPath)} -e 'process.stdin.pipe(process.stdout)' >&3 3>&-)`,
    'exec 3>&-',
    command,
  ].join('\n')
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, character => String.fromCharCode(character.charCodeAt(0) + 32))
}

/** Decision-equivalent bounded stderr classification for the active DSH rule set. */
class SandboxRunnerFailureScanner {
  private readonly rules: readonly RunnerFailureRule[]
  private readonly denialSignatures: readonly string[]
  private readonly lowerFatal: readonly (readonly string[])[]
  private readonly lowerInfo: readonly (readonly string[])[]
  private readonly maxFatalLength: number
  private readonly maxInfoLength: number
  private readonly maxDenialLength: number
  private readonly matches: (string | undefined)[]
  private readonly lineMatches: (string | undefined)[]
  private readonly decoder = new StringDecoder('utf8')
  private readonly denialDecoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }
  private fatalTail = ''
  private infoPrefix = ''
  private infoPossible = false
  private lineLength = 0
  private denialTail = { stdout: '', stderr: '' }
  private denialWitness: { stdout?: string; stderr?: string } = {}
  private denialSignature: { stdout?: string; stderr?: string } = {}

  constructor(rules: readonly RunnerFailureRule[], denialSignatures: readonly string[]) {
    this.rules = rules
    this.denialSignatures = denialSignatures
    const strings = [
      ...rules.flatMap(rule => [...rule.fatalSignatures, ...rule.informationalLines ?? []]),
      ...denialSignatures,
    ]
    if (strings.some(value => /[^\x00-\x7f]/u.test(value))) {
      throw new TypeError('Host sandbox runner signatures must be ASCII for bounded stream classification')
    }
    this.lowerFatal = rules.map(rule => rule.fatalSignatures.filter(signature => signature.trim() !== '').map(asciiLower))
    this.lowerInfo = rules.map(rule => (rule.informationalLines ?? []).map(asciiLower))
    this.maxFatalLength = Math.max(0, ...this.lowerFatal.flatMap(signatures => signatures.map(value => value.length)))
    this.maxInfoLength = Math.max(0, ...this.lowerInfo.flatMap(lines => lines.map(value => value.length)))
    this.maxDenialLength = Math.max(0, ...denialSignatures.map(value => value.length))
    this.matches = rules.map(() => undefined)
    this.lineMatches = rules.map(() => undefined)
    this.infoPossible = this.maxInfoLength > 0
  }

  write(bytes: Buffer, stream: 'stdout' | 'stderr' = 'stderr'): void {
    if (stream === 'stderr') this.consumeRunner(this.decoder.write(bytes))
    this.consumeDenial(this.denialDecoders[stream].write(bytes), stream)
  }

  end(): void {
    this.consumeRunner(this.decoder.end())
    this.commitLine(false)
    for (const stream of ['stdout', 'stderr'] as const) {
      this.consumeDenial(this.denialDecoders[stream].end(), stream)
    }
  }

  classifyRunner(exitCode: number | null): { readonly detail: string } | undefined {
    for (let index = 0; index < this.rules.length; index += 1) {
      const signature = this.matches[index]
      if (signature === undefined) continue
      // The official classifier owns exit-code gates and rule precedence. The
      // matching line itself is intentionally not retained when it is unbounded.
      let witness = `${signature}\0`
      while (this.rules[index]!.informationalLines?.some(line => asciiLower(line) === asciiLower(witness)) === true) {
        witness += '\0'
      }
      if (classifyRunnerFailure(exitCode, witness, [this.rules[index]!]) !== undefined) {
        return { detail: HOST_SANDBOX_RUNNER_CLASSIFICATION }
      }
    }
    return undefined
  }

  matchesDenial(exitCode: number | null): boolean {
    for (const stream of ['stdout', 'stderr'] as const) {
      const witness = this.denialWitness[stream]
      const signature = this.denialSignature[stream]
      if (witness !== undefined && signature !== undefined && matchesSignature(exitCode, witness, [signature])) return true
    }
    return false
  }

  private consumeRunner(text: string): void {
    for (const character of text) {
      if (character === '\n') {
        this.commitLine(this.infoPrefix.endsWith('\r'))
        continue
      }
      const folded = asciiLower(character)
      this.lineLength += character.length
      if (this.infoPossible) {
        if (this.lineLength <= this.maxInfoLength) this.infoPrefix += folded
        else {
          this.infoPossible = false
          this.infoPrefix = ''
        }
      }
      if (this.maxFatalLength > 0) {
        this.fatalTail = (this.fatalTail + folded).slice(-this.maxFatalLength)
        for (let index = 0; index < this.rules.length; index += 1) {
          if (this.lineMatches[index] !== undefined || this.matches[index] !== undefined) continue
          const match = this.lowerFatal[index]!.find(signature => signature !== '' && this.fatalTail.includes(signature))
          if (match !== undefined) {
            const source = this.rules[index]!.fatalSignatures[this.lowerFatal[index]!.indexOf(match)]
            this.lineMatches[index] = source
          }
        }
      }
    }
  }

  private consumeDenial(text: string, stream: 'stdout' | 'stderr'): void {
    for (const character of text) {
      if (this.denialWitness[stream] !== undefined) continue
      const folded = asciiLower(character)
      const denialWindow = (this.denialTail[stream] + folded).slice(-this.maxDenialLength)
      for (let index = 0; index < this.denialSignatures.length; index += 1) {
        const signature = this.denialSignatures[index]!
        const lowered = asciiLower(signature)
        if (lowered !== '' && denialWindow.includes(lowered)) {
          this.denialWitness[stream] = lowered
          this.denialSignature[stream] = signature
          break
        }
      }
      this.denialTail[stream] = denialWindow.slice(-Math.max(0, this.maxDenialLength - 1))
    }
  }

  private commitLine(stripCr: boolean): void {
    const infoLine = stripCr ? this.infoPrefix.slice(0, -1) : this.infoPrefix
    for (let index = 0; index < this.rules.length; index += 1) {
      if (this.matches[index] !== undefined || this.lineMatches[index] === undefined) continue
      if (this.infoPossible && this.lowerInfo[index]!.includes(infoLine)) continue
      this.matches[index] = this.lineMatches[index]
    }
    this.fatalTail = ''
    this.infoPrefix = ''
    this.infoPossible = this.maxInfoLength > 0
    this.lineLength = 0
    this.lineMatches.fill(undefined)
  }
}

/** Only this Host service owns F1 process, policy, identity and completion operations. */
const GIT_SUBCOMMAND_FALLBACK = [
  'add', 'am', 'archive', 'bisect', 'branch', 'bundle', 'checkout',
  'cherry-pick', 'clean', 'clone', 'commit', 'config', 'diff', 'fetch',
  'init', 'log', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset',
  'restore', 'revert', 'rm', 'show', 'stash', 'status', 'switch', 'tag',
] as const

export interface HostSessionLike {
  readonly id: string
}

export interface HostAgentLike {
  readonly id: string
  readonly session: HostSessionLike
}

interface HostRegistryLike<Value> {
  get(sessionId: string): Value | undefined
}

export interface WorkingDirectoryLike {
  get(session: HostSessionLike): string
}

export interface SandboxPolicyServiceLike {
  resolve(input: { readonly session: HostSessionLike }): SandboxExecutionPolicy | Promise<SandboxExecutionPolicy>
}

export interface SandboxServiceLike {
  confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
}

export interface SubprocessServiceLike {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
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

interface ActiveRun {
  readonly abort: () => void
  readonly done: Promise<void>
  readonly finish: () => void
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
      graceMs: 5_000,
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
  private readonly activeRuns = new Map<string, ActiveRun>()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, deps: PiTuiHostUserShellHostDeps) {
    super(ctx, PI_TUI_HOST_USER_SHELL_NAMESPACE)
    this.deps = deps
    ctx.effect(() => () => this.dispose(), 'pi-tui-host-user-shell-runs')
  }

  async *run(
    sessionId: string,
    requestId: string,
    expectedCwd: string,
    command: string,
    policy: HostUserShellPolicy,
    signal: AbortSignal,
  ): RemoteStream<HostUserShellFrame, HostUserShellAck> {
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      yield { kind: 'refused', requestId, reason: 'invalid-request', message: 'Host shell execution is restricted to the authenticated Owner peer' }
      return
    }
    if (this.disposed || this.lifecycle.signal.aborted) {
      yield { kind: 'refused', requestId, reason: 'scope-unavailable', message: 'Host shell service is stopping' }
      return
    }

    const activeKey = `${invocation.peer.id}\0${sessionId}\0${requestId}`
    if (this.activeRuns.has(activeKey)) {
      yield { kind: 'refused', requestId, reason: 'invalid-request', message: 'this Host shell request is already running' }
      return
    }
    const localAbort = new AbortController()
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    this.activeRuns.set(activeKey, { abort: () => localAbort.abort(), done, finish })
    const wireSignal = AbortSignal.any([signal, invocation.signal, invocation.peer.signal, this.lifecycle.signal])
    const runSignal = AbortSignal.any([wireSignal, localAbort.signal])
    let handle: SubprocessHandle | undefined
    let mux: HostUserShellOutputMux | undefined
    let ackWindow: HostUserShellAckWindow | undefined
    let ackPump: ReturnType<typeof startHostUserShellAckPump> | undefined
    let confinement: ConfinedArgv | undefined
    let processOutcome: SubprocessOutcome | undefined
    let processError: unknown
    let scanner: SandboxRunnerFailureScanner | undefined
    let rangeEmpty = false
    let terminationIssued = false
    let terminalSent = false
    let ackFailure: unknown
    let ackFailed = false
    let doneObserved: Promise<void> | undefined
    let muxClosed = false
    let ackPumpStopped = false
    const terminate = (): void => {
      if (handle === undefined || terminationIssued) return
      terminationIssued = true
      handle.terminate()
    }
    const closeMux = async (): Promise<void> => {
      if (mux === undefined || muxClosed) return
      muxClosed = true
      await mux.close()
    }
    const stopAckPump = async (): Promise<void> => {
      if (ackPump === undefined || ackPumpStopped) return
      ackPumpStopped = true
      await ackPump.stop()
    }

    try {
      const exact = this.exactIdentity(sessionId)
      if (exact === undefined) {
        yield { kind: 'refused', requestId, reason: 'scope-unavailable', message: 'the requested live Host Session is unavailable' }
        return
      }
      const cwd = this.effectiveCwd(exact.session)
      if (cwd === undefined || cwd !== expectedCwd) {
        yield { kind: 'refused', requestId, reason: 'scope-unavailable', message: 'the expected Host working directory does not match the live Session' }
        return
      }
      const hostPolicy = this.deps.shellPolicy()
      if (policy !== hostPolicy) {
        yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: 'the requested shell policy does not match the current Host preference — refresh settings and retry' }
        return
      }
      const rawArgv = ['bash', '-c', hostShellCommand(command)]
      let argv: readonly string[] = rawArgv
      if (hostPolicy === 'sandbox') {
        const sandboxPolicy = this.deps.sandboxPolicy()
        const sandbox = this.deps.sandbox()
        if (sandboxPolicy === undefined || sandbox === undefined) {
          yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: 'Host shell sandbox policy is unavailable — nothing was executed' }
          return
        }
        let resolved: SandboxExecutionPolicy
        let confined: ConfinedArgv
        try {
          resolved = await sandboxPolicy.resolve({ session: exact.session })
          runSignal.throwIfAborted()
          if (resolved.mode === 'danger-full-access') {
            yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: 'Host shell sandbox refuses danger-full-access — nothing was executed' }
            return
          }
          confined = await sandbox.confine(rawArgv, resolved as SandboxPolicy, runSignal)
        } catch (error) {
          runSignal.throwIfAborted()
          yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: `Host shell sandbox could not establish confinement: ${error instanceof Error ? error.message : 'provider failure'}` }
          return
        }
        if (confined.enforcement !== 'full') {
          yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: 'Host shell sandbox enforcement is not full — nothing was executed' }
          return
        }
        confinement = confined
        argv = confined.argv
        try {
          scanner = new SandboxRunnerFailureScanner(confined.runnerFailureRules, confined.denialSignatures)
        } catch (error) {
          yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: `Host sandbox diagnostics cannot be classified safely: ${error instanceof Error ? error.message : 'unsupported rules'}` }
          return
        }
      }
      runSignal.throwIfAborted()
      if (this.deps.shellPolicy() !== hostPolicy) {
        yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: 'the Host shell policy changed during preparation — nothing was executed' }
        return
      }
      if (!this.isSameIdentity(sessionId, exact) || this.effectiveCwd(exact.session) !== cwd) {
        yield { kind: 'refused', requestId, reason: 'scope-unavailable', message: 'the Host Session or working directory changed during shell preparation' }
        return
      }
      const subprocess = this.deps.subprocess()
      if (subprocess === undefined) {
        yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: 'the Host subprocess provider is unavailable — nothing was executed' }
        terminalSent = true
        return
      }
      try {
        handle = subprocess.spawn({
          argv,
          cwd,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 5_000,
          signal: runSignal,
        })
      } catch (error) {
        yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: `the Host process could not start — nothing was executed (${error instanceof Error ? error.message : 'provider failure'})` }
        terminalSent = true
        return
      }
      if (handle.stdout === undefined || handle.stderr === undefined) {
        throw new Error('Host subprocess did not provide both raw output pipes')
      }
      ackWindow = new HostUserShellAckWindow(requestId)
      ackPump = startHostUserShellAckPump(invocation, ackWindow, error => {
        ackFailed = true
        ackFailure = error
        localAbort.abort(error)
      })
      mux = new HostUserShellOutputMux(handle.stdout, handle.stderr)
      doneObserved = handle.done.then(
        outcome => { processOutcome = outcome },
        error => { processError = error },
      )
      yield { kind: 'started', requestId, sessionId, policy }

      for (;;) {
        await ackWindow.waitForCapacity(runSignal)
        const chunk = await mux.next(runSignal)
        if (chunk === undefined) break
        scanner?.write(chunk.bytes, chunk.stream)
        const seq = ackWindow.markSent()
        yield { kind: 'output', requestId, seq, stream: chunk.stream, base64: chunk.bytes.toString('base64') }
      }
      await doneObserved
      if (processError !== undefined) {
        if (confinement !== undefined && isRunnerSpawnFailure(processError, argv[0], cwd)) {
          const empty = await handle.waitForExit(wireSignal)
          if (!empty) wireSignal.throwIfAborted()
          rangeEmpty = true
          await ackWindow.waitForDrain(wireSignal)
          await stopAckPump()
          ackWindow.close()
          yield { kind: 'failed', requestId, phase: 'sandbox-runner', message: 'Host sandbox runner failed before the user command executed' }
          terminalSent = true
          return
        }
        throw processError
      }
      if (processOutcome === undefined) throw new Error('Host subprocess outcome was not observed')
      const empty = await handle.waitForExit(wireSignal)
      if (!empty) wireSignal.throwIfAborted()
      rangeEmpty = true
      scanner?.end()
      const runnerFailure = scanner?.classifyRunner(processOutcome.exitCode)
      if (runnerFailure !== undefined) {
        await ackWindow.waitForDrain(wireSignal)
        await stopAckPump()
        ackWindow.close()
        yield { kind: 'failed', requestId, phase: 'sandbox-runner', message: 'Host sandbox runner failed before the user command executed' }
        terminalSent = true
        return
      }
      const denied = hostPolicy === 'sandbox'
        && processOutcome.exitCode !== null
        && processOutcome.exitCode !== 0
        && scanner?.matchesDenial(processOutcome.exitCode) === true
      await ackWindow.waitForDrain(wireSignal)
      await stopAckPump()
      ackWindow.close()
      const exit = processOutcome.exitCode !== null
        ? { kind: 'exit' as const, code: processOutcome.exitCode }
        : processOutcome.signal !== null
          ? { kind: 'signal' as const, signal: processOutcome.signal }
          : undefined
      if (exit === undefined) throw new Error('Host subprocess returned neither an exit code nor a signal')
      yield {
        kind: 'settled', requestId, exit, aborted: wireSignal.aborted, sandboxDenied: denied,
      }
      terminalSent = true
    } catch (error) {
      if (wireSignal.aborted) throw error
      if (ackFailed) throw ackFailure
      if (handle === undefined) {
        yield { kind: 'refused', requestId, reason: 'policy-unavailable', message: `Host shell admission failed before process creation — nothing was executed (${error instanceof Error ? error.message : 'provider failure'})` }
        terminalSent = true
        return
      }
      localAbort.abort(error)
      terminate()
      const empty = await handle.waitForExit()
      if (!empty) throw new Error('Host subprocess range did not terminate after a Host failure')
      rangeEmpty = true
      await doneObserved
      await closeMux()
      if (ackWindow !== undefined) {
        await ackWindow.waitForDrain(wireSignal)
        await stopAckPump()
        ackWindow.close()
      }
      yield {
        kind: 'failed', requestId,
        phase: 'transport-internal',
        message: error instanceof Error ? error.message : 'Host shell execution failed',
      }
      terminalSent = true
    } finally {
      localAbort.abort()
      ackWindow?.close()
      if (!terminalSent && handle !== undefined) terminate()
      if (handle !== undefined && !rangeEmpty) {
        const empty = await handle.waitForExit()
        if (!empty) throw new Error('Host subprocess managed range did not become empty')
        rangeEmpty = true
      }
      if (doneObserved !== undefined) await doneObserved
      await closeMux()
      await stopAckPump()
      this.activeRuns.delete(activeKey)
      finish()
    }
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
    const active = [...this.activeRuns.values()]
    for (const run of active) run.abort()
    this.disposal = Promise.all(active.map(run => run.done)).then(() => undefined)
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
