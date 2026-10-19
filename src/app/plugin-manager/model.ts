/**
 * Pure Plugin Manager presentation projection (S4-D1): turns the detached
 * {@link PluginManagerSnapshot} + presentation classification into package
 * cards grouped into the four FROZEN sections, plus the pure Detail projection.
 *
 * It performs no I/O, owns no state and never re-derives Host truth:
 * enabled/read-only/removable/availability/official/source/installTarget facts
 * are rendered exactly as the port delivers them. The ONLY local policies are
 * the Current-TUI surface-safety layer (which NARROWS effective actions) and
 * the version-limited rc.2 presentation identity lists (which SELECT a section,
 * never create a card or fabricate catalog facts).
 *
 * @module @xmoon76/dsh-pi-tui/app/plugin-manager/model
 */

import type {
  PluginAvailability,
  PluginBundleFact,
  PluginChangeFact,
  PluginErrorFact,
  PluginExemptionFact,
  PluginIncompatibleFact,
  PluginInstallTargetFact,
  PluginManagerSnapshot,
  PluginReadOnlyReason,
  PluginRegistriesFact,
  PluginRowFact,
} from '../../runtime/plugin-manager-port.ts'
import {
  EXPERIMENTAL_BUNDLE_IDS,
  PLUGIN_SECTION_LABELS,
  PLUGIN_SECTION_ORDER,
  SELF_BUNDLE,
  type PluginOrigin,
  type PluginPackageClassification,
  type PluginPresentationRole,
  type PluginPresentationSection,
} from './classify.ts'
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
  /** Whether the Current-TUI composition controls this row (protection-only). */
  readonly selfProtected: boolean
  /** Effective capability: an addressable live row that is not self-owned. */
  readonly canToggle: boolean
}

/** The exact rc.2 Auto Review Optional bundle identity (B03). */
export const AUTO_REVIEW_BUNDLE = '@deepseek-ai/dsh-experimental-auto-review'
/** The Owner-frozen consequence text shown before disabling Auto Review or
 *  removing its bundle. It is a Host-capability fact, not a TUI risk verdict. */
export const AUTO_REVIEW_DISABLE_WARNING = 'Disabling Auto Review can change existing Auto sessions to Full access. Auto Review is not a sandbox. Continue?'

/** The bounded, read-only product-support copy of one exact rc.2 Bxx bundle. */
interface ExperimentalBundleSupport {
  /** The TUI surface the bundle's capability really reaches today. */
  readonly surface: string
  /** Limitation or hazard copy; absent only where a frozen warning already
   *  carries the whole consequence (B03 Auto Review). */
  readonly limit?: string
  /** True when the copy carries a privacy/security/billing/external risk that
   *  must use the warning tone; otherwise it is a neutral limitation. */
  readonly risk?: boolean
}

/**
 * The FROZEN rc.2 product-support copy (§3). This is bounded presentation
 * evidence for the exact package identities, NOT Host capability state: it
 * never reads enablement/fiber/availability and never claims a live Host PASS.
 * It is deliberately module-private — no runtime qualification store is built
 * from it (the live ledger stays in `docs/client-server-migration.md`).
 */
