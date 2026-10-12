/**
 * The instrument's own rules — the two decisions the driver must not get wrong,
 * kept pure so the headless suite covers them:
 *
 *   - **Which directory it may own.** The driver wipes its run directory on every
 *     start, so a `--out` that points at a workspace, a home directory or an
 *     ancestor of the repository must be REFUSED instead of deleted.
 *   - **Which commands it may repeat.** A retry is invisible for a read or for an
 *     idempotent set, and is a SECOND real input for a click, a key or a subject
 *     launch — a green run could then claim "exactly one real input" while two
 *     were delivered. Those are sent once and must be acknowledged.
 */
import { sep } from 'node:path'

/** Written into every run directory it claims; its presence IS the ownership. */
export const RUN_MARKER = 'tern-pane-run.json'

/**
 * May the driver wipe `root` and take it over?
 *
 * @param root     the resolved run directory
 * @param repo     the repository root (never wipeable, nor anything above it)
 * @param cwd      the working directory the run was started from
 * @param home     the user's home directory
 * @param entries  `root`'s top-level names, `[]` when it does not exist
 * @returns `{ ok: true }` or `{ ok: false, reason }`
 */
export function runDirectoryVerdict({ root, repo, cwd, home, entries = [] }) {
  if (typeof root !== 'string' || root === '') return { ok: false, reason: 'the run directory is empty' }
  const prefix = root.endsWith(sep) ? root : root + sep
  for (const guarded of [repo, cwd, home]) {
    if (typeof guarded !== 'string' || guarded === '') continue
    if (root === guarded || guarded.startsWith(prefix)) {
      return { ok: false, reason: `${root} holds ${guarded}` }
    }
  }
  if (entries.length === 0) return { ok: true }
  if (entries.includes(RUN_MARKER)) return { ok: true }
  return { ok: false, reason: `${root} is not a harness run directory (no ${RUN_MARKER})` }
}

/**
 * Commands whose repetition cannot be observed: reads and idempotent sets. A
 * command that is not here — `click`, `key`, `run` — is delivered exactly once.
 */
const REPEATABLE_COMMANDS = new Set([
  'tree', 'dump', 'pick', 'state', 'stats', 'layers', 'a11y', 'menus', 'system', 'perf', 'shot', 'resize', 'css',
])

export const isRepeatableCommand = (command) => REPEATABLE_COMMANDS.has(command)

/**
 * Quote a path for the generated `launch.sh`. The run directory, the repository
 * and the subject may all contain spaces or quotes, and an unquoted path there
 * fails as a confusing "no such file" instead of starting the subject.
 */
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
