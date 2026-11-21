/**
 * The ONE narrow adapter between a persisted Stable extension setting and the
 * official Host per-package Config authority (R8-E PR-4).
 *
 * A persisted setting is registered through the existing
 * `piTuiExtensions.registerSetting()` with an author-declared
 * `persisted: { path, choices }` descriptor. This module owns three
 * deterministic projections, and NOTHING else:
 *
 * ```text
 * live registration owner -> current Client Loader entry -> ACTIVE package
 *   -> official ConfigPort.extensionConfigs.read(packageName)
 *   -> author choice -> ONE CAS mutate -> authoritative readback
 * ```
 *
 * It stores no value, creates no second registry and never falls back to a
 * package name supplied by the plugin author. A persisted setting whose owner
 * cannot be proven ACTIVE in THIS Client is `unavailable` (never written).
 *
 * @module @xmoon76/dsh-pi-tui/app/client-extensions/persisted-setting
 */

import type { ExtensionConfigsConfig } from '../../runtime/config-port.ts'
import type { TuiPersistedChoice, TuiPersistedScalar } from '../../extension/public-types.ts'
import type { ClientExtensionObservation } from './mount-owner.ts'

/** The structural view of one live persisted registration (the registry's
 *  internal record satisfies it). */
export interface PersistedSettingRecord {
  readonly id: string
  readonly owner: string
  readonly registrationToken: number
  readonly mode: 'runtime' | 'persisted'
  readonly currentValue: string
  readonly persisted?: {
    readonly path: readonly string[]
    readonly choices: readonly TuiPersistedChoice[]
  }
}

/** The proven current-Client owner of one persisted registration. */
export interface PersistedSettingOwner {
  readonly packageName: string
  readonly entryId: string
  readonly registrationToken: number
}

/** One resolved (or refused) owner lookup. */
export type PersistedSettingOwnerResolution =
  | ({ readonly kind: 'ready' } & PersistedSettingOwner)
  | { readonly kind: 'unavailable'; readonly reason: string }

/** One authoritative read of the field a persisted setting edits. */
export type PersistedSettingRead =
  | {
      readonly mode: 'ready'
      readonly effective: unknown
      readonly inherited: unknown
      readonly user: unknown
      /** Own-field presence at the leaf of `user` (not value inequality). */
      readonly userFieldPresent: boolean
      readonly revision: number
      readonly generation: object
      /** The author choice id matching the current USER field, when one exists. */
      readonly candidateId?: string
      readonly overriddenDisplay: 'Yes' | 'No'
      readonly runtimeValue: string
    }
  | { readonly mode: 'stale' | 'unavailable' | 'unreadable'; readonly reason: string }

/** The commit outcome vocabulary the Settings workspace already understands. */
export interface PersistedSettingCommitOutcome {
  readonly outcome: 'verified' | 'not-saved' | 'unverified' | 'indeterminate'
  readonly reason?: string
}

interface FieldRead {
  readonly present: boolean
  readonly value: unknown
}

/** Read one own-property path WITHOUT invoking an accessor. A missing or
 *  non-value descriptor is `present: false`; a non-object intermediate is the
 *  same. This never materializes `{}` for `undefined`. */
function readOwnField(root: unknown, path: readonly string[]): FieldRead {
  let current: unknown = root
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return { present: false, value: undefined }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment)
    if (descriptor === undefined || !('value' in descriptor)) return { present: false, value: undefined }
    current = descriptor.value
  }
  return { present: true, value: current }
}

/** JSON-scalar equality for the declared choice contract. */
function sameScalar(left: unknown, right: TuiPersistedScalar): boolean {
  if (right === null) return left === null
  if (typeof right === 'number') return typeof left === 'number' && Object.is(left, right)
  return typeof left === typeof right && left === right
}

/** Whether the effective leaf differs from the inherited leaf. */
function differsFromInherited(effective: unknown, inherited: unknown): 'Yes' | 'No' {
  if (effective === undefined && inherited === undefined) return 'No'
  if (effective === undefined || inherited === undefined) return 'Yes'
  try {
    return JSON.stringify(effective) === JSON.stringify(inherited) ? 'No' : 'Yes'
  } catch {
    return 'Yes'
  }
}

/** Resolve the EXACT current-Client package that owns one persisted setting.
 *  Only a live owner -> live Loader entry id -> exactly one ACTIVE observation
 *  is writable. The plugin-supplied declaration never names a package. */