const EXPERIMENTAL_BUNDLE_SUPPORT: Readonly<Record<string, ExperimentalBundleSupport>> = Object.freeze({
  '@deepseek-ai/dsh-experimental-agent-team-profile': {
    surface: 'Host Team tools; child and task activity use existing Tool/Activity views.',
    limit: 'No native Team roster or task board. Global delegation tools differ from preset-local tools.',
  },
  '@deepseek-ai/dsh-experimental-voice-input-bundle': {
    surface: 'Speech services are Host-side; browser microphone UI is not available in PiTui.',
    limit: 'Local model preparation or API credentials may be required; no TUI recording/transcription flow.',
    risk: true,
  },
  '@deepseek-ai/dsh-experimental-auto-review': {
    surface: 'Auto is an official permission preset; tool decisions use the Host authority.',
  },
  '@deepseek-ai/dsh-experimental-inspector-profile': {
    surface: 'Browser/Node Inspector has no PiTui inspection page.',
    limit: 'Requires Web transport; captureFetch may expose unredacted debugging data. Host activation is not qualified here.',
    risk: true,
  },
  '@deepseek-ai/dsh-experimental-tool-worktree': {
    surface: 'create_worktree is a Host tool; the effective Session directory appears through the existing status/path views.',
    limit: 'No dedicated worktree panel; use Host cwd, not original Session header.',
  },
  '@deepseek-ai/dsh-experimental-cot-translation-bundle': {
    surface: 'Host translation service; PiTui shows original reasoning, not translated reasoning.',
    limit: 'Invoked translators can send reasoning/private text to third-party services.',
    risk: true,
  },
  '@deepseek-ai/dsh-experimental-terminal-bundle': {
    surface: 'Host terminal_* tools and their results/jobs use existing Tool/Job views.',
    limit: 'No separate terminal workspace. !/!! one-shot shell behavior is unchanged.',
  },
  '@deepseek-ai/dsh-experimental-session-search': {
    surface: 'session_search and related Host read tools return results as Tool output.',
    limit: 'Session Browser is not replaced by the Host query tool; search is workspace-scoped.',
  },
  '@deepseek-ai/dsh-experimental-session-titles-bundle': {
    surface: 'Official title provider updates existing Session/title surfaces.',
    limit: 'Manual title source retains official precedence; no independent title cache.',
  },
  '@deepseek-ai/dsh-experimental-badge-skill-bundle': {
    surface: 'dsh-badge is a Host Skill provider, visible via /skill in skills-capable presets.',
    limit: 'The minimal preset has no skill tool; this does not add a model tool.',
  },
  '@deepseek-ai/dsh-experimental-ralph-bundle': {
    surface: 'ralph is a Host foreground tool; its workflow events and result use existing Tool/Activity views.',
    limit: 'May run multiple rounds and incur model cost. No dedicated Ralph UI or guaranteed Job.',
    risk: true,
  },
  '@deepseek-ai/dsh-experimental-plugin-market-bundle': {
    surface: 'Host market service and cordis-scoped plugin_market tool; no PiTui Discover page.',
    limit: 'No default marketplace; only user-configured index sources are listed.',
  },
  '@deepseek-ai/dsh-subagent-codex': {
    surface: 'On-demand external one-shot Codex subagent tool, not a continuable conversation.',
    limit: 'Native provider/auth has not been successfully qualified; no Continue/Resume; a system CLI is not a substitute. EXTERNAL_UNVERIFIED.',
    risk: true,
  },
  '@deepseek-ai/dsh-subagent-claude-code': {
    surface: 'On-demand external one-shot Claude Code subagent tool, not a continuable conversation.',
    limit: 'Native provider/auth has not been successfully qualified; no Continue/Resume. EXTERNAL_UNVERIFIED.',
    risk: true,
  },
})

/** One package card: a bundle, or a standalone managed plugin entry. */
export interface PluginCardView {
  /** Stable logical identity, NEVER a screen index. */
  readonly value: string
  /** Whether the card's mutation target is a bundle or a standalone entry. */
  readonly target: 'bundle' | 'entry'
  readonly role: PluginPresentationRole
  readonly section: PluginPresentationSection
  readonly origin: PluginOrigin
  /** One of the 14 rc.2 Experimental identities. */
  readonly experimental: boolean
  /** `Third-party → Unverified origin`: provenance could not be proven. */
  readonly unverified: boolean
  readonly name: string
  readonly version?: string
  readonly title?: string
  readonly description?: string
  /** Official Host facts, preserved as-is. */
  readonly official: boolean
  readonly availability: PluginAvailability
  readonly installTarget?: PluginInstallTargetFact
  /** Host profile-owned dependency spec (user information already stripped). */
  readonly source?: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly optional: boolean
  readonly removable: boolean
  readonly readOnlyReason?: PluginReadOnlyReason
  readonly error?: PluginErrorFact
  readonly rows: readonly PluginRowView[]
  readonly overrides: readonly string[]
  readonly extension?: TuiExtensionFacts
  /** The ONE bounded Host-capability consequence note (exact B03 identity
   *  only). It never rewrites `official`/`availability`/`enabled`. */
  readonly riskNotice?: string
  /** Why no direct bundle mutation may be dispatched (undefined = allowed). */
  readonly toggleBlockedReason?: string
  /** Why no removal may be dispatched (undefined = allowed). */
  readonly removeBlockedReason?: string
  /** Why no official catalog installation may be dispatched. */
  readonly installBlockedReason?: string
  /** Effective bundle capability = Host capability ∩ Current-TUI safety. */
  readonly canToggle: boolean
  readonly canRemove: boolean
  /** `missing` official catalog entry with a real Host installTarget. */
  readonly canInstall: boolean
  /** True when the Current-TUI safety policy narrows this card's actions: the
   * self bundle itself, or a self-bundle row it provably owns. */
  readonly isSelf: boolean
}

