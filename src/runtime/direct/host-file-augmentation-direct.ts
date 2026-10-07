/**
 * The session `@`-reference Host router (TS8-HF1): ONE Host-side authority
 * that answers a completion query with the routing boundary
 *
 * ```text
 * bare workspace fuzzy search          -> official ctx.fileReferences.list
 *   @foo @readme @src @.env               (workspace index, cache, exclusions,
 *                                         scoring, maxResults stay authoritative)
 *
 * explicit path navigation             -> dsh-pi-tui Host scoped discovery
 *   @src/ @src/uti @./ @../shared/foo      (the exact scope the user typed:
 *   @../../foo @/tmp/foo @~/Down           recursive fuzzy inside it, explicit
 *   Windows drive @C:/work/foo and UNC     parent/absolute/native paths)
 * ```
 *
 * The decision is the TOKEN's explicit path navigation, never the resolved
 * search base's workspace containment (the superseded v1 rule): a user-typed
 * separator, a root form (`.`/`..`/`~`) or a Windows absolute path is what
 * selects the scoped route, so `@dist/` and `@link/foo` address their
 * explicitly named scope even when the official provider would exclude or not
 * traverse it.
 *
 * POSIX BOUNDARY: on a POSIX Host a backslash is an ordinary FILENAME character,
 * but the reused TS8-A path resolver selects its Windows dialect from the token
 * alone and normalizes the separators (a pinned cross-dialect contract of the
 * Client-local completion — `test/domain-file-completion.test.ts`). The
 * augmentation therefore does NOT CLAIM an ambiguous POSIX token that contains a
 * backslash: such a token is left to the official provider rather than searched
 * in a scope we cannot represent verbatim. This is a deliberate fail-closed
 * narrowing, not a claim that the token is a bare fuzzy query; delete the guard
 * once the shared resolver distinguishes host dialect, token dialect and literal
 * backslashes.
 *
 * The official provider is called ONLY on the bare route; an authoritative
 * official `[]` stays empty and never falls back to the scanner. The scoped
 * route never calls the official provider and needs no capability from it.
 *
 * Home shorthand (`@~`, `@~/Down`) is dsh-pi-tui INPUT syntax: discovery runs
 * against the Host HOME, but every returned candidate is materialized as an
 * ABSOLUTE Host path — DSH path resolution performs no shell-style `~`
 * expansion, so a literal `~/...` completion value would be unusable. Ranking
 * always scores the SCOPE-RELATIVE candidate, never the materialized absolute
 * path (the home prefix itself must not satisfy the path-substring tier).
 *
 * This authority receives HOST facts only (the live Agent, the Host discovery
 * driver, the Host path environment); it never reads the Client cwd, home or
 * platform.
 *
 * TODO(upstream-file-reference-explicit-scope): Delete the pi-tui
 * explicit-scope augmentation when the minimum supported DSH fileReferences
 * provider supports equivalent explicit scoped recursive search,
 * parent/absolute Host path navigation, explicit excluded/symlink scope
 * access, and a Host-home-safe completion representation.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-file-augmentation-direct
 */

import { posix, win32 } from 'node:path'
import { discoverForQuery, type LocalDiscoveryDriver } from '../../domain/file-completion/discovery-policy.ts'
import {
  reattachDisplayBase,
  resolvePathQuery,
  type PathQueryEnvironment,
} from '../../domain/file-completion/query.ts'
import { rankPathCandidates } from '../../domain/file-completion/ranking.ts'
import type { HostFileCandidate, HostFileListResult } from '../host-file-port.ts'

/** A live agent as the router resolves the session scope (structural
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

/** The Host facts the router answers with. The environment and the driver are
 * the HOST machine's, never the Client's; `official` is read per call so an
 * unmounted provider is an unavailable bare answer, not a constructor error. */
export interface PiTuiHostFileReferenceDeps {
  readonly official: FileReferencesServiceLike | undefined
  readonly driver: LocalDiscoveryDriver
  readonly environment: PathQueryEnvironment
}

