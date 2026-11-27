/**
 * The authoritative OSC 7577 resume target: exact launch scope -> the public
 * cold-open command. This module is Client-local and performs only boot-time
 * proof; Session identity stays with the production ownership core.
 *
 * A target is produced only when EVERY launch fact is losslessly expressible:
 * the real official Profile, absolute DSH home, the actual backend, the real
 * CLI launch cwd, the current Node executable and the exact official DSH JS
 * entry. Overlays, an explicit preset, telemetry overrides, special Node flags,
 * a multiplexer/SSH topology, a non-TTY launch or an untrusted token source
 * disable the sender instead of guessing.
 *
 * @module @xmoon76/dsh-pi-tui/client/program-resume/target
 */

import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { canonicalFullSessionId } from '../../domain/session/browser.ts'
import { isProgramResumeToken } from './codec.ts'
import {
  decodeProgramResumeHandoff,
  type ProgramResumeLaunchFacts,
} from './handoff.ts'

/** The official installed DSH manifest path (the launcher's install anchor). */
export interface ProgramResumeProfileContext {
  readonly name: string
  readonly home: string
  readonly cwd: string
  readonly installAnchor: string
  readonly overlays: readonly unknown[]
  readonly telemetryDisabledEnv: string | undefined
}

/** The official layered launch snapshot, structurally. */
export interface ProgramResumeLaunchEnvironment {
  getFrom(
    name: string,
    sources: readonly ('process' | 'project-env' | 'user-env')[],
  ): { readonly value: string; readonly source: string } | undefined
}

/** The exact cold-open command one committed Session may be resumed with. */
export interface ProgramResumeTarget {
  readonly token: string
  readonly ownerPid: number
  readonly argv: readonly string[]
  readonly cwd: string
}

/** The one candidate pair built before any Session exists. */
export interface ProgramResumeCapability {
  readonly token: string
  readonly facts: ProgramResumeLaunchFacts
}

/** The fixed protocol command prefix; `/usr/bin/env` is a real executable. */
const ENV = '/usr/bin/env'
const FORBIDDEN_PATH_TEXT = /[\u0000-\u001F\u007F-\u009F]/u

