/**
 * The shared Remote backend assembly (M3-3B) that the real split Client
 * consumes: the semantic bundle, the Remote ConfigPort mirror and the Remote
 * session archive over ONE Client runtime source.
 *
 * This module is PRODUCTION code. It contains no in-process Host carrier and no
 * M3 wire composer: the retired M3 join lives in
 * `test/support/m3-inprocess/runtime.ts`, and `src/**` cannot reach it.
 *
 * @module app/remote/runtime
 */

import type { Backend } from '../../runtime/backend.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { RemoteConfigPort, type RemoteConfigRuntimeSource } from '../../runtime/remote/config-remote.ts'
import { RemoteConfigWriteLifetime } from '../../runtime/remote/config-write-lifetime.ts'
import { RemoteSessionPolicyPort } from '../../runtime/remote/session-policy-remote.ts'
import { RemoteTeamModePort } from '../../runtime/remote/team-mode-remote.ts'
import { RemoteSessionArchive } from '../../runtime/remote/session-archive-remote.ts'
import { RemoteSessionMarkdown } from '../../runtime/remote/session-markdown-remote.ts'
import { createRemoteBackend } from '../../runtime/remote/backend-remote.ts'
import { RemotePromptSerializerProduction } from '../../runtime/remote/prompt-serializer-remote.ts'
import { createRemoteFileReceiptUploader } from '../../runtime/remote/file-upload-remote.ts'
import { RemoteHostUserShellPort } from '../../runtime/remote/host-user-shell-remote.ts'
import { RemoteHostShellCompletionPort } from '../../runtime/remote/host-shell-completion-remote.ts'
import { RemoteWebAccessPort } from '../../runtime/remote/web-access-remote.ts'
import { RemoteAcpAccessPort } from '../../runtime/remote/acp-access-remote.ts'
import { mergeCause } from './dispose-cause.ts'
import { createRemoteM3ASemantics, remoteM3ARuntimeSourceOf, type RemoteM3ARuntimeSource, type RemoteM3ASemantics } from './m3a-semantics.ts'
import type { SplitClientInteractionDelivery } from '../../runtime/remote/interaction-remote.ts'

/** Compile-time proof that the shared Client runtime source satisfies the
 *  Remote ConfigPort's narrow source face (never called; referenced by the
 *  official-contract gate). The M3-1 Client runtime AND the real split
 *  Client's Domain mount are the same structural source; the config-plane
 *  namespaces stay part of the ONE `remote` service, never a second object. */
export function remoteConfigRuntimeSourceOf(
  runtime: RemoteM3ARuntimeSource,
  trustedHostOrigin?: string,
): RemoteConfigRuntimeSource {
  return {
    remote: runtime.remote,
    connection: runtime.connection,
    ...(trustedHostOrigin === undefined ? {} : { trustedHostOrigin }),
  }
}

/** The composition-owned unary Fetch face the archive adapter addresses:
 *  exactly `typeof fetch` structurally (the M3 in-process carrier and the B1
 *  authenticated Cookie carrier both satisfy it). */
