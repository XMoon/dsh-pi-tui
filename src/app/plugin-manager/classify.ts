/**
 * Plugin Manager presentation classification (P1-A1.5 / S4-D1): assigns every
 * managed package card its presentation section and provenance without
 * inventing a second plugin system and without name heuristics.
 *
 * Evidence ladder (plan §4.3), evaluated in this exact order:
 *  1. exact `SELF_BUNDLE`                                   → TUI & Extensions
 *  2. ≥1 observation whose Loader `entryId` is owned by
 *     exactly this one card                                 → TUI & Extensions
 *  3. Host `official:true` AND an exact rc.2 `B01–B14` id   → Experimental
 *  4. Host `official:true`, or an exact rc.2 built-in base
 *     bundle id proven by Host inventory                    → Official DSH
 *  5. a profile-owned bundle the Host proves is not
 *     official (own `installed`/`source`)                   → Third-party
 *  6. anything whose source/official status cannot be
 *     proven                                               → Third-party,
 *                                                            `Unverified origin`
 *
 * A false negative is acceptable; a false positive is not. Association is by
 * the PROVEN Loader entry id only — an observation without one is never used,
 * however its owner name happens to read. Multiple proven observations of the
 * same card aggregate into one extension fact set; an `entryId` claimed by
 * zero or several cards classifies none of them.
 *
 * `EXPERIMENTAL_BUNDLE_IDS` is a version-limited PRESENTATION list: it only
 * answers "which section/order does a real Host item take". It never creates a
 * card, never fills a missing `installTarget`/version, and must be re-compared
 * with the official catalog before any later DSH version updates it.
 *
 * @module @xmoon76/dsh-pi-tui/app/plugin-manager/classify
 */

import type { PluginAvailability } from '../../runtime/plugin-manager-port.ts'
import type { TuiExtensionObservation } from './extension-inventory.ts'

/** The bundle that provides the currently running TUI surface. */
export const SELF_BUNDLE = '@xmoon76/dsh-pi-tui'

/** The four main presentation sections in their FROZEN display order. */
export const PLUGIN_SECTION_ORDER = ['tui', 'official', 'third-party', 'experimental'] as const

/** One frozen main section id. */
export type PluginPresentationSection = typeof PLUGIN_SECTION_ORDER[number]

/** Human labels of the frozen sections (Experimental is always last). */
export const PLUGIN_SECTION_LABELS: Record<PluginPresentationSection, string> = {
  tui: 'TUI & Extensions',
  official: 'Official DSH',
  'third-party': 'Third-party',
  experimental: 'Experimental',
}

/** The three presentation roles; management authority is unaffected. */
export type PluginPresentationRole = 'current-tui' | 'tui-extension' | 'dsh-plugin'

/** Whose package a card provably is. `unknown` is an audit fact, not a guess. */
export type PluginOrigin = 'official' | 'third-party' | 'unknown'

/**
 * The 14 rc.2 B01–B14 Optional/On-demand identities, in the frozen display
 * order (§4.4). This is CLASSIFICATION EVIDENCE, never catalog authority: a
 * missing Host item is a catalog discrepancy, not a generated card.
 */
export const EXPERIMENTAL_BUNDLE_IDS: readonly string[] = Object.freeze([
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
])

/**
 * The exact rc.2 built-in base bundle ids (the shipped `PROFILE_TEMPLATES`
 * bundle sets plus the default profile bundle). `official:false` on these is
 * NOT third-party evidence: the DSH installation ships them. This list is
 * version-limited evidence, never a name heuristic.
 */
export const OFFICIAL_BASE_BUNDLE_IDS: readonly string[] = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
])

const EXPERIMENTAL = new Set(EXPERIMENTAL_BUNDLE_IDS)
const OFFICIAL_BASE = new Set(OFFICIAL_BASE_BUNDLE_IDS)

/**
 * The proven classification input of one card. Bundle fields are the Host
 * `BundleInfo` facts; an entry card carries only its stable key/entry ids.
 */
export interface PluginClassificationInput {
  /** Stable card key (the model's own identity). */
  readonly key: string
  /** The bundle package name, when the card is a bundle. */
  readonly bundleName?: string
  /** ONLY the proven Loader entry ids (`row.entryId` / `entry.entryId`). */
  readonly entryIds: readonly string[]
  /** Host `BundleInfo.official`. */
  readonly official?: boolean
  /** Host `BundleInfo.availability`. */
  readonly availability?: PluginAvailability
  /** Host `BundleInfo.installed`. */
  readonly installed?: boolean
  /** Host `BundleInfo.source` (profile-owned dependency spec, already
   * stripped of user information by the Host). */
  readonly source?: string
}

/** Aggregated, provable TUI-extension facts for one card. */
export interface TuiExtensionFacts {
  /** The Loader entry ids that are proven to belong to this card. */
  readonly entryIds: readonly string[]
  readonly contributionKinds: readonly string[]
  readonly contributionCount: number
  readonly health: 'active' | 'failed' | 'mixed'
  readonly usesAdvancedCapability: boolean
  readonly usesUnstableCapability: boolean
}