export function resolvePersistedSettingOwner(
  record: PersistedSettingRecord,
  ownerEntryIds: ReadonlyMap<string, string>,
  clientObservations: readonly ClientExtensionObservation[],
): PersistedSettingOwnerResolution {
  if (record.mode !== 'persisted' || record.persisted === undefined) {
    return { kind: 'unavailable', reason: 'not a persisted extension setting' }
  }
  const entryId = ownerEntryIds.get(record.owner)
  if (entryId === undefined) {
    return { kind: 'unavailable', reason: 'not an active opted-in Client extension' }
  }
  const matches = clientObservations.filter(observation => observation.entryId === entryId)
  if (matches.length !== 1 || matches[0]?.phase !== 'active') {
    return { kind: 'unavailable', reason: 'not an active opted-in Client extension' }
  }
  return {
    kind: 'ready',
    packageName: matches[0].packageName,
    entryId,
    registrationToken: record.registrationToken,
  }
}

/** Read the author-declared field from ONE authoritative Host Config read.
 *  `effective`, `inherited` and `user` are the leaf values at
 *  `persisted.path`; the leaf USER own-field presence is a separate fact. */
export function readPersistedSetting(
  record: PersistedSettingRecord,
  packageName: string,
  extensionConfigs: ExtensionConfigsConfig,
): PersistedSettingRead {
  if (record.mode !== 'persisted' || record.persisted === undefined) {
    return { mode: 'unavailable', reason: 'not a persisted extension setting' }
  }
  const read = extensionConfigs.read(packageName)
  if (read.kind !== 'ready') {
    return { mode: read.kind, reason: read.reason }
  }
  const path = record.persisted.path
  const effective = readOwnField(read.effective, path)
  const inherited = readOwnField(read.inherited, path)
  const user = readOwnField(read.user, path)
  const candidateId = user.present
    ? record.persisted.choices.find(choice => choice.op === 'set' && sameScalar(user.value, choice.value))?.id
    : record.persisted.choices.find(choice => choice.op === 'unset')?.id
  return {
    mode: 'ready',
    effective: effective.present ? effective.value : undefined,
    inherited: inherited.present ? inherited.value : undefined,
    user: user.present ? user.value : undefined,
    userFieldPresent: user.present,
    revision: read.revision,
    generation: read.generation,
    ...candidateId === undefined ? {} : { candidateId },
    overriddenDisplay: differsFromInherited(
      effective.present ? effective.value : undefined,
      inherited.present ? inherited.value : undefined,
    ),
    runtimeValue: record.currentValue,
  }
}

/** Commit ONE author choice through the existing per-package CAS writer.
 *  Only the exact registration/package/candidate captured by the painted
 *  Confirm may dispatch. There is no retry and no second writer. */
export async function commitPersistedSetting(
  record: PersistedSettingRecord,
  trustedOwner: PersistedSettingOwner,
  candidateId: string,
  extensionConfigs: ExtensionConfigsConfig,
  capturedRevision: number,
  capturedGeneration: object,
): Promise<PersistedSettingCommitOutcome> {
  if (record.mode !== 'persisted' || record.persisted === undefined) {
    return { outcome: 'not-saved', reason: 'not a persisted extension setting' }
  }
  if (trustedOwner.registrationToken !== record.registrationToken) {
    return { outcome: 'not-saved', reason: 'The extension setting was unloaded or replaced' }
  }
  const choice = record.persisted.choices.find(candidate => candidate.id === candidateId)
  if (choice === undefined) {
    return { outcome: 'not-saved', reason: 'the requested value is not one of the extension setting\'s registered choices' }
  }
  const fresh = extensionConfigs.read(trustedOwner.packageName)
  if (fresh.kind !== 'ready') {
    return { outcome: 'not-saved', reason: 'Host Config is not current; refresh before editing' }
  }
  if (fresh.revision !== capturedRevision || !Object.is(fresh.generation, capturedGeneration)) {
    return { outcome: 'not-saved', reason: 'Host Config changed; refresh and review' }
  }
  const op = choice.op === 'unset'
    ? { op: 'unset' as const, path: record.persisted.path }
    : { op: 'set' as const, path: record.persisted.path, value: choice.value }
  const mutation = await extensionConfigs.mutate(
    trustedOwner.packageName,
    [op],
    capturedRevision,
    capturedGeneration,
  )
  if (mutation.kind === 'conflict') {
    return { outcome: 'not-saved', reason: 'Host Config changed; refresh and review' }
  }
  if (mutation.kind === 'rejected') return { outcome: 'not-saved', reason: mutation.reason }
  if (mutation.kind === 'outcome-unconfirmed') {
    return { outcome: 'indeterminate', reason: mutation.reason }
  }
  const readback = extensionConfigs.read(trustedOwner.packageName)
  if (readback.kind !== 'ready') {
    return { outcome: 'unverified', reason: readback.reason }
  }
  const user = readOwnField(readback.user, record.persisted.path)
  const matches = choice.op === 'unset'
    ? !user.present
    : user.present && sameScalar(user.value, choice.value)
  if (!matches) {
    return {
      outcome: 'not-saved',
      reason: 'the authoritative USER field does not carry the requested value',
    }
  }
  return { outcome: 'verified' }
}
