/**
 * The Client-local Herdr Session projection (H2).
 *
 * ONE pure mapping from the already-committed main Session owner and the
 * authoritative resume target to the facts Herdr may persist:
 * - a reportable Session is a canonical FULL main-Session id (the existing
 *   `canonicalFullSessionId` classifier); a bare UUID, a fuzzy prefix, a child
 *   id or a display subject never produces a resume target;
 * - a Direct process may add the public cold-open argv
 *   `dsh --profile <actual> --session <canonical>`;
 * - a public daemon/Split Client adds the public daemon argv
 *   `env DSH_PI_TUI_BACKEND=daemon dsh --profile <actual> --session <canonical>`.
 *   The pinned backend keeps recovery on the daemon route even if the Profile
 *   is later saved back to Direct; it does NOT prove that the original Host
 *   process still exists. The official local discovery/authentication reuses a
 *   live Host, and an absent Host is whatever the public daemon CLI starts for
 *   that Profile.
 *
 * The resume argv is validated as a WHOLE against the Herdr CLI contract
 * (1-64 arguments, at most 8192 UTF-8 bytes, no apostrophe or control
 * character, a PATH command name matching `[A-Za-z0-9_.-]+` that does not
 * start with `-`). An invalid argument vector only drops `resumeArgv`; the
 * Session id itself is still reportable. Nothing is truncated, escaped or
 * "repaired", and no profile is validated against the Host here.
 *
 * @module @xmoon76/dsh-pi-tui/client/herdr/session
 */

import { canonicalFullSessionId } from '../../domain/session/browser.ts'

/** The facts one committed main Session contributes to the Herdr Pane. */
export interface HerdrSessionProjection {
  readonly sessionId: string
  readonly resumeArgv?: readonly string[]
}

/**
 * The authoritative resume target of this Client process. `profile` is the
 * official entry Profile, never a default or a later Settings mirror.
 */
export type HerdrResumeTarget =
  | { readonly kind: 'direct'; readonly profile: string }
  | { readonly kind: 'daemon'; readonly profile: string }

/** Herdr's hard argv bounds for one reported resume command. */
const HERDR_RESUME_MAX_ARGS = 64
const HERDR_RESUME_MAX_BYTES = 8192
/** The upstream command-word rule for `resume_argv[0]`. */
const HERDR_COMMAND_WORD = /^[A-Za-z0-9_.-]+$/u
/** The upstream per-argument rejection: apostrophe or Unicode control chars. */
const HERDR_FORBIDDEN_ARG_CHAR = /['\p{Cc}]/u

/** Whether the complete generated argv is a legal Herdr resume command. */
function legalResumeArgv(argv: readonly string[]): boolean {
  if (argv.length === 0 || argv.length > HERDR_RESUME_MAX_ARGS) return false
  const command = argv[0]
  if (!HERDR_COMMAND_WORD.test(command) || command.startsWith('-')) return false
  let bytes = 0
  for (const arg of argv) {
    if (HERDR_FORBIDDEN_ARG_CHAR.test(arg)) return false
    bytes += Buffer.byteLength(arg, 'utf8')
  }
  return bytes <= HERDR_RESUME_MAX_BYTES
}

/**
 * Project one committed main Session onto the Herdr reporting contract.
 * @param sessionId - the current main-owner Session id (undefined when there is none).
 * @param target - the authoritative resume target; undefined when unknown.
 * @returns the reportable projection, or undefined when the id is not canonical.
 */
export function herdrSessionProjection(
  sessionId: string | undefined,
  target: HerdrResumeTarget | undefined,
): HerdrSessionProjection | undefined {
  if (sessionId === undefined || !canonicalFullSessionId(sessionId)) return undefined
  if (target === undefined) return { sessionId }
  const resumeArgv = target.kind === 'direct'
    ? ['dsh', '--profile', target.profile, '--session', sessionId]
    : ['env', 'DSH_PI_TUI_BACKEND=daemon', 'dsh', '--profile', target.profile, '--session', sessionId]
  return legalResumeArgv(resumeArgv) ? { sessionId, resumeArgv } : { sessionId }
}
