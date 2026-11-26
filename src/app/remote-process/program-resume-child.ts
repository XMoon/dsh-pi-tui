/**
 * The private spawn-boundary fill for one admitted foreground Client's OSC 7577
 * handoff. The public daemon-launcher child-environment builder stays
 * capability-free, so its emitted declaration cannot leak the Client-local
 * target/handoff module paths.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/program-resume-child
 */

import {
  encodeProgramResumeHandoff,
  PROGRAM_RESUME_HANDOFF_ENV,
  PROGRAM_RESUME_TOKEN_ENV,
} from '../../client/program-resume/handoff.ts'
import type { ProgramResumeCapability } from '../../client/program-resume/target.ts'

/** Add the protocol token and non-secret facts only to the admitted child env. */
export function applyProgramResumeChildEnvironment(
  env: NodeJS.ProcessEnv,
  capability: ProgramResumeCapability,
): void {
  env[PROGRAM_RESUME_TOKEN_ENV] = capability.token
  env[PROGRAM_RESUME_HANDOFF_ENV] = encodeProgramResumeHandoff(capability.facts)
}
