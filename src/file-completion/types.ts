/**
 * The shared types of the file-completion engine (the 2026-08-27
 * convergence plan): ONE path query/ranking/presentation model behind BOTH
 * `@` mentions (Host filesystem, through HostFilePort) and `/image`
 * arguments (Client-local filesystem). Only identity/data crosses the
 * sources — the engine is pure policy, the source is where the fs lives.
 * @module @xmoon76/dsh-pi-tui/file-completion/types
 */

/** One path-only discovery result. Sources return path FACTS; presentation
 * (quoting, trailing `/`, labels, descriptions) is client policy. */
export interface PathCandidate {
  /** The user-facing display path: workspace-relative for unscoped whole-tree
   * queries (`src/deep.ts`), token-relative for scoped ones (`../x.ts`,
   * `~/pics/a.png`, `/tmp/x`). Directories carry NO trailing slash. */
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** A half-open text range in the current line. */
export interface TextRange {
  readonly start: number
  readonly end: number
}

/**
 * The classified file-completion context at the cursor. File completion is
 * ALLOWED only in `mention` (`@...`) and `image-argument` (`/image ...`)
 * contexts — `none` means ordinary text/paths, where neither the natural
 * trigger nor Tab may open a file dropdown (kimi parity, plan §2.1/§4).
 */
export type FileCompletionContext =
  | {
      kind: 'mention'
      /** The raw mention prefix INCLUDING `@` (and an unclosed `"` when
       * quoted): `@src/fo`, `@"my file`. */
      query: string
      /** The replaced span in the line: [cursorCol - query.length, cursorCol). */
      range: TextRange
    }
  | {
      kind: 'image-argument'
      /** The raw argument text INCLUDING leftover separator whitespace:
       * `fi`, `   subdir/`. */
      query: string
      range: TextRange
    }
  | { kind: 'none' }

/**
 * The parsed path completion query (plan §5.1): where to search, what to
 * match, and how to present the result. PURE — no filesystem access.
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
