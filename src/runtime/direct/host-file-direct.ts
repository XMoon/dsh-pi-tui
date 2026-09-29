/**
 * The Direct Host-file adapter (M1.10, realigned M3-3A) — the in-process
 * implementation of `HostFilePort` over the OFFICIAL Host authority:
 *
 * ```text
 * session scope   -> ctx.fileReferences.list(agent, query, signal)
 *                    (the official @deepseek-ai/dsh-file-reference-local
 *                    provider the TUI composition mounts — the same Host
 *                    service the wire `fileReferences/list` forwards to)
 * workspace scope -> the Direct-only legacy scanner (fd/fdfind whole-tree
 *                    fuzzy, the bounded recursive fallback) — a sessionless
 *                    compatibility path with NO official carrier (the wire
 *                    answers `unavailable`); it must not define the
 *                    session `@file` semantics
 * ```
 *
 * The official service owns the workspace root, ranking, result bounds,
 * excluded directories, caching and tool-result invalidation — this
 * adapter maps, it does not re-implement. `query` is the official wire
 * form (path text following `@`, outside quotes); the `resolveReference`
 * existence probe is a Direct-only diagnostic seam (the wire has no
 * carrier and the submission path consumes nothing).
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-file-direct
 */

import { statSync } from 'node:fs'
import { resolveMentionCandidate } from '../../mentions.ts'
import type { DiscoverySource } from '../../file-completion/discovery.ts'
import { discoverForQuery, resolveFdPath } from '../../file-completion/discovery.ts'
import { presentDiscovery, reattachDisplayBase, resolveQuery } from '../../file-completion/engine.ts'
import type {
  HostFileCandidate,
  HostFileListResult,
  HostFilePort,
  HostFileResolveResult,
  HostFileScope,
} from '../host-file-port.ts'

/** A live agent as the adapter resolves the session scope (structural
 * projection: the workspace cwd). */
export interface LiveAgentLike {
  readonly session: { readonly header: { readonly cwd?: string } }
}

/** The structural official `ctx.fileReferences` face (the
 * `FileReferenceService.list` subset — the exact session Agent, the
 * official query form, caller cancellation). */
export interface FileReferencesServiceLike {
  list(
    agent: unknown,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly HostFileCandidate[]>
}

/** The minimal Host context surface (structural — the service resolves
 * from the dsh installation; never a package dependency). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The Direct backend's Host-file port: the current TUI filesystem
 * mechanics behind the semantic `HostFilePort` interface. */
export class DirectHostFilePort implements HostFilePort {
  private readonly ctx: HostContextLike | undefined
  private readonly fdPath: string | null
  private readonly agentFor: (sessionId: string) => unknown | undefined

  /** @param ctx - the Host context carrying the official
   *   `ctx.fileReferences` service (the session scope's authority). A
   *   ctx-less construction (tests/legacy call sites) answers the session
   *   scope `unavailable` and keeps only the workspace compatibility
   *   path. @param agentFor - the session-id → live-agent resolver
   *   (runner injected). @param fdPath - the Host's fd/fdfind executable
   *   for the WORKSPACE compatibility scanner; defaults to the PATH probe;
   *   tests inject `null` to pin the fallback scan. */
  constructor(
    agentFor: (sessionId: string) => unknown | undefined,
    fdPathOrCtx: string | null | HostContextLike = resolveFdPath(),
    maybeCtx?: HostContextLike,
  ) {
    if (typeof fdPathOrCtx === 'string' || fdPathOrCtx === null) {
      this.fdPath = fdPathOrCtx
      this.ctx = maybeCtx
    } else {
      this.ctx = fdPathOrCtx
      this.fdPath = resolveFdPath()
    }
    this.agentFor = agentFor
  }

  /** The official `ctx.fileReferences` service, when the composition
   *  mounts it (the `dsh-file-reference-local` row). */
  private fileReferences(): FileReferencesServiceLike | undefined {
    return this.ctx?.get('fileReferences') as FileReferencesServiceLike | undefined
  }

  /** The discovery seam this adapter answers with (the Host's own fd
   * detection — the port's discovery source is ALWAYS the Host fs). */
  private get discoverySource(): DiscoverySource {
    return { fdPath: this.fdPath }
  }

  /** TEST seam: the resolved fd/fdfind executable (null = fallback-only).
   * Lets an fd-backed test assert it actually runs through a finder. */
  fdPathAvailableForTest(): string | null {
    return this.fdPath
  }

  /** The scope's workspace cwd (undefined = the session is unresolvable —
   * a fail-closed empty discovery). A RESOLVED session without a header
   * cwd falls back to the process cwd — DIRECT-mode parity with the
   * runner's sessionCwd() (the Client machine IS the Host machine); a
   * Remote adapter must NOT inherit this fallback (the plan's locality
   * rule: remote discovery fails closed on an unresolvable scope). */
  private scopeCwd(scope: HostFileScope): string | undefined {
    if (scope.kind === 'workspace') return scope.cwd
    const agent = this.agentFor(scope.sessionId) as LiveAgentLike | undefined
    if (agent === undefined) return undefined
    return agent.session.header.cwd ?? process.cwd()
  }

