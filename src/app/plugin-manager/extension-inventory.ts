/**
 * TUI-internal read-only projection over the shared `piTuiExtensions`
 * runtime (P1-A1.4).
 *
 * It aggregates the runtime's own contribution-health records into detached
 * owner-level observations. It is NOT a second plugin inventory, NOT a
 * loader, and NOT an enable/disable authority: it never registers,
 * unloads or mutates anything, and it exposes no Cordis Context/Fiber
 * object. It is deliberately package-private — never part of the public
 * `@xmoon76/dsh-pi-tui/extensions` API.
 *
 * @module @xmoon76/dsh-pi-tui/app/plugin-manager/extension-inventory
 */

import { copySafe } from '../../domain/terminal/copy-safe.ts'

/** The minimal read view of one live contribution (`ContributionHealth`). */
export interface TuiExtensionHealthRecord {
  readonly id: string
  /** The UID-qualified contribution owner (`<uid>:<name>`). */
  readonly owner: string
  /** The slot/extension point the contribution registered under. */
  readonly extensionPoint: string
  /** Official contribution lifecycle state. */
  readonly state: string
  /** The first error of the CURRENT failure generation, when the ledger has
   *  one. Never synthesized from a log or an exception here. */
  readonly lastError?: string
}

/** The read seam: the existing ledger health snapshot + the internal
 * owner→Loader-entry-id projection. */
export interface TuiExtensionObservationSource {
  healthSnapshot(): readonly TuiExtensionHealthRecord[]
  /** Owner → owning Loader entry id (the official PluginManager `entryId`). */
  ownerEntryIds?(): ReadonlyMap<string, string>
}

/** Detached owner-level facts about live TUI extension contributions. */
export interface TuiExtensionObservation {
  /** The UID-qualified live owner (`<uid>:<name>`). */
  readonly owner: string
  /**
   * The owning Loader entry id, when the runtime could prove it: the EXACT
   * key the official PluginManager reports as `entryId`. Absent → the owner
   * cannot be associated with a package (falls back to DSH Plugin).
   */
  readonly entryId?: string
  /** Distinct extension points this owner registered under. */
  readonly contributionKinds: readonly string[]
  readonly contributionCount: number
  readonly health: 'active' | 'failed' | 'mixed'
  /** Observed advanced / unstable capability use (factual, never inferred). */
  readonly usesAdvancedCapability: boolean
  readonly usesUnstableCapability: boolean
}

const ADVANCED_PREFIX = 'advanced.'
const UNSTABLE_PREFIX = 'unstable.'

interface Aggregation {
  owner: string
  kinds: Set<string>
  count: number
  failed: number
  active: number
  advanced: boolean
  unstable: boolean
}

/**
 * Aggregate live contributions by owner. Owners are reported exactly as the
 * runtime records them; no classification or package association happens
 * here.
 */
export function observeTuiExtensions(
  source: TuiExtensionObservationSource,
): readonly TuiExtensionObservation[] {
  const entryIds = source.ownerEntryIds?.()
  const byOwner = new Map<string, Aggregation>()
  for (const record of source.healthSnapshot()) {
    let entry = byOwner.get(record.owner)
    if (entry === undefined) {
      entry = {
        owner: record.owner,
        kinds: new Set(),
        count: 0,
        failed: 0,
        active: 0,
        advanced: false,
        unstable: false,
      }
      byOwner.set(record.owner, entry)
    }
    entry.kinds.add(record.extensionPoint)
    entry.count += 1
    if (record.state === 'failed') entry.failed += 1
    else entry.active += 1
    if (record.extensionPoint.startsWith(ADVANCED_PREFIX)) entry.advanced = true
    if (record.extensionPoint.startsWith(UNSTABLE_PREFIX)) entry.unstable = true
  }
  return [...byOwner.values()]
    .sort((left, right) => left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0)
    .map(entry => {
      const entryId = entryIds?.get(entry.owner)
      return Object.freeze({
        owner: entry.owner,
        ...(entryId === undefined ? {} : { entryId }),
        contributionKinds: Object.freeze([...entry.kinds].sort()),
        contributionCount: entry.count,
        health: entry.failed === 0 ? 'active' as const : entry.active === 0 ? 'failed' as const : 'mixed' as const,
        usesAdvancedCapability: entry.advanced,
        usesUnstableCapability: entry.unstable,
      })
    })
}

