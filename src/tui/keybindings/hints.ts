/**
 * Key hint formatting (plan §18): the ONE place that turns a KeyId into
 * the human label the footer/help/settings render. The UI must never
 * hard-code "Shift+Tab" again — it renders `keyHint(keymap, action)` so a
 * user remap automatically updates every hint.
 * @module @xmoon76/dsh-pi-tui/tui/keybindings/hints
 */

import type { KeyId } from '@xmoon76/pi-tui'

/**
 * The TSP renderer's FIXED parked-Question inspection chord (PR3-B B3 §3.8).
 *
 * The TSP interaction seat is not a Host command and owns no keymap action —
 * `Alt+Q` is dispatched from the raw SDK key stream — so this label can never
 * come from `keyHint`/`keysFor`. It also cannot go stale under a remap,
 * because no remap exists for it. It lives HERE, with the key-label
 * vocabulary, because the host-keybindings gate only sanctions key labels
 * owned by this tree: a renderer module must not hard-code the chord itself.
 */
export const TSP_CONTINUED_INSPECTION_LABEL = 'Alt+Q'

/**
 * The History editor-seat tenant's FIXED labels (Phase 3B / B3-A).
 *
 * The seat is a per-surface COMPONENT contract, not a Host command: it owns no
 * keymap action, so these labels can never come from `keyHint`/`keysFor`. They
 * also cannot go stale under a remap, because no remap exists for them. They
 * live HERE, with the key-label vocabulary, because the host-keybindings gate
 * only sanctions key labels owned by this tree: a panel or renderer module must
 * not hard-code the chords itself.
 */
export const HISTORY_PREVIEW_SCROLL_LABEL = 'Alt+↑/↓'
export const HISTORY_COPY_LABEL = 'Alt+C'

/**
 * The History editor-seat tenant's ONE fixed-chord table (Phase 3B / B3-B).
 *
 * The seat is a per-surface COMPONENT contract, not a Host command: it owns no
 * keymap action and no remap exists, so both the handler's KeyIds and the
 * footer / key-badge labels are fixed. Keeping them in ONE table (and in this
 * key-label authority, which is the sanctioned owner of fixed chords) means a
 * hint and the handler it names can never drift into two string authorities.
 */
export const HISTORY_CHORDS = {
  accept: { keys: ['enter', 'ctrl+j'], label: 'Enter' },
  scope: { keys: ['tab'], label: 'Tab' },
  results: { keys: ['up', 'down', 'pageUp', 'pageDown'], label: '↑/↓' },
  preview: { keys: ['alt+up', 'alt+down', 'alt+pageUp', 'alt+pageDown', 'alt+home', 'alt+end'], label: HISTORY_PREVIEW_SCROLL_LABEL },
  copy: { keys: ['alt+c'], label: HISTORY_COPY_LABEL },
  expand: { keys: ['f2'], label: 'F2' },
  cancel: { keys: ['escape', 'ctrl+c'], label: 'Esc' },
} as const satisfies Record<string, { keys: readonly string[]; label: string }>

/** One History chord table key. */
export type HistoryChordId = keyof typeof HISTORY_CHORDS

/**
 * The Delivered files browser's FIXED local chords (Delivered files PR1).
 *
 * The browser panel is a per-surface COMPONENT contract, not a Host command: it
 * owns no keymap action and no remap exists for these chords, so both the
 * handler's KeyIds and the painted labels live in ONE table in this key-label
 * authority — the same category as the History seat's fixed chords. A hint and
 * its handler therefore cannot drift into two string authorities.
 */
export const DELIVERED_FILES_CHORDS = {
  turns: { keys: ['shift+t'], label: 'Shift+T' },
  copyPath: { keys: ['shift+c'], label: 'Shift+C' },
} as const

/** The display name of a bare (unmodified) key id. */
const BASE_KEY_LABELS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageUp: 'PageUp',
  pageDown: 'PageDown',
  // The canonical form lowercases named keys (pageUp → pageup, pageDown →
  // pagedown — convergence: the runtime parser lowercases, so the keymap
  // identity matches it). The DISPLAY mapping must cover both spellings so
  // hints always render PageUp/PageDown.
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  'ctrl+[': 'Ctrl+[',
}

/** Format one KeyId as a human label (`ctrl+shift+f` → `Ctrl+Shift+F`). */
export function formatKeyId(key: KeyId): string {
  const parts = key.split('+')
  const mods: string[] = []
  let base = ''
  for (const part of parts) {
    if (part === 'ctrl') mods.push('Ctrl')
    else if (part === 'alt') mods.push('Alt')
    else if (part === 'shift') mods.push('Shift')
    else if (part === 'super') mods.push('Super')
    else base = part
  }
  const baseLabel = BASE_KEY_LABELS[base] ?? (base.length === 1 ? base.toUpperCase() : base)
  return [...mods, baseLabel].join('+')
}

/** Format a `<leader>X` sequence label (`<leader>t` → `Leader T`). */
export function formatLeaderSequence(completingKey: KeyId): string {
  return `Leader ${formatKeyId(completingKey)}`
}

/** Join several key labels for one action (`Ctrl+F / Ctrl+Shift+F`). */
export function formatKeyList(keys: readonly KeyId[]): string {
  return keys.map(formatKeyId).join(' / ')
}