/** One frozen main section of the inventory. */
export interface PluginManagerSectionView {
  readonly id: PluginPresentationSection
  readonly label: string
  readonly cards: readonly PluginCardView[]
}

/** The classified, sectioned view of the official inventory. */
export interface PluginManagerModel {
  /** The four sections in FROZEN order; Experimental is always last. */
  readonly sections: readonly PluginManagerSectionView[]
  /** Every card flattened in section order (the stable selection universe). */
  readonly cards: readonly PluginCardView[]
  readonly registries: PluginRegistriesFact
  readonly exemptions: readonly PluginExemptionFact[]
  readonly exemptionWarnings: readonly string[]
}

/** One fact line inside a Detail group. */
export interface PluginDetailFact {
  readonly label: string
  readonly value: string
  readonly tone: 'normal' | 'dim' | 'success' | 'warning' | 'error'
}

/** One titled group of the Detail projection. */
export interface PluginDetailGroup {
  readonly title: string
  readonly facts: readonly PluginDetailFact[]
}

/** One selectable Detail action. A disabled action is readable but inert. */
export interface PluginDetailAction {
  readonly value: string
  readonly label: string
  readonly enabled: boolean
  /** The exact refusal reason when `enabled` is false. */
  readonly reason?: string
  readonly tone: 'normal' | 'warning' | 'error'
}

/** The pure Detail projection one card paints. */
export interface PluginDetailView {
  readonly card: PluginCardView
  /** `title ?? name` — localized presentation only. */
  readonly title: string
  readonly groups: readonly PluginDetailGroup[]
  readonly actions: readonly PluginDetailAction[]
}

/** Stable identity of one bundle card. */
export function bundleValue(name: string): string {
  return `bundle:${name}`
}

/** Stable identity of one standalone plugin-entry card. */
export function entryValue(entryId: string): string {
  return `entry:${entryId}`
}

