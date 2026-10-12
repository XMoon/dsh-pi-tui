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
export function runDirectoryVerdict({ root, repo, cwd, home, entries = [], holder, isAlive }) {
  if (typeof root !== 'string' || root === '') return { ok: false, reason: 'the run directory is empty' }
  const prefix = root.endsWith(sep) ? root : root + sep
  for (const guarded of [repo, cwd, home]) {
    if (typeof guarded !== 'string' || guarded === '') continue
    if (root === guarded || guarded.startsWith(prefix)) {
      return { ok: false, reason: `${root} holds ${guarded}` }
    }
  }
  // Ownership is not exclusivity: a second harness pointed at the same run
  // directory would wipe the first one's evidence and fight it for the socket.
  if (holder !== undefined && Number.isInteger(holder.pid) && isAlive?.(holder.pid) === true) {
    return { ok: false, reason: `${root} is held by a live run (pid ${holder.pid})` }
  }
  if (entries.length === 0) return { ok: true }
  if (entries.includes(RUN_MARKER)) return { ok: true }
  return { ok: false, reason: `${root} is not a harness run directory (no ${RUN_MARKER})` }
}

/**
 * Commands whose repetition cannot be observed: bare reads and idempotent sets.
 * The decision is on the WHOLE command shape, never on the name alone — a bare
 * `a11y` reads the accessibility tree, while `a11y click <selector>` clicks and
 * `a11y increment <selector>` edits, and `perf on|off|reset|mark` restarts the
 * measurement collection. Those are delivered exactly once, like `click`, `key`
 * and `run`.
 */
const BARE_READS = new Set(['tree', 'dump', 'pick', 'state', 'stats', 'layers', 'menus', 'system'])

export function isRepeatableCommand(args) {
  const [command, ...rest] = Array.isArray(args) ? args : [args]
  if (BARE_READS.has(command)) return true
  if (command === 'a11y') return rest.length === 0
  if (command === 'perf') return rest.length === 0 || rest[0] === 'since'
  return command === 'shot' || command === 'resize' || command === 'css'
}

/**
 * Quote a path for the generated `launch.sh`. The run directory, the repository
 * and the subject may all contain spaces or quotes, and an unquoted path there
 * fails as a confusing "no such file" instead of starting the subject.
 */
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
