/**
 * Built-in command definitions for the status domain (/status) plus the
 * /status extension-health rows.
 *
 * The rows are command presentation over existing runner/port facts; no
 * status semantic projection lives here.
 * @module @xmoon76/dsh-pi-tui/commands/status
 */

import type { TuiCommandRunner, RegisterOne } from '../../commands.ts'
import { color } from '../theme/runtime.ts'
import type { SessionStatsFacts } from '../../domain/status/stats.ts'
import { formatTokens } from '../token-format.ts'
import { displaySessionId } from './sessions.ts'

/** One decimal place, dropping a redundant ".0". */
function trimDecimal(value: number): string {
  const text = value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** Format seconds with one decimal ("8.1s"). */
function formatSeconds(ms: number): string {
  return `${trimDecimal(ms / 1000)}s`
}

/** Format a DURATION for the /status Stats row: `8.1s` under a minute,
 * `27m54s` under an hour, `1h06m05s` beyond — the lifetime LLM wall grows
 * into minutes and hours, where plain seconds stop being readable. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return formatSeconds(ms)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

/** Render the /status Stats row from the AUTHORITY-GROUPED facts (PR5 v2
 *  §1B-2): known groups render; absent groups are omitted; NO known group
 *  reads `unmeasured`. An authoritative zero still renders as a zero. */
export function formatStatsFacts(facts: SessionStatsFacts): string {
  const parts: string[] = []
  const lifetime = facts.lifetime
  if (lifetime !== undefined) {
    const lifetimeParts: string[] = []
    if (lifetime.turns !== undefined) lifetimeParts.push(`t${lifetime.turns}`)
    if (lifetime.steps !== undefined) lifetimeParts.push(`s${lifetime.steps}`)
    if (lifetime.llmMs !== undefined) lifetimeParts.push(`LLM ${formatDuration(lifetime.llmMs)}`)
    if (lifetimeParts.length > 0) parts.push(lifetimeParts.join('/'))
  }
  const tokens = facts.tokens
  if (tokens !== undefined) {
    // Direct display parity: the legacy formatter's R…/W… cache token
    // columns ride the SAME tokens group (no second stat source; an absent
    // Remote tokenUsage group omits the whole segment).
    const cacheParts = [
      tokens.cacheRead > 0 ? `R${formatTokens(tokens.cacheRead)}` : '',
      tokens.cacheWrite > 0 ? `W${formatTokens(tokens.cacheWrite)}` : '',
      tokens.cacheRead > 0 || tokens.cacheWrite > 0 ? `CH${tokens.cacheHitPct.toFixed(1)}%` : '',
    ].filter(part => part !== '')
    parts.push([`↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`, ...cacheParts].join(' '))
  }
  const recent = facts.recent
  if (recent !== undefined) {
    parts.push(`TTFB ${formatSeconds(recent.firstTokenMsAvg)} · ${recent.tokensPerSec} tok/s`)
  }
  if (parts.length === 0) return 'unmeasured'
  return parts.join(' | ')
}

/**
 * M11: the /status extension-health rows (plan §16 — /status extension
 * health). Reads the extension registries' live snapshots: contribution
 * health (failed/shadowed states + last error), the registry revision
 * counts, and the capability set. Renders as read-only settings rows.
 * @param runner - the TuiCommandRunner (its extensions accessor is
 *   undefined without the extension service — the rows vanish).
 */
export function extensionHealthRows(runner: Pick<TuiCommandRunner, 'extensions'>): { id: string; label: string; description: string; currentValue: string }[] {
  const extensions = runner.extensions
  if (extensions === undefined) return []
  const rows: { id: string; label: string; description: string; currentValue: string }[] = []
  const health = extensions.commands.snapshot()
  const commandCount = health.entries.length
  // P1-08: the LIVE contribution-health snapshot (failed/shadowed states
  // + lastError) — the M11 health requirement is a real observable
  // surface, not registry counts only.
  const healthRecords = extensions.health?.() ?? []
  const themeCount = extensions.themes.snapshot().themes.length
  const settingCount = extensions.settings.snapshot().rows.length
  const autocompleteCount = extensions.autocomplete.snapshot().providers.length
  const bindingCount = extensions.keybindings.snapshot().bindings.length
  const rendererCount = extensions.renderers.snapshot().messageRenderers.length
    + extensions.renderers.snapshot().toolRenderers.length
  const editorCount = extensions.editors.snapshot().editors.length
  rows.push({
    id: 'ext-registry-counts',
    label: color.textDim('Extensions'),
    description: 'Live contributions across every registry (M1–M9)',
    currentValue: color.textDim(
      `cmd ${commandCount} · theme ${themeCount} · set ${settingCount} · ac ${autocompleteCount} · kb ${bindingCount} · ren ${rendererCount} · ed ${editorCount}`,
    ),
  })
  // The capability row must reflect the REAL capability set (round-1
  // finding 1): the live PiTuiApiInfo.capabilities — never a hardcoded
  // or count-inferred list (the registry presence is a separate
  // diagnostic, not a capability claim).
  const api = extensions.api
  const capabilities = api === undefined ? [] : [...api().capabilities].sort()
  rows.push({
    id: 'ext-capabilities',
    label: color.textDim('Capabilities'),
    description: 'The host extension capabilities (feature-detect, never parse versions)',
    currentValue: color.textDim(capabilities.length === 0 ? 'none' : capabilities.join(' · ')),
  })
  // The registry-type diagnostic (separate from capabilities — a
  // registry with live contributions is a FACT, not a capability).
  const registryTypes = [
    commandCount > 0 ? 'commands' : '',
    themeCount > 0 ? 'themes' : '',
    settingCount > 0 ? 'settings' : '',
    autocompleteCount > 0 ? 'autocomplete' : '',
    bindingCount > 0 ? 'keybindings' : '',
    rendererCount > 0 ? 'renderers' : '',
    editorCount > 0 ? 'editors' : '',
  ].filter(Boolean)
  rows.push({
    id: 'ext-registries',
    label: color.textDim('Registries'),
    description: 'Live registries with contributions (diagnostic, not capabilities)',
    currentValue: color.textDim(registryTypes.length === 0 ? 'none' : registryTypes.join(' · ')),
  })
  // P1-08: the live health row — failed/shadowed contributions with their
  // last error, across EVERY registry (incl. transcript renderers). A
  // healthy surface shows 'all active'; failures are surfaced verbatim
  // (single-line, bounded — the ledger's error policy).
  const failed = healthRecords.filter(record => record.state !== 'active')
  rows.push({
    id: 'ext-health',
    label: color.textDim('Health'),
    description: 'Live contribution states (failed/shadowed + last error; recovery clears)',
    currentValue: failed.length === 0
      ? color.textDim('all active')
      : failed.map(record =>
          `${record.extensionPoint}:${record.id} ${record.state}${record.lastError === undefined ? '' : ` — ${record.lastError}`}`,
        ).join(' · '),
  })
  return rows
}

export interface StatusCommandDeps {
  runner: Pick<
    TuiCommandRunner,
    'app' | 'extensions' | 'requireLiveSessionScope' | 'currentSessionStats' | 'forceContextMeasurement' | 'sessionReader'
  >
  registerOne: RegisterOne
}

/** /status — session stats, identity and extension health. */
export function registerStatusCommand({ runner, registerOne }: StatusCommandDeps): void {
  const app = runner.app
  registerOne({
    name: 'status',
    description: 'Show session stats and identity',
    handler: async () => {
      const scope = await runner.requireLiveSessionScope()
      const stats = await runner.currentSessionStats(scope)
      // Explicit status: measure NOW through the runner's context
      // coordinator — the panel and the cached footer value share ONE
      // measurement (no duplicate reads, no stale footer). Stubs without
      // the coordinator fall back to a direct session-read port read
      // (best-effort, migration M1.11): unavailable/unmeasurable → the
      // panel falls back to unmeasured — never a crash.
      // Explicit status: measure NOW through the runner's context
      // coordinator — the panel and the cached footer value share ONE
      // measurement (no duplicate reads, no stale footer). The direct
      // session-read port is used ONLY when the coordinator is absent
      // (stubs): an explicit presence check, never a `??` fallback — a
      // force returning undefined (no live session / measurement failure)
      // must not trigger a second, uncached measurement (round-9 finding).
      const forceContext = runner.forceContextMeasurement
      const contextTokens = forceContext === undefined
        ? runner.sessionReader.measureContext(scope.sessionId)
        : forceContext()
      // PR3-A: the settings panel is PiTui chrome; unreachable without editor
      // input on a non-PiTui renderer (runner.app undefined there).
      const app = runner.app
      if (app === undefined) return { kind: 'error', text: 'the settings panel is unavailable in this renderer' }
      app.openSettings(
        [
          {
            id: 'session-id',
            label: color.textDim('Session'),
            description: color.textDim(scope.sessionId),
            currentValue: color.textDim(displaySessionId(scope.sessionId)),
          },
          {
            id: 'session-stats',
            label: 'Stats',
            // PR5 v2 §1B-2: the facts formatter renders KNOWN groups only —
            // an absent authority group (a Remote projection gap) is
            // omitted, and no known group reads `unmeasured`.
            description: stats === undefined ? 'unmeasured' : formatStatsFacts(stats),
            currentValue: '',
          },
          {
            id: 'session-context',
            label: 'Context',
            description: contextTokens === undefined ? 'unmeasured' : `${Math.round(contextTokens / 1000)}k tokens in window`,
            currentValue: '',
          },
          // ── M11: extension health (plan §16) ───────────────────
          ...extensionHealthRows(runner),
        ],
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })
}
