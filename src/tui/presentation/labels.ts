/**
 * Display fitting for a delivery's file labels (Delivered files PR1).
 *
 * A list cell cannot grow, so an over-wide label is abbreviated with BOTH ends
 * (design-language §6.4 `abbreviateName`). That alone cannot guarantee that two
 * DIFFERENT labels stay different: their only distinguishing characters may sit
 * in the middle of the clamp. This module therefore fits the whole delivery at
 * once and makes the PAINTED text pairwise distinct — the one property the
 * surface actually owes the user.
 *
 * The ordinal device is the same one the label projection uses for identical
 * declarations: it never takes a text another row naturally has, it is appended
 * inside the fitted width, and it is deterministic in the delivery's order.
 * @module @xmoon76/dsh-pi-tui/tui/presentation/labels
 */

import { abbreviateName } from '../pickers/name-label.ts'

/**
 * Fit one delivery's labels into `room` cells so no two returned strings are
 * equal.
 *
 * A row whose abbreviated text collides with an earlier row gains a visible
 * ` (n)` ordinal, re-abbreviated from its FULL label so the ends still survive.
 * The ordinal skips every text another row naturally produces, so it can never
 * manufacture a second collision.
 * @param labels - the delivery's projected labels, in declaration order.
 * @param room - the widest the painted label may be, in cells.
 * @returns one fitted label per input, positionally aligned.
 */
export function fitDeliveredLabels(labels: readonly string[], room: number): readonly string[] {
  const limit = Math.max(1, Math.floor(room))
  const fitted = labels.map(label => abbreviateName(label, limit))
  const reserved = new Set(fitted)
  const used = new Set<string>()
  return fitted.map((text, index) => {
    if (!used.has(text)) {
      used.add(text)
      return text
    }
    // With N labels, the candidates (2)..(N+1) always contain a free one:
    // `reserved` and `used` each hold at most N taken values.
    for (let ordinal = 2; ordinal <= labels.length + 2; ordinal += 1) {
      const suffix = ` (${ordinal})`
      const candidate = `${abbreviateName(labels[index] ?? '', Math.max(1, limit - suffix.length))}${suffix}`
      if (reserved.has(candidate) || used.has(candidate)) continue
      used.add(candidate)
      return candidate
    }
    throw new Error('delivered labels: no free ordinal')
  })
}
