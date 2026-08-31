/**
 * Access status derivation (plan §4.2): the effective permission preset,
 * the sandbox mode and the approval policy are INDEPENDENT facts. The
 * preset is the official `permissionPresets.current(session)` resolution
 * (alpha.2 reads the session's knob state); the sandbox mode comes from
 * the official sandbox policy service (or the official fold); the approval
 * policy comes from the official approval fold. Nothing is guessed from
 * preset names, runner names or platform names, and `custom` is a neutral
 * unmatched combination — never danger.
 *
 * The module is generic over the event type so it stays free of Host type
 * imports (the boundary gate): the runner instantiates it with the real
 * session event type.
 * @module @xmoon76/dsh-pi-tui/status/derive-access
 */

import type { AccessStatus } from './types.ts'

/** The official permission-presets service surface (structural). */
export interface PermissionPresetsLike {
  current(session: unknown): string
  optionOf(name: string): { name: string; label?: string }
}

/** The official sandbox-policy service surface (structural). */
export interface SandboxPolicyLike {
  resolve(request?: { session?: unknown }): { mode: string }
}

/** The official approval fold (dsh-user-approval's effectiveApprovalPolicy). */
export type ApprovalFold<E> = (events: readonly E[]) => 'ask' | 'never' | undefined

/** The derivation inputs; every service is optional (capability-gated). */
export interface AccessDeriveDeps<E> {
  permissionPresets?: PermissionPresetsLike
  sandboxPolicy?: SandboxPolicyLike
  approvalFold?: ApprovalFold<E>
  /** The official sandbox fold (dsh-sandbox-policy's effectiveSandboxMode),
   * used when the sandbox policy service is absent. */
  sandboxFold?: (events: readonly E[]) => string | undefined
}

/** The sandbox modes the TUI's own vocabulary names. */
export type SandboxModeName = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Normalize an upstream sandbox mode string onto the TUI vocabulary;
 * unknown modes are omitted (never guessed). */
export function sandboxModeName(mode: string | undefined): SandboxModeName | undefined {
  switch (mode) {
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return mode
    default:
      return undefined
  }
}

/**
 * Derive the access section from the official services. Every input is
 * optional: a missing service degrades to an absent fact, never a crash.
 * @param deps - the service surfaces.
 * @param events - the display subject's session events (log order).
 * @param session - the live session object for the sandbox policy resolve
 *   (optional; the fold fallback covers its absence).
 */
export function deriveAccessStatus<E>(
  deps: AccessDeriveDeps<E>,
  events: readonly E[],
  session?: unknown,
): AccessStatus {
  const status: {
    permissionPreset?: AccessStatus['permissionPreset']
    sandbox?: AccessStatus['sandbox']
    approval?: AccessStatus['approval']
  } = {}

  const presets = deps.permissionPresets
  if (presets !== undefined && session !== undefined) {
    try {
      const id = presets.current(session)
      const option = presets.optionOf(id)
      status.permissionPreset = {
        id,
        label: option.label ?? option.name,
        matched: id !== 'custom',
      }
    } catch {
      // A throwing preset service degrades to an absent fact.
    }
  }

  let sandboxMode: string | undefined
  const policy = deps.sandboxPolicy
  if (policy !== undefined) {
    try {
      sandboxMode = policy.resolve(session === undefined ? undefined : { session }).mode
    } catch {
      sandboxMode = undefined
    }
  }
  if (sandboxMode === undefined && deps.sandboxFold !== undefined) {
    try {
      sandboxMode = deps.sandboxFold(events)
    } catch {
      sandboxMode = undefined
    }
  }
  const mode = sandboxModeName(sandboxMode)
  if (mode !== undefined) status.sandbox = { mode }

  if (deps.approvalFold !== undefined) {
    try {
      const policy = deps.approvalFold(events)
      if (policy !== undefined) status.approval = { policy }
    } catch {
      // Degrade to an absent fact.
    }
  }

  return status
}