/** The action values the workspace maps to controller operations. */
export const PLUGIN_ACTION = {
  install: 'action:install',
  officialInstall: 'action:official-install',
  refresh: 'action:refresh',
  close: 'action:close',
  toggle: 'action:toggle',
  remove: 'action:remove',
  back: 'action:back',
  confirmRemove: 'action:confirm-remove',
  cancelRemove: 'action:cancel-remove',
  approveBuilds: 'action:approve-builds',
  reconcileInstall: 'action:reconcile-install',
  hideInstall: 'action:hide-install',
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

/** Human text for one proven origin. */
export function originLabel(origin: PluginOrigin): string {
  switch (origin) {
    case 'official': return 'Official DSH'
    case 'third-party': return 'Third-party'
    default: return 'Unknown origin'
  }
}

/** Human text for the official availability fact. */
export function availabilityLabel(availability: PluginAvailability): string {
  switch (availability) {
    case 'installation': return 'Installation'
    case 'profile': return 'Profile'
    default: return 'Missing'
  }
}

/** Render one Host error fact as an actionable line. */
export function errorText(error: PluginErrorFact): string {
  const parts = [error.code]
  if (error.diagnostic !== undefined && error.diagnostic !== '') parts.push(error.diagnostic)
  for (const entry of error.incompatible ?? []) parts.push(incompatibleText(entry))
  return parts.join(' — ')
}

/** Render one rejected package with the requirements it does not satisfy. */
export function incompatibleText(entry: PluginIncompatibleFact): string {
  const requirements = Object.entries(entry.requirements).map(([name, range]) => `${name} ${range}`).join(', ')
  return `${entry.name}@${entry.version} rejects DSH ${entry.runtimeVersion}${requirements === '' ? '' : ` (needs ${requirements})`}`
}

/**
 * Strip URL credentials from one Host-provided source spec before painting it.
 * The Host already removes user information from dependency sources; this is
 * the presentation boundary that guarantees no `user:secret@` is painted.
 */
export function maskedSource(source: string): string {
  return source.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@')
}

/** The truthful one-line status chip of a card (never `active` for `enabled`). */
export function cardStatusChip(card: PluginCardView): string | undefined {
  if (card.isSelf) return 'current'
  if (card.error !== undefined) return 'error'
  if (card.availability === 'missing') return card.canInstall ? 'available' : 'unavailable'
  // An ENABLED Host row is enabled whatever ships it. Only a NOT-ENABLED,
  // NOT-INSTALLED shipped Optional bundle is AVAILABLE (selectable), never
  // "installed but disabled".
  if (card.enabled) return 'enabled'
  if (!card.installed) return 'available'
  return 'disabled'
}

/** The chip's ink: state chips are `textMuted`; only a failed/unavailable
 * state escalates to the semantic warning/error token. */
export function cardStatusTone(card: PluginCardView): 'muted' | 'warning' | 'error' {
  if (card.error !== undefined) return 'error'
  if (card.availability === 'missing' && !card.canInstall) return 'warning'
  return 'muted'
}

function cardStatusFacts(card: PluginCardView): PluginDetailFact[] {
  const facts: PluginDetailFact[] = [
    { label: 'Installed', value: card.installed ? 'Yes' : 'No', tone: card.installed ? 'normal' : 'dim' },
    { label: 'Enabled', value: card.enabled ? 'Yes' : 'No', tone: card.enabled ? 'normal' : 'dim' },
    { label: 'Availability', value: availabilityLabel(card.availability), tone: card.availability === 'missing' ? 'warning' : 'dim' },
    { label: 'Origin', value: originLabel(card.origin), tone: card.origin === 'unknown' ? 'warning' : 'dim' },
  ]
  const liveRows = card.rows.filter(row => row.live)
  if (liveRows.length > 0) {
    const failed = liveRows.filter(row => row.fiberPhase === 'failed').length
    const active = liveRows.filter(row => row.fiberPhase === 'active').length
    facts.push({
      label: 'Fiber',
      value: `${active}/${liveRows.length} active${failed === 0 ? '' : ` · ${failed} failed`}`,
      tone: failed > 0 ? 'warning' : 'dim',
    })
  }
  if (card.error !== undefined) facts.push({ label: 'Error', value: errorText(card.error), tone: 'error' })
  if (card.readOnlyReason !== undefined) {
    facts.push({
      label: 'Read-only',
      value: card.readOnlyReason === 'management-required'
        ? 'Required by DSH management'
        : 'Not addressable through the profile patch',
      tone: 'warning',
    })
  }
  return facts
}

function cardSourceFacts(card: PluginCardView): PluginDetailFact[] {
  const facts: PluginDetailFact[] = [
    { label: 'Availability', value: availabilityLabel(card.availability), tone: 'dim' },
    { label: 'Origin', value: originLabel(card.origin), tone: card.origin === 'unknown' ? 'warning' : 'dim' },
  ]
  if (card.source !== undefined) {
    facts.push({ label: 'Source', value: maskedSource(card.source), tone: 'dim' })
  }
  if (card.installTarget !== undefined) {
    facts.push({ label: 'Offered version', value: card.installTarget.version, tone: 'dim' })
    facts.push({ label: 'Install target', value: maskedSource(card.installTarget.spec), tone: 'dim' })
  }
  if (card.version !== undefined) {
    facts.push({ label: 'Current version', value: card.version, tone: 'dim' })
  }
  if (
    card.installTarget !== undefined
    && card.version !== undefined
    && card.installTarget.version !== card.version
  ) {
    facts.push({
      label: 'Update',
      value: 'Update not applied automatically — remove then install is required',
      tone: 'warning',
    })
  }
  return facts
}

function cardComponentFacts(card: PluginCardView): PluginDetailFact[] {
  const facts: PluginDetailFact[] = []
  for (const row of card.rows) {
    const name = row.title ?? row.description ?? row.moduleName
    const id = row.entryId === '' ? row.moduleName : row.entryId
    const state = row.live
      ? `${row.enabled ? 'Enabled' : 'Disabled'} · ${row.fiberPhase ?? 'pending'}`
      : 'Not live'
    facts.push({ label: id, value: `${name} · ${state}`, tone: row.live ? 'dim' : 'warning' })
    if (row.readOnlyReason !== undefined) {
      facts.push({
        label: `  ${id}`,
        value: row.readOnlyReason === 'management-required'
          ? 'Read-only: required by DSH management'
          : 'Read-only: not addressable through the profile patch',
        tone: 'warning',
      })
    }
    if (row.selfProtected) {
      facts.push({ label: `  ${id}`, value: 'Protected by the Current TUI composition', tone: 'warning' })
    }
  }
  for (const override of card.overrides) {
    facts.push({ label: 'Override', value: override, tone: 'dim' })
  }
  return facts
}

/**
 * The exact rc.2 package-support facts of one Experimental card, or none. The
 * bounded copy is keyed by the PROVEN bundle identity: an `official:false`
 * same-name package, a standalone entry, a non-Experimental section or an
 * unlisted row never inherits it.
 */
function experimentalSupportFacts(card: PluginCardView): PluginDetailFact[] {
  if (card.target !== 'bundle' || card.official !== true || card.section !== 'experimental') return []
  const support = EXPERIMENTAL_BUNDLE_SUPPORT[card.name]
  if (support === undefined) return []
  const facts: PluginDetailFact[] = [
    { label: 'TUI surface', value: support.surface, tone: 'normal' },
  ]
  if (support.limit !== undefined) {
    facts.push({
      label: support.risk === true ? 'Risk' : 'Limit',
      value: support.limit,
      tone: support.risk === true ? 'warning' : 'dim',
    })
  }
  return facts
}

function cardWarningFacts(card: PluginCardView, exemptions: readonly PluginExemptionFact[]): PluginDetailFact[] {
  const facts: PluginDetailFact[] = []
  if (card.riskNotice !== undefined) {
    facts.push({ label: 'Risk', value: card.riskNotice, tone: 'warning' })
  }
  if (card.error !== undefined) {
    facts.push({ label: 'Host error', value: errorText(card.error), tone: 'error' })
  }
  // The Host accepts an exact-version exemption WITHOUT an incompatible error;
  // an applied exemption must still be visible on the card (plan §4.5).
  const exemptionKeys = new Set<string>()
  if (card.version !== undefined) {
    const key = `${card.name}@${card.version}`
    const exemption = exemptions.find(candidate => candidate.packageVersion === key)
    if (exemption !== undefined) {
      exemptionKeys.add(key)
      facts.push({
        label: 'Exemption',
        value: `${key}: exempted for DSH ${exemption.runtimeVersions.join(', ')}`,
        tone: 'success',
      })
    }
  }
  for (const entry of card.error?.incompatible ?? []) {
    const key = `${entry.name}@${entry.version}`
    if (exemptionKeys.has(key)) continue
    const exemption = exemptions.find(candidate => candidate.packageVersion === key)
    facts.push({
      label: 'Exemption',
      value: exemption === undefined
        ? `${key}: no exact-version exemption applies`
        : `${key}: exempted for DSH ${exemption.runtimeVersions.join(', ')}`,
      tone: exemption === undefined ? 'warning' : 'success',
    })
  }
  if (card.isSelf) {
    facts.push({
      label: 'Protection',
      value: 'This bundle provides the Current TUI and is managed outside this screen.',
      tone: 'dim',
    })
  } else if (card.role === 'tui-extension') {
    facts.push({
      label: 'TUI extension',
      value: 'Live contributions are associated by the exact Loader entry id.',
      tone: 'dim',
    })
  }
  if (card.experimental) {
    facts.push(...experimentalSupportFacts(card))
  }
  if (card.unverified) {
    facts.push({
      label: 'Provenance',
      value: 'Source unknown — this is not asserted to be a community package.',
      tone: 'warning',
    })
  }
  return facts
}

function cardActions(card: PluginCardView): PluginDetailAction[] {
  const actions: PluginDetailAction[] = []
  if (card.isSelf) {
    // The Current TUI bundle and every row it provably controls NEVER expose a
    // write action, not even a disabled one (plan MUST #9).
    actions.push({ value: PLUGIN_ACTION.back, label: 'Back', enabled: true, tone: 'normal' })
    return actions
  }
  if (card.availability === 'missing') {
    actions.push(card.canInstall
      ? {
        value: PLUGIN_ACTION.officialInstall,
        label: 'Install…',
        enabled: true,
        tone: 'normal',
      }
      : {
        value: PLUGIN_ACTION.officialInstall,
        label: 'Install…',
        enabled: false,
        reason: card.installBlockedReason ?? 'No official install target is available',
        tone: 'warning',
      })
  } else {
    actions.push(card.canToggle
      ? {
        value: PLUGIN_ACTION.toggle,
        label: card.enabled ? 'Disable…' : 'Enable…',
        enabled: true,
        tone: 'normal',
      }
      : {
        value: PLUGIN_ACTION.toggle,
        label: card.enabled ? 'Disable…' : 'Enable…',
        enabled: false,
        reason: card.toggleBlockedReason ?? 'This bundle is read-only',
        tone: 'warning',
      })
  }
  // Only a profile-owned, Host-removable bundle EVER shows Remove. A shipped
  // installation bundle, a missing catalog entry and a standalone Loader
  // entry have no removal action at all (not even a disabled one).
  if (card.target === 'bundle' && card.availability === 'profile' && card.removable) {
    actions.push(card.canRemove
      ? {
        value: PLUGIN_ACTION.remove,
        label: 'Remove…',
        enabled: true,
        tone: 'warning',
      }
      : {
        value: PLUGIN_ACTION.remove,
        label: 'Remove…',
        enabled: false,
        reason: card.removeBlockedReason ?? 'This bundle is not removable',
        tone: 'warning',
      })
  }
  for (const row of card.rows) {
    if (!row.canToggle) continue
    actions.push({
      value: rowToggleValue(row.entryId),
      label: row.enabled ? `Disable row ${row.entryId}` : `Enable row ${row.entryId}`,
      enabled: true,
      tone: 'normal',
    })
  }
  actions.push({ value: PLUGIN_ACTION.back, label: 'Back', enabled: true, tone: 'normal' })
  return actions
}

/** Build the pure Detail projection of one card. The profile's exact-version
 * exemptions are passed in so an incompatible Host error can say whether an
 * exemption already applies (never guessed locally). */
export function buildPluginDetailView(
  card: PluginCardView,
  exemptions: readonly PluginExemptionFact[] = [],
): PluginDetailView {
  const groups: PluginDetailGroup[] = [
    { title: 'Status', facts: cardStatusFacts(card) },
    { title: 'Source', facts: cardSourceFacts(card) },
  ]
  if (card.description !== undefined && card.description !== '') {
    groups.push({ title: 'Description', facts: [{ label: 'Description', value: card.description, tone: 'normal' }] })
  }
  if (card.rows.length > 0 || card.overrides.length > 0) {
    groups.push({ title: 'Components', facts: cardComponentFacts(card) })
  }
  const warnings = cardWarningFacts(card, exemptions)
  if (warnings.length > 0) groups.push({ title: 'Compatibility', facts: warnings })
  return Object.freeze({
    card,
    title: card.title ?? card.name,
    groups: Object.freeze(groups.map(group => Object.freeze({
      title: group.title,
      facts: Object.freeze(group.facts.map(fact => Object.freeze(fact))),
    }))),
    actions: Object.freeze(cardActions(card).map(action => Object.freeze(action))),
  })
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
    selfProtected: selfOwned,
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
    selfProtected: selfOwned,
    canToggle: addressable && !selfOwned,
  })
}

