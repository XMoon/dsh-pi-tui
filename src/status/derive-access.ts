/**
 * Access status derivation (plan §4.2): the effective permission preset,
 * the sandbox mode and the approval policy are INDEPENDENT facts. The
 * preset is the official `permissionPresets.current(session)` resolution;
 * the sandbox mode comes from the official sandbox policy service; the
 * approval policy comes from the official approval service's session
 * override read (`overrideOf(session)`, no configured default applied —
 * an absent override stays an absent fact). Nothing is guessed from
 * preset names, runner names or platform names, and `custom` is a neutral
 * unmatched combination — never danger.
 *
 * Every seam is session-oriented (alpha.4): no event-log array crosses
 * this boundary, so the module stays free of Host type imports (the
 * boundary gate) while the official services own their own folds.
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

/** The official approval service surface (structural; `overrideOf(session)`
 * reads the session's own `approval/policy` fold without the configured
 * default). */
export interface ApprovalServiceLike {
  overrideOf(session: unknown): 'ask' | 'never' | undefined
}

/** The derivation inputs; every service is optional (capability-gated). */
export interface AccessDeriveDeps {
  permissionPresets?: PermissionPresetsLike
  sandboxPolicy?: SandboxPolicyLike
  approval?: ApprovalServiceLike
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
 * @param session - the display subject's live session (opaque; each
 *   service reads it through its own official seam).
 */
export function deriveAccessStatus(deps: AccessDeriveDeps, session?: unknown): AccessStatus {
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

  const policy = deps.sandboxPolicy
  if (policy !== undefined) {
    try {
      const mode = sandboxModeName(policy.resolve(session === undefined ? undefined : { session }).mode)
      if (mode !== undefined) status.sandbox = { mode }
    } catch {
      // Degrade to an absent fact.
    }
  }

  const approval = deps.approval
  if (approval !== undefined && session !== undefined) {
    try {
      const policy = approval.overrideOf(session)
      if (policy !== undefined) status.approval = { policy }
    } catch {
      // Degrade to an absent fact.
    }
  }

  return status
}
