/**
 * The Direct Host-file adapter (M1.10, realigned M3-3A) — the in-process
 * implementation of `HostFilePort` over the CURRENT TUI filesystem
 * behavior: the SHARED file-completion engine (fd/fdfind whole-tree fuzzy
 * when a finder is on the Host PATH, scoped-directory discovery otherwise,
 * the bounded recursive fallback as last resort) and stat-based existence
 * checks. This is the ONLY module in the `@`-file path that touches the
 * filesystem; the pure grammar stays in `src/mentions.ts`, and the Remote
 * adapter maps the same interface onto the official fileReferences wire.
 * The interim same-machine discovery answers the same path-only contract
 * the wire serves; the official `dsh-file-reference-local` provider
 * (mounted by the TUI composition) is the Host-side authority.
 *
 * SCOPED QUERIES (plan §19): `@src/de` searches workspace/src + term `de`;
 * `@../../foo` searches the resolved parent scope; `@~/foo` searches the
 * home scope; `@/tmp/foo` searches the absolute scope. NEVER a whole-tree
 * scan filtered by string — the query resolver in the engine owns the
 * scope split, this adapter only answers discovery.
 *
 * In Direct mode the Client machine IS the Host machine; the session
 * scope resolves through the runner-injected live-agent resolver.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-file-direct
 */

import { statSync } from 'node:fs'
import { resolveMentionCandidate } from '../../mentions.ts'
import type { DiscoverySource } from '../../file-completion/discovery.ts'
import { discoverForQuery, resolveFdPath } from '../../file-completion/discovery.ts'
import { reattachDisplayBase, resolveQuery } from '../../file-completion/engine.ts'
import type {
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

/** The Direct backend's Host-file port: the current TUI filesystem
 * mechanics behind the semantic `HostFilePort` interface. */
export class DirectHostFilePort implements HostFilePort {
  private readonly fdPath: string | null
  private readonly agentFor: (sessionId: string) => unknown | undefined

  /** @param agentFor - the session-id → live-agent resolver (runner
   *   injected). @param fdPath - the Host's fd/fdfind executable; defaults
   *   to the PATH probe; tests inject `null` to pin the fallback scan. */
  constructor(agentFor: (sessionId: string) => unknown | undefined, fdPath: string | null = resolveFdPath()) {
    this.fdPath = fdPath
    this.agentFor = agentFor
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
    const signal = options?.signal
    // Cancellation is CANCELLATION and wins over EVERY other outcome
    // (the M3-3A failure vocabulary: an aborted request rejects — the
    // Remote adapter's `throwIfAborted` shape) — including the
    // unresolvable-scope unavailable below.
    signal?.throwIfAborted()
    const workDir = this.scopeCwd(scope)
    // An unresolvable scope is an UNAVAILABLE capability (the adapter cannot
    // even form the Host-side query), never an authoritative empty answer.
    if (workDir === undefined) {
      return { kind: 'unavailable', reason: 'the session scope has no resolvable Host workspace' }
    }
    // `query` is the editor's at-prefix INCLUDING the leading `@` (and an
    // unclosed `"` for the quoted form). The engine strips the `@` and any
    // trailing quote, resolves the scope and answers discovery with path
    // facts relative to the query's search base.
    const { raw } = stripPrefix(query)
    try {
      const resolved = resolveQuery(raw, workDir)
      const candidates = await discoverForQuery(resolved, this.discoverySource, signal ?? new AbortController().signal)
      // A cancellation landing mid-discovery outranks any result or local
      // failure the engine reported alongside it.
      signal?.throwIfAborted()
      // THE PORT CONTRACT: paths are USER-FACING — the display base the
      // user typed (`../`, `~/pics/`, `/tmp/`, `src/`) is reattached here
      // (the engine's pure reattachment), so the client's presentation
      // (ranking, quoting, the `@`-insertion value) sees final paths.
      return {
        kind: 'ok',
        items: candidates.map(candidate => {
          const display = reattachDisplayBase(candidate, resolved)
          return { path: display.path, kind: display.kind }
        }),
      }
    } catch {
      // A cancellation that surfaced through the engine stays a
      // cancellation; only a genuine local discovery failure is an
      // unavailable answer here (never an authoritative "nothing matches").
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

/** Strip the `@` and any closing quote from one editor at-prefix
 * (`@src/fo` → `src/fo`; `@"my file` → `my file`; `@"closed"` → `closed`). */
function stripPrefix(query: string): { raw: string } {
  if (query.startsWith('@')) {
    const inner = query.slice(1)
    if (inner.startsWith('"')) {
      return { raw: inner.endsWith('"') ? inner.slice(1, -1) : inner.slice(1) }
    }
    return { raw: inner }
  }
  return { raw: query }
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
