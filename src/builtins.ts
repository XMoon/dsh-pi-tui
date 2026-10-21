/**
 * The first-party builtins contributor: `@xmoon76/dsh-pi-tui/builtins`.
 *
 * Loader-only (NOT a stable third-party SDK — the plan documents this):
 * registers the bundle's own chrome contributions through the SAME public
 * extension API a third-party plugin uses, so the first-party path is
 * dogfooded (plan M3: builtins and third-party plugins share one service
 * API; the host keeps no special builtin slot setters).
 *
 * M1 scope: the version header badge and the todo-summary dock item. The
 * turn/step footer counters were migrated OUT of the extension slot into
 * the host-native `turns-steps` footer item (plan §13.4) — the host core
 * state no longer depends on plugin loading.
 * @module @xmoon76/dsh-pi-tui/builtins
 */

import type { Context } from '@deepseek-ai/cordis'
import { bundleVersion, dshVersion } from './client/launcher/version.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from './extensions.ts'
import type { DockItem, HeaderBadge, StyledSpan } from './extension/public-types.ts'
import { TUI_STARTUP_SERVICE } from './startup.ts'

/** Stable Cordis plugin name for the builtins row. */
export const name = 'pi-tui-builtins'

/** The builtins mount only when the TUI startup flags were parsed. */
export const inject = [TUI_STARTUP_SERVICE, PI_TUI_EXTENSIONS_SERVICE]

/**
 * Register the first-party chrome contributions. The turn/step footer
 * segment subscribes to the surface state and re-bakes via handle.replace
 * on every state change (the async-producer → cache → invalidate pattern
 * from the plan §8.4, with replace() as the cache commit).
 * @param ctx - the builtins plugin context (the extension service resolves
 *   through it; the registration is owned by THIS fiber).
 */
export function apply(ctx: Context): void {
  if (ctx.get(TUI_STARTUP_SERVICE) === undefined) return
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return

  // Version header badge: the installed dsh version first, then the bundle
  // version prefixed `tui-` — `[dsh-0.1.2-alpha.2 · tui-v0.4.0-alpha.1]` (read live
  // from the launcher + the installed package.json — never hardcode either
  // version here). Without a resolvable dsh launcher the badge degrades to
  // the bundle version alone.
  const installedDsh = dshVersion()
  service.register<HeaderBadge>('chrome.header.badge', {
    id: 'builtin-version',
    order: 1000,
    description: 'The dsh and bundle versions (first-party builtin).',
  }, {
    text: installedDsh === undefined
      ? `tui-v${bundleVersion()}`
      : `dsh-${installedDsh} · tui-v${bundleVersion()}`,
    tone: 'info',
  })

  // Todo summary dock item (P1-5): the todo summary — previously hardcoded
  // in the host's renderDock — flows through the public dock slot. The host
  // provides the summary TEXT in the activity snapshot; this builtin owns
  // the presentation (`☑  summary` dim line). An empty summary hides the
  // item (the host panel-expanded / empty-list cases render nothing).
  const todoDock = service.register<DockItem>('input.dock.item', {
    id: 'builtin-todo-summary',
    order: 1000,
    description: 'The todo summary line (first-party builtin).',
  }, { label: [] })

  const renderTodoDock = (state: {
    readonly activity: { readonly todoSummary?: string }
    readonly session: { readonly displaySubject?: { readonly todoSummary?: string } }
  }): void => {
    // The chrome follows the DISPLAY SUBJECT (M3-5 PR1): while a child viewer is
    // mounted the host publishes the child's own state additively on
    // `session.displaySubject`, and the live-session `activity.todoSummary` keeps
    // its v2 meaning (the live session's list). The choice is by SUBJECT, never
    // by field absence: a mounted display subject with no summary (an empty or
    // unavailable child todo list) hides the item instead of falling back to the
    // live session's — which would print the parent's list on the child surface.
    const summary = state.session.displaySubject === undefined
      ? state.activity.todoSummary
      : state.session.displaySubject.todoSummary
    if (summary === undefined || summary === '') {
      todoDock.replace({ label: [] })
      return
    }
    const label: StyledSpan[] = [
      { text: '☑  ', tone: 'textDim' },
      { text: summary, tone: 'textDim' },
    ]
    todoDock.replace({ label })
  }
  service.subscribeState(state => {
    renderTodoDock(state)
  })
}