function bundleMutationBlocked(bundle: PluginBundleFact, isSelf: boolean): string | undefined {
  if (isSelf) return 'This bundle provides the Current TUI and cannot be changed from here.'
  if (bundle.readOnlyReason === 'management-required') return 'Required by DSH management; it cannot be changed here.'
  if (bundle.readOnlyReason === 'unaddressable') return 'Not addressable through the profile patch.'
  if (bundle.availability === 'missing') {
    return bundle.installTarget === undefined
      ? 'The bundle is not installed and no official install target is available.'
      : 'The bundle is not installed; install it from its official catalog entry.'
  }
  if (bundle.error !== undefined) return errorText(bundle.error)
  return undefined
}

function bundleRemoveBlocked(bundle: PluginBundleFact, isSelf: boolean): string | undefined {
  const mutation = bundleMutationBlocked(bundle, isSelf)
  if (mutation !== undefined) return mutation
  if (!bundle.removable) return 'Shipped with this DSH installation; it is not removable.'
  if (bundle.availability !== 'profile') return 'Only profile-owned bundles can be removed.'
  return undefined
}

/**
 * Build the classified model. `claims` comes from
 * {@link classifyPluginPackages}; an unclassified card falls back to
 * `dsh-plugin` and an unproven origin.
 */
export function buildPluginManagerModel(
  snapshot: PluginManagerSnapshot,
  claims: ReadonlyMap<string, PluginPackageClassification>,
): PluginManagerModel {
  const liveByEntry = new Map<string, PluginRowFact>()
  for (const entry of snapshot.plugins) liveByEntry.set(entry.entryId, entry)

  // Live entries referenced by any bundle row are NOT standalone cards. This
  // is the ONLY de-duplication rule and it is entry-id based.
  const bundledEntryIds = new Set<string>()
  for (const bundle of snapshot.bundles) {
    for (const row of bundle.rows) {
      if (row.entryId !== undefined) bundledEntryIds.add(String(row.entryId))
    }
  }

  // PROTECTION-ONLY (never visibility/role): the official identity proof for a
  // row the Current TUI composition controls.
  const selfBundle = snapshot.bundles.find(bundle => bundle.name === SELF_BUNDLE)
  const selfProtectionIds = new Set<string>([
    ...(selfBundle?.rows ?? []).map(row => row.rowId),
    ...(selfBundle?.overrides ?? []),
  ])

  const cards: PluginCardView[] = []
  for (const bundle of snapshot.bundles) {
    const value = bundleValue(bundle.name)
    const claim = claims.get(value)
    const role: PluginPresentationRole = claim?.role ?? 'dsh-plugin'
    const section = claim?.section ?? 'third-party'
    const origin = claim?.origin ?? 'unknown'
    const isSelf = role === 'current-tui'
    const rows = bundle.rows.map(row => {
      const liveId = row.entryId === undefined ? undefined : liveByEntry.get(String(row.entryId))
      const selfOwned = isSelf || selfProtectionIds.has(row.rowId)
      return rowView(row, liveId, selfOwned)
    })
    const toggleBlocked = bundleMutationBlocked(bundle, isSelf)
    const removeBlocked = bundleRemoveBlocked(bundle, isSelf)
    const installBlocked = bundle.availability !== 'missing'
      ? 'Only a missing official catalog entry can be installed.'
      : isSelf
        ? 'This bundle provides the Current TUI and cannot be installed from here.'
        : bundle.installTarget === undefined
          ? 'No official install target is available for this entry.'
          : undefined
    const canInstall = bundle.availability === 'missing' && bundle.installTarget !== undefined && !isSelf
    cards.push(Object.freeze({
      value,
      target: 'bundle' as const,
      role,
      section,
      origin,
      experimental: claim?.experimental ?? false,
      unverified: claim?.unverified ?? (section === 'third-party' && origin === 'unknown'),
      name: bundle.name,
      ...(bundle.version === undefined ? {} : { version: bundle.version }),
      ...(bundle.title === undefined ? {} : { title: bundle.title }),
      ...(bundle.description === undefined ? {} : { description: bundle.description }),
      official: bundle.official,
      availability: bundle.availability,
      ...(bundle.installTarget === undefined ? {} : { installTarget: bundle.installTarget }),
      ...(bundle.source === undefined ? {} : { source: bundle.source }),
      enabled: bundle.enabled,
      installed: bundle.installed,
      optional: bundle.optional,
      removable: bundle.removable,
      ...(bundle.readOnlyReason === undefined ? {} : { readOnlyReason: bundle.readOnlyReason }),
      ...(bundle.error === undefined ? {} : { error: bundle.error }),
      rows: Object.freeze(rows),
      overrides: Object.freeze([...bundle.overrides]),
      ...(claim?.extension === undefined ? {} : { extension: claim.extension }),
      ...(bundle.name === AUTO_REVIEW_BUNDLE && bundle.enabled ? { riskNotice: AUTO_REVIEW_DISABLE_WARNING } : {}),
      ...(toggleBlocked === undefined ? {} : { toggleBlockedReason: toggleBlocked }),
      ...(removeBlocked === undefined ? {} : { removeBlockedReason: removeBlocked }),
      ...(installBlocked === undefined ? {} : { installBlockedReason: installBlocked }),
      canToggle: toggleBlocked === undefined,
      canRemove: removeBlocked === undefined,
      canInstall,
      isSelf,
    }))
  }

  for (const entry of snapshot.plugins) {
    if (bundledEntryIds.has(entry.entryId)) continue
    const value = entryValue(entry.entryId)
    const claim = claims.get(value)
    // A standalone entry is NEVER guessed into Current TUI: that role is the
    // self BUNDLE card alone.
    const role: PluginPresentationRole = claim?.role ?? 'dsh-plugin'
    const section = claim?.section ?? 'third-party'
    const origin = claim?.origin ?? 'unknown'
    const selfProtected = entry.patchId !== undefined && selfProtectionIds.has(entry.patchId)
    const row = entryRowView(entry, selfProtected)
    const toggleBlocked = selfProtected
      ? 'Controlled by the Current TUI composition; it cannot be changed here.'
      : entry.readOnlyReason === 'management-required'
        ? 'Required by DSH management; it cannot be changed here.'
        : entry.readOnlyReason === 'unaddressable'
          ? 'Not addressable through the profile patch.'
          : undefined
    cards.push(Object.freeze({
      value,
      target: 'entry' as const,
      role,
      section,
      origin,
      experimental: claim?.experimental ?? false,
      unverified: claim?.unverified ?? (section === 'third-party' && origin === 'unknown'),
      name: entry.moduleName,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      official: false,
      availability: 'profile' as const,
      enabled: entry.enabled,
      installed: true,
      optional: false,
      removable: false,
      ...(entry.readOnlyReason === undefined ? {} : { readOnlyReason: entry.readOnlyReason }),
      rows: Object.freeze([row]),
      overrides: Object.freeze([]),
      ...(claim?.extension === undefined ? {} : { extension: claim.extension }),
      ...(toggleBlocked === undefined ? {} : { toggleBlockedReason: toggleBlocked }),
      removeBlockedReason: 'A standalone Loader entry has no profile package to remove.',
      installBlockedReason: 'A standalone Loader entry is not an installable bundle.',
      canToggle: toggleBlocked === undefined,
      canRemove: false,
      canInstall: false,
      isSelf: selfProtected,
    }))
  }

  const grouped: Record<PluginPresentationSection, PluginCardView[]> = {
    tui: [],
    official: [],
    'third-party': [],
    experimental: [],
  }
  for (const card of cards) grouped[card.section].push(card)
  // Current TUI is first inside its section; the rest keep the official Host
  // catalog order. Experimental follows the frozen rc.2 B01–B14 order.
  grouped.tui.sort((left, right) => {
    if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1
    return 0
  })
  const experimentalOrder = new Map(EXPERIMENTAL_BUNDLE_IDS.map((name, index) => [name, index]))
  grouped.experimental.sort((left, right) => {
    const leftIndex = experimentalOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER
    const rightIndex = experimentalOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER
    return leftIndex - rightIndex
  })
  // Third-party keeps proven packages before the audited Unverified subsection.
  grouped['third-party'].sort((left, right) => Number(left.unverified) - Number(right.unverified))

  const sections = PLUGIN_SECTION_ORDER.map(id => Object.freeze({
    id,
    label: PLUGIN_SECTION_LABELS[id],
    cards: Object.freeze(grouped[id]),
  }))
  const flat = sections.flatMap(section => [...section.cards])
  return Object.freeze({
    sections: Object.freeze(sections),
    cards: Object.freeze(flat),
    registries: snapshot.registries,
    exemptions: snapshot.exemptions,
    exemptionWarnings: snapshot.exemptionWarnings,
  })
}