  async listReferences(
    scope: HostFileScope,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileListResult> {
    // Cancellation wins over EVERY other outcome (the M3-3A failure
    // vocabulary): an aborted request rejects at entry — before any
    // scope/capability decision.
    options?.signal?.throwIfAborted()

    if (scope.kind === 'session') {
      // The OFFICIAL Host authority: the exact session Agent and the
      // official query form (path text following `@`) go straight to
      // `ctx.fileReferences.list` — the same service the wire
      // `fileReferences/list` forwards to. The service owns the workspace
      // root, ranking, bounds, excluded directories and caching; this
      // adapter only detaches the result.
      const agent = this.agentFor(scope.sessionId)
      if (agent === undefined) {
        return { kind: 'unavailable', reason: 'the session scope has no resolvable live Agent' }
      }
      const references = this.fileReferences()
      if (references === undefined) {
        return { kind: 'unavailable', reason: 'the official Host file-reference service is not mounted' }
      }
      const signal = options?.signal ?? new AbortController().signal
      const candidates = await references.list(agent, query, signal)
      signal.throwIfAborted()
      return {
        kind: 'ok',
        items: candidates.map(candidate => ({ path: candidate.path, kind: candidate.kind })),
      }
    }

    // WORKSPACE scope: a Direct-only sessionless compatibility path with
    // NO official carrier (the wire answers `unavailable`). The legacy
    // scanner (fd/fdfind, bounded recursive fallback) answers behind the
    // same path-only contract; it must not define the session semantics.
    // `query` is already the official form (text following `@`): a literal
    // `@@dir/file` mention normalizes to the query `@dir/file` — no grammar
    // parsing here, the scanner engine owns scope resolution for the raw
    // text.
    const workDir = scope.cwd
    const signal = options?.signal
    try {
      const resolved = resolveQuery(query, workDir)
      const candidates = await discoverForQuery(resolved, this.discoverySource, signal ?? new AbortController().signal)
      signal?.throwIfAborted()
      // THE PORT CONTRACT: the candidates cross ALREADY ranked, filtered
      // and bounded, in the adapter's own order. This compatibility path
      // has no official authority, so the adapter completes the legacy
      // ranking itself (the engine's rank/slice, over the reattached
      // user-facing paths) — the client never re-ranks what a source
      // returned.
      const displayed = candidates.map(candidate => reattachDisplayBase(candidate, resolved))
      const ranked = presentDiscovery(displayed, resolved.searchTerm, { at: false, quoted: false })
      return {
        kind: 'ok',
        items: ranked.map(item => {
          // presentPathCandidate's label IS the user-facing path (+ the
          // directory slash marker); the DTO wants the bare path + kind.
          const path = item.label.endsWith('/') ? item.label.slice(0, -1) : item.label
          const source = displayed.find(candidate => candidate.path === path)
          return { path, kind: source?.kind ?? 'file' }
        }),
      }
    } catch {
      signal?.throwIfAborted()
      return { kind: 'unavailable', reason: 'local file discovery failed' }
    }
  }

  async resolveReference(
    scope: HostFileScope,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileResolveResult> {
    // A cancelled probe rejects before any filesystem access — cancellation
    // wins over the unresolvable-scope unavailable below (M3-3A failure
    // vocabulary).
    options?.signal?.throwIfAborted()
    const cwd = this.scopeCwd(scope)
    if (cwd === undefined) {
      return { kind: 'unavailable', reason: 'the session scope has no resolvable Host workspace' }
    }
    const candidate = resolveMentionCandidate(path, cwd)
    return exists(candidate)
      ? { kind: 'found', path: candidate }
      : { kind: 'missing' }
  }

  async canonicalizeMentions(_scope: HostFileScope, text: string): Promise<string> {
    // The OFFICIAL mention semantics (M3-3A realignment): the selected
    // `@`-reference is literal prompt text and the Host's
    // FILE_REFERENCE_PROMPT (installed by the official
    // dsh-file-reference-local row the composition mounts) owns its
    // resolution. The historical existence-probe absolute rewrite — a
    // Direct-only behavior the wire has no carrier for — is retired so
    // both backends send the SAME bytes for the same input.
    return text
  }
}

/** The synchronous existence probe (the Direct machine IS the Host
 * machine; a Remote adapter swaps this for the official capability). */
function exists(candidate: string): boolean {
  try {
    statSync(candidate)
    return true
  } catch {
    return false
  }
}

/** Re-exported for the migration guard (the bundle boundary gate
 * allowlists the discovery module's fd probe). */
export { resolveFdPath }
