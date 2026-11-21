/**
 * The settings registry (M5, plan §10 item 1): plugins register settings
 * ROWS that the host appends to the `/settings` panel. The registry carries
 * SEMANTIC row descriptions (label, description, current value, choices);
 * the host maps them to its own SettingsList rows at open time — a plugin
 * never constructs a SettingsList component or touches the panel layout.
 *
 * Contract (plan M5 gates):
 * - rows render in deterministic order (order ASC, id ASC);
 * - a duplicate (id) is an error; a duplicate LABEL is allowed but
 *   discouraged (diagnostics only);
 * - dynamic unload removes the rows;
 * - the host owns the panel; a row's `onChange` receives the chosen value
 *   and MAY reject it (returning false keeps the previous value);
 * - values are STRINGS only — no component, no raw ANSI, no terminal
 *   escape can enter through this seam.
 * @module @xmoon76/dsh-pi-tui/extension/internal/settings-registry
 */

import type {
  TuiPersistedChoice,
  TuiSettingContribution,
  TuiSettingHandle,
  TuiSettingsRegistrySnapshot,
} from '../public-types.ts'

/** The detailed outcome of one settings apply. 'stale' and 'gone' are
 * NOT plugin rejections (a newer apply superseded this one, or the row
 * was disposed mid-apply) — the host must stay silent on them. */
export type SettingApplyOutcome = 'accepted' | 'rejected' | 'stale' | 'gone'

/** The frozen author-declared descriptor of one persisted row. */
export interface PersistedSettingDescriptor {
  readonly path: readonly string[]
  readonly choices: readonly TuiPersistedChoice[]
}

/** Whether one value is a JSON scalar a persisted choice may write. */
function isPersistedScalar(value: unknown): boolean {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

/** Validate and freeze one author-declared persisted descriptor. Every error
 *  is a registration-time failure; the registry never repairs a declaration. */
function persistedDescriptorOf(
  contribution: Extract<TuiSettingContribution, { persisted: unknown }>,
): PersistedSettingDescriptor {
  const descriptor = contribution.persisted as
    | { readonly path?: unknown; readonly choices?: unknown }
    | undefined
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new Error('persisted settings row requires a persisted descriptor')
  }
  if (contribution.values !== undefined || contribution.onChange !== undefined) {
    throw new Error('a persisted settings row cannot declare runtime values or onChange')
  }
  const path = descriptor.path
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('persisted settings path must be a non-empty array')
  }
  for (const segment of path) {
    if (typeof segment !== 'string' || segment === '') {
      throw new Error('persisted settings path segments must be non-empty strings')
    }
  }
  const choices = descriptor.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('persisted settings choices must be a non-empty array')
  }
  const ids = new Set<string>()
  const frozenChoices: TuiPersistedChoice[] = []
  for (const choice of choices as readonly TuiPersistedChoice[]) {
    if (choice === null || typeof choice !== 'object') {
      throw new Error('persisted settings choices must be objects')
    }
    if (typeof choice.id !== 'string' || choice.id === '') {
      throw new Error('persisted settings choice ids must be non-empty strings')
    }
    if (ids.has(choice.id)) {
      throw new Error(`duplicate persisted settings choice id "${choice.id}"`)
    }
    ids.add(choice.id)
    if (choice.label !== undefined && typeof choice.label !== 'string') {
      throw new Error(`persisted settings choice "${choice.id}" label must be a string`)
    }
    if (choice.op === 'set') {
      if (!isPersistedScalar(choice.value)) {
        throw new Error(`persisted settings choice "${choice.id}" value must be a JSON scalar`)
      }
      frozenChoices.push(Object.freeze({ ...choice }))
    } else if (choice.op === 'unset') {
      if (Object.hasOwn(choice, 'value')) {
        throw new Error(`persisted settings choice "${choice.id}" is unset and must not carry a value`)
      }
      frozenChoices.push(Object.freeze({ ...choice }))
    } else {
      throw new Error('persisted settings choice has an unsupported op')
    }
  }
  return Object.freeze({ path: Object.freeze([...path]), choices: Object.freeze(frozenChoices) })
}

