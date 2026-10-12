/**
 * The two rules the harness keeps pure, so the headless suite covers them:
 *
 *   - **Which commands may be repeated.** A retry is invisible for a read or an
 *     idempotent set, and is a SECOND real input for a click, a key or a subject
 *     launch — a green run could then claim "exactly one real input" while two
 *     were delivered.
 *   - **How a path is quoted into the generated `launch.sh`.** The run directory,
 *     the repository and the subject may all contain spaces or quotes.
 *
 * The run directory needs no rule here: every run creates a fresh directory of its
 * own and deletes nothing, so there is no ownership to prove or to take over.
 */

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
 * Quote a path for the generated `launch.sh`. An unquoted path with a space fails
 * there as a confusing "no such file" instead of starting the subject.
 */
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
