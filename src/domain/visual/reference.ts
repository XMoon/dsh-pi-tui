/**
 * The stable, model-visible visual reference (`sv1_…`) and the credential
 * machine block that carries it.
 *
 * A reference names ONE generating visual tool result. It is derived from the
 * exact official identity tuple — session, turn, the seq of the open
 * `step/start`, and the model's `tool/call` id — so the same figure produced
 * twice is two references, while a replayed log derives the same reference.
 * The hash is NOT a permission token: every publication re-verifies the tuple
 * against committed session events.
 *
 * The reference rides in its own TEXT content block, `visual-ref-v1:sv1_…`,
 * inserted before the final `visual-v1:` fact block by the generating tool's
 * `projectContent`; it is never part of the durable fact itself.
 * @module @xmoon76/dsh-pi-tui/domain/visual/reference
 */

import { createHash } from 'node:crypto'

/** Prefix of the machine block carrying the stable reference. */
export const VISUAL_REFERENCE_PREFIX = 'visual-ref-v1:'

/** The one accepted reference spelling: lowercase hex, exactly 20 digits. */
export const VISUAL_REFERENCE_PATTERN = /^sv1_[0-9a-f]{20}$/u

/**
 * The stable reference for one committed generating call.
 * @param identity - the exact official tuple of the generating result.
 * @returns the `sv1_` reference.
 */
export function visualReference(identity: {
  readonly sessionId: string
  readonly turn: number
  readonly stepStartSeq: number
  readonly callId: string
}): string {
  // The trailing empty field reserves the position where a future sub-call
  // identity would go; root results always carry the empty segment.
  const tuple = [identity.sessionId, String(identity.turn), String(identity.stepStartSeq), identity.callId, ''].join('\u0000')
  const digest = createHash('sha256').update(tuple, 'utf8').digest('hex')
  return `sv1_${digest.slice(0, 20)}`
}

/** Whether one string is a well-formed reference (shape only, no authorization). */
export function isVisualReference(value: unknown): value is string {
  return typeof value === 'string' && VISUAL_REFERENCE_PATTERN.test(value)
}

/** Serialize the machine block for one reference. */
export function visualReferenceLine(reference: string): string {
  return `${VISUAL_REFERENCE_PREFIX}${reference}`
}

/** Parse one machine block that carries only a reference. */
export function parseVisualReferenceLine(text: string): string | undefined {
  if (!text.startsWith(VISUAL_REFERENCE_PREFIX)) return undefined
  const reference = text.slice(VISUAL_REFERENCE_PREFIX.length)
  return VISUAL_REFERENCE_PATTERN.test(reference) ? reference : undefined
}

