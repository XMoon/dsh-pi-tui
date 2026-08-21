/**
 * Slot identity map: the canonical slot names, their semantics, and the
 * registry key for each slot. The SurfaceHost (M2) reads slot semantics from
 * here; the ledger enforces the semantic rules (list ordering / single
 * winner) on registration.
 * @module @xmoon76/dsh-pi-tui/extension/slot-map
 */

import type { PiTuiSlotName, PiTuiSlotSemantic } from './public-types.ts'

/** The semantic of every known slot. M1 implements `list` only; `single`
 * is declared for the ledger's conflict rules and becomes reachable when the
 * first single-winner slot lands (M2+). M4 adds the two widget slots as
 * `list` (multiple widgets stack in deterministic order). */
const SLOT_SEMANTICS: Readonly<Record<PiTuiSlotName, PiTuiSlotSemantic>> = {
  'chrome.header.badge': 'list',
  'input.dock.item': 'list',
  'chrome.footer.status': 'list',
  'input.widget.above': 'list',
  'input.widget.below': 'list',
}

/** Whether a string names a known slot. `Object.hasOwn`, never `in` — a
 * prototype member like 'constructor' must not pass the guard. */
export function isSlotName(name: string): name is PiTuiSlotName {
  return Object.hasOwn(SLOT_SEMANTICS, name)
}

/** The semantic of a known slot. Throws on unknown names (callers guard
 * with {@link isSlotName} first — registration errors carry the slot name). */
export function slotSemantic(name: PiTuiSlotName): PiTuiSlotSemantic {
  return SLOT_SEMANTICS[name]
}

/** Every known slot name, for diagnostics and health listing. */
export function slotNames(): readonly PiTuiSlotName[] {
  return Object.keys(SLOT_SEMANTICS) as PiTuiSlotName[]
}