/** A readable regular file. */
function regularFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** An executable regular file. */
function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A readable/traversable directory. */
function directory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve the exact official CLI entry from the installed DSH manifest. */
export function resolveOfficialCliEntry(installAnchor: string, expectedEntry?: string): string | undefined {
  if (!isAbsolute(installAnchor)) return undefined
  let manifestPath: string
  let manifest: unknown
  try {
    manifestPath = realpathSync(installAnchor)
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
  const record = manifest as { readonly name?: unknown; readonly version?: unknown; readonly bin?: unknown }
  if (record.name !== '@deepseek-ai/dsh' || typeof record.version !== 'string') return undefined
  const bin = record.bin
  const relative = bin !== null && typeof bin === 'object' && !Array.isArray(bin)
    ? (bin as { readonly dsh?: unknown }).dsh
    : undefined
  if (typeof relative !== 'string' || relative === '' || isAbsolute(relative)) return undefined
  const root = dirname(manifestPath)
  let entry: string
  try {
    entry = realpathSync(join(root, relative))
  } catch {
    return undefined
  }
  // The official JS entry must stay inside THIS installation; a manifest may
  // not turn the launch target into an arbitrary external script.
  if (entry !== root && !entry.startsWith(`${root}${sep}`)) return undefined
  if (!regularFile(entry)) return undefined
  if (expectedEntry !== undefined) {
    try {
      if (realpathSync(expectedEntry) !== entry) return undefined
    } catch {
      return undefined
    }
  }
  return entry
}

/** The inherited process-layer value, or undefined. */
function processLayer(launch: ProgramResumeLaunchEnvironment, name: string): string | undefined {
  const entry = launch.getFrom(name, ['process'])
  return entry === undefined || entry.value === '' ? undefined : entry.value
}

/** Whether the launch topology may report at all. */
function topologyAdmitted(env: NodeJS.ProcessEnv, launch: ProgramResumeLaunchEnvironment): boolean {
  if (processLayer(launch, 'SSH_CONNECTION') !== undefined || processLayer(launch, 'SSH_TTY') !== undefined) return false
  for (const name of ['TMUX', 'STY', 'ZELLIJ'] as const) {
    const value = env[name]
    if (value !== undefined && value !== '') return false
  }
  return true
}

/** The one official-profile admission shared by Direct and the daemon supervisor. */
function profileAdmitted(input: {
  readonly profileContext: ProgramResumeProfileContext
  readonly launch: ProgramResumeLaunchEnvironment
  readonly presetId: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly execArgv: readonly string[]
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly platform: NodeJS.Platform
}): boolean {
  if (input.platform !== 'linux' && input.platform !== 'darwin') return false
  if (!input.stdinIsTTY || !input.stdoutIsTTY) return false
  if (input.presetId !== undefined && input.presetId !== '') return false
  // The official launch path treats a non-empty environment preset exactly like
  // `--preset`; the frozen resume argv cannot carry either form.
  if ((input.env.DSH_PI_TUI_PRESET?.trim() ?? '') !== '') return false
  if (input.profileContext.overlays.length !== 0) return false
  if ((input.profileContext.telemetryDisabledEnv ?? '') !== '') return false
  if (input.execArgv.length !== 0) return false
  if (processLayer(input.launch, 'NODE_OPTIONS') !== undefined) return false
  const flatNodeOptions = input.env.NODE_OPTIONS
  if (flatNodeOptions !== undefined && flatNodeOptions !== '') return false
  if (!topologyAdmitted(input.env, input.launch)) return false
  return true
}

/** An absolute, control-free path string. */
function pathTextAdmitted(value: string): boolean {
  return isAbsolute(value) && !FORBIDDEN_PATH_TEXT.test(value)
}

/** Validate the profile name/path text the command must carry verbatim. */
function scopeTextAdmitted(input: ProgramResumeProfileContext): boolean {
  if (input.name === '' || input.name.startsWith('-') || FORBIDDEN_PATH_TEXT.test(input.name)) return false
  return pathTextAdmitted(input.home) && pathTextAdmitted(input.cwd)
    && directory(input.home) && directory(input.cwd)
}

/** Build the non-secret facts once the caller has the trusted token. */
function capabilityOf(input: {
  readonly profileContext: ProgramResumeProfileContext
  readonly launch: ProgramResumeLaunchEnvironment
  readonly token: string
  readonly backend: 'direct' | 'daemon'
  readonly ownerPid: number
  readonly nodePath: string
  readonly cliPath: string
}): ProgramResumeCapability | undefined {
  if (!isProgramResumeToken(input.token)) return undefined
  if (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 0) return undefined
  if (!pathTextAdmitted(input.nodePath) || !pathTextAdmitted(input.cliPath)) return undefined
  if (!executableFile(ENV) || !executableFile(input.nodePath) || !regularFile(input.cliPath)) return undefined
  if (!scopeTextAdmitted(input.profileContext)) return undefined
  return {
    token: input.token,
    facts: {
      version: 1,
      ownerPid: input.ownerPid,
      home: input.profileContext.home,
      profile: input.profileContext.name,
      backend: input.backend,
      cwd: input.profileContext.cwd,
      nodePath: input.nodePath,
      cliPath: input.cliPath,
    },
  }
}

/** The Direct CLI's capability: token must come from the inherited layer only. */
export function directProgramResumeCapability(input: {
  readonly profileContext: ProgramResumeProfileContext
  readonly launch: ProgramResumeLaunchEnvironment
  readonly presetId: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly execArgv: readonly string[]
  readonly argv: readonly string[]
  readonly execPath: string
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly platform: NodeJS.Platform
}): ProgramResumeCapability | undefined {
  if (!profileAdmitted(input)) return undefined
  const token = processLayer(input.launch, 'OSC7577_TOKEN')
  if (token === undefined) return undefined
  const argv1 = input.argv[1]
  if (argv1 === undefined) return undefined
  const cli = resolveOfficialCliEntry(input.profileContext.installAnchor, argv1)
  if (cli === undefined) return undefined
  return capabilityOf({
    profileContext: input.profileContext,
    launch: input.launch,
    token,
    backend: 'direct',
    ownerPid: process.pid,
    nodePath: input.execPath,
    cliPath: cli,
  })
}

/** The daemon supervisor's capability: same proof, daemon backend and own PID. */
export function daemonProgramResumeCapability(input: {
  readonly profileContext: ProgramResumeProfileContext
  readonly launch: ProgramResumeLaunchEnvironment
  readonly presetId: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly execArgv: readonly string[]
  readonly argv: readonly string[]
  readonly execPath: string
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly platform: NodeJS.Platform
}): ProgramResumeCapability | undefined {
  if (!profileAdmitted(input)) return undefined
  const token = processLayer(input.launch, 'OSC7577_TOKEN')
  if (token === undefined) return undefined
  const argv1 = input.argv[1]
  if (argv1 === undefined) return undefined
  const cli = resolveOfficialCliEntry(input.profileContext.installAnchor, argv1)
  if (cli === undefined) return undefined
  return capabilityOf({
    profileContext: input.profileContext,
    launch: input.launch,
    token,
    backend: 'daemon',
    ownerPid: process.pid,
    nodePath: input.execPath,
    cliPath: cli,
  })
}

/**
 * Validate the daemon Client's captured private handoff at the real process
 * boundary. Any untrusted shape, a different official scope, a changed
 * supervisor owner, an unsupported topology or a path that is no longer the
 * same kind of file disables the sender without affecting business startup.
 */
export function clientProgramResumeCapability(input: {
  readonly token: string | undefined
  readonly handoff: string | undefined
  readonly expectedHome: string
  readonly expectedProfile: string
  readonly isReexec: boolean
  readonly parentPid: number
  readonly env: NodeJS.ProcessEnv
  readonly execArgv: readonly string[]
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly platform: NodeJS.Platform
}): ProgramResumeCapability | undefined {
  if (!isProgramResumeToken(input.token) || input.handoff === undefined) return undefined
  if (input.platform !== 'linux' && input.platform !== 'darwin') return undefined
  if (!input.stdinIsTTY || !input.stdoutIsTTY) return undefined
  if (input.execArgv.length !== 0) return undefined
  const nodeOptions = input.env.NODE_OPTIONS
  if (nodeOptions !== undefined && nodeOptions !== '') return undefined
  for (const name of ['TMUX', 'STY', 'ZELLIJ', 'SSH_CONNECTION', 'SSH_TTY'] as const) {
    const value = input.env[name]
    if (value !== undefined && value !== '') return undefined
  }
  const facts = decodeProgramResumeHandoff(input.handoff)
  if (facts === undefined || facts.backend !== 'daemon') return undefined
  if (facts.profile !== input.expectedProfile) return undefined
  if (facts.profile === '' || facts.profile.startsWith('-') || FORBIDDEN_PATH_TEXT.test(facts.profile)) return undefined
  if (!pathTextAdmitted(facts.home) || !pathTextAdmitted(facts.cwd)) return undefined
  if (!pathTextAdmitted(facts.nodePath) || !pathTextAdmitted(facts.cliPath)) return undefined
  if (facts.ownerPid === process.pid) return undefined
  if (!input.isReexec && facts.ownerPid !== input.parentPid) return undefined
  let home: string
  let expectedHome: string
  try {
    home = realpathSync(facts.home)
    expectedHome = realpathSync(input.expectedHome)
  } catch {
    return undefined
  }
  if (home !== expectedHome) return undefined
  const profileDir = join(home, 'profiles', input.expectedProfile)
  if (!directory(profileDir)) return undefined
  if (!directory(facts.cwd) || !executableFile(ENV) || !executableFile(facts.nodePath) || !regularFile(facts.cliPath)) return undefined
  return { token: input.token, facts: { ...facts, home } }
}

/**
 * Freeze the exact cold-open command for one committed canonical Session.
 * @param capability - the already-admitted launch capability.
 * @param sessionId - the committed main-owner Session id.
 * @returns the command, or undefined when the id is not canonical.
 */
export function programResumeTarget(
  capability: ProgramResumeCapability,
  sessionId: string | undefined,
): ProgramResumeTarget | undefined {
  if (sessionId === undefined || !canonicalFullSessionId(sessionId)) return undefined
  const facts = capability.facts
  return {
    token: capability.token,
    ownerPid: facts.ownerPid,
    cwd: facts.cwd,
    argv: [
      ENV,
      `DSH_HOME=${facts.home}`,
      `DSH_PI_TUI_BACKEND=${facts.backend}`,
      facts.nodePath,
      facts.cliPath,
      '--profile',
      facts.profile,
      '--session',
      sessionId,
    ],
  }
}