/** Human text for one completed mutation, including restart/override facts. */
export function changeSummary(change: PluginChangeFact): string {
  const parts: string[] = [`${change.stage} ${change.application}`]
  if (change.bundle !== undefined) parts.push(`bundle ${change.bundle}`)
  if (change.version !== undefined) parts.push(`version ${change.version}`)
  if (change.application === 'restart-required') {
    parts.push(`restart required${change.restartReason === undefined ? '' : ` (${change.restartReason})`}`)
  }
  if (change.application === 'overridden') parts.push('a higher-priority override still wins')
  if (change.pendingBuilds !== undefined && change.pendingBuilds.length > 0) {
    parts.push(`pending build scripts: ${change.pendingBuilds.join(', ')}`)
  }
  if (change.packageResult?.kind !== undefined) parts.push(`package failure: ${change.packageResult.kind}`)
  if (change.packageResult?.timedOut === true) parts.push('package run timed out')
  for (const entry of change.packageResult?.incompatible ?? []) parts.push(incompatibleText(entry))
  if (change.failedAt !== undefined) parts.push(`failed at ${change.failedAt}`)
  if (change.error !== undefined) parts.push(errorText(change.error))
  for (const warning of change.warnings ?? []) parts.push(warning)
  return parts.join(' · ')
}
