/**
 * M3-1 experimental Remote runtime composition owner.
 *
 * The only app-level module that joins the Host-side and Client-side Remote
 * runtimes, in the frozen order:
 *
 * ```text
 * caller Host prerequisites
 *   -> Remote Host composition (additive official rows)
 *   -> Client composition (official wire over the in-process carrier)
 * ```
 *
 * It knows nothing about `TuiApp`, surfaces, `SessionOwnerRef`, the semantic
 * `Backend`, commands, or submission. M3-1 has no production bootstrap call
 * site; the only sanctioned way to reach this module is the lazy
 * `runtime/backend-loader.ts` boundary, and tests may construct it directly.
 *
 * @module app/remote/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Backend } from '../../runtime/backend.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { RemoteConfigPort, type RemoteConfigRuntimeSource } from '../../runtime/remote/config-remote.ts'
import { RemoteSessionArchive } from '../../runtime/remote/session-archive-remote.ts'
import { createRemoteBackend } from '../../runtime/remote/backend-remote.ts'
import { createRemoteClientRuntime, type RemoteClientRuntime } from './client-runtime.ts'
import { RemotePromptSerializerProduction } from '../../runtime/remote/prompt-serializer-remote.ts'
import { RemoteHostUserShellPort } from '../../runtime/remote/host-user-shell-remote.ts'
import { createRemoteHostRuntime, mergeCause, type InProcessHostCarrier, type RemoteHostRuntime } from './host-runtime.ts'
import { createRemoteM3ASemantics, remoteM3ARuntimeSourceOf, type RemoteM3ASemantics } from './m3a-semantics.ts'

/**
 * Run one disposal step with per-step error isolation: the step's failures
 * are collected (never thrown here) so the remaining cleanup steps always
 * run. Returns every collected error.
 */
async function collectDisposeErrors(dispose: () => Promise<void> | void): Promise<unknown[]> {
  try {
    await dispose()
  } catch (error) {
    return [error]
  }
  return []
}

/** Start input for the experimental Remote runtime. */
export interface ExperimentalRemoteRuntimeOptions {
  /** The already-running ordinary pi-tui Host Context (never disposed here). */
  readonly hostContext: Context
  /** Host bootstrap prerequisite barrier owned by the caller (M3-0 ordering contract). */
  readonly waitForHostPrerequisites: () => Promise<void>
  /** Lifecycle signal observed between the Host prerequisite and composition. */
  readonly signal?: AbortSignal
}

/** The joined experimental Remote runtime. Not exported from the package root. */
export interface ExperimentalRemoteRuntime {
  readonly host: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  /** Dispose the Client first, then the Host additive fibers. Idempotent. */
  dispose(): Promise<void>
}

/**
 * Start the experimental Remote runtime: wait for the caller's Host
 * prerequisites (the M3-0 `legacy settings migration -> Remote Host
 * composition -> Client readiness` ordering contract), compose the Host
 * rows, then compose the Client over the Host carrier.
 *
 * Failure semantics: a Host construction failure unwinds the partial Host
 * fibers and no Client Context is created; a Client construction failure
 * unwinds the partial Client, disposes the Host runtime, and rethrows the
 * original error.
 */
export async function createExperimentalRemoteRuntime(
  options: ExperimentalRemoteRuntimeOptions,
): Promise<ExperimentalRemoteRuntime> {
  await options.waitForHostPrerequisites()
  options.signal?.throwIfAborted()

  const host = await createRemoteHostRuntime(options.hostContext)
  let client: RemoteClientRuntime
  try {
    client = await createRemoteClientRuntime({ carrier: host.carrier, signal: options.signal })
  } catch (error) {
    // §17.3: rethrow the original Client failure. A Host disposal failure
    // must not mask it — the causes aggregate instead.
    const disposeErrors = await collectDisposeErrors(() => host.dispose())
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote runtime: host disposal failures during client-failure unwind')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }

  let disposed = false
  return {
    host,
    client,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      // Client first, then Host — both run even if the first throws; the
      // first collected error surfaces with the second attached as cause.
      const errors = [
        ...await collectDisposeErrors(() => client.dispose()),
        ...await collectDisposeErrors(() => host.dispose()),
      ]
      if (errors.length > 0) {
        const failure = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
        if (errors.length > 1) {
          mergeCause(failure, new AggregateError(errors.slice(1), 'remote runtime: remaining disposal failures'))
        }
        throw failure
      }
    },
  }
}

/** Compile-time proof that the ONE M3-1 Client runtime satisfies the Remote
 *  ConfigPort's narrow source face (never called; referenced by the
 *  official-contract gate). */
export function remoteConfigRuntimeSourceOf(runtime: RemoteClientRuntime): RemoteConfigRuntimeSource {
  return runtime
}

/** Inputs for the complete experimental Remote `Backend` assembly. */
export interface RemoteBackendRuntimeOptions {
  /** The ONE M3-1 Client runtime every adapter shares. */
  readonly runtime: RemoteClientRuntime
  /** The application-owned prompt serializer (the D2.2 writer dependency).
   * Absent selects the PRODUCTION serializer (M3-4 PR3): the PreparedPrompt
   * → official PromptContentPart mapping over the same Client sessions face.
   * Composition tests may still inject an explicit stub. */
  readonly promptSerializer?: RemotePromptSerializer
  /** The composition-owned fetch the archive adapter addresses. */
  readonly fetch: InProcessHostCarrier['fetch']
}

