/**
 * The path query resolver (plan §5.1/§6): pure — turns a raw token into
 * the search directory, the basename term, the display prefix and whether
 * the token names an EXPLICIT scope. No filesystem access; `~` expansion
 * is the adapter's job, resolved here already for the search base.
 *
 * A scoped token (`src/fo`, `../foo`, `../../foo`, `~/foo`, `/tmp/foo`,
 * `C:\Users\sh`, `\\server\share\fo`) searches ONLY its resolved
 * directory — never a whole-tree scan filtered by string (plan §6.1). An
 * unscoped token (`foo`, `nested`, `config`) is a whole-tree fuzzy query
 * (plan §6.2) with an EMPTY display base.
 * @module @xmoon76/dsh-pi-tui/file-completion/query
 */

import { basename, dirname, isAbsolute, join, win32 } from 'node:path'
import { homedir } from 'node:os'
import type { PathCompletionQuery } from './types.ts'

/**
 * The migration-era search-directory resolver (test-pinned): PURE — turns
 * one raw token into the readdir target, the basename prefix and the
 * Windows-dialect flag. The shared engine's {@link resolvePathQuery} is the
 * converged implementation; this wrapper keeps the old triple shape so the
 * `mentions.test.ts` pins stay valid while the engine takes over the real
 * completion path.
 * @param token - the parsed argument token (no leading separator
 *   whitespace).
 * @param cwd - the session workspace (relative forms resolve against it).
 * @param expanded - `expandHomeToken(token)` (callers compute it).
 */
export function resolvePathSearch(
  token: string,
  cwd: string,
  expanded: string,
): { searchDir: string; searchPrefix: string; winAbsolute: boolean } {
  // Absolute detection covers every platform form: POSIX `/x`, Windows
  // drive (`C:\x`, `C:/x`) and UNC (`\\server\share`) paths.
  const posixAbsolute = isAbsolute(expanded)
  const winAbsolute = !posixAbsolute && win32.isAbsolute(expanded)
  const absolute = token.startsWith('~') || posixAbsolute || winAbsolute
  const pathDirname = winAbsolute ? win32.dirname : dirname
  const pathBasename = winAbsolute ? win32.basename : basename
  if (
    token === './' || token === '../' || token === '~' || token === '~/' || token === '/' || token === ''
  ) {
    return { searchDir: absolute ? expanded : join(cwd, expanded), searchPrefix: '', winAbsolute }
  }
  if (token.endsWith('/') || token.endsWith('\\')) {
    return { searchDir: absolute ? expanded : join(cwd, expanded), searchPrefix: '', winAbsolute }
  }
  return {
    searchDir: absolute ? pathDirname(expanded) : join(cwd, dirname(expanded)),
    searchPrefix: pathBasename(expanded),
    winAbsolute,
  }
}

/** Expand a leading `~` in one token (other tokens unchanged). */
export function expandHomeToken(token: string): string {
  if (token === '~') return homedir()
  if (token.startsWith('~/')) return join(homedir(), token.slice(2))
  return token
}

/** The token's raw path, quotes stripped for a quoted `@` prefix (an
 * unclosed quoted form `@"my file` stays unclosed — the query is the text
 * inside the quotes). */
export function stripAtQuotes(atPrefix: string): { raw: string; quoted: boolean } {
  if (atPrefix.startsWith('@"')) {
    const inner = atPrefix.slice(2)
    return { raw: inner.endsWith('"') ? inner.slice(0, -1) : inner, quoted: true }
  }
  const inner = atPrefix.slice(1)
  return { raw: inner.endsWith('"') ? inner.slice(0, -1) : inner, quoted: false }
}

/** Whether the raw token is a bare scope form: it names a directory that
 * should be LISTED (searchTerm ''). `.`/`..` root forms list their own
 * relative directory; `./`/`../`/`~`/`~/`/`/` list the scope root. */
function isBareScopeForm(raw: string): boolean {
  return (
    raw === '' || raw === '.' || raw === '..'
    || raw === './' || raw === '../'
    || raw === '~' || raw === '~/'
    || raw === '/' || raw === '.\\' || raw === '..\\'
  )
}

/** The separator a display base ends with (the user's own dialect). */
function separatorOf(winAbsolute: boolean): string {
  return winAbsolute ? '\\' : '/'
}

/** The display prefix of a scoped token, always ending with the user's
 * separator: `src/` for `src/foo`, `../` for `../foo`, `~/pics/` for
 * `~/pics/a`; `./` for `./foo` (dirname normalizes `./` away); `''` only
 * for a `sub`-style unscoped token. ROOT dirnames keep their trailing
 * separator (win32.dirname('C:\\Wi') is 'C:\\'; a UNC share root stays
 * '\\server\\share\\') — those must never gain a second one. */
