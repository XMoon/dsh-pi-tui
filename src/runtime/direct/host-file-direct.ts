/**
 * The Direct Host-file adapter (M1.10) — the in-process implementation of
 * `HostFilePort` over the CURRENT TUI filesystem behavior: fd whole-tree
 * fuzzy search when fd is on PATH (delegated to the vendored fork's
 * machinery so the ranking/capping stays byte-identical), the bounded
 * recursive fallback scan otherwise, and stat-based existence checks. This
 * is the ONLY module in the `@`-file path that touches the filesystem; the
 * pure grammar (`findFileMentions`, the rewrite rules) stays in
 * `src/mentions.ts`, and a Remote adapter will implement the same
 * interface over the official fileReferences capability in a later
 * milestone.
 *
 * In Direct mode the Client machine IS the Host machine; the session
 * scope resolves through the runner-injected live-agent resolver.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-file-direct
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CombinedAutocompleteProvider } from '@xmoon76/pi-tui'
import {
  expandFileMentionsForSubmit,
  resolveMentionCandidate,
} from '../../mentions.ts'
import type {
  HostFileCandidate,
  HostFilePort,
  HostFileResolveResult,
  HostFileScope,
} from '../host-file-port.ts'

/** A live agent as the adapter resolves the session scope (structural
 * projection: the workspace cwd). */
export interface LiveAgentLike {
  readonly session: { readonly header: { readonly cwd?: string } }
}

/** One scanned candidate of the recursive fallback (relative display path
 * + filesystem facts). */
interface FsMentionCandidate {
  readonly path: string
  readonly absolutePath: string
  readonly isDirectory: boolean
}

/** The recursive scan bounds (kimi MAX_FALLBACK_SCAN / SUGGESTIONS). */
const MAX_FALLBACK_SCAN = 2000
const MAX_FALLBACK_SUGGESTIONS = 50

/** Locate an executable `fd` on the HOST PATH (bare command names resolve
 * through PATH at spawn time; absolute/relative entries must exist and be
 * X_OK). POSIX PATH separators only — moved VERBATIM from the pre-migration
 * mentions.ts (this deployment targets POSIX hosts; a Windows Host would
 * need a platform-aware probe, recorded as a portability note, not a
 * Direct behavior change). */
export function resolveFdPath(): string | null {
  const pathEntries = process.env.PATH?.split(':').filter(entry => entry !== '') ?? []
  for (const dir of pathEntries) {
    const candidate = join(dir, 'fd')
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Not here; keep scanning.
    }
  }
  return null
}

/** The Direct backend's Host-file port: the current TUI filesystem
 * mechanics behind the semantic `HostFilePort` interface. */
export class DirectHostFilePort implements HostFilePort {
  private readonly fdPath: string | null
  private readonly agentFor: (sessionId: string) => unknown | undefined

  /** @param agentFor - the session-id → live-agent resolver (runner
   *   injected). @param fdPath - the Host's fd executable; defaults to the
   *   PATH probe; tests inject `null` to pin the fallback scan. */
  constructor(agentFor: (sessionId: string) => unknown | undefined, fdPath: string | null = resolveFdPath()) {
    this.fdPath = fdPath
    this.agentFor = agentFor
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
  ): Promise<readonly HostFileCandidate[]> {
    const workDir = this.scopeCwd(scope)
    if (workDir === undefined) return []
    const signal = options?.signal
    if (this.fdPath !== null) {
      try {
        // The fork's fd-backed whole-tree fuzzy search with the SAME item
        // shapes the editor produced before the migration: delegate the
        // query as the fork's synthetic `@` line so ranking, capping and
        // quoting stay byte-identical.
        const provider = new CombinedAutocompleteProvider([], workDir, this.fdPath)
        const result = await provider.getSuggestions([query], 0, query.length, { signal: signal ?? new AbortController().signal })
        if (result !== null) return result.items.map(toCandidate)
        return []
      } catch {
        // fd failed to spawn: keep `@` usable through the fallback.
      }
    }
    return fsMentionSuggestions(workDir, query, signal).map(toCandidate)
  }

