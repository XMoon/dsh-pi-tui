/**
 * Pure Plugin Manager presentation projection (P1-A, v2): turns the detached
 * {@link PluginManagerSnapshot} + presentation classification into package
 * cards and flat selectable rows.
 *
 * It performs no I/O, owns no state and never re-derives Host truth:
 * enabled/read-only/removable/compatibility facts are rendered exactly as
 * the port delivers them. The ONLY local policy is the Current-TUI
 * surface-safety layer, which NARROWS effective actions (never forges Host
 * fields).
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager/model
 */

import type {
  PluginBundleFact,
  PluginChangeFact,
  PluginErrorFact,
  PluginExemptionFact,
  PluginIncompatibleFact,
  PluginManagerSnapshot,
  PluginReadOnlyReason,
  PluginRegistriesFact,
  PluginRowFact,
} from '../runtime/plugin-manager-port.ts'
import type { PluginPackageClassification, PluginPresentationRole } from './classify.ts'
import type { TuiExtensionFacts } from './classify.ts'

/** One declared/live plugin row of a package card. */
export interface PluginRowView {
  readonly entryId: string
  readonly moduleName: string
  readonly title?: string
  readonly description?: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
  /** False when the bundle declares the row but no live Loader entry carries it. */
  readonly live: boolean
  readonly patchId?: string
  readonly readOnlyReason?: PluginReadOnlyReason
  /** Effective capability: an addressable live row that is not self-owned. */
  readonly canToggle: boolean
}

/** One package card: a bundle, or a standalone managed plugin entry. */
export interface PluginCardView {
  /** Stable logical identity, NEVER a screen index. */
  readonly value: string
  /** Whether the card's mutation target is a bundle or a standalone entry. */
  readonly source: 'bundle' | 'entry'
  readonly role: PluginPresentationRole
  readonly name: string
  readonly version?: string
  readonly title?: string
  readonly description?: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly optional: boolean
  /** Official Host fact, preserved as-is. */
  readonly removable: boolean
  readonly readOnlyReason?: PluginReadOnlyReason
  readonly error?: PluginErrorFact
  readonly rows: readonly PluginRowView[]
  readonly overrides: readonly string[]
  readonly extension?: TuiExtensionFacts
  /** Effective bundle capability = Host capability ∩ Current-TUI safety. */
  readonly canToggle: boolean
  readonly canRemove: boolean
  /** True only for the bundle that provides the running TUI surface. */
  readonly isSelf: boolean
}

/** The classified, sectioned view of the official inventory. */
export interface PluginManagerModel {
  readonly currentTui: readonly PluginCardView[]
  readonly tuiExtensions: readonly PluginCardView[]
  readonly dshPlugins: readonly PluginCardView[]
  readonly registries: PluginRegistriesFact
  readonly exemptions: readonly PluginExemptionFact[]
  readonly exemptionWarnings: readonly string[]
}

/** Stable identity of one bundle card. */
export function bundleValue(name: string): string {
  return `bundle:${name}`
}

/** Stable identity of one standalone plugin-entry card. */
export function entryValue(entryId: string): string {
  return `entry:${entryId}`
}

/** The action values the panel maps to operations. */
export const PLUGIN_ACTION = {
  install: 'action:install',
  refresh: 'action:refresh',
  close: 'action:close',
  toggle: 'action:toggle',
  remove: 'action:remove',
  back: 'action:back',
  confirmRemove: 'action:confirm-remove',
  cancelRemove: 'action:cancel-remove',
} as const

/** The row-level toggle value for one addressable plugin entry id. */
export function rowToggleValue(entryId: string): string {
  return `action:toggle-row:${entryId}`
}

/** The entry id of a row-level toggle value, or undefined. */
export function rowToggleEntryId(value: string): string | undefined {
  const prefix = 'action:toggle-row:'
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}

/** One rendered row; the panel only draws and selects these. */
export interface PluginManagerRow {
  readonly value: string
  readonly kind: 'card' | 'section' | 'action' | 'info'
  readonly label: string
  readonly secondary?: string
  readonly badge?: string
  readonly tone: 'normal' | 'dim' | 'success' | 'warning' | 'error'
  readonly selectable: boolean
}

function section(label: string): PluginManagerRow {
  return { value: `section:${label}`, kind: 'section', label, tone: 'dim', selectable: false }
}

function info(label: string, secondary?: string): PluginManagerRow {
  return {
    value: `info:${label}:${secondary ?? ''}`,
    kind: 'info',
    label,
    ...(secondary === undefined ? {} : { secondary }),
    tone: 'dim',
    selectable: false,
  }
}

function action(value: string, label: string, tone: PluginManagerRow['tone'] = 'normal'): PluginManagerRow {
  return { value, kind: 'action', label, tone, selectable: true }
}