/** Internal registration record. */
interface SettingRecord {
  readonly id: string
  readonly label: string
  readonly description: string | undefined
  readonly values: readonly string[]
  readonly order: number
  readonly owner: string
  /** R8-E PR-4: runtime-only rows keep the legacy contract; persisted rows are
   *  an explicit opt-in whose only writer is the Host ConfigPort adapter. */
  readonly mode: 'runtime' | 'persisted'
  /** The immutable author declaration of a persisted row. */
  readonly persisted: PersistedSettingDescriptor | undefined
  /** C2-R6: the REGISTRATION identity of this record within this registry
   *  instance. Every `register()` allocates a new one, so a same-id
   *  re-registration (or a same-owner HMR reload) is a DIFFERENT setting.
   *  It is internal — `snapshot()` never exposes it and no Stable API type
   *  carries it — and is only ever compared, never ordered or displayed. */
  readonly registrationToken: number
  currentValue: string
  /** P2-01: the latest APPLY epoch for this row — a slow earlier change
   * must never overwrite a newer completed one (last-completion-wins
   * race). */
  applyEpoch: number
  readonly onChange: ((value: string) => boolean | void | Promise<boolean | void>) | undefined
  disposed: boolean
}

/**
 * The settings registry. One instance backs the runner; the extension
 * service exposes registration; the runner asks {@link rows} when
 * composing the /settings panel and {@link apply} when a row changes.
 */
export class SettingsRegistry {
  private readonly records = new Map<string, SettingRecord>()
  private revision = 0
  /** The per-registration token source (see {@link SettingRecord.registrationToken}). */
  private nextRegistrationToken = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /**
   * Register one settings row. A duplicate id is an error.
   * @param contribution - the row.
   * @param owner - the Cordis fiber name.
   * @returns a handle to set/remove the row.
   */
  register(contribution: TuiSettingContribution, owner: string): TuiSettingHandle {
    if (this.records.has(contribution.id)) {
      throw new Error(`duplicate settings row id "${contribution.id}"`)
    }
    if (contribution.label === '') throw new Error('settings row label must not be empty')
    const persisted = contribution.persisted === undefined ? undefined : persistedDescriptorOf(contribution)
    this.nextRegistrationToken += 1
    const record: SettingRecord = {
      id: contribution.id,
      label: contribution.label,
      description: contribution.description,
      values: persisted === undefined ? contribution.values ?? [] : persisted.choices.map(choice => choice.id),
      order: contribution.order ?? 0,
      owner,
      mode: persisted === undefined ? 'runtime' : 'persisted',
      persisted,
      registrationToken: this.nextRegistrationToken,
      currentValue: contribution.currentValue,
      applyEpoch: 0,
      onChange: persisted === undefined ? contribution.onChange : undefined,
      disposed: false,
    }
    this.records.set(contribution.id, record)
    this.revision += 1
    this.onInvalidate()
    // The handle is bound to the RECORD it registered, never to the bare id:
    // a late handle of an unloaded fiber must stay inert even when a NEW
    // registration reused the same id (the C2-R6 HMR fence).
    return {
      id: contribution.id,
      setValue: (value: string) => {
        if (this.records.get(contribution.id) !== record) return
        this.setValue(contribution.id, value)
      },
      dispose: () => this.disposeRecord(record),
    }
  }

  /** Update one row's current value (live panel refresh). */
  setValue(id: string, value: string): void {
    const record = this.records.get(id)
    if (record === undefined || record.disposed) return
    record.currentValue = value
    this.revision += 1
    this.onInvalidate()
  }

  /** Remove one row by id (idempotent). */
  dispose(id: string): void {
    const record = this.records.get(id)
    if (record !== undefined) this.disposeRecord(record)
  }

  /** Dispose every row owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const record of [...this.records.values()]) {
      if (record.owner === owner) this.disposeRecord(record)
    }
  }

  /** Remove ONE record by its captured identity: a disposed record or an id
   *  now owned by a NEWER registration is inert (a late fiber teardown must
   *  never unload the replacement). */
  private disposeRecord(record: SettingRecord): void {
    if (record.disposed || this.records.get(record.id) !== record) return
    record.disposed = true
    this.records.delete(record.id)
    this.revision += 1
    this.onInvalidate()
  }