/** Whether one raw SDK key matches a fixed `KeyId` chord exactly. */
export function matchesKeyId(
  key: { readonly name: string; readonly ctrl?: boolean; readonly alt?: boolean; readonly shift?: boolean; readonly meta?: boolean },
  chord: KeyId,
): boolean {
  const parts = chord.split('+')
  const base = parts[parts.length - 1] as string
  return key.name === base
    && (key.ctrl === true) === parts.includes('ctrl')
    && (key.alt === true) === parts.includes('alt')
    && (key.shift === true) === parts.includes('shift')
    && (key.meta === true) === parts.includes('super')
}

/**
 * The TSP renderer's FIXED published-visual chords (PR3 §2.4): ONE machine
 * definition that serves BOTH the raw-key dispatch and the dock/notice labels.
 *
 * The TSP surface owns no Host keymap action, so these chords are dispatched
 * from the raw SDK key stream and can never come from `keyHint`/`keysFor`. They
 * also cannot go stale under a remap, because no remap exists for them. Keeping
 * the machine ids HERE — with the key-label vocabulary — means the handler and
 * the displayed label can never become two independent string authorities.
 */
export const TSP_VISUAL_CHORDS = {
  select: 'alt+v',
  copy: 'alt+c',
} as const satisfies Record<'select' | 'copy', KeyId>

/** The dock/notice labels DERIVED from the one chord table. */
export const TSP_VISUAL_SELECT_LABEL = formatKeyId(TSP_VISUAL_CHORDS.select)
export const TSP_VISUAL_COPY_LABEL = formatKeyId(TSP_VISUAL_CHORDS.copy)

/** The Job workspace's FIXED local keys (B1-C/B1-D, the same category as the
 *  History editor seat's labels below): the workspace owns NO keymap action for
 *  them — the page toggle and the current page's exact copy are screen-local,
 *  deliberately non-rebindable semantics — so they cannot come from `keyHint`,
 *  and they cannot lie either because no remap exists for them. The **key ids**
 *  live in this authority and the panel imports them for BOTH the handler and
 *  the hint, so an advertised key can never drift from the key that really acts
 *  (design language §7.1). */
export const JOB_LOCAL_KEYS = {
  /** Switch between the Output and Command pages, in both directions. */
  switchPage: 'tab',
  /** Copy the current page's exact original. A BARE letter — the same key the
   *  Settings workspace's copy uses and the one the `[C]` affordance badges name —
   *  so the bar hint reads `c copy …` and badge and key agree (§4.1, §7.1). */
  copy: 'c',
} as const

/**
 * The SVG Viewer's FIXED screen-local chords (PR2.5).
 *
 * The Viewer is a leased READ-ONLY screen, not a Host command surface: these
 * keys are dispatched by the viewer panel only while its screen lease is live,
 * so they are not Host keymap actions and no remap exists for them. Keeping the
 * machine KeyIds and their labels in ONE table means the handler and the
 * action bar (and the panel's page devices) can never drift into two string
 * authorities. The labels are derived through the shared key vocabulary.
 */
const viewerKeyLabel = (key: KeyId): string => formatHintKeys(formatKeyId(key))

export const SVG_VIEWER_CHORDS = {
  /** Switch between the Preview and Source pages (both directions). */
  switchPage: { keys: ['tab'], label: viewerKeyLabel('tab') },
  /** Copy the RAW SVG source (available on both pages). */
  copy: { keys: ['c'], label: viewerKeyLabel('c') },
  /** Close the Viewer and restore the transcript it was opened from. */
  close: { keys: ['escape'], label: viewerKeyLabel('escape') },
  scrollUp: { keys: ['up'], label: '↑' },
  scrollDown: { keys: ['down'], label: '↓' },
  pageUp: { keys: ['pageUp'], label: 'PgUp' },
  pageDown: { keys: ['pageDown'], label: 'PgDn' },
  first: { keys: ['home'], label: 'Home' },
  last: { keys: ['end'], label: 'End' },
} as const satisfies Record<string, { keys: readonly KeyId[]; label: string }>

/** The Source page's fixed scroll hint, derived from the ONE chord table. */
export const SVG_VIEWER_SCROLL_LABEL = [
  `${SVG_VIEWER_CHORDS.scrollUp.label}/${SVG_VIEWER_CHORDS.scrollDown.label}`,
  `${SVG_VIEWER_CHORDS.pageUp.label}/${SVG_VIEWER_CHORDS.pageDown.label}`,
  `${SVG_VIEWER_CHORDS.first.label}/${SVG_VIEWER_CHORDS.last.label}`,
].join(' ')

/** Format one already-labelled key list for an ACTION-BAR HINT: a BARE
 *  unmodified letter stays lowercase (`s`, never `S`) because `S` reads as ⇧S in
 *  prose — the design language's key rule (§4.1). A modified chord keeps its
 *  formatted form (`Shift+S`), and a list keeps its OWN separator spacing
 *  (`s / Shift+S`, the same shape {@link formatKeyList} paints). */
export function formatHintKeys(keys: string): string {
  return keys.split('/').map(part => {
    const core = part.trim()
    const lowered = /^[A-Za-z]$/u.test(core) ? core.toLowerCase() : core
    // Preserve the separator's own spacing instead of imposing one: the list
    // formatter's ` / ` must survive, and a compact `S/Shift+S` stays compact.
    return part.replace(core, lowered)
  }).join('/')
}