/** The resolved presentation facts of one package card. */
export interface PluginPackageClassification {
  readonly role: PluginPresentationRole
  readonly section: PluginPresentationSection
  readonly origin: PluginOrigin
  /** Whether this card is one of the 14 rc.2 Experimental identities. */
  readonly experimental: boolean
  /** `Third-party → Unverified origin`: neither official nor profile source
   * could be proven. */
  readonly unverified: boolean
  /** Present only with `tui-extension`. */
  readonly extension?: TuiExtensionFacts
}

/** Aggregate several proven observations of ONE card into detached facts. */
function aggregate(observations: readonly TuiExtensionObservation[]): TuiExtensionFacts {
  const entryIds = new Set<string>()
  const kinds = new Set<string>()
  let contributionCount = 0
  let failed = 0
  let active = 0
  let advanced = false
  let unstable = false
  for (const observation of observations) {
    if (observation.entryId !== undefined) entryIds.add(observation.entryId)
    for (const kind of observation.contributionKinds) kinds.add(kind)
    contributionCount += observation.contributionCount
    if (observation.health === 'active') active += 1
    else if (observation.health === 'failed') failed += 1
    else { active += 1; failed += 1 }
    if (observation.usesAdvancedCapability) advanced = true
    if (observation.usesUnstableCapability) unstable = true
  }
  return Object.freeze({
    entryIds: Object.freeze([...entryIds].sort()),
    contributionKinds: Object.freeze([...kinds].sort()),
    contributionCount,
    health: failed === 0 ? 'active' : active === 0 ? 'failed' : 'mixed',
    usesAdvancedCapability: advanced,
    usesUnstableCapability: unstable,
  })
}

/**
 * Resolve whose package one card provably is. `official` and the exact rc.2
 * base ids are official evidence; a profile-owned bundle with its own Host
 * `source` is third-party evidence; everything else is `unknown` (audited,
 * never guessed from a package scope or an `experimental` substring).
 */
export function originOf(input: PluginClassificationInput): PluginOrigin {
  if (input.official === true) return 'official'
  if (input.bundleName !== undefined && OFFICIAL_BASE.has(input.bundleName)) return 'official'
  if (input.bundleName !== undefined && input.installed === true && input.source !== undefined) {
    return 'third-party'
  }
  return 'unknown'
}

/** Resolve the frozen main section of one card from Host facts + role proof. */
export function sectionOf(input: PluginClassificationInput, role: PluginPresentationRole): PluginPresentationSection {
  if (input.bundleName === SELF_BUNDLE) return 'tui'
  if (role === 'tui-extension') return 'tui'
  if (
    input.official === true
    && input.bundleName !== undefined
    && EXPERIMENTAL.has(input.bundleName)
  ) {
    return 'experimental'
  }
  if (input.official === true || (input.bundleName !== undefined && OFFICIAL_BASE.has(input.bundleName))) {
    return 'official'
  }
  // Rules 5/6: a profile-owned bundle the Host proves is not official belongs
  // to Third-party; anything unproven is Third-party → Unverified origin.
  return 'third-party'
}

/**
 * Classify every package card. Association requires a PROVEN Loader entry id
 * that belongs to exactly one card; otherwise the card stays `dsh-plugin`.
 */
export function classifyPluginPackages(
  inputs: readonly PluginClassificationInput[],
  observations: readonly TuiExtensionObservation[],
): ReadonlyMap<string, PluginPackageClassification> {
  // observation → the single card that owns its proven entry id.
  const perCard = new Map<string, TuiExtensionObservation[]>()
  for (const observation of observations) {
    if (observation.entryId === undefined) continue
    const owners = inputs.filter(input => input.entryIds.includes(observation.entryId!))
    if (owners.length !== 1) continue
    const key = owners[0]!.key
    const list = perCard.get(key)
    if (list === undefined) perCard.set(key, [observation])
    else list.push(observation)
  }

  const out = new Map<string, PluginPackageClassification>()
  for (const input of inputs) {
    const extensionFacts = perCard.get(input.key)
    const role: PluginPresentationRole = input.bundleName === SELF_BUNDLE
      ? 'current-tui'
      : extensionFacts === undefined || extensionFacts.length === 0
        ? 'dsh-plugin'
        : 'tui-extension'
    const origin = originOf(input)
    const section = sectionOf(input, role)
    const experimental = section === 'experimental'
    out.set(input.key, Object.freeze({
      role,
      section,
      origin,
      experimental,
      unverified: section === 'third-party' && origin === 'unknown',
      ...(role === 'tui-extension' && extensionFacts !== undefined
        ? { extension: aggregate(extensionFacts) }
        : {}),
    }))
  }
  return out
}