  /** The owning fiber of one setting id (the health bridge resolves
   * owners here — the runner never passes owners around). */
  ownerOf(id: string): string | undefined {
    return this.records.get(id)?.owner
  }

  /** The rows in deterministic order (order ASC, id ASC). */
  rows(): readonly SettingRecord[] {
    return [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  /** The detailed outcome of one apply — the host needs to distinguish a
   * plugin REJECTION (a real failure: record health, revert, notify) from
   * a STALE or GONE result (a newer apply superseded this one, or the row
   * was disposed mid-apply: the plugin never refused — recording a
   * failure would be a false alarm; the review's P2).
   *
   * C2-R6: `expectedRegistrationToken` (used ONLY by this concrete registry's
   * protected settings consumer) fences a confirmation to the registration it
   * was made for. A mismatched token is `gone` BEFORE any callback runs, so a
   * same-id replacement never receives an old choice; the original two-argument
   * call sites keep their semantics unchanged. */
  applyDetailed(id: string, value: string, expectedRegistrationToken?: number): Promise<SettingApplyOutcome> {
    if (expectedRegistrationToken !== undefined) {
      const record = this.records.get(id)
      if (record === undefined || record.disposed || record.registrationToken !== expectedRegistrationToken) {
        return Promise.resolve('gone')
      }
    }
    return this.applyInternal(id, value)
  }

  /** Apply a value change to one row; returns whether the change was
   * accepted (the row's onChange may reject). P2-01: concurrent applies
   * use latest-only commit — a slow EARLIER change that settles after a
   * NEWER one must NOT overwrite it (last-completion-wins race). Each
   * apply stamps an epoch; only the LATEST epoch may write the value. */
  async apply(id: string, value: string): Promise<boolean> {
    return (await this.applyInternal(id, value)) === 'accepted'
  }

  private async applyInternal(id: string, value: string): Promise<SettingApplyOutcome> {
    const record = this.records.get(id)
    if (record === undefined || record.disposed) return 'gone'
    // R8-E PR-4: a persisted row's only writer is the Host ConfigPort adapter.
    // The legacy runtime apply path must never stand in for it (and must never
    // synthesize persistence by running an `onChange`, which cannot exist).
    if (record.mode === 'persisted') return 'rejected'
    const epoch = record.applyEpoch + 1
    record.applyEpoch = epoch
    const onChange = record.onChange
    if (onChange !== undefined) {
      let accepted: boolean | void
      try {
        accepted = await onChange(value)
      } catch {
        // GENERATION/LIFETIME FIRST (the review's P2): a callback that
        // settled after a NEWER apply superseded it (or after the row was
        // disposed) is STALE/GONE even when it threw — the plugin never
        // refused the CURRENT state, and the host must stay silent.
        if (record.disposed || this.records.get(id) !== record) return 'gone'
        if (record.applyEpoch !== epoch) return 'stale'
        return 'rejected'
      }
      // Same precedence for a resolved outcome: lifetime, then generation,
      // then the callback's own answer.
      if (record.disposed || this.records.get(id) !== record) return 'gone'
      if (record.applyEpoch !== epoch) return 'stale'
      if (accepted === false) return 'rejected'
    }
    // The row may have been disposed (or replaced under the same id) while
    // an async callback was in flight. A detached callback must never commit
    // into an orphaned record or invalidate the live registry.
    if (record.disposed || this.records.get(id) !== record) return 'gone'
    record.currentValue = value
    this.revision += 1
    this.onInvalidate()
    return 'accepted'
  }

  /** Whether any row is live (Plugin Manager diagnostics). */
  hasAny(): boolean {
    for (const record of this.records.values()) {
      if (!record.disposed) return true
    }
    return false
  }

  /** An immutable snapshot (Plugin Manager diagnostics). Runtime-only rows
   *  keep their original seven facts; a persisted row adds its frozen mode
   *  and author descriptor. */
  snapshot(): TuiSettingsRegistrySnapshot {
    const rows = this.rows().map(record => ({
      id: record.id,
      label: record.label,
      description: record.description,
      currentValue: record.currentValue,
      values: record.values,
      order: record.order,
      owner: record.owner,
      ...record.mode === 'persisted' ? { mode: 'persisted' as const, persisted: record.persisted } : {},
    }))
    return { rows, revision: this.revision }
  }
}