/** Human text for one role, shown as the card's classification chip. */
export function roleLabel(role: PluginPresentationRole): string {
  switch (role) {
    case 'current-tui': return 'Current TUI'
    case 'tui-extension': return 'TUI extension'
    default: return 'DSH plugin'
  }
}

function cardBadge(card: PluginCardView): string {
  if (card.error !== undefined) return 'error'
  if (card.readOnlyReason !== undefined) return 'read-only'
  return card.enabled ? 'active' : 'disabled'
}

function cardTone(card: PluginCardView): PluginManagerRow['tone'] {
  if (card.error !== undefined) return 'error'
  if (card.role === 'current-tui') return 'normal'
  if (card.readOnlyReason !== undefined) return 'warning'
  return card.enabled ? 'normal' : 'dim'
}

/** The card's one-line secondary text: description + factual flags. */
function cardSecondary(card: PluginCardView): string | undefined {
  const text = card.title ?? card.description
  const flags: string[] = [roleLabel(card.role)]
  if (card.role === 'tui-extension' && card.extension !== undefined) {
    flags.push(`${card.extension.contributionCount} contribution${card.extension.contributionCount === 1 ? '' : 's'}`)
    flags.push(card.extension.health)
  }
  if (!card.installed) flags.push('provided')
  if (card.optional) flags.push('optional')
  const head = text ?? ''
  const tail = flags.join(' · ')
  return head === '' ? tail : `${head} · ${tail}`
}

/** Render one Host error fact as an actionable line. */
export function errorText(error: PluginErrorFact): string {
  const parts = [error.code]
  if (error.diagnostic !== undefined && error.diagnostic !== '') parts.push(error.diagnostic)
  for (const entry of error.incompatible ?? []) parts.push(incompatibleText(entry))
  return parts.join(' — ')
}

/** Render one rejected package with its required peer ranges. */
export function incompatibleText(entry: PluginIncompatibleFact): string {
  const peers = Object.entries(entry.peers).map(([name, range]) => `${name} ${range}`).join(', ')
  return `${entry.name}@${entry.version} rejects DSH ${entry.runtimeVersion}${peers === '' ? '' : ` (needs ${peers})`}`
}

/** Format the exemption list for the diagnostics section. */
export function exemptionText(entry: PluginExemptionFact): string {
  return `${entry.packageVersion} → ${entry.runtimeVersions.join(', ')}`
}

/** The registries summary rendered on the list footer/detail. */
export function registriesText(registries: PluginRegistriesFact): string {
  const parts: string[] = [registries.registry === null ? 'pnpm default' : registries.registry]
  if (registries.fallbackRegistries.length > 0) parts.push(`fallbacks: ${registries.fallbackRegistries.join(', ')}`)
  if (registries.resolved !== null) parts.push(`resolved: ${registries.resolved}`)
  return parts.join(' · ')
}

function rowView(
  row: { readonly rowId: string; readonly moduleName: string; readonly title?: string; readonly description?: string; readonly entryId?: string },
  live: PluginRowFact | undefined,
  selfOwned: boolean,
): PluginRowView {
  const entryId = live?.entryId ?? row.entryId ?? ''
  const title = live?.title ?? row.title
  const description = live?.description ?? row.description
  const addressable = live !== undefined && live.patchId !== undefined && live.readOnlyReason === undefined
  return Object.freeze({
    entryId,
    moduleName: live?.moduleName ?? row.moduleName,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    enabled: live?.enabled ?? false,
    fiberPhase: live?.fiberPhase ?? null,
    live: live !== undefined,
    ...(live?.patchId === undefined ? {} : { patchId: live.patchId }),
    ...(live?.readOnlyReason === undefined ? {} : { readOnlyReason: live.readOnlyReason }),
    canToggle: addressable && !selfOwned,
  })
}

function entryRowView(entry: PluginRowFact, selfOwned: boolean): PluginRowView {
  const addressable = entry.patchId !== undefined && entry.readOnlyReason === undefined
  return Object.freeze({
    entryId: entry.entryId,
    moduleName: entry.moduleName,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    enabled: entry.enabled,
    fiberPhase: entry.fiberPhase,
    live: true,
    ...(entry.patchId === undefined ? {} : { patchId: entry.patchId }),
    ...(entry.readOnlyReason === undefined ? {} : { readOnlyReason: entry.readOnlyReason }),
    canToggle: addressable && !selfOwned,
  })
}

/**
 * Build the classified model. `claims` comes from
 * {@link classifyPluginPackages}; an unclassified card falls back to
 * `dsh-plugin`.
 */
