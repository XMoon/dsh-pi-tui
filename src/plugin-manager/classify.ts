/**
 * Plugin Manager presentation classification (P1-A1.5): assigns every
 * managed package card a presentation role without inventing a second plugin
 * system and without name heuristics.
 *
 * Rules (plan §4.1):
 *  1. exact `SELF_BUNDLE`                              → current-tui
 *  2. ≥1 observation whose Loader `entryId` is owned   → tui-extension
 *     by exactly this one card
 *  3. otherwise                                        → dsh-plugin
 *
 * A false negative is acceptable; a false positive is not. Association is by
 * the PROVEN Loader entry id only — an observation without one is never used,
 * however its owner name happens to read. Multiple proven observations of the
 * same card aggregate into one extension fact set; an `entryId` claimed by
 * zero or several cards classifies none of them.
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager/classify
 */

import type { TuiExtensionObservation } from './extension-inventory.ts'

/** The bundle that provides the currently running TUI surface. */
export const SELF_BUNDLE = '@xmoon76/dsh-pi-tui'

/** The three presentation roles; management authority is unaffected. */
export type PluginPresentationRole = 'current-tui' | 'tui-extension' | 'dsh-plugin'

/** The proven Loader entry ids one managed package card exposes. Module
 * specifiers are deliberately NOT part of this set: only a proven entry id is
 * ownership proof. */
export interface PluginClassificationInput {
  /** Stable card key (the model's own identity). */
  readonly key: string
  /** The bundle package name, when the card is a bundle. */
  readonly bundleName?: string
  /** ONLY the proven Loader entry ids (`row.entryId` / `entry.entryId`). */
  readonly entryIds: readonly string[]
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

/** The resolved role of one package card. */
export interface PluginPackageClassification {
  readonly role: PluginPresentationRole
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
    if (input.bundleName === SELF_BUNDLE) {
      out.set(input.key, { role: 'current-tui' })
      continue
    }
    const owned = perCard.get(input.key)
    if (owned === undefined || owned.length === 0) {
      out.set(input.key, { role: 'dsh-plugin' })
      continue
    }
    out.set(input.key, { role: 'tui-extension', extension: aggregate(owned) })
  }
  return out
}