export type RemoteBackendFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Inputs for the complete experimental Remote `Backend` assembly. */
export interface RemoteBackendRuntimeOptions {
  /** Split-Client only: the Client-root interaction delivery owner. */
  readonly delivery?: SplitClientInteractionDelivery
  /** Split-Client only: the surface revision identity attached to `delivery`. */
  readonly surfaceRevision?: number
  /** Qualification-only telemetry forwarded to the Remote interaction port. */
  readonly onQualification?: (record: Record<string, unknown>) => void
  /** The ONE shared Client runtime source every adapter consumes: the M3-1
   *  Client runtime or the real split Client's mounted official Domains —
   *  never a second graph. */
  readonly runtime: RemoteM3ARuntimeSource
  /** The application-owned prompt serializer (the D2.2 writer dependency).
   * Absent selects the PRODUCTION serializer (M3-4 PR3): the PreparedPrompt
   * → official PromptContentPart mapping over the same Client sessions face.
   * Composition tests may still inject an explicit stub. */
  readonly promptSerializer?: RemotePromptSerializer
  /** The composition-owned fetch the archive adapter addresses. */
  readonly fetch: RemoteBackendFetch
  /** The authenticated Host listener origin from the verified Client Host identity. */
  readonly trustedHostOrigin?: string
  /** The composition-owned surface/process lifetime for pre-prompt preparation. */
  readonly signal?: AbortSignal
  /** The composition-owned pre-dispatch dispatch admission (the surface-stop
   *  fence the Remote session writer consults immediately before dispatch).
   *  Absent = every pre-dispatch write is admissible (the pre-fence behavior). */
  readonly isDispatchAllowed?: () => boolean
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
    // ONE composition-owned receipt uploader: the production prompt serializer
    // and the Host command port stage their files through the SAME official
    // authenticated raw-upload route. A test-injected prompt serializer must
    // not cost the command path its staging capability.
    const uploader = createRemoteFileReceiptUploader(options.fetch)
    const semantics = createRemoteM3ASemantics(remoteM3ARuntimeSourceOf(options.runtime), {
      // The production serializer is the DEFAULT (M3-4 PR3): it consumes the
      // application PreparedPrompt and reads recalled durable images through
      // the official binding-scoped attachment read. An explicit injection
      // (composition tests) still wins.
      promptSerializer: options.promptSerializer
        ?? RemotePromptSerializerProduction.overSessions(options.runtime.sessions, uploader),
      fileReceiptUploader: uploader,
      ...(options.isDispatchAllowed === undefined ? {} : { isDispatchAllowed: options.isDispatchAllowed }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
      ...(options.surfaceRevision === undefined ? {} : { surfaceRevision: options.surfaceRevision }),
      ...(options.onQualification === undefined ? {} : { onQualification: options.onQualification }),
    })
    unwind.push(() => semantics.dispose())
    // M6-1 F8: the ONE shared accepted-write lifetime. The ConfigPort's
    // settings/credential writes and the session-policy approval write both
    // bracket through it, so the Client reload gate observes every accepted
    // persisted write through ONE fact (never a second counter).
    const writeLifetime = new RemoteConfigWriteLifetime()
    const config = new RemoteConfigPort(
      remoteConfigRuntimeSourceOf(options.runtime, options.trustedHostOrigin),
      { writeLifetime },
    )
    unwind.push(() => config.dispose())
    const sessionArchive = new RemoteSessionArchive({ fetch: options.fetch })
    // S5-PR3: the official authenticated Markdown read over the SAME
    // composition-owned fetch; the Host-only profile already registers the
    // official route, so this adapter never mounts a second Host row.
    const sessionMarkdown = new RemoteSessionMarkdown({ fetch: options.fetch })
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
        sessionMarkdown,
        hostUserShell: new RemoteHostUserShellPort(
          options.runtime.remote.piTuiHostUserShell,
          options.runtime.connection.generation,
        ),
        hostShellCompletion: new RemoteHostShellCompletionPort(
          options.runtime.remote.piTuiHostUserShell,
          options.runtime.connection.generation,
        ),
        // M5-W PR-C: the Split Client's Web frontend control over the package's
        // ONE private `piTuiWebAccess` namespace and the SAME Connection
        // generation source every other adapter fences on.
        webAccess: new RemoteWebAccessPort(
          options.runtime.remote.piTuiWebAccess,
          options.runtime.connection.generation,
        ),
        // PO-1B: the Split Client's local ACP listener control over the package's
        // ONE private `piTuiAcpAccess` namespace and the SAME Connection
        // generation source every other adapter fences on.
        acpAccess: new RemoteAcpAccessPort(
          options.runtime.remote.piTuiAcpAccess,
          options.runtime.connection.generation,
        ),
        // M6-1 F8: the exact-Session policy port over the SAME mounted
        // contribution namespace, the SAME Connection generation source and
        // the SHARED accepted-write lifetime above.
        sessionPolicy: new RemoteSessionPolicyPort(
          options.runtime.remote.piTuiSessionPolicy,
          options.runtime.connection.generation,
          writeLifetime,
        ),
        // FR1: the official generated `agentTeams` namespace over the SAME
        // Client sessions service and the SAME Connection generation source.
        // A missing mounted namespace is a truthful unavailable, never Direct.
        teamMode: new RemoteTeamModePort({
          sessions: options.runtime.sessions,
          remote: { agentTeams: options.runtime.remote.agentTeams },
          connection: { generation: options.runtime.connection.generation },
        }),
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
