/**
 * The transport/UI-neutral file-completion vocabulary (TS8-A): the
 * path-only candidate DTO and the parsed path query. ONE query/ranking
 * model answers BOTH the Client-local `/attach` + `/image` argument paths
 * and the Direct WORKSPACE compatibility scanner; a live Session `@`
 * mention does NOT flow through it (the official Host `fileReferences`
 * authority returns its candidates already filtered, ranked and bounded).
 *
 * This module is PURE: no filesystem, no environment, no presentation.
 * @module @xmoon76/dsh-pi-tui/domain/file-completion/types
 */

/** One path-only discovery result. Sources return path FACTS; presentation
 * (quoting, trailing `/`, labels, descriptions) is TUI policy. */
export interface PathCandidate {
  /** The user-facing display path: workspace-relative for unscoped whole-tree
   * queries (`src/deep.ts`), token-relative for scoped ones (`../x.ts`,
   * `~/pics/a.png`, `/tmp/x`). Directories carry NO trailing slash. */
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/**
 * The parsed path completion query: where to search, what to match, and how
 * to present the result. PURE — no filesystem access; the environment facts
 * (`~` home directory, whether the filesystem host is Windows) arrive from
 * the locality owner as an explicit `PathQueryEnvironment` (see `query.ts`).
 */
export interface PathCompletionQuery {
  /** The token as typed (quotes stripped; leading separator whitespace
   * stripped by the caller). */
  readonly raw: string
  /** The absolute directory to search (already `~`-expanded and
   * resolved against cwd for scoped forms; cwd itself for unscoped). */
  readonly searchBase: string
  /** The basename term to match ('' = list the directory's children). */
  readonly searchTerm: string
  /** The user-facing prefix to reattach to a result path ('' for
   * whole-tree queries): `../` for `../foo`, `src/` for `src/foo`. */
  readonly displayBase: string
  /** Whether the token names an explicit scope (has a directory part, a
   * root form, `~` or absolute): search ONLY that directory — never a
   * whole-tree scan filtered by string. */
  readonly explicitScope: boolean
  /** Whether the token is genuinely Windows-dialect (win32 dirname/join
   * math; the display keeps the user's `\` dialect). */
  readonly winAbsolute: boolean
}
