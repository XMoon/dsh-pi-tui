/**
 * The path query resolver (plan §5.1/§6): pure — turns a raw token into
 * the search directory, the basename term, the display prefix and whether
 * the token names an EXPLICIT scope. No filesystem access; `~` expansion
 * is the adapter's job, resolved here already for the search base.
 *
 * A scoped token (`src/fo`, `../foo`, `../../foo`, `~/foo`, `/tmp/foo`,
 * a drive-qualified path, or an UNC path) searches ONLY its resolved
 * directory — never a whole-tree scan filtered by string (plan §6.1). An
 * unscoped token (`foo`, `nested`, `config`) is a whole-tree fuzzy query
 * (plan §6.2) with an EMPTY display base.
 * @module @xmoon76/dsh-pi-tui/file-completion/query
 */

import { basename, dirname, join, win32 } from 'node:path'
import { homedir } from 'node:os'
import type { PathCompletionQuery } from './types.ts'

/**
 * The migration-era search-directory resolver (test-pinned): PURE — turns
 * one raw token into the readdir target, the basename prefix and the Windows
 * dialect flag. The shared engine's {@link resolvePathQuery} is the
 * converged implementation; this wrapper keeps the old triple shape so the
 * `mentions.test.ts` pins stay valid while the engine takes over the real
 * completion path.
 * @param token - the parsed argument token (no leading separator
 *   whitespace).
 * @param cwd - the session workspace (relative forms resolve against it).
 * @param expanded - `expandHomeToken(token)` (callers compute it). Kept in
 *   this compatibility signature; the converged resolver owns expansion.
 */
export function resolvePathSearch(
  token: string,
  cwd: string,
  _expanded: string,
): { searchDir: string; searchPrefix: string; winAbsolute: boolean } {
  const query = resolvePathQuery(token, cwd)
  return {
    searchDir: query.searchBase,
    searchPrefix: query.searchTerm,
    winAbsolute: query.winAbsolute,
  }
}

