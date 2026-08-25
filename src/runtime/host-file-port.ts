/**
 * The Host-file domain port (M1.10) — the semantic contract between the
 * TUI and the HOST filesystem for `@`-file references: completion
 * discovery, send-time existence resolution and draft canonicalization.
 * Implemented by `src/runtime/direct/` (Direct) today and by a Remote
 * adapter in a later milestone. The port is the locality boundary the
 * migration guardrails demand: the TUI must never assume the Client
 * filesystem IS the Host filesystem — under remote attach, `@src/foo.ts`
 * means the HOST workspace, and this port is where that resolution lives.
 *
 * Only identity/data crosses the port: scopes are serializable
 * (`sessionId` / `cwd`), candidates are path-only DTOs, and NO Node fs
 * object, `Dirent`, `Stats` or live Agent ever appears.
 *
 * NOT in this port (deliberate locality split): the `!`/`!!` local shell,
 * `/image` local file reads, `/export` local output writes, the clipboard,
 * the external editor and plain shell/path completion — those keep their
 * own client-local semantics.
 *
 * Future wire mapping (M2): the official fileReferences Host capability /
 * Remote seam (`fileReferences.list(agent, query, signal)` →
 * path-only candidates).
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/host-file-port
 */

/** One `@`-reference completion candidate (detached, path-only). The
 * presentation fields carry the EXACT completion the editor inserts (the
 * Direct adapter preserves the current fd/fallback item shapes). */
export interface HostFileCandidate {
  /** The completion VALUE (the `@path` / `@"path"` form the editor
   * inserts; directories keep their trailing `/`). */
  readonly value: string
  /** The display label (basename + `/` for directories). */
  readonly label: string
  /** The resolved absolute/display path the description row shows. */
  readonly description: string
  /** Whether the candidate is a directory (completion stays open). */
  readonly kind: 'file' | 'directory'
}

/** The filesystem scope one reference resolves against: a live SESSION
 * (identity-addressed; the Direct adapter resolves the agent internally,
 * a Remote adapter maps the official identity) or an explicit WORKSPACE
 * cwd (the sessionless cold surface). */
export type HostFileScope =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'workspace'; readonly cwd: string }

/** The outcome of one existence probe. */
export type HostFileResolveResult =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'missing' }

/** The Host-file domain port. */
export interface HostFilePort {
  /** Complete one `@`-mention query (the editor's at-prefix INCLUDING the
   * leading `@`, e.g. `@src/fo` or `@"my file`). Returns the candidates
   * the current Host filesystem discovery offers (fd whole-tree fuzzy
   * when fd is on the Host PATH, the bounded recursive scan otherwise),
   * or [] when nothing matches. */
  listReferences(
    scope: HostFileScope,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly HostFileCandidate[]>
  /** Probe one raw mention path (`src/foo.ts`, `~/x`, `/abs/x`) for
   * existence in the scope, resolving it to the absolute Host path
   * (`~` expansion; relative against the scope workspace; absolute kept;
   * symlinks absolutized, never realpath'd). */
  resolveReference(
    scope: HostFileScope,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileResolveResult>
  /** Canonicalize every `@`-file mention of one draft for submission: the
   * editor keeps the concise relative form, the model-facing message
   * carries the unambiguous absolute path. A nonexistent path is left
   * verbatim (typos and non-path `@` words are never mangled). */
  canonicalizeMentions(scope: HostFileScope, text: string): Promise<string>
}