/** The complete experimental Remote `Backend` plus its disposal owner. */
export interface RemoteBackendRuntime {
  readonly backend: Backend
  readonly semantics: RemoteM3ASemantics
  /** Drop adapter-owned caches/subscriptions. Runs BEFORE the Client
   *  Context disposal (`RemoteClientRuntime.dispose()`). Idempotent. */
  dispose(): void
}

/**
 * Assemble the complete experimental Remote `Backend` (M3-3B) from ONE M3-1
 * Client runtime: the M3-3A semantic bundle (session/runtime/catalog/host-file
 * + the M3-3B interaction and Plugin Manager/Job-observation adapters), the
 * Remote ConfigPort mirror, and the Remote session archive. It is NOT a
 * production cutover: normal startup still selects Direct.
 *
 * Construction is TRANSACTIONAL in the caller's ownership sense: every part
 * that installs its own subscriptions/caches (the semantics bundle, the
 * ConfigPort mirror) is unwound — adapters before anything the caller owns —
 * when a LATER assembly step throws before this function returns. The caller
 * therefore never receives or leaks backend partial state (plan §12).
 */
export async function createRemoteBackendRuntime(
  options: RemoteBackendRuntimeOptions,
): Promise<RemoteBackendRuntime> {
  // Reverse-unwind ledger of the constructed parts, in construction order.
  // Each entry runs that part's disposal exactly once, error-isolated from
  // the others; the first collected error surfaces with the rest attached.
  const unwind: Array<() => void> = []
  const runReverse = (): void => {
    const errors: unknown[] = []
    for (let index = unwind.length - 1; index >= 0; index -= 1) {
      try {
        unwind[index]()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      const failure = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
      if (errors.length > 1) {
        mergeCause(failure, new AggregateError(errors.slice(1), 'remote backend runtime: remaining disposal failures'))
      }
      throw failure
    }
  }
  try {
    const semantics = createRemoteM3ASemantics(remoteM3ARuntimeSourceOf(options.runtime), {
      // The production serializer is the DEFAULT (M3-4 PR3): it consumes the
      // application PreparedPrompt and reads recalled durable images through
      // the official binding-scoped attachment read. An explicit injection
      // (composition tests) still wins.
      promptSerializer: options.promptSerializer
        ?? RemotePromptSerializerProduction.overSessions(options.runtime.sessions),
    })
    unwind.push(() => semantics.dispose())
    const config = new RemoteConfigPort(remoteConfigRuntimeSourceOf(options.runtime))
    unwind.push(() => config.dispose())
    const sessionArchive = new RemoteSessionArchive({ fetch: options.fetch })
    // §2.3/§4.1 config readiness barrier: the mirror's invalidation listeners
    // are already installed (the port's constructor), the M3-1 Client runtime
    // already awaited its own initial readiness (so a Connection generation
    // exists), and THIS is the first read. Awaiting it here is what makes a
    // freshly assembled Remote backend's settings/providers/permissions
    // readable instead of permanently 'stale'.
    //
    // A transient failure must not prevent the backend from existing: the mirror
    // RECORDS it (`lastRefreshFailure()`), `readiness()` stays 'stale', and the
    // next invalidation / write pre-flight / explicit read retries. The
    // consumer then shows a truthful unavailable state instead of fabricated
    // values.
    try {
      await config.describe()
    } catch {
      // Recorded by `RemoteConfigPort.describe()`; construction continues.
    }
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      runReverse()
    }
    return {
      backend: createRemoteBackend({
        ...semantics,
        config,
        sessionArchive,
        // M3-4 PR3: the Remote Host user-shell adapter (truthful
        // unavailable; CARRIER_GAP) — served by the backend, so the
        // composition root holds no static Remote edge.
        hostUserShell: new RemoteHostUserShellPort(),
      }),
      semantics,
      dispose,
    }
  } catch (error) {
    // A failure at ANY point after the first constructed part (including the
    // final `createRemoteBackend` assembly) unwinds every constructed part
    // before the caller sees the rejection: backend partial state does not
    // survive. An unwind failure rides the original error's cause chain
    // without masking it.
    let unwindFailure: unknown
    try {
      runReverse()
    } catch (secondary) {
      unwindFailure = secondary
    }
    if (unwindFailure !== undefined) {
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), unwindFailure)
    }
    throw error
  }
}

// M3-4 PR1 single-entry re-export: the ONE dynamic boundary
// (`runtime/backend-loader.ts`) imports THIS module; the application-runtime
// aggregate joins through this intra-`app/remote` STATIC edge instead of a
// second dynamic target, keeping the frozen "ONE dynamic edge into
// app/remote/**" contract intact.
export {
  createRemoteApplicationRuntime,
  type RemoteApplicationRuntime,
  type RemoteApplicationRuntimeOptions,
} from './application-runtime.ts'