export function buildPluginManagerModel(
  snapshot: PluginManagerSnapshot,
  claims: ReadonlyMap<string, PluginPackageClassification>,
): PluginManagerModel {
  const liveByEntry = new Map<string, PluginRowFact>()
  for (const entry of snapshot.plugins) liveByEntry.set(entry.entryId, entry)

  // Live entries referenced by any bundle row are NOT standalone cards. This
  // is the ONLY de-duplication rule and it is entry-id based: a standalone
  // Loader entry that merely shares a module specifier with a bundle row (e.g.
  // `@deepseek-ai/dsh-workspace` used by both the TUI bundle and an unrelated
  // row) is a DIFFERENT entry and must remain visible.
  const bundledEntryIds = new Set<string>()
  for (const bundle of snapshot.bundles) {
    for (const row of bundle.rows) {
      if (row.entryId !== undefined) bundledEntryIds.add(String(row.entryId))
    }
  }

  const cards: PluginCardView[] = []
  for (const bundle of snapshot.bundles) {
    const value = bundleValue(bundle.name)
    const claim = claims.get(value)
    const role: PluginPresentationRole = claim?.role ?? 'dsh-plugin'
    const isSelf = role === 'current-tui'
    const rows = bundle.rows.map(row => {
      const liveId = row.entryId === undefined ? undefined : liveByEntry.get(String(row.entryId))
      const selfOwned = isSelf
      return rowView(row, liveId, selfOwned)
    })
    const hostToggle = bundle.readOnlyReason === undefined
    const hostRemove = bundle.removable && bundle.readOnlyReason === undefined
    cards.push(Object.freeze({
      value,
      source: 'bundle' as const,
      role,
      name: bundle.name,
      ...(bundle.version === undefined ? {} : { version: bundle.version }),
      ...(bundle.title === undefined ? {} : { title: bundle.title }),
      ...(bundle.description === undefined ? {} : { description: bundle.description }),
      enabled: bundle.enabled,
      installed: bundle.installed,
      optional: bundle.optional,
      removable: bundle.removable,
      ...(bundle.readOnlyReason === undefined ? {} : { readOnlyReason: bundle.readOnlyReason }),
      ...(bundle.error === undefined ? {} : { error: bundle.error }),
      rows: Object.freeze(rows),
      overrides: Object.freeze([...bundle.overrides]),
      ...(claim?.extension === undefined ? {} : { extension: claim.extension }),
      canToggle: hostToggle && !isSelf,
      canRemove: hostRemove && !isSelf,
      isSelf,
    }))
  }

  for (const entry of snapshot.plugins) {
    if (bundledEntryIds.has(entry.entryId)) continue
    const value = entryValue(entry.entryId)
    const claim = claims.get(value)
    // A standalone entry is NEVER guessed into Current TUI: that role is the
    // self BUNDLE card alone. A standalone entry is a TUI extension only when
    // its proven entryId was associated, otherwise an ordinary DSH plugin.
    const role: PluginPresentationRole = claim?.role ?? 'dsh-plugin'
    const row = entryRowView(entry, false)
    cards.push(Object.freeze({
      value,
      source: 'entry' as const,
      role,
      name: entry.moduleName,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      enabled: entry.enabled,
      installed: true,
      optional: false,
      removable: false,
      ...(entry.readOnlyReason === undefined ? {} : { readOnlyReason: entry.readOnlyReason }),
      rows: Object.freeze([row]),
      overrides: Object.freeze([]),
      ...(claim?.extension === undefined ? {} : { extension: claim.extension }),
      canToggle: row.canToggle,
      canRemove: false,
      isSelf: false,
    }))
  }

  const empty: PluginCardView[] = []
  const currentTui = cards.filter(card => card.role === 'current-tui')
  const tuiExtensions = cards.filter(card => card.role === 'tui-extension')
  const dshPlugins = cards.filter(card => card.role === 'dsh-plugin')
  return Object.freeze({
    currentTui: Object.freeze(currentTui.length > 0 ? currentTui : empty),
    tuiExtensions: Object.freeze(tuiExtensions),
    dshPlugins: Object.freeze(dshPlugins),
    registries: snapshot.registries,
    exemptions: snapshot.exemptions,
    exemptionWarnings: snapshot.exemptionWarnings,
  })
}

function cardRow(card: PluginCardView, busyValue: string | undefined): PluginManagerRow {
  const name = card.version === undefined ? card.name : `${card.name} ${card.version}`
  const label = busyValue === card.value ? `${name} …` : name
  return {
    value: card.value,
    kind: 'card',
    label,
    ...(cardSecondary(card) === undefined ? {} : { secondary: cardSecondary(card)! }),
    badge: cardBadge(card),
    tone: cardTone(card),
    selectable: true,
  }
}

