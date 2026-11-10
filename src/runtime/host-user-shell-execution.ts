/**
 * The one Host user-shell execution core shared by the Direct adapter and the
 * authenticated split-Host service.
 *
 * Both policies run the raw command through the official subprocess seam as
 * `['bash', '-c', command]` (no wrapper, relay or shell-flag translation):
 * - `bypass` spawns that argv directly;
 * - `sandbox` resolves the EXACT Session policy and calls the installed
 *   official `ctx.sandbox.confine` exactly once, requires `enforcement:
 *   'full'`, and spawns the EXACT argv returned by that one call.
 *
 * Output is bounded by the subprocess collect/spill dispositions and read only
 * after `done` AND `waitForExit` proved the managed range empty. Cancellation
 * is the caller's signal: the provider terminates the range, and this module
 * joins it before returning. No long-lived stream, acknowledgement window or
 * second process owner exists here.
 * @module @xmoon76/dsh-pi-tui/runtime/host-user-shell-execution
 */

import {
  classifyRunnerFailure,
  isRunnerSpawnFailure,
  matchesSignature,
  type ConfinedArgv,
  type SandboxExecutionPolicy,
  type SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  boundedHostUserShellOutput,
  boundedHostUserShellResultStreams,
  MAX_HOST_USER_SHELL_MESSAGE_BYTES,
  MAX_HOST_USER_SHELL_SPILL_PATH_BYTES,
  MAX_HOST_USER_SHELL_STREAM_BYTES,
  type HostUserShellPolicy,
  type HostUserShellResult,
} from './host-user-shell-port.ts'

export const HOST_USER_SHELL_SPILL_MAX_BYTES = 64 * 1024 * 1024
export const HOST_USER_SHELL_GRACE_MS = 5_000

export interface HostSessionLike {
  readonly id: string
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

/** A final pre-spawn veto: throwing it prevents the spawn and is mapped by the
 * caller into its own truthful refusal. */
export class HostShellExecutionVeto extends Error {
  readonly reason: 'scope-unavailable' | 'policy-unavailable' | 'invalid-request'