/** One exact contribution record for the Plugin Manager Diagnostics page. */
export interface TuiContributionDiagnostic {
  readonly owner: string
  /** The owning official Loader entry id, only when the runtime proved it. */
  readonly entryId?: string
  readonly extensionPoint: string
  readonly id: string
  readonly state: string
  readonly lastError?: string
}

/** The live registry snapshots the diagnostics page reports. Only the COUNT
 * of each registry is a diagnostic fact; a registry with zero contributions
 * is not a capability claim. */
export interface TuiExtensionRegistrySource {
  readonly commands: { snapshot(): { readonly entries: readonly unknown[] } }
  readonly themes: { snapshot(): { readonly themes: readonly unknown[] } }
  readonly settings: { snapshot(): { readonly rows: readonly unknown[] } }
  readonly autocomplete: { snapshot(): { readonly providers: readonly unknown[] } }
  readonly keybindings: { snapshot(): { readonly bindings: readonly unknown[] } }
  readonly renderers: {
    snapshot(): {
      readonly messageRenderers: readonly unknown[]
      readonly toolRenderers: readonly unknown[]
    }
  }
  readonly editors: { snapshot(): { readonly editors: readonly unknown[] } }
}

/** Live contribution counts across every registry. */
export interface TuiExtensionRegistryCounts {
  readonly commands: number
  readonly themes: number
  readonly settings: number
  readonly autocomplete: number
  readonly keybindings: number
  readonly renderers: number
  readonly editors: number
}

/** The contribution totals behind the health summary. `other` keeps any
 * state the ledger reports outside the frozen active/failed/shadowed set. */
export interface TuiExtensionContributionTotals {
  readonly total: number
  readonly active: number
  readonly failed: number
  readonly shadowed: number
  readonly other: number
}

/** The detached, immutable Plugin Manager diagnostics projection. It combines
 * three separate truth sources without collapsing them: contribution health
 * records, live registry counts, and the actual advertised capability set. */
export interface TuiExtensionDiagnostics {
  /** Contributions whose owner has a PROVEN Loader entry id, sorted. */
  readonly entries: readonly TuiContributionDiagnostic[]
  /** Contributions whose owner the runtime could not associate, sorted. */
  readonly unmappedEntries: readonly TuiContributionDiagnostic[]
  readonly contributionTotals: TuiExtensionContributionTotals
  readonly registryCounts: TuiExtensionRegistryCounts
  readonly capabilities: readonly string[]
  /** `all active`, or `n failed · n shadowed` (plus `n other` if reported). */
  readonly healthSummary: string
}