/** The top-level list: three sections, then the global actions. */
export function pluginManagerListRows(
  model: PluginManagerModel,
  busyValue: string | undefined,
): PluginManagerRow[] {
  const rows: PluginManagerRow[] = []
  if (model.currentTui.length > 0) {
    rows.push(section('Current TUI'))
    for (const card of model.currentTui) rows.push(cardRow(card, busyValue))
  }
  if (model.tuiExtensions.length > 0) {
    rows.push(section('TUI Extensions'))
    for (const card of model.tuiExtensions) rows.push(cardRow(card, busyValue))
  }
  rows.push(section('DSH Plugins'))
  for (const card of model.dshPlugins) rows.push(cardRow(card, busyValue))
  rows.push(section('Registries'))
  rows.push(info('registries', registriesText(model.registries)))
  if (model.exemptions.length > 0) {
    rows.push(section('Version exemptions'))
    for (const entry of model.exemptions) rows.push(info('exemption', exemptionText(entry)))
  }
  for (const warning of model.exemptionWarnings) rows.push(info('exemption warning', warning))
  rows.push(section('Actions'))
  rows.push(action(PLUGIN_ACTION.install, 'Install…'))
  rows.push(action(PLUGIN_ACTION.refresh, 'Refresh'))
  rows.push(action(PLUGIN_ACTION.close, 'Close'))
  return rows
}

/** Package detail: metadata, declared rows, diagnostics and item actions.
 * `exemptions` cross-references the profile's exact-version exemptions so a
 * compatibility error says whether one already applies (plan §11). */
export function cardDetailRows(
  card: PluginCardView,
  exemptions: readonly PluginExemptionFact[] = [],
): PluginManagerRow[] {
  const rows: PluginManagerRow[] = []
  const status = [card.enabled ? 'enabled' : 'disabled', roleLabel(card.role)]
  if (!card.installed) status.push('provided by the installation')
  if (card.optional) status.push('optional')
  status.push(card.removable ? 'removable' : 'not removable')
  rows.push(info('Status', status.join(' · ')))
  if (card.readOnlyReason !== undefined) rows.push(info('Read-only', card.readOnlyReason))
  if (card.error !== undefined) {
    rows.push({ ...info('Error', errorText(card.error)), tone: 'error' })
    for (const entry of card.error.incompatible ?? []) {
      const key = `${entry.name}@${entry.version}`
      const exemption = exemptions.find(candidate => candidate.packageVersion === key)
      rows.push(info('  exemption', exemption === undefined
        ? `${key}: no exact-version exemption applies`
        : `${key}: exempted for DSH ${exemption.runtimeVersions.join(', ')}`))
    }
  }
  if (card.role === 'current-tui') {
    rows.push(info('This bundle provides the current TUI and is managed outside this screen.'))
  }
  if (card.extension !== undefined) {
    const extension = card.extension
    rows.push(info('TUI contributions', `${extension.contributionCount} · ${extension.health}`))
    rows.push(info('Contribution kinds', extension.contributionKinds.join(', ')))
    rows.push(info('Proven entries', extension.entryIds.join(', ')))
    if (extension.usesAdvancedCapability) rows.push(info('Capability use', 'Uses Advanced capability'))
    if (extension.usesUnstableCapability) rows.push(info('Capability use', 'Uses Unstable capability'))
  }
  if (card.rows.length > 0) {
    rows.push(info('Plugin rows'))
    for (const row of card.rows) {
      const text = row.title ?? row.description ?? row.moduleName
      const state = row.live ? `${row.enabled ? 'enabled' : 'disabled'} · ${row.fiberPhase ?? 'no live fiber'}` : 'not live'
      rows.push(info(`  ${row.entryId === '' ? row.moduleName : row.entryId}`, `${text} · ${state}`))
      // An ordinary addressable row offers its own official toggle; a
      // Current-TUI row never does (effective capability is false).
      if (row.canToggle) {
        rows.push(action(rowToggleValue(row.entryId), row.enabled ? `    Disable row ${row.entryId}` : `    Enable row ${row.entryId}`))
      }
    }
  }
  if (card.overrides.length > 0) rows.push(info('Overrides', card.overrides.join(', ')))
  rows.push(info('Actions'))
  if (card.canToggle) rows.push(action(PLUGIN_ACTION.toggle, card.enabled ? 'Disable' : 'Enable'))
  if (card.canRemove) rows.push(action(PLUGIN_ACTION.remove, 'Remove…', 'warning'))
  rows.push(action(PLUGIN_ACTION.back, 'Back'))
  return rows
}

/** Human text for one completed mutation, including restart/override facts. */
export function changeSummary(change: PluginChangeFact): string {
  const parts: string[] = [`${change.stage} ${change.application}`]
  if (change.bundle !== undefined) parts.push(`bundle ${change.bundle}`)
  if (change.error !== undefined) parts.push(errorText(change.error))
  if (change.application === 'restart-required') parts.push('restart the profile to apply')
  if (change.application === 'overridden') parts.push('a higher-priority override still wins')
  for (const warning of change.warnings ?? []) parts.push(warning)
  return parts.join(' · ')
}
