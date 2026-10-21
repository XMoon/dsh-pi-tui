/**
 * The neutral path query resolver (TS8-A, split out of the historical
 * `src/file-completion/query.ts`): PURE — turns a raw token into the search
 * directory, the basename term, the display prefix and whether the token
 * names an EXPLICIT scope. No filesystem access, and no environment
 * discovery: the facts this algebra needs arrive from the LOCALITY owner as
 * an explicit {@link PathQueryEnvironment}, never from `homedir()` /
 * `process.platform` inside the domain layer.
 *
 * A scoped token (`src/fo`, `../foo`, `../../foo`, `~/foo`, `/tmp/foo`,
 * a drive-qualified path, or an UNC path) searches ONLY its resolved
 * directory — never a whole-tree scan filtered by string. An unscoped token
 * (`foo`, `nested`, `config`) is a whole-tree fuzzy query with an EMPTY
 * display base.
 * @module @xmoon76/dsh-pi-tui/domain/file-completion/query
 */

import { posix, win32, type PlatformPath } from 'node:path'
import type { PathCandidate, PathCompletionQuery } from './types.ts'

/**
 * The environment facts one path query needs, supplied by the LOCALITY
 * owner (Client process or Direct Host process). Deliberately not a generic
 * Context/Services bag: exactly the `~` home directory and whether the
 * filesystem host is Windows.
 */
export interface PathQueryEnvironment {
  readonly homeDir: string
  readonly windowsHost: boolean
}

/**
 * The HOST filesystem's path algebra, selected from the EXPLICIT
 * `windowsHost` fact. Every host-native path this module computes (a joined
 * scope, an expanded `~`) goes through this api, so the domain never infers
 * the running machine from the ambient `node:path` default export: a caller
 * that injects a foreign host's facts gets that host's algebra.
 */
function hostPathApi(windowsHost: boolean): PlatformPath {
  return windowsHost ? win32 : posix
}

/**
 * Return the final path component without depending on the host OS dialect.
 * Completion can present a Windows path while the client process is running
 * on POSIX (and vice versa), so `node:path.basename` is not sufficient here.
 */
export function basenameOfPath(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(separator + 1)
}

/**
 * Expand a leading `~` in one token against the locality's home directory
 * (other tokens unchanged). PURE — both the home directory AND the host
 * platform are explicit facts: the joined result is a path on the HOST
 * filesystem, so it uses that host's algebra.
 * @param token - the raw token.
 * @param homeDir - the locality owner's home directory fact.
 * @param windowsHost - whether the filesystem host is Windows.
 */
export function expandHomeToken(token: string, homeDir: string, windowsHost: boolean): string {
  if (token === '~') return homeDir
  if (token.startsWith('~/') || token.startsWith('~\\')) {
    // Resolve a Windows-looking home token on POSIX too: the completion
    // source owns the real filesystem path, while the raw token keeps its
    // original separator for presentation.
    return hostPathApi(windowsHost).join(homeDir, token.slice(2).replace(/\\/g, '/'))
  }
  return token
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

/** Join a relative scope while keeping POSIX fixtures usable for a
 * Windows-looking token. The result is a path on the HOST filesystem, so the
 * joiner comes from the EXPLICIT host fact (never `process.platform`); the
 * TOKEN's own dialect only decides whether backslashes are the user's
 * separators or ordinary characters.
 *
 * A `windowsDialect` token on a POSIX host has backslashes in the USER'S
 * dialect, not as filesystem separators, so they are normalized; an
 * unmistakable drive/UNC `cwd` selects the win32 joiner even on a POSIX host
 * (that cwd string is itself a Windows path). */
function joinRelativeScope(cwd: string, rawPath: string, windowsDialect: boolean, windowsHost: boolean): string {
  const api = hostPathApi(windowsHost)
  if (!windowsDialect) return api.join(cwd, rawPath)
  // `win32.isAbsolute('/workspace')` is true for a rooted Windows path too,
  // but on POSIX that string is an ordinary absolute POSIX cwd. Select the
  // filesystem joiner from the explicit host fact or an unmistakable
  // drive/UNC cwd.
  const windowsCwd = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
  if (windowsHost || windowsCwd) return win32.join(cwd, rawPath)
  return api.join(cwd, rawPath.replace(/\\/g, '/'))
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
 * Resolve ONE raw completion token into the pure path query.
 * @param raw - the token as typed (quotes stripped; leading separator
 *   whitespace stripped by the caller).
 * @param cwd - the completion base (the Client cwd for local completion, the
 *   Direct workspace cwd for the WORKSPACE compatibility scanner; relative
 *   forms resolve against it).
 * @param environment - the locality owner's explicit environment facts.
 */
export function resolvePathQuery(raw: string, cwd: string, environment: PathQueryEnvironment): PathCompletionQuery {
  const expanded = expandHomeToken(raw, environment.homeDir, environment.windowsHost)
  // Detect the dialect from the RAW token, not from `path.isAbsolute` on the
  // expanded token. On Windows, node:path.isAbsolute(drivePath) is true but
  // that must not erase the Windows dialect; on POSIX, `~\\x` expands to a
  // POSIX absolute filesystem path while remaining a Windows-looking token.
  const posixAbsolute = raw.startsWith('/')
  const winAbsolute = isWindowsAbsolute(raw)
  const windowsDialect = isWindowsDialect(raw, winAbsolute)
  const absolute = isHomeToken(raw) || posixAbsolute || winAbsolute
  // The TOKEN is parsed with the Windows grammar when the token's own dialect
  // is Windows OR the HOST is Windows (a drive-relative `C:foo` is an ordinary
  // POSIX name on a POSIX host, but a drive-relative path on a Windows one).
  // Both facts are explicit here; the ambient default export is never used.
  const tokenWindows = windowsDialect || environment.windowsHost
  const pathDirname = tokenWindows ? win32.dirname : posix.dirname
  const pathBasename = tokenWindows ? win32.basename : posix.basename
  const separator = separatorOfRaw(raw, windowsDialect)

  if (isBareScopeForm(raw)) {
    // Complete the whole scope directory: `@` alone lists cwd; `.`/`..`
    // and their separator forms list the RELATIVE directory; `~/` maps to
    // home; `/` maps to the POSIX root.
    const relativeForm = raw === '.' || raw === '..' || raw === './' || raw === '../' || raw === '.\\' || raw === '..\\'
    const scopeDir = relativeForm
      ? joinRelativeScope(cwd, raw, windowsDialect, environment.windowsHost)
      : (absolute ? expanded : joinRelativeScope(cwd, expanded, windowsDialect, environment.windowsHost))
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
      searchBase: absolute ? expanded : joinRelativeScope(cwd, expanded, windowsDialect, environment.windowsHost),
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
    ? expandHomeToken(rawDir, environment.homeDir, environment.windowsHost)
    : (absolute ? pathDirname(expanded) : joinRelativeScope(cwd, rawDir, windowsDialect, environment.windowsHost))
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

/**
 * Reattach the query's display base onto one discovered candidate path.
 * Discovery returns paths RELATIVE to the query's search base; the candidate
 * the user accepts must read in the USER'S dialect (`../sibling-file.ts`,
 * `~/pics/a.png`, `src/deep.ts`, `/tmp/x`). The SOURCE calls this before its
 * candidates cross the port contract (the port's paths are user-facing).
 * PURE.
 */
export function reattachDisplayBase(candidate: PathCandidate, query: PathCompletionQuery): PathCandidate {
  if (query.displayBase === '') return candidate
  return { ...candidate, path: `${query.displayBase}${candidate.path}` }
}
