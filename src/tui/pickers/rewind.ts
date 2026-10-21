/**
 * Rewind picker ITEM (TS8-E): the PiTui `PickerItem` for one rewind candidate.
 * Consumes the neutral candidate fold from `domain/session/rewind.ts`; owns no
 * semantics. The outline-to-picker-row projection consumed by the mounted
 * surface lives in `app/surface/rewind-presentation.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/pickers/rewind
 */

import type { RewindCandidate } from '../../domain/session/rewind.ts'
import type { PickerItem } from '../../tui-app.ts'

/** One picker row for a candidate. The value remains the selected turn-start
 * identity; the workflow resolves the captured row before dispatch. */
export function rewindPickerItem(candidate: RewindCandidate): PickerItem {
  const tag = candidate.hasNonTextContent ? '[attachment] ' : ''
  const preview = candidate.preview === '' && candidate.hasNonTextContent ? '(attachment only)' : candidate.preview
  return {
    value: String(candidate.turnStartSeq),
    label: `turn ${candidate.turn} · ${tag}${preview}`,
    ...(candidate.hasNonTextContent
      ? { description: 'non-text content is not re-staged on rewind' }
      : {}),
  }
}
