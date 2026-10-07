/**
 * The Direct Host-file adapter (M1.10, realigned M3-3A, scoped route TS8-HF1) —
 * the in-process implementation of `HostFilePort`:
 *
 * ```text
 * session scope   -> the shared Host router
 *                    (runtime/direct/host-file-augmentation-direct.ts):
 *                      bare `@foo`       -> official ctx.fileReferences.list
 *                                           (the same Host service the official
 *                                           wire `fileReferences/list` forwards
 *                                           to)
 *                      explicit `@src/`  -> dsh-pi-tui Host scoped discovery
 *                                           (`host-discovery.ts`)
 * workspace scope -> the Direct-only WORKSPACE compatibility scanner
 *                    (`runtime/direct/file-completion/host-discovery.ts`:
 *                    fd/fdfind whole-tree fuzzy, the bounded recursive
 *                    fallback) — a sessionless compatibility path with NO
 *                    official carrier (the wire answers `unavailable`); it
 *                    must not define the session `@file` semantics
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
import { homedir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import { discoverForQuery, type LocalDiscoveryDriver } from '../../domain/file-completion/discovery-policy.ts'
import { reattachDisplayBase, resolvePathQuery } from '../../domain/file-completion/query.ts'
import { rankPathCandidates } from '../../domain/file-completion/ranking.ts'
import {
  DirectHostDiscoveryDriver,
  hostPathQueryEnvironment,
  resolveFdPath,
} from './file-completion/host-discovery.ts'
import {
  listPiTuiHostFileReferences,
  type FileReferencesServiceLike,
  type LiveAgentLike,
} from './host-file-augmentation-direct.ts'
import type {
  HostFileListResult,
  HostFilePort,
  HostFileResolveResult,
  HostFileScope,
} from '../host-file-port.ts'

export type { FileReferencesServiceLike, LiveAgentLike } from './host-file-augmentation-direct.ts'

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
   *   `ctx.fileReferences` service (the bare-query authority). A
   *   ctx-less construction (tests/legacy call sites) answers a bare
   *   session query `unavailable` and keeps the explicit-scope and
   *   workspace compatibility paths. @param agentFor - the session-id →
   *   live-agent resolver (runner injected). @param fdPath - the Host's
   *   fd/fdfind executable for the Host scanners; defaults to the PATH
   *   probe; tests inject `null` to pin the fallback scan. */
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

  /** The discovery boundary this adapter answers with: the Direct Host's own
   * filesystem (the WORKSPACE compatibility path's scanner and the session
   * explicit-scope route both read the Host fs, never the Client's). */
  private get hostDiscovery(): LocalDiscoveryDriver {
    return new DirectHostDiscoveryDriver(this.fdPath)
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
      // The shared Host router owns the route decision: a BARE query goes to
      // the official Host authority (the same service the wire
      // `fileReferences/list` forwards to), an EXPLICIT path scope
      // (`@src/`, `@../`, `@/abs`, `@~/`) goes to the Host scoped discovery.
      // This adapter owns only the Session→Agent locality lookup.
      const agent = this.agentFor(scope.sessionId) as LiveAgentLike | undefined
      if (agent === undefined) {
        return { kind: 'unavailable', reason: 'the session scope has no resolvable live Agent' }
      }
      const signal = options?.signal ?? new AbortController().signal
      return await listPiTuiHostFileReferences(agent, query, signal, {
        official: this.fileReferences(),
        driver: this.hostDiscovery,
        environment: hostPathQueryEnvironment(),
      })
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
      const resolved = resolvePathQuery(query, workDir, hostPathQueryEnvironment())
      const candidates = await discoverForQuery(resolved, this.hostDiscovery, signal ?? new AbortController().signal)
      signal?.throwIfAborted()
      // THE PORT CONTRACT: the candidates cross ALREADY ranked, filtered
      // and bounded, in the adapter's own order. This compatibility path
      // has no official authority, so the adapter completes the legacy
      // ranking itself (the pure neutral rankPathCandidates over the
      // reattached user-facing paths — no UI DTO round-trip) — the client
      // never re-ranks what a source returned.
      const displayed = candidates.map(candidate => reattachDisplayBase(candidate, resolved))
      const ranked = rankPathCandidates(displayed, resolved.searchTerm)
      return {
        kind: 'ok',
        items: ranked.map(candidate => ({ path: candidate.path, kind: candidate.kind })),
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
    const candidate = resolveReferenceCandidate(path, cwd)
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

/**
 * Resolve ONE raw Host reference path to the candidate absolute path: `~`
 * expands through the Host homedir, an absolute path stays as-is, a
 * relative path resolves against the Host workspace cwd. PURE — the Direct
 * diagnostic `resolveReference` seam's own path resolution.
 */
function resolveReferenceCandidate(raw: string, hostCwd: string): string {
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return raw === '~'
      ? homedir()
      : join(homedir(), raw.slice(2).replace(/\\/g, '/'))
  }
  // `path.isAbsolute` follows the host OS. The reference grammar must also
  // preserve Windows drive/UNC references when a client process is POSIX
  // (and must not mistake a POSIX `/tmp` path for a Windows path on Windows).
  if (isAbsolute(raw) || (!raw.startsWith('/') && win32.isAbsolute(raw))) return raw
  // A relative Windows-looking token is still relative to the Host scope;
  // normalize its separators only when the scope itself is POSIX.
  return raw.includes('\\') && process.platform !== 'win32'
    ? join(hostCwd, raw.replace(/\\/g, '/'))
    : join(hostCwd, raw)
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

/** Re-exported for the WORKSPACE compatibility scan's finder seam (the tests
 * and the port's own constructor pin the Direct Host's fd/fdfind probe). */
export { resolveFdPath }
