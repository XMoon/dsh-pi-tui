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

import { basename } from 'node:path'
import type { AutocompleteItem } from '@xmoon76/pi-tui'
import type { PathCandidate, PathCompletionQuery } from './types.ts'

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
 * directories keep the trailing `/` (so accept continues), values with
 * spaces are quoted — with the `@"..."` form when the user typed a
 * quoted `@` prefix. PURE client policy. */
export function presentPathCandidate(
  candidate: PathCandidate,
  context: { at: boolean; quoted: boolean },
): AutocompleteItem {
  const displayPath = candidate.path
  const pathValue = candidate.kind === 'directory' ? `${displayPath}/` : displayPath
  const needsQuotes = context.quoted || pathValue.includes(' ')
  const value = needsQuotes
    ? `${context.at ? '@"' : '"'}${pathValue}"`
    : `${context.at ? '@' : ''}${pathValue}`
  return {
    value,
    label: `${basename(candidate.path)}${candidate.kind === 'directory' ? '/' : ''}`,
    description: displayPath,
  }
}
