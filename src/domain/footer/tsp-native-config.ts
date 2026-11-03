/**
 * TSP-7 PR-D: the one-shot read-only TSP native footer config projection.
 *
 * A PURE domain decision: given the merged TUI settings document, the config
 * readiness and the USER-layer custom-item parse result, it answers WHICH
 * native footer presentation the TSP renderer mounts — and nothing else. It
 * reads no runtime port, executes nothing, persists nothing and never
 * rewrites the settings document: the persisted footer mode/layout/items stay
 * byte-for-byte what they were (the incompatible facts surface as bounded
 * notices instead of being silently "fixed").
 *
 * Unsupported capabilities are EXPLICIT_UNAVAILABLE by design: whole-footer
 * `command`, custom command items and extension items are never executed in
 * TSP; the resolver routes them to a native mode plus a notice, never to a
 * fabricated value. Which layout refs are actually renderable is decided by
 * the renderer against the REAL registry (no second builtin id list here).
 * @module @xmoon76/dsh-pi-tui/domain/footer/tsp-native-config
 */

import {
  isFooterLayout,
  parseFooterLayout,
  resolveCommandFooterFallback,
  type FooterLayoutV1,
} from './layout.ts'
import type {
  FooterCustomItemsParseResult,
  FooterCustomTextItemSettings,
} from './custom-items.ts'

/** The native presentation modes the TSP renderer can mount. */
export type TspNativeFooterMode = 'default' | 'compact' | 'custom'

/** The boot-time read-only footer projection consumed by ONE TSP mount. */
export interface TspNativeFooterConfig {
  readonly mode: TspNativeFooterMode
  /** The validated layout; present only for a `custom` mode with a valid one. */
  readonly layout?: FooterLayoutV1
  /** The USER-layer text definitions (kind:'text' only — never commands). */
  readonly userTextItems: readonly FooterCustomTextItemSettings[]
  /** The USER-layer command definition IDS (classified unavailable — never executed, never stringified to the renderer). */
  readonly userCommandIds: ReadonlySet<string>
  /** The bounded boot notices, in the fixed order, deduplicated. */
  readonly notices: readonly string[]
}

/** The fixed user-facing notice strings (the renderer only orders and enqueues them). */
export const TSP_FOOTER_NOTICES = {
  notCurrent: 'Footer settings are not current; TSP is showing its default footer.',
  invalidLayout: 'Invalid footer layout; TSP is showing its default footer.',
  commandFallback: 'TSP cannot run command footer; saved native fallback shown.',
  unavailableItems: 'Some footer items are unavailable in TSP; settings were preserved.',
  unsupportedSeparator: 'Custom footer separators are not supported in TSP; settings were preserved.',
  invalidCustomItems: 'Invalid custom footer items were skipped.',
} as const

/** The native row separator the renderer always uses (any other persisted
 * separator text is unsupported and noticed, never rendered). */
export const TSP_NATIVE_ROW_SEPARATOR = '  '

/**
 * Resolve the TSP native footer config. The algorithm is fixed by the PR-D
 * plan §3.2 — do not "improve" it into a second settings authority:
 *
 * 1. `readiness !== 'ready'` fails closed to the fixed default with ONE
 *    not-current notice; the USER-layer items must not be read in that state
 *    (the caller passes an empty parse result — this function never reads a
 *    port itself).
 * 2. `compact` keeps its fixed single native row (the plan's own preset — the
 *    PiTui compact layout is NOT reused).
 * 3. `custom` parses `footerLayout`: valid → custom + layout; invalid → the
 *    fixed default + ONE invalid-layout notice (the persisted raw value is
 *    preserved untouched).
 * 4. `command` never executes: the EXISTING `resolveCommandFooterFallback`
 *    decides the persisted native fallback and ONE command notice is added.
 *    An invalid custom fallback degrades to the default AND keeps the
 *    invalid-layout notice.
 * 5. `default`/`full`/unknown values keep the fixed default; `footerLayout`
 *    is deliberately not read so a stale layout cannot pollute it.
 */
export function resolveTspNativeFooterConfig(input: {
  readonly doc: { readonly footer: string; readonly footerFallbackMode?: unknown; readonly footerLayout?: unknown }
  readonly readiness: string
  readonly userItems: FooterCustomItemsParseResult
}): TspNativeFooterConfig {
  const notices: string[] = []
  const pushNotice = (text: string): void => {
    if (!notices.includes(text)) notices.push(text)
  }

  // 1. Not ready: the fixed default, no USER-layer values, one notice.
  if (input.readiness !== 'ready') {
    pushNotice(TSP_FOOTER_NOTICES.notCurrent)
    return { mode: 'default', userTextItems: [], userCommandIds: new Set<string>(), notices }
  }

  // The USER-layer classification (only read once readiness is trusted): text
  // definitions are projectable, command definitions are unavailable-by-id.
  const userTextItems = input.userItems.items
    .filter((item): item is FooterCustomTextItemSettings => item.kind === 'text')
  const userCommandIds = new Set<string>(
    input.userItems.items
      .filter(item => item.kind === 'command')
      .map(item => item.id),
  )
  if (input.userItems.invalidCount > 0) pushNotice(TSP_FOOTER_NOTICES.invalidCustomItems)

  let mode: TspNativeFooterMode = 'default'
  let layout: FooterLayoutV1 | undefined

  switch (input.doc.footer) {
    case 'compact':
      // 2. The fixed TSP compact row. The USER text items stay in the
      // projection (a diagnostic fact), but the compact row never injects
      // them — its placements are the plan's own preset.
      mode = 'compact'
      break
    case 'custom': {
      // 3. The persisted layout decides; an invalid one fails soft to the
      // default with ONE notice, and the raw document is never rewritten.
      const parsed = parseFooterLayout(input.doc.footerLayout)
      if (isFooterLayout(parsed)) {
        mode = 'custom'
        layout = parsed
      } else {
        pushNotice(TSP_FOOTER_NOTICES.invalidLayout)
      }
      break
    }
    case 'command': {
      // 4. NO execution path exists in TSP: the persisted native fallback
      // (already restart-proof and explicitly mode-gated by the existing
      // resolver) is what shows, plus ONE command notice.
      const fallback = resolveCommandFooterFallback(input.doc)
      if (fallback.mode === 'compact') {
        mode = 'compact'
      } else if (fallback.mode === 'custom' && fallback.layout !== undefined) {
        mode = 'custom'
        layout = fallback.layout
      } else if (fallback.mode === 'custom') {
        // `footerFallbackMode: custom` with an invalid persisted layout: the
        // fallback itself is the builtin default, and the invalid-layout
        // notice states why (both notices, once each, fixed order).
        pushNotice(TSP_FOOTER_NOTICES.invalidLayout)
      }
      pushNotice(TSP_FOOTER_NOTICES.commandFallback)
      break
    }
    default:
      // 5. 'default' | 'full' | unknown compat values → the fixed default.
      // footerLayout is deliberately NOT read here.
      break
  }

  // A persisted separator the native row does not implement: the renderer
  // keeps its standard spacing and the settings are preserved — stated once.
  if (layout !== undefined) {
    for (const row of layout.rows) {
      if (row.separator?.text !== undefined && row.separator.text !== TSP_NATIVE_ROW_SEPARATOR) {
        pushNotice(TSP_FOOTER_NOTICES.unsupportedSeparator)
        break
      }
    }
  }

  return {
    mode,
    ...(layout === undefined ? {} : { layout }),
    userTextItems,
    userCommandIds,
    notices,
  }
}
