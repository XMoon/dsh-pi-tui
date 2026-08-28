/**
 * The shared path presentation (plan §8): how one path-only candidate
 * becomes an `AutocompleteItem`. The `@` mention shape and the `/image`
 * argument shape differ ONLY in the value prefix (`@` + quoting vs bare)
 * — the path math (trailing `/` for continuation, quoting, labels,
 * descriptions) is shared.
 *
 * The SOURCE is responsible for reattaching the query's display base
 * (see {@link displayPathOf}): candidates reach this layer as FINAL
 * user-facing display paths (`../sibling.ts`, `~/pics/a.png`,
 * `src/deep.ts`) — scoped or not, one shape.
 * @module @xmoon76/dsh-pi-tui/file-completion/presentation
 */

import type { AutocompleteItem } from '@xmoon76/pi-tui'
import { basenameOfPath, type PathCandidate, type PathCompletionQuery } from './types.ts'

/** The joined display path for one candidate under a scoped query: the
 * display base (already in the user's own dialect, always ending with the
 * user's separator) + the candidate path. `../` + `sibling-file.ts` →
 * `../sibling-file.ts`; `~/pics/` + `a.png` → `~/pics/a.png`;
 * `/tmp/` + `x` → `/tmp/x`; `C:\Users\` + `shot.png` → `C:\Users\shot.png`.
 * An unscoped query ('' display base) returns the path unchanged. PURE —
 * called by the SOURCE after discovery, before the candidate crosses to
 * the presentation/ranking layer. */
export function displayPathOf(candidate: PathCandidate, query: PathCompletionQuery): string {
  if (query.displayBase === '') return candidate.path
  return `${query.displayBase}${candidate.path}`
}

/** Present one FINAL-display-path candidate as a completion item:
 * directories keep the trailing separator OF THE USER'S OWN DIALECT (`/`
 * on POSIX, `\` for a Windows-dialect token — so `C:\Users\foo\` stays
 * dialect-consistent and the next Tab continues in the same dialect), so
 * accept continues; values with spaces are quoted — with the `@"..."`
 * form when the user typed a quoted `@` prefix. PURE client policy. */
export function presentPathCandidate(
  candidate: PathCandidate,
  context: { at: boolean; quoted: boolean; sep?: string },
): AutocompleteItem {
  const sep = context.sep ?? '/'
  const displayPath = candidate.path
  const pathValue = candidate.kind === 'directory' ? `${displayPath}${sep}` : displayPath
  const needsQuotes = context.quoted || pathValue.includes(' ')
  const value = needsQuotes
    ? `${context.at ? '@"' : '"'}${pathValue}"`
    : `${context.at ? '@' : ''}${pathValue}`
  return {
    value,
    // The vendored SelectList uses the slash marker to recognize a directory
    // item during apply. The accepted VALUE carries the user's actual
    // separator; keep this UI marker stable across path dialects.
    label: `${basenameOfPath(candidate.path)}${candidate.kind === 'directory' ? '/' : ''}`,
    description: displayPath,
  }
}
