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

/** The `driver` field a marker must carry before it proves anything. */
export const DRIVER_ID = 'tern-pane-drive'

/**
 * What a marker file proves. Its NAME proves nothing: this driver deletes the
 * directory the marker sits in, so only a marker that parses AND identifies this
 * driver counts as ownership. Everything else — absent, truncated, another
 * writer's JSON — is reported as present-but-invalid, and the verdict refuses.
 */
export function markerOwnership(raw) {
  if (raw === undefined) return { present: false }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { present: true, valid: false }
  }
  if (typeof value !== 'object' || value === null || value.driver !== DRIVER_ID || !Number.isInteger(value.pid)) {
    return { present: true, valid: false }
  }
  return { present: true, valid: true, pid: value.pid }
}

/**
 * May the driver wipe `root` and take it over?
 *
 * @param root     the resolved run directory (callers must normalize it first)
 * @param repo     the repository root (never wipeable, nor anything above it)
 * @param cwd      the working directory the run was started from
 * @param home     the user's home directory
 * @param entries  `root`'s top-level names, `[]` when it does not exist
 * @param marker   `markerOwnership(rawMarkerText)`
 * @param isAlive  liveness probe for the pid in a valid marker
 * @returns `{ ok: true }` or `{ ok: false, reason }`
 */
export function runDirectoryVerdict({ root, repo, cwd, home, entries = [], marker = { present: false }, isAlive }) {
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
  if (marker.present && marker.valid && isAlive?.(marker.pid) === true) {
    return { ok: false, reason: `${root} is held by a live run (pid ${marker.pid})` }
  }
  if (entries.length === 0) return { ok: true }
  if (marker.present && marker.valid) return { ok: true }
  if (marker.present) {
    return { ok: false, reason: `${root} carries a ${RUN_MARKER} this driver cannot read` }
  }
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
