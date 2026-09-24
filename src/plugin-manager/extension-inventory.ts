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
 * @module @xmoon76/dsh-pi-tui/plugin-manager/extension-inventory
 */

/** The minimal read view of one live contribution (`ContributionHealth`). */
export interface TuiExtensionHealthRecord {
  readonly id: string
  /** The UID-qualified contribution owner (`<uid>:<name>`). */
  readonly owner: string
  /** The slot/extension point the contribution registered under. */
  readonly extensionPoint: string
  /** Official contribution lifecycle state. */
  readonly state: string
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
  /** The HMR-stable owner name (the fiber name, without the uid). */
  readonly ownerName: string
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
  ownerName: string
  kinds: Set<string>
  count: number
  failed: number
  active: number
  advanced: boolean
  unstable: boolean
}

/** The HMR-stable name of a UID-qualified owner (`uid:name` → `name`). */
export function extensionOwnerName(owner: string): string {
  const separator = owner.indexOf(':')
  return separator === -1 ? owner : owner.slice(separator + 1)
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
        ownerName: extensionOwnerName(record.owner),
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
        ownerName: entry.ownerName,
        ...(entryId === undefined ? {} : { entryId }),
        contributionKinds: Object.freeze([...entry.kinds].sort()),
        contributionCount: entry.count,
        health: entry.failed === 0 ? 'active' as const : entry.active === 0 ? 'failed' as const : 'mixed' as const,
        usesAdvancedCapability: entry.advanced,
        usesUnstableCapability: entry.unstable,
      })
    })
}