  constructor(reason: HostShellExecutionVeto['reason'], message: string) {
    super(message)
    this.name = 'HostShellExecutionVeto'
    this.reason = reason
  }
}

/** What one shared-core execution produced. The callers map `refused`/
 * `failed` into their own wire/app vocabulary. */
export type HostShellExecutionOutcome =
  | { readonly kind: 'settled'; readonly result: HostUserShellResult }
  | { readonly kind: 'refused'; readonly reason: 'policy-unavailable'; readonly message: string }
  | { readonly kind: 'failed'; readonly phase: 'sandbox-runner' | 'infrastructure'; readonly message: string }

export interface HostShellExecutionRequest {
  readonly command: string
  readonly cwd: string
  readonly policy: HostUserShellPolicy
  readonly signal: AbortSignal
  readonly subprocess: SubprocessServiceLike
  /** The exact live Session; required for the `sandbox` policy. */
  readonly session: HostSessionLike | undefined
  readonly sandboxPolicy: SandboxPolicyServiceLike | undefined
  readonly sandbox: SandboxServiceLike | undefined
  /**
   * Runs synchronously IMMEDIATELY before the one spawn (after all async
   * preparation). Throwing {@link HostShellExecutionVeto} prevents the spawn.
   */
  readonly beforeSpawn?: () => void
}

/** Bound a Host diagnostic so a wire message bound can never be exceeded. */
export function boundedHostShellMessage(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= MAX_HOST_USER_SHELL_MESSAGE_BYTES) return text
  let end = MAX_HOST_USER_SHELL_MESSAGE_BYTES - 3
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}…`
}

export function hostShellDiagnostic(error: unknown): string {
  return boundedHostShellMessage(error instanceof Error ? error.message : String(error))
}

function refused(message: string): HostShellExecutionOutcome {
  return { kind: 'refused', reason: 'policy-unavailable', message: boundedHostShellMessage(message) }
}

function failed(phase: 'sandbox-runner' | 'infrastructure', message: string): HostShellExecutionOutcome {
  return { kind: 'failed', phase, message: boundedHostShellMessage(message) }
}

function collectedOutput(reader: SubprocessOutputReader | undefined): {
  readonly text: string
  readonly truncated: boolean
  readonly spillPath?: string
} {
  if (reader === undefined) throw new Error('the Host subprocess did not expose the requested collected stream')
  const read = reader.readFrom(0)
  const spillPath = read.spillPath
  if (spillPath !== undefined && Buffer.byteLength(spillPath, 'utf8') > MAX_HOST_USER_SHELL_SPILL_PATH_BYTES) {
    return { text: read.text, truncated: read.lossy }
  }
  return { text: read.text, truncated: read.lossy, ...(spillPath === undefined ? {} : { spillPath }) }
}

/**
 * Execute one user-shell command to settlement through the official
 * subprocess seam. Never throws for a command-level failure; a thrown
 * {@link HostShellExecutionVeto} from `beforeSpawn` propagates without a spawn.
 * @param request - command, exact Host scope and the resolved official services.
 * @returns the bounded semantic result or a truthful refusal/failure.
 */
export async function executeHostShellOnce(request: HostShellExecutionRequest): Promise<HostShellExecutionOutcome> {
  const { command, cwd, policy, signal, subprocess } = request
  const rawArgv = ['bash', '-c', command] as const
  let confined: ConfinedArgv | undefined
  if (policy === 'sandbox') {
    const prepared = await confineSandbox(rawArgv, request)
    if ('kind' in prepared) return prepared
    confined = prepared
  }
  signal.throwIfAborted()

  const spec: SubprocessSpawnSpec = {
    argv: confined?.argv ?? rawArgv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_HOST_USER_SHELL_STREAM_BYTES, spill: { maxBytes: HOST_USER_SHELL_SPILL_MAX_BYTES } },
      stderr: { maxBytes: MAX_HOST_USER_SHELL_STREAM_BYTES, spill: { maxBytes: HOST_USER_SHELL_SPILL_MAX_BYTES } },
    },
    graceMs: HOST_USER_SHELL_GRACE_MS,
    signal,
  }

  // The caller's final identity/policy gate runs here, synchronously, after
  // every await of preparation and immediately before the one spawn.
  request.beforeSpawn?.()
  signal.throwIfAborted()

  let handle: SubprocessHandle
  try {
    handle = subprocess.spawn(spec)
  } catch (error) {
    signal.throwIfAborted()
    if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], cwd)) {
      return failed('sandbox-runner', `the Host sandbox runner failed before the user command executed (${hostShellDiagnostic(error)})`)
    }
    return refused(`the Host process could not start — nothing was executed (${hostShellDiagnostic(error)})`)
  }

  let outcome: Awaited<typeof handle.done> | undefined
  try {
    outcome = await handle.done
    const empty = await handle.waitForExit()
    if (!empty) throw new Error('the Host subprocess managed range did not become empty')
  } catch (error) {
    // Managed-range observation failed. Terminate the official range, then
    // retry the UNBOUNDED no-signal observation exactly once. A second failure
    // must surface an explicit unknown outcome; it must never be swallowed and
    // reported as a joined/clean settlement.
    handle.terminate()
    let rangeEmpty = false
    let observationError: unknown
    try {
      rangeEmpty = await handle.waitForExit()
    } catch (retryError) {
      observationError = retryError
    }
    if (!rangeEmpty) {
      const observed = observationError === undefined
        ? 'the Host subprocess managed range was not confirmed empty'
        : `the Host subprocess managed range could not be observed (${hostShellDiagnostic(observationError)})`
      return failed(
        'infrastructure',
        `${observed}; the process outcome is unknown and cleanup is not confirmed — do not treat this as a clean settlement (${hostShellDiagnostic(error)})`,
      )
    }
    if (outcome === undefined) {
      if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], cwd)) {
        return failed('sandbox-runner', `the Host sandbox runner failed before the user command executed (${hostShellDiagnostic(error)})`)
      }
      if (signal.aborted) signal.throwIfAborted()
      return failed('infrastructure', `the Host process failed before reporting an outcome (${hostShellDiagnostic(error)})`)
    }
    // The retry confirmed an empty range and the exit facts were already
    // observed: continue with those authoritative facts.
  }
  if (outcome === undefined) {
    return failed('infrastructure', 'the Host process did not report an outcome')
  }

  // The managed range is empty: the collected readers are now the only output
  // authority and are read exactly once, bounded.
  let stdout
  let stderr
  try {
    stdout = collectedOutput(handle.collected.stdout)
    stderr = collectedOutput(handle.collected.stderr)
  } catch (error) {
    return failed('infrastructure', `the Host process output could not be read (${hostShellDiagnostic(error)})`)
  }

  // Official bounded-tail diagnostic semantics: a truncated stderr may have
  // dropped a higher-priority runner-fatal line that would outrank a denial.
  // A nonzero sandbox exit with truncated diagnostics is therefore a
  // reason-UNKNOWN settlement, not a confirmed runner failure or denial, even
  // when the retained tail happens to match either signature set.
  const stderrTruncated = stderr.truncated
  const exitNonzero = outcome.exitCode !== null && outcome.exitCode !== 0
  const failureReasonUnknown = confined !== undefined && exitNonzero && stderrTruncated
  if (confined !== undefined && !failureReasonUnknown) {
    const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderr.text, confined.runnerFailureRules)
    if (runnerFailure !== undefined) {
      return failed('sandbox-runner', `the Host sandbox runner failed before the user command executed (${runnerFailure.detail})`)
    }
  }
  // A definite denial requires the absence of the higher-priority uncertainty:
  // with truncated diagnostics a runner fatal may have been dropped even when
  // the retained tail matches a denial signature.
  const denied = confined !== undefined
    && !failureReasonUnknown
    && matchesSignature(outcome.exitCode, stderr.text, confined.denialSignatures)

  const exit = outcome.exitCode !== null
    ? { kind: 'exit' as const, code: outcome.exitCode }
    : outcome.signal !== null
      ? { kind: 'signal' as const, signal: outcome.signal }
      : undefined
  if (exit === undefined) {
    return failed('infrastructure', 'the Host process returned neither an exit code nor a terminating signal')
  }
  if (exit.kind === 'exit' && (exit.code < 0 || exit.code > 255)) {
    return failed('infrastructure', `the Host process returned an unusable exit code ${String(exit.code)}`)
  }
  const streams = boundedHostUserShellResultStreams(
    boundedHostUserShellOutput(stdout),
    boundedHostUserShellOutput(stderr),
  )
  return {
    kind: 'settled',
    result: {
      exit,
      stdout: streams.stdout,
      stderr: streams.stderr,
      sandboxDenied: denied,
      aborted: signal.aborted,
      timedOut: false,
    },
  }
}

async function confineSandbox(
  rawArgv: readonly string[],
  request: HostShellExecutionRequest,
): Promise<ConfinedArgv | HostShellExecutionOutcome> {
  const { session, sandboxPolicy, sandbox, signal } = request
  if (session === undefined) {
    return refused('Host shell sandbox requires a live Session — nothing was executed')
  }
  if (sandboxPolicy === undefined || sandbox === undefined) {
    return refused('Host shell sandbox policy is unavailable — nothing was executed')
  }
  let resolved: SandboxExecutionPolicy
  let confined: ConfinedArgv
  try {
    resolved = await sandboxPolicy.resolve({ session })
    signal.throwIfAborted()
    if (resolved.mode === 'danger-full-access') {
      return refused('Host shell sandbox refuses danger-full-access — nothing was executed')
    }
    confined = await sandbox.confine(rawArgv, resolved as SandboxPolicy, signal)
  } catch (error) {
    signal.throwIfAborted()
    return refused(`Host shell sandbox could not establish confinement: ${hostShellDiagnostic(error)} — nothing was executed`)
  }
  if (confined.enforcement !== 'full') {
    return refused('Host shell sandbox enforcement is not full — nothing was executed')
  }
  return confined
}
