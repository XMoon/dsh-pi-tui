/**
 * The Client-local Herdr Session projection (H2).
 *
 * ONE pure mapping from the already-committed main Session owner and the
 * actual running profile to the facts Herdr may persist:
 * - a reportable Session is a canonical FULL main-Session id (the existing
 *   `canonicalFullSessionId` classifier); a bare UUID, a fuzzy prefix, a child
 *   id or a display subject never produces a resume target;
 * - a Direct process may add the public cold-open argv
 *   `dsh --profile <actual> --session <canonical>`;
 * - the internal Split Remote Client reports the id only: the frozen product
 *   has no public CLI that could re-attach an existing Host, and a Direct
 *   `--session` command there would create a NEW Host.
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
 * @param directProfile - the actual Direct running profile; undefined on Remote.
 * @returns the reportable projection, or undefined when the id is not canonical.
 */
export function herdrSessionProjection(
  sessionId: string | undefined,
  directProfile: string | undefined,
): HerdrSessionProjection | undefined {
  if (sessionId === undefined || !canonicalFullSessionId(sessionId)) return undefined
  if (directProfile === undefined) return { sessionId }
  const resumeArgv = ['dsh', '--profile', directProfile, '--session', sessionId]
  return legalResumeArgv(resumeArgv) ? { sessionId, resumeArgv } : { sessionId }
}
