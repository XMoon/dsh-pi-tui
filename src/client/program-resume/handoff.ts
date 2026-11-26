/**
 * The private program-resume handoff between the daemon supervisor and its
 * foreground Client, plus the environment keys the OSC 7577 sender owns.
 *
 * The handoff carries only non-secret launch facts. The capability token rides
 * in its own protocol environment variable and is never duplicated into this
 * JSON, a log, argv, a Session or a Host DTO.
 *
 * @module @xmoon76/dsh-pi-tui/client/program-resume/handoff
 */

/** The protocol's capability environment variable. */
export const PROGRAM_RESUME_TOKEN_ENV = 'OSC7577_TOKEN'

/** The private, versioned supervisor -> foreground Client fact channel. */
export const PROGRAM_RESUME_HANDOFF_ENV = 'SPLIT_PROCESS_OSC7577_V1'

/** A hard ceiling on the decoded handoff (it carries paths, not payloads). */
const MAX_HANDOFF_BYTES = 16 * 1024

/** The non-secret launch facts one OSC 7577 sender may use. */
export interface ProgramResumeLaunchFacts {
  readonly version: 1
  /** The real owning process: Direct itself, or the public daemon supervisor. */
  readonly ownerPid: number
  /** The official absolute DSH home. */
  readonly home: string
  /** The official Profile name. */
  readonly profile: string
  /** The backend the launch actually used, pinned into the resume command. */
  readonly backend: 'direct' | 'daemon'
  /** The real Client launch cwd, not a later Host working directory. */
  readonly cwd: string
  /** The absolute Node executable that will run the resume command. */
  readonly nodePath: string
  /** The real `@deepseek-ai/dsh` JS entry resolved from the install anchor. */
  readonly cliPath: string
}

/** The captured pair, still in its untrusted environment form. */
export interface ProgramResumeHandoffCapture {
  readonly token: string | undefined
  readonly handoff: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read and delete both OSC 7577 environment fields in ONE synchronous step.
 * The caller decides whether the captured values are trustworthy; the raw
 * strings never remain ambient for a later child.
 */
export function takeProgramResumeHandoff(env: NodeJS.ProcessEnv): ProgramResumeHandoffCapture {
  const token = env[PROGRAM_RESUME_TOKEN_ENV]
  const handoff = env[PROGRAM_RESUME_HANDOFF_ENV]
  delete env[PROGRAM_RESUME_TOKEN_ENV]
  delete env[PROGRAM_RESUME_HANDOFF_ENV]
  return { token, handoff }
}

/** Encode the non-secret facts for the foreground Client environment. */
export function encodeProgramResumeHandoff(facts: ProgramResumeLaunchFacts): string {
  return JSON.stringify({
    version: facts.version,
    ownerPid: facts.ownerPid,
    home: facts.home,
    profile: facts.profile,
    backend: facts.backend,
    cwd: facts.cwd,
    nodePath: facts.nodePath,
    cliPath: facts.cliPath,
  })
}

/**
 * Decode the private handoff strictly: bounded JSON, exactly the v1 keys and
 * primitive types. Path/admission proof belongs to the caller (it needs the
 * officially resolved home/profile and the live process facts).
 * @returns the decoded facts, or undefined for any malformed shape.
 */
export function decodeProgramResumeHandoff(raw: string): ProgramResumeLaunchFacts | undefined {
  if (raw === '' || Buffer.byteLength(raw, 'utf8') > MAX_HANDOFF_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const keys = Object.keys(parsed).sort()
  const expected = ['backend', 'cliPath', 'cwd', 'home', 'nodePath', 'ownerPid', 'profile', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined
  if (parsed.version !== 1) return undefined
  if (typeof parsed.ownerPid !== 'number' || !Number.isSafeInteger(parsed.ownerPid) || parsed.ownerPid <= 0) return undefined
  const home = parsed.home
  const profile = parsed.profile
  const cwd = parsed.cwd
  const nodePath = parsed.nodePath
  const cliPath = parsed.cliPath
  if (typeof home !== 'string' || home === '') return undefined
  if (typeof profile !== 'string' || profile === '') return undefined
  if (typeof cwd !== 'string' || cwd === '') return undefined
  if (typeof nodePath !== 'string' || nodePath === '') return undefined
  if (typeof cliPath !== 'string' || cliPath === '') return undefined
  if (parsed.backend !== 'direct' && parsed.backend !== 'daemon') return undefined
  return {
    version: 1,
    ownerPid: parsed.ownerPid,
    home,
    profile,
    backend: parsed.backend,
    cwd,
    nodePath,
    cliPath,
  }
}

/** Remove both fields from a child-environment copy. */
export function scrubProgramResumeEnvironment(env: NodeJS.ProcessEnv): void {
  delete env[PROGRAM_RESUME_TOKEN_ENV]
  delete env[PROGRAM_RESUME_HANDOFF_ENV]
}