function displayBaseFor(raw: string, rawDir: string, winAbsolute: boolean): string {
  if (rawDir === '') return ''
  if (rawDir === '.') {
    // dirname('src/foo') is 'src', but dirname('./foo') is '.' — the
    // user's `./` prefix is the intent, never the empty prefix.
    return raw.startsWith('./') ? './' : ''
  }
  if (rawDir.endsWith('/') || rawDir.endsWith('\\')) return rawDir
  return `${rawDir}${separatorOf(winAbsolute)}`
}

/**
 * Resolve ONE raw completion token into the pure path query (plan §5.1).
 * @param raw - the token as typed (quotes stripped; leading separator
 *   whitespace stripped by the caller).
 * @param cwd - the completion base (the session workspace; relative
 *   forms resolve against it).
 * @returns the query: searchBase (absolute), searchTerm, displayBase,
 *   explicitScope, winAbsolute.
 */
export function resolvePathQuery(raw: string, cwd: string): PathCompletionQuery {
  const expanded = expandHomeToken(raw)
  // Absolute detection covers every platform form: POSIX `/x`, Windows
  // drive (`C:\x`, `C:/x`) and UNC (`\\server\share`) paths. The win32
  // check engages ONLY for genuinely Windows-dialect tokens — win32 alone
  // would also accept a bare POSIX `/x` token, which must keep the POSIX
  // dialect (its dirname/join use backslashes).
  const posixAbsolute = isAbsolute(expanded)
  const winAbsolute = !posixAbsolute && win32.isAbsolute(expanded)
  const absolute = raw.startsWith('~') || posixAbsolute || winAbsolute
  const pathDirname = winAbsolute ? win32.dirname : dirname
  const pathBasename = winAbsolute ? win32.basename : basename
  const sep = separatorOf(winAbsolute)

  if (isBareScopeForm(raw)) {
    // Complete the whole scope directory: `@` alone lists cwd; `.`/`..`
    // and their separator forms list the RELATIVE directory (`.` → cwd,
    // `..` → cwd/..); `~/` maps to home; `/` maps to the POSIX root.
    const relativeForm = raw === '.' || raw === '..' || raw === './' || raw === '../' || raw === '.\\' || raw === '..\\'
    const scopeDir = relativeForm
      ? join(cwd, raw.replace(/\\/g, '/'))
      : (absolute ? expanded : join(cwd, expanded))
    const displayBase = raw === '' ? ''
      : raw === '~' ? '~/'
        : (raw.endsWith('/') || raw.endsWith('\\') ? raw : `${raw}${sep}`)
    return { raw, searchBase: scopeDir, searchTerm: '', displayBase, explicitScope: true, winAbsolute }
  }

  if (raw.endsWith('/') || raw.endsWith('\\')) {
    // A trailing separator: show the directory's contents (a Windows path
    // ends with `\`).
    return {
      raw,
      searchBase: absolute ? expanded : join(cwd, expanded),
      searchTerm: '',
      displayBase: raw,
      explicitScope: true,
      winAbsolute,
    }
  }

  // Split into directory + basename prefix. dirname leaves a trailing
  // separator ONLY on roots — which must keep it — so the search base is
  // the dirname VERBATIM (never stripped). `../` scopes: dirname('../foo')
  // is '..', dirname('../../foo') is '../..' — join(cwd, rawDir) resolves
  // the literal parent prefix, and the display prefix stays in the user's
  // own dialect.
  const hasSeparator = raw.includes('/') || raw.includes('\\')
  const rawDir = hasSeparator ? (winAbsolute ? win32.dirname(raw) : dirname(raw)) : ''
  const displayBase = displayBaseFor(raw, rawDir, winAbsolute)
  const searchTerm = pathBasename(expanded)
  const explicitScope = hasSeparator || absolute
  // `~/pics/a`: the `~` lives in the DIRECTORY part — expand there, never
  // join the literal `~/pics` against cwd. Every other form resolves the
  // raw directory prefix against cwd (dirname keeps `..`/`../..` literal,
  // so a parent scope escapes cwd exactly as far as the user typed).
  const searchBaseForScope = raw.startsWith('~/')
    ? expandHomeToken(rawDir)
    : (absolute ? pathDirname(expanded) : join(cwd, rawDir))
  return {
    raw,
    searchBase: explicitScope ? searchBaseForScope : cwd,
    searchTerm,
    displayBase,
    explicitScope,
    winAbsolute,
  }
}

/** The basename TERM of a raw completion token — what ranking scores
 * against ('de' for 'src/de', 'nested' for 'nested', '' for listings).
 * PURE, no filesystem access. */
export function termOfRaw(raw: string): string {
  if (isBareScopeForm(raw)) return ''
  const last = raw.endsWith('/') || raw.endsWith('\\') ? '' : (raw.split(/[\\/]/).pop() ?? '')
  return last === '.' || last === '..' ? '' : last
}