function compareDiagnostic(
  left: TuiContributionDiagnostic,
  right: TuiContributionDiagnostic,
): number {
  if (left.owner !== right.owner) return left.owner < right.owner ? -1 : 1
  if (left.extensionPoint !== right.extensionPoint) return left.extensionPoint < right.extensionPoint ? -1 : 1
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/** Copy All's exact registry-count line (also the page's own display). */
export function formatTuiExtensionRegistryCounts(counts: TuiExtensionRegistryCounts): string {
  return `cmd ${counts.commands} · theme ${counts.themes} · set ${counts.settings} · ac ${counts.autocomplete}`
    + ` · kb ${counts.keybindings} · ren ${counts.renderers} · ed ${counts.editors}`
}

/** Copy All's exact capability line (also the page's own display). */
export function formatTuiExtensionCapabilities(capabilities: readonly string[]): string {
  return capabilities.length === 0 ? 'none' : capabilities.join(' · ')
}

/** One diagnostic entry's exact copy block. The owner and the proven entry id
 * are part of the copied identity: an unassociated record must never look
 * like an attached package. */
export function formatTuiContributionDiagnostic(entry: TuiContributionDiagnostic): string {
  // The report's own line structure is generated here; every EXTERNAL field
  // passes the shared terminal-control guard so a hostile owner/id/state/error
  // cannot inject ESC/CSI/OSC/C1 or forge a line in the copied block.
  const lines = [`Owner: ${copySafe(entry.owner)}`]
  if (entry.entryId !== undefined) lines.push(`Entry: ${copySafe(entry.entryId)}`)
  lines.push(`Contribution: ${copySafe(entry.extensionPoint)}:${copySafe(entry.id)}`, `State: ${copySafe(entry.state)}`)
  if (entry.lastError !== undefined) lines.push(`Error: ${copySafe(entry.lastError)}`)
  return lines.join('\n')
}

/** Copy All: every diagnostic fact and every contribution, independent of
 * what the current viewport shows. LF only; no ANSI and no truncation. */
export function serializeTuiExtensionDiagnostics(view: TuiExtensionDiagnostics): string {
  const lines = [
    'dsh-pi-tui Plugin Diagnostics',
    `Health: ${copySafe(view.healthSummary)}`,
    `Registries: ${copySafe(formatTuiExtensionRegistryCounts(view.registryCounts))}`,
    `Capabilities: ${copySafe(formatTuiExtensionCapabilities(view.capabilities))}`,
  ]
  if (view.entries.length > 0) {
    lines.push('')
    for (const entry of view.entries) lines.push(formatTuiContributionDiagnostic(entry), '')
  }
  if (view.unmappedEntries.length > 0) {
    lines.push('Unassociated extension contributions', '')
    for (const entry of view.unmappedEntries) lines.push(formatTuiContributionDiagnostic(entry), '')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Project the live extension runtime into the Plugin Manager Diagnostics
 * facts. This is a READ: it calls each registry snapshot once, reads the
 * ledger's health records once and never registers, mutates, polls or infers
 * an entry id from a package name. Records whose owner has no proven entry id
 * stay visible in `unmappedEntries`.
 */
export function describeTuiExtensionDiagnostics(
  source: TuiExtensionObservationSource,
  registries: TuiExtensionRegistrySource,
  capabilities: ReadonlySet<string>,
): TuiExtensionDiagnostics {
  const entryIds = source.ownerEntryIds?.()
  const entries: TuiContributionDiagnostic[] = []
  const unmappedEntries: TuiContributionDiagnostic[] = []
  let active = 0
  let failed = 0
  let shadowed = 0
  let other = 0
  for (const record of source.healthSnapshot()) {
    if (record.state === 'active') active += 1
    else if (record.state === 'failed') failed += 1
    else if (record.state === 'shadowed') shadowed += 1
    else other += 1
    const entryId = entryIds?.get(record.owner)
    const diagnostic: TuiContributionDiagnostic = Object.freeze({
      owner: record.owner,
      ...(entryId === undefined ? {} : { entryId }),
      extensionPoint: record.extensionPoint,
      id: record.id,
      state: record.state,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    })
    if (entryId === undefined) unmappedEntries.push(diagnostic)
    else entries.push(diagnostic)
  }
  entries.sort(compareDiagnostic)
  unmappedEntries.sort(compareDiagnostic)
  // ONE snapshot per registry: the two renderer lists must come from the
  // SAME revision (a second call could observe an intervening registration).
  const rendererSnapshot = registries.renderers.snapshot()
  const registryCounts: TuiExtensionRegistryCounts = Object.freeze({
    commands: registries.commands.snapshot().entries.length,
    themes: registries.themes.snapshot().themes.length,
    settings: registries.settings.snapshot().rows.length,
    autocomplete: registries.autocomplete.snapshot().providers.length,
    keybindings: registries.keybindings.snapshot().bindings.length,
    renderers: rendererSnapshot.messageRenderers.length + rendererSnapshot.toolRenderers.length,
    editors: registries.editors.snapshot().editors.length,
  })
  const totals: TuiExtensionContributionTotals = Object.freeze({
    total: active + failed + shadowed + other,
    active,
    failed,
    shadowed,
    other,
  })
  const healthParts = failed + shadowed + other === 0
    ? ['all active']
    : [
        `${failed} failed`,
        `${shadowed} shadowed`,
        ...(other === 0 ? [] : [`${other} other`]),
      ]
  return Object.freeze({
    entries: Object.freeze(entries),
    unmappedEntries: Object.freeze(unmappedEntries),
    contributionTotals: totals,
    registryCounts,
    capabilities: Object.freeze([...capabilities].sort()),
    healthSummary: healthParts.join(' · '),
  })
}