/** Whether the token names an EXPLICIT path scope (the frozen classifier,
 * decided from the raw token and the HOST platform — never from filesystem
 * existence, official result count, or workspace containment).
 *
 * A POSIX host has ONE separator: any `/` is an explicit scope, and the root
 * forms are explicit. A token that also contains a backslash is deliberately NOT
 * claimed (see the module comment): the reused resolver cannot represent its
 * literal POSIX scope, so the official provider keeps it.
 *
 * A Windows host treats `\` as a separator as well and accepts any
 * win32-absolute form (drive/UNC) even before its first separator is visible. */
function isExplicitPathNavigation(raw: string, environment: PathQueryEnvironment): boolean {
  if (raw === '') return false
  if (environment.windowsHost) {
    return raw === '.' || raw === '..' || raw === '~'
      || raw.includes('/') || raw.includes('\\') || win32.isAbsolute(raw)
  }
  // POSIX: `\` is a filename character. A mixed `/`+`\` token has an exact scope
  // this augmentation cannot represent through the shared resolver, so it fails
  // closed instead of searching a normalized (different) directory.
  if (raw.includes('\\')) return false
  return raw === '.' || raw === '..' || raw === '~' || raw.includes('/')
}

/** Whether the token is a leading-home form (`~`, `~/x`, `~\x`). */
function isHomeToken(raw: string): boolean {
  return raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
}

/** Materialize one candidate discovered under a HOME scope as an ABSOLUTE Host
 * path (the `~` shorthand must never reach the prompt as literal text). */
function materializeHostPath(candidate: HostFileCandidate, searchBase: string, windowsHost: boolean): HostFileCandidate {
  const api = windowsHost ? win32 : posix
  return { path: api.join(searchBase, candidate.path), kind: candidate.kind }
}

/**
 * Answer one session `@` completion query over the Host facts.
 *
 * Cancellation (the caller's `signal`) outranks every route: an aborted
 * request rejects at entry — before the route/capability decision — and again
 * after each await, so a cancelled scope never serves a late result and never
 * reports `unavailable`.
 *
 * @param agent - the live Agent the session scope resolved to.
 * @param query - the official query form (path text following `@`).
 * @param signal - caller cancellation.
 * @param deps - the Host facts this router answers with.
 */
export async function listPiTuiHostFileReferences(
  agent: LiveAgentLike,
  query: string,
  signal: AbortSignal,
  deps: PiTuiHostFileReferenceDeps,
): Promise<HostFileListResult> {
  signal.throwIfAborted()

  if (!isExplicitPathNavigation(query, deps.environment)) {
    // BARE workspace fuzzy: the OFFICIAL Host authority owns the workspace
    // index, ranking, bounds, exclusions and caching. An authoritative empty
    // answer is final — the scanner is never a fallback.
    const official = deps.official
    if (official === undefined) {
      return { kind: 'unavailable', reason: 'the official Host file-reference service is not mounted' }
    }
    const candidates = await official.list(agent, query, signal)
    signal.throwIfAborted()
    return {
      kind: 'ok',
      items: candidates.map(candidate => ({ path: candidate.path, kind: candidate.kind })),
    }
  }

  // EXPLICIT path navigation: resolve the user-typed scope against the exact
  // Session workspace cwd ON THE HOST (never a Client cwd) and discover inside
  // that scope with the shared TS8-A path/query machinery.
  const workspaceCwd = agent.session.header.cwd ?? process.cwd()
  const resolved = resolvePathQuery(query, workspaceCwd, deps.environment)
  const discovered = await discoverForQuery(resolved, deps.driver, signal)
  signal.throwIfAborted()
  // RANK BEFORE the final path shape is chosen. The home shorthand must return
  // an ABSOLUTE Host path, but scoring those absolute paths would let the HOME
  // prefix itself satisfy the full-path substring tier — a query naming the home
  // directory would then match every candidate. The scoring model always sees
  // the scope-relative candidate; only the accepted value is materialized.
  const homeToken = isHomeToken(query)
  const scored = homeToken
    ? discovered
    : discovered.map(candidate => reattachDisplayBase(candidate, resolved))
  const ranked = rankPathCandidates(scored, resolved.searchTerm)
  return {
    kind: 'ok',
    items: ranked.map(candidate => homeToken
      ? materializeHostPath(candidate, resolved.searchBase, deps.environment.windowsHost)
      : { path: candidate.path, kind: candidate.kind }),
  }
}