/** Expand a leading `~` in one token (other tokens unchanged). */
export function expandHomeToken(token: string): string {
  if (token === '~') return homedir()
  if (token.startsWith('~/') || token.startsWith('~\\')) {
    // Resolve a Windows-looking home token on POSIX too: the completion
    // source owns the real filesystem path, while the raw token keeps its
    // original separator for presentation.
    return join(homedir(), token.slice(2).replace(/\\/g, '/'))
  }
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

/**
 * Choose the separator immediately before the basename. This preserves a
 * mixed Windows token's actual dialect (forward-slash drive paths stay
 * forward-slashed, while backslash drive paths stay backslashed) instead of
 * normalizing it to the host platform's preferred separator.
 */
export function separatorOfRaw(raw: string, windowsDialect: boolean): '/' | '\\' {
  const slash = raw.lastIndexOf('/')
  const backslash = raw.lastIndexOf('\\')
  if (slash === -1 && backslash === -1) return windowsDialect ? '\\' : '/'
  return backslash > slash ? '\\' : '/'
}

/** Whether the token is a leading-home form, including `~\\foo`. */
function isHomeToken(raw: string): boolean {
  return raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
}

/** Whether one raw token is genuinely Windows-dialect. */
function isWindowsDialect(raw: string, winAbsolute: boolean): boolean {
  return winAbsolute || raw.includes('\\')
}

/** Whether an absolute path uses the Windows drive/UNC grammar. */
function isWindowsAbsolute(raw: string): boolean {
  // A POSIX `/tmp` path is deliberately not treated as a Windows rooted path
  // even on Windows, where win32.isAbsolute('/tmp') also returns true.
  return !raw.startsWith('/') && win32.isAbsolute(raw)
}

/** Join a relative scope while keeping POSIX test fixtures usable for a
 * Windows-looking token. On a real Windows cwd, win32.join is authoritative;
 * on POSIX, backslashes are the user's dialect but not filesystem separators. */
function joinRelativeScope(cwd: string, rawPath: string, windowsDialect: boolean): string {
  if (!windowsDialect) return join(cwd, rawPath)
  // `win32.isAbsolute('/workspace')` is true for a rooted Windows path too,
  // but on POSIX that string is an ordinary absolute POSIX cwd. Select the
  // filesystem joiner from the actual host or an unmistakable drive/UNC cwd.
  const windowsCwd = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
  if (process.platform === 'win32' || windowsCwd) return win32.join(cwd, rawPath)
  return join(cwd, rawPath.replace(/\\/g, '/'))
}

/** Whether the raw token names a directory that should be LISTED
 * (`searchTerm === ''`). `.`/`..` root forms list their own relative
 * directory; `./`/`../`/`~`/`/` list the scope root. */
function isBareScopeForm(raw: string): boolean {
  return (
    raw === '' || raw === '.' || raw === '..'
    || raw === './' || raw === '../'
    || raw === '~' || raw === '~/' || raw === '~\\'
    || raw === '/' || raw === '.\\' || raw === '..\\'
  )
}

/**
 * Resolve ONE raw completion token into the pure path query (plan §5.1).
 * @param raw - the token as typed (quotes stripped; leading separator
 *   whitespace stripped by the caller).
 * @param cwd - the completion base (the session workspace; relative forms
 *   resolve against it).
 */
export function resolvePathQuery(raw: string, cwd: string): PathCompletionQuery {
  const expanded = expandHomeToken(raw)
  // Detect the dialect from the RAW token, not from `path.isAbsolute` on the
  // expanded token. On Windows, node:path.isAbsolute(drivePath) is true but
  // that must not erase the Windows dialect; on POSIX, `~\\x` expands to a
  // POSIX absolute filesystem path while remaining a Windows-looking token.
  const posixAbsolute = raw.startsWith('/')
  const winAbsolute = isWindowsAbsolute(raw)
  const windowsDialect = isWindowsDialect(raw, winAbsolute)
  const absolute = isHomeToken(raw) || posixAbsolute || winAbsolute
  const pathDirname = windowsDialect ? win32.dirname : dirname
  const pathBasename = windowsDialect ? win32.basename : basename
  const separator = separatorOfRaw(raw, windowsDialect)

  if (isBareScopeForm(raw)) {
    // Complete the whole scope directory: `@` alone lists cwd; `.`/`..`
    // and their separator forms list the RELATIVE directory; `~/` maps to
    // home; `/` maps to the POSIX root.
    const relativeForm = raw === '.' || raw === '..' || raw === './' || raw === '../' || raw === '.\\' || raw === '..\\'
    const scopeDir = relativeForm
      ? joinRelativeScope(cwd, raw, windowsDialect)
      : (absolute ? expanded : joinRelativeScope(cwd, expanded, windowsDialect))
    const displayBase = raw === '' ? ''
      : raw === '~' ? `~${separator}`
        : (raw.endsWith('/') || raw.endsWith('\\') ? raw : `${raw}${separator}`)
    return { raw, searchBase: scopeDir, searchTerm: '', displayBase, explicitScope: true, winAbsolute }
  }

  if (raw.endsWith('/') || raw.endsWith('\\')) {
    // A trailing separator: show the directory's contents (a Windows path
    // ends with `\\`).
    return {
      raw,
      searchBase: absolute ? expanded : joinRelativeScope(cwd, expanded, windowsDialect),
      searchTerm: '',
      displayBase: raw,
      explicitScope: true,
      winAbsolute,
    }
  }

  // Keep the DISPLAY base as a literal prefix of what the user typed. The
  // path module may normalize mixed drive separators; using the raw slice
  // preserves mixed separators and lets the completion value stay dialect
  // consistent with the input.
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  const hasSeparator = lastSlash >= 0
  const displayBase = hasSeparator ? raw.slice(0, lastSlash + 1) : ''
  const rawDir = hasSeparator ? raw.slice(0, lastSlash) : ''
  const searchTerm = pathBasename(expanded)
  const explicitScope = hasSeparator || absolute

  // `~/pics/a` expands the raw directory prefix against HOME. Every other
  // form resolves the raw directory against cwd (parent prefixes escape cwd
  // exactly as far as the user typed).
  const searchBaseForScope = isHomeToken(raw)
    ? expandHomeToken(rawDir)
    : (absolute ? pathDirname(expanded) : joinRelativeScope(cwd, rawDir, windowsDialect))
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
 * against (`de` for `src/de`, `nested` for `nested`, '' for listings).
 * PURE, no filesystem access. */
export function termOfRaw(raw: string): string {
  if (isBareScopeForm(raw)) return ''
  const last = raw.endsWith('/') || raw.endsWith('\\') ? '' : (raw.split(/[\\/]/).pop() ?? '')
  return last === '.' || last === '..' ? '' : last
}
