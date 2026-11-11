/**
 * Pure Host-path syntax for the inline Session Workspace directory editor.
 *
 * This module answers ONE question: for a raw Host path string and the Host
 * home the official `directoryPicker` reported, which Host level should be
 * listed and what name prefix is being typed? It never touches a filesystem,
 * never resolves against a Client `cwd`, never expands `~`/environment
 * variables and never chooses a platform from the Client's own
 * `process.platform`: the Host home is the ONLY dialect fact.
 *
 * `node:path.posix` and `node:path.win32` are used as pure string grammars;
 * the default `node:path` export (which follows the Client platform) is
 * deliberately NOT imported.
 * @module @xmoon76/dsh-pi-tui/domain/file-completion/host-directory-query
 */

import { posix, win32 } from 'node:path'

/** The Host's own path separator, inferred from its reported home. */
export type HostDirectorySeparator = '/' | '\\'

/** One parsed Host path: the level to list plus the prefix typed for its children. */
export type HostDirectoryQuery =
  /** Blank input: no level may be requested. */
  | { readonly kind: 'empty' }
  /** A non-blank path that is not absolute for the Host dialect. */
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
    readonly kind: 'absolute'
    /** The absolute Host level to list (verbatim; never normalized against a Client cwd). */
    readonly directoryToList: string
    /** The name prefix typed after the level; `''` lists the level itself. */
    readonly prefix: string
    readonly separator: HostDirectorySeparator
  }

const WINDOWS_DRIVE_HOME = /^[A-Za-z]:[\\/]/u
const WINDOWS_UNC_HOME = /^\\\\[^\\/]+[\\/][^\\/]+/u
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u
const WINDOWS_UNC_ABSOLUTE = /^\\\\[^\\/]+[\\/][^\\/]+/u

/**
 * The Host's own separator, inferred from its reported home directory.
 * A Windows drive path or a UNC share home means `\\`; everything else is
 * POSIX. The home is authoritative Host data, never the Client OS.
 */
export function hostDirectorySeparator(hostHome: string): HostDirectorySeparator {
  return WINDOWS_DRIVE_HOME.test(hostHome) || WINDOWS_UNC_HOME.test(hostHome) ? '\\' : '/'
}

/**
 * Parse one raw editor value against the Host dialect.
 *
 * `raw` is preserved verbatim: the returned listing target/prefix are only a
 * display/query derivation, and the value the user finally verifies is still
 * the raw string (the Host is the final authority on whether it exists).
 */
export function hostDirectoryQuery(raw: string, hostHome: string): HostDirectoryQuery {
  if (raw.trim() === '') return { kind: 'empty' }
  const separator = hostDirectorySeparator(hostHome)
  if (separator === '/') {
    if (!raw.startsWith('/')) {
      return { kind: 'invalid', reason: 'The Host path must be absolute.' }
    }
    if (raw.endsWith('/')) {
      return { kind: 'absolute', directoryToList: raw, prefix: '', separator }
    }
    return {
      kind: 'absolute',
      directoryToList: posix.dirname(raw),
      prefix: posix.basename(raw),
      separator,
    }
  }
  if (!WINDOWS_DRIVE_ABSOLUTE.test(raw) && !WINDOWS_UNC_ABSOLUTE.test(raw)) {
    return {
      kind: 'invalid',
      reason: 'The Host path must be drive-absolute or a complete UNC share path.',
    }
  }
  if (/[\\/]$/u.test(raw) || win32.parse(raw).root === raw) {
    return { kind: 'absolute', directoryToList: raw, prefix: '', separator }
  }
  return {
    kind: 'absolute',
    directoryToList: win32.dirname(raw),
    prefix: win32.basename(raw),
    separator,
  }
}

/**
 * The value Tab writes into the editor for one official Host `entry.path`.
 * The path itself is never joined or normalized by the Client: only the Host
 * separator is appended when the official path does not already end in one.
 */
export function hostDirectoryCandidateValue(
  absoluteHostPath: string,
  separator: HostDirectorySeparator,
): string {
  const trailing = separator === '\\' ? /[\\/]$/u : /\/$/u
  return trailing.test(absoluteHostPath) ? absoluteHostPath : `${absoluteHostPath}${separator}`
}
