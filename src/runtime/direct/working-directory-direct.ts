/**
 * The Direct read of the official Session working-directory authority
 * (`ctx.workingDirectory`, `@deepseek-ai/dsh-working-directory`). The service
 * owns ONE effective absolute directory per Session — the projection's
 * committed value, whose initial state is the immutable Session header cwd —
 * and the official tools (`tool-fs`, `tool-bash`, …) read the same owner
 * (`ensure()`), so a TUI consumer that resolves a directory-based operation
 * reads it HERE instead of the header.
 *
 * The header keeps its own, different meaning: the ORIGINAL project recorded
 * at Session creation (roster grouping, fork lineage). Direct adapters must
 * not substitute one for the other.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/working-directory-direct
 */

/** The structural official service face this read needs (never a package
 *  dependency; the service resolves from the dsh installation). */
export interface WorkingDirectoryServiceLike {
  /** The committed effective directory of one exact Session, without
   *  filesystem I/O. */
  get(session: unknown): string
}

/** A live agent as the directory read resolves it (structural projection). */
export interface EffectiveCwdAgentLike {
  readonly session: {
    readonly header: { readonly cwd?: string }
  }
}

/**
 * The effective directory of one live Agent's Session: the official
 * `workingDirectory.get(session)` value when the service is mounted, else the
 * immutable header cwd — the INITIAL committed value of that same projection,
 * so a minimal composition without the row keeps the historical read instead
 * of inventing a directory.
 *
 * @param workingDirectory - the official service, or `undefined` when the
 * composition does not mount the row.
 * @param agent - the exact live Agent whose Session is read.
 * @returns the effective absolute directory, or `undefined` when neither the
 * service nor a header cwd can answer (never a Client-side guess).
 */
export function effectiveAgentCwd(
  workingDirectory: WorkingDirectoryServiceLike | undefined,
  agent: EffectiveCwdAgentLike,
): string | undefined {
  if (workingDirectory === undefined) return agent.session.header.cwd
  return workingDirectory.get(agent.session)
}

/** The effective directory recorded by one official `workingDirectory`
 *  projection SNAPSHOT value: its wire view is `string | null`, where `null`
 *  is the legal "no directory recorded" state (the header had none) — an
 *  absent/foreign value reads `undefined` (unavailable), never a directory. */
export function projectedWorkingDirectory(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