  async resolveReference(
    scope: HostFileScope,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileResolveResult> {
    // An already-aborted request is a cancelled probe: fail closed before
    // any filesystem access (the caller never consumes a cancelled result).
    if (options?.signal?.aborted === true) return { kind: 'missing' }
    const cwd = this.scopeCwd(scope)
    if (cwd === undefined) return { kind: 'missing' }
    const candidate = resolveMentionCandidate(path, cwd)
    return exists(candidate)
      ? { kind: 'found', path: candidate }
      : { kind: 'missing' }
  }

  async canonicalizeMentions(scope: HostFileScope, text: string): Promise<string> {
    const cwd = this.scopeCwd(scope)
    if (cwd === undefined) return text
    return expandFileMentionsForSubmit(text, cwd, exists)
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

/** Map one discovery item onto the detached candidate DTO. */
function toCandidate(item: { value: string; label?: string; description?: string }): HostFileCandidate {
  const label = item.label ?? ''
  const value = item.value
  const isDirectory = label.endsWith('/') || value.endsWith('/')
  return {
    value,
    label,
    description: item.description ?? '',
    kind: isDirectory ? 'directory' : 'file',
  }
}

/** Recursively collect candidates under the workspace (bounded, `.git`
 * skipped). PRESERVED pre-migration behavior: the fd path follows the
 * Host's ignore rules, the fallback deliberately skips only `.git` (kimi
 * parity) — ignored/sensitive files may appear when fd is absent, exactly
 * as before the migration (documented, not a regression). */
function collectFsMentionCandidates(
  workDir: string,
  signal?: AbortSignal,
): FsMentionCandidate[] {
  const aborted = (): boolean => signal?.aborted === true
  const candidates: FsMentionCandidate[] = []
  const stack: string[] = ['']
  let scanned = 0
  while (stack.length > 0 && scanned < MAX_FALLBACK_SCAN) {
    if (aborted()) break
    const relativeDir = stack.pop() ?? ''
    const absoluteDir = relativeDir === '' ? workDir : join(workDir, relativeDir)
    let entries
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (aborted() || scanned >= MAX_FALLBACK_SCAN) break
      if (entry.name === '.git') continue
      const relativePath = relativeDir === '' ? entry.name : join(relativeDir, entry.name)
      const absolutePath = join(absoluteDir, entry.name)
      let isDirectory = entry.isDirectory()
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(absolutePath).isDirectory()
        } catch {
          // Broken symlink or permission error — keep it as a file candidate.
        }
      }
      scanned += 1
      candidates.push({ path: relativePath, absolutePath, isDirectory })
      if (isDirectory && !entry.isSymbolicLink()) {
        stack.push(relativePath)
      }
    }
  }
  return candidates
}

/** Rank candidates against the query (the pre-migration scoring). */
function scoreCandidate(candidate: FsMentionCandidate, lowerQuery: string): number {
  if (lowerQuery === '') {
    const depthPenalty = candidate.path.split('/').length - 1
    return (candidate.isDirectory ? 120 : 100) - depthPenalty
  }
  const lowerPath = candidate.path.toLowerCase()
  const lowerBase = basename(candidate.path).toLowerCase()
  let score = 0
  if (lowerBase === lowerQuery) score = 100
  else if (lowerBase.startsWith(lowerQuery)) score = 80
  else if (lowerBase.includes(lowerQuery)) score = 50
  else if (lowerPath.includes(lowerQuery)) score = 30
  if (candidate.isDirectory && score > 0) score += 10
  return score
}

/** The completion item for one candidate: `@path` (quoted when it has
 * spaces), directories keep their trailing `/` so `@dir/` continues. The
 * QUOTED form (`@"…"`) forces the quoted value regardless of spaces —
 * the fork's quoted-prefix parity. */
function toMentionCandidate(candidate: FsMentionCandidate, quoted: boolean): HostFileCandidate {
  const valuePath = candidate.isDirectory ? `${candidate.path}/` : candidate.path
  const value = quoted || valuePath.includes(' ') ? `@"${valuePath}"` : `@${valuePath}`
  return {
    value,
    label: `${basename(candidate.path)}${candidate.isDirectory ? '/' : ''}`,
    description: candidate.absolutePath,
    kind: candidate.isDirectory ? 'directory' : 'file',
  }
}

/** The bounded recursive fallback suggestion set for one `@` prefix. The
 * prefix may be the BARE form (`@foo`) or the QUOTED form (`@"my file`);
 * the quoted form searches the inner text and produces quoted values. */
function fsMentionSuggestions(
  workDir: string,
  atPrefix: string,
  signal?: AbortSignal,
): readonly HostFileCandidate[] {
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) return []
  const quoted = atPrefix.startsWith('@"')
  const inner = quoted ? atPrefix.slice(2) : atPrefix.slice(1)
  // An unclosed quoted prefix has no trailing quote; a CLOSED one keeps
  // it in the completion prefix (the fork's quoted-prefix grammar) — strip
  // it for the search, the values stay quoted either way.
  const query = inner.endsWith('"') ? inner.slice(0, -1) : inner
  const candidates = collectFsMentionCandidates(workDir, signal)
  if (candidates.length === 0 || aborted()) return []
  const lowerQuery = query.toLowerCase()
  return candidates
    .map(candidate => ({ candidate, score: scoreCandidate(candidate, lowerQuery) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.candidate.isDirectory !== b.candidate.isDirectory) {
        return a.candidate.isDirectory ? -1 : 1
      }
      return a.candidate.path.localeCompare(b.candidate.path)
    })
    .slice(0, MAX_FALLBACK_SUGGESTIONS)
    .map(entry => toMentionCandidate(entry.candidate, quoted))
}
