/**
 * The shared path presentation (plan §8): how one path-only candidate
 * becomes an `AutocompleteItem`. The `@` mention shape and the `/attach` +
 * `/image` argument shapes differ ONLY in the value prefix (`@` + quoting vs
 * bare) — the path math (trailing `/` for continuation, quoting, and labels)
 * is shared.
 *
 * The SOURCE is responsible for reattaching the query's display base
 * (see {@link displayPathOf}): candidates reach this layer as FINAL
 * user-facing display paths (`../sibling.ts`, `~/pics/a.png`,
 * `src/deep.ts`) — scoped or not, one shape.
 * @module @xmoon76/dsh-pi-tui/file-completion/presentation
 */

import type { AutocompleteItem } from '@xmoon76/pi-tui'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { PathCandidate, PathCompletionQuery } from './types.ts'

/** The joined display path for one candidate under a scoped query: the
 * display base (already in the user's own dialect, always ending with the
 * user's separator) + the candidate path. `../` + `sibling-file.ts` →
 * `../sibling-file.ts`; `~/pics/` + `a.png` → `~/pics/a.png`;
 * `/tmp/` + `x` → `/tmp/x`; a Windows drive base + `shot.png` keeps its
 * backslash dialect.
 * An unscoped query ('' display base) returns the path unchanged. PURE —
 * called by the SOURCE after discovery, before the candidate crosses to
 * the presentation/ranking layer. */
export function displayPathOf(candidate: PathCandidate, query: PathCompletionQuery): string {
  if (query.displayBase === '') return candidate.path
  return `${query.displayBase}${candidate.path}`
}

/** Present one FINAL-display-path candidate as a completion item.
 *
 * `at: true` (the `@`-mention form) delegates the VALUE to the OFFICIAL
 * `formatFileMention` — the same authority the official web client uses —
 * and returns `undefined` for a path the official grammar cannot represent
 * safely (control characters, `"`): the caller filters those, exactly as
 * the official client does. The separator-dialect and quoting notes below
 * apply to the NON-@ forms (`/attach` + `/image` arguments), whose value
 * shape has no official grammar and stays this layer's own policy:
 * directories keep the trailing separator OF THE USER'S OWN DIALECT (`/`
 * on POSIX, `\` for a Windows-dialect token) so accept continues; values
 * with spaces are quoted. PURE client policy for the item shape; the @
 * value is the official grammar's. */
export function presentPathCandidate(
  candidate: PathCandidate,
  context: { at: boolean; quoted: boolean; sep?: string },
): AutocompleteItem | undefined {
  const displayPath = candidate.path
  if (context.at) {
    // The OFFICIAL mention grammar: the quoting rules (any whitespace
    // quotes) and the safety refusal (`undefined` for control chars / `"`)
    // are its authority, never re-implemented here. `preserveQuote` keeps
    // an explicitly opened quote (directory continuation stays quoted).
    const value = formatFileMention(
      { path: displayPath, kind: candidate.kind },
      context.quoted,
    )
    if (value === undefined) return undefined
    return {
      value,
      // The vendored SelectList uses the slash marker to recognize a
      // directory item during apply; the official value itself already
      // carries the trailing `/` (the grammar appends it for directories).
      label: `${displayPath}${candidate.kind === 'directory' ? '/' : ''}`,
      description: undefined,
    }
  }
  const sep = context.sep ?? '/'
  const pathValue = candidate.kind === 'directory' ? `${displayPath}${sep}` : displayPath
  const needsQuotes = pathValue.includes(' ')
  const value = needsQuotes ? `"${pathValue}"` : pathValue
  return {
    value,
    // The vendored SelectList uses the slash marker to recognize a directory
    // item during apply. The accepted VALUE carries the user's actual
    // separator; keep this UI marker stable across path dialects.
    label: `${displayPath}${candidate.kind === 'directory' ? '/' : ''}`,
    description: undefined,
  }
}
