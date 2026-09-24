/**
 * Plugin Manager presentation classification (P1-A1.5): assigns every
 * managed package card a presentation role without inventing a second plugin
 * system and without name heuristics.
 *
 * Rules (plan §4.1):
 *  1. exact `SELF_BUNDLE`                         → current-tui
 *  2. exact + UNIQUE live extension-owner match   → tui-extension
 *  3. otherwise                                   → dsh-plugin
 *
 * A false negative is acceptable; a false positive is not. "Exact" means
 * whole-identity equality against a Live extension owner name (never a
 * substring / prefix / "contains tui" heuristic); "unique" means the matched
 * observation is not claimed by any other package card.
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager/classify
 */

import type { TuiExtensionObservation } from './extension-inventory.ts'

/** The bundle that provides the currently running TUI surface. */
export const SELF_BUNDLE = '@xmoon76/dsh-pi-tui'

/** The three presentation roles; management authority is unaffected. */
export type PluginPresentationRole = 'current-tui' | 'tui-extension' | 'dsh-plugin'

/** The exact identities one managed package card exposes to association. */
export interface PluginClassificationInput {
  /** Stable card key (the model's own identity). */
  readonly key: string
  /** The bundle package name, when the card is a bundle. */
  readonly bundleName?: string
  /** Exact module specifiers / Loader entry ids the official record exposes. */
  readonly identities: readonly string[]
}

/** The resolved role of one package card. */
export interface PluginPackageClassification {
  readonly role: PluginPresentationRole
  readonly observation?: TuiExtensionObservation
}

/** One exact owner association candidate: the Loader entry id when proven,
 * otherwise the whole-identity owner name (never a substring/prefix match). */
function matchesOwner(identities: ReadonlySet<string>, observation: TuiExtensionObservation): boolean {
  if (observation.entryId !== undefined && identities.has(observation.entryId)) return true
  return identities.has(observation.ownerName) || identities.has(observation.owner)
}

/**
 * Classify every package card, enforcing GLOBAL uniqueness: an observation
 * claimed by more than one card classifies none of them (ambiguous identity
 * falls back to `dsh-plugin`, never a guess).
 */
export function classifyPluginPackages(
  inputs: readonly PluginClassificationInput[],
  observations: readonly TuiExtensionObservation[],
): ReadonlyMap<string, PluginPackageClassification> {
  const out = new Map<string, PluginPackageClassification>()
  const claimed = new Map<string, string[]>()
  for (const input of inputs) {
    if (input.bundleName === SELF_BUNDLE) {
      out.set(input.key, { role: 'current-tui' })
      continue
    }
    const identities = new Set(input.identities.filter(identity => identity !== ''))
    const matches = observations.filter(observation => matchesOwner(identities, observation))
    if (matches.length !== 1) {
      out.set(input.key, { role: 'dsh-plugin' })
      continue
    }
    const observation = matches[0]!
    const owners = claimed.get(observation.owner) ?? []
    owners.push(input.key)
    claimed.set(observation.owner, owners)
    out.set(input.key, { role: 'tui-extension', observation })
  }
  // Drop every ambiguous claim: one live owner may decorate at most one card.
  for (const [owner, keys] of claimed) {
    if (keys.length < 2) continue
    const observation = observations.find(candidate => candidate.owner === owner)!
    for (const key of keys) out.set(key, { role: 'dsh-plugin' })
    void observation
  }
  return out
}
