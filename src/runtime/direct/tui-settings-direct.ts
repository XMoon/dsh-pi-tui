/**
 * The Direct TUI-settings adapter (DSH 0.1.7 PR A): the `TuiSettingsConfig`
 * facade over the `tui-app` plugin's profile-owned volatile Config
 * references. The plugin's own `Config` schema (src/index.ts) is the ONE
 * runtime authority; this adapter only unwraps references into the detached
 * `TuiSettingsDoc` snapshot consumers already use, and converts the legacy
 * whole-document `get → modify → replace` cycle into path-scoped
 * `SettingsForms.mutate` operations so inherited/base values are never
 * promoted into the USER profile override.
 *
 * Write provenance follows the 0.1.7 Settings contract:
 * - a field is written ONLY when the requested document actually changes
 *   the current effective value (no pinning of base/project values);
 * - a field is UNSET only when the USER profile override currently owns a
 *   value and the requested document drops it (an inherited value stays
 *   inherited);
 * - the mutation carries the `SettingsDescriptor.revision` read immediately
 *   before the write, so a concurrent external edit surfaces as a
 *   `SettingsConflictError` instead of a silent last-write-wins.
 *
 * The module never touches `ctx` (no client-boundary debt): the runner
 * injects the volatile refs and the structural SettingsForms surface.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/tui-settings-direct
 */

import type { Volatile } from '@deepseek-ai/cordis'
import type { TuiSettingsConfig, TuiSettingsDoc } from '../config-port.ts'

/** The `tui-app` plugin Config's live preference references (the runtime
 * shape schemastery produces for the `.volatile()` fields declared in
 * src/index.ts). Every read goes through `.get()` at operation time — the
 * adapter never snapshots these across operations. */
export interface TuiConfigRefs {
  readonly theme: Volatile<string>
  readonly iconStyle: Volatile<string>
  readonly footer: Volatile<string>
  readonly footerFallbackMode: Volatile<string>
  readonly footerLayout: Volatile<unknown>
  readonly footerCustomItems: Volatile<unknown>
  readonly footerCommand: Volatile<unknown>
  readonly fullscreen: Volatile<string>
  readonly busyEnter: Volatile<string>
  readonly localShellSandbox: Volatile<string>
  readonly homeEndKeys: Volatile<string>
  readonly displayPreset: Volatile<string | undefined>
  readonly progressUpdates: Volatile<string | undefined>
  readonly responseStyle: Volatile<string | undefined>
  readonly notificationMode: Volatile<string>
  readonly notificationMethod: Volatile<string>
  readonly wheelScrollLines: Volatile<string>
  readonly keybindings: Volatile<unknown>
  /** Internal one-shot legacy-migration marker; never a product row. */
  readonly legacySettingsMigrationVersion: Volatile<number>
}

/** The structural 0.1.7 SettingsForms surface the writer needs (the service
 * resolves from the dsh installation; this is never a package dependency). */
export interface SettingsFormsLike {
  describe(options?: { readonly redactSecrets?: boolean }): readonly TuiSettingsDescriptorLike[] | undefined
  mutate(
    ns: string,
    ops: readonly TuiSettingsPathOp[],
    expectedRevision?: number,
  ): Promise<unknown>
}

/** The descriptor slice the writer/trust reads consume. */
export interface TuiSettingsDescriptorLike {
  readonly ns: string
  /** The form-projected EFFECTIVE value (volatile fields only). */
  readonly value?: unknown
  /** The form-projected USER profile override. */
  readonly user?: unknown
  readonly revision?: number
}

/** One path-addressed form edit (the 0.1.7 `SettingsPathOp` shape). */
export type TuiSettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** Whether two whole-value field snapshots are observationally equal (the
 * fields are JSON-shaped persisted data; a stable key order keeps the
 * comparison structural). */
function fieldEquals(left: unknown, right: unknown): boolean {
  return left === right || stableJson(left) === stableJson(right)
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        return Object.fromEntries(Object.keys(entry).sort().map(key => [key, (entry as Record<string, unknown>)[key]]))
      }
      return entry
    }) ?? 'undefined'
  } catch {
    // A non-JSON value (hostile or cyclic) compares by identity only.
    return '\u0000unserializable'
  }
}

/** Every top-level field the diff considers — the Config's declared
 * preference keys, in schema order. Unknown keys in a replacement document
 * are ignored: the schema is the authority, not the caller's spread. */
const DIFF_FIELDS: readonly (keyof TuiConfigRefs)[] = [
  'theme',
  'iconStyle',
  'footer',
  'footerFallbackMode',
  'footerLayout',
  'footerCustomItems',
  'footerCommand',
  'fullscreen',
  'busyEnter',
  'localShellSandbox',
  'homeEndKeys',
  'displayPreset',
  'progressUpdates',
  'responseStyle',
  'notificationMode',
  'notificationMethod',
  'wheelScrollLines',
  'keybindings',
]

/** The Direct `tui-app` settings facade: effective snapshot reads over the
 * plugin's volatile references, path-scoped profile writes through the
 * official SettingsForms surface. */
export class DirectTuiSettings implements TuiSettingsConfig {
  readonly mutationQueueKey = this
  private readonly refs: TuiConfigRefs
  private readonly forms: SettingsFormsLike | undefined
  private readonly ns: string

  constructor(refs: TuiConfigRefs, forms: SettingsFormsLike | undefined, ns: string = 'tui-app') {
    this.refs = refs
    this.forms = forms
    this.ns = ns
  }

  get(): TuiSettingsDoc {
    return {
      theme: this.refs.theme.get(),
      iconStyle: this.refs.iconStyle.get(),
      footer: this.refs.footer.get(),
      footerFallbackMode: this.refs.footerFallbackMode.get(),
      footerLayout: this.refs.footerLayout.get(),
      footerCustomItems: this.refs.footerCustomItems.get(),
      footerCommand: this.refs.footerCommand.get() as TuiSettingsDoc['footerCommand'],
      fullscreen: this.refs.fullscreen.get(),
      busyEnter: this.refs.busyEnter.get(),
      localShellSandbox: this.refs.localShellSandbox.get(),
      homeEndKeys: this.refs.homeEndKeys.get(),
      displayPreset: this.refs.displayPreset.get(),
      progressUpdates: this.refs.progressUpdates.get(),
      responseStyle: this.refs.responseStyle.get(),
      notificationMode: this.refs.notificationMode.get(),
      notificationMethod: this.refs.notificationMethod.get(),
      wheelScrollLines: this.refs.wheelScrollLines.get(),
      keybindings: this.refs.keybindings.get(),
    }
  }

  /** The current `tui-app` descriptor (effective value + USER override +
   * revision), or undefined when the settings surface cannot serve it. */
  readDescriptor(): TuiSettingsDescriptorLike | undefined {
    try {
      const descriptors = this.forms?.describe()
      return descriptors?.find(descriptor => descriptor.ns === this.ns)
    } catch {
      // An unreadable settings surface fails the write explicitly; reads of
      // the effective document still work off the plugin references.
      return undefined
    }
  }

  async replace(doc: TuiSettingsDoc): Promise<void> {
    const forms = this.forms
    if (forms === undefined) throw new Error('settings service unavailable')
    // ONE descriptor snapshot is the indivisible decision unit for a write:
    // its value (effective), user (override ownership) and revision (the
    // conflict fence) are read together, the ops are derived from exactly
    // that snapshot, and the SAME revision guards the mutate. Re-reading
    // the descriptor for the revision would refresh the fence after a
    // concurrent edit and let stale ops commit over a newer USER value.
    // Runtime READS stay on the Config references (get()); the descriptor
    // projection is only the write-reconciliation snapshot.
    const descriptor = this.readDescriptor()
    if (descriptor === undefined) throw new Error('settings entry "tui-app" is not configurable in this deployment')
    const current = (descriptor.value ?? {}) as Record<string, unknown>
    const next = doc as unknown as Record<string, unknown>
    // The USER override decides whether a dropped field is an UNSET (the
    // user layer owns a value to remove) or a no-op (the effective value is
    // inherited and stays inherited — never pinned into the profile).
    const user = descriptor.user
    const userSection = user !== null && typeof user === 'object' && !Array.isArray(user)
      ? user as Record<string, unknown>
      : undefined
    const ops: TuiSettingsPathOp[] = []
    for (const field of DIFF_FIELDS) {
      const requested = next[field]
      const effective = current[field]
      const owned = userSection?.[field]
      if (requested !== undefined) {
        if (owned !== undefined) {
          if (fieldEquals(requested, owned)) {
            // The USER override already stores exactly this value: no op
            // (a document rebuilt from a merged view re-states the user's
            // own raw value — writing it back would only pin it).
          } else if (!fieldEquals(requested, effective)) {
            ops.push({ op: 'set', path: [field], value: requested })
          } else if (effective === null || typeof effective !== 'object') {
            // requested === effective ≠ owned on a SCALAR: the caller wrote
            // the inherited/base value over its own override — a
            // reset-to-inherited, expressed as an UNSET so the override
            // stops shadowing the layers beneath instead of being pinned.
            ops.push({ op: 'unset', path: [field] })
          }
          // requested === effective ≠ owned on an OBJECT is the merged-view
          // restate: upstream mergeLayers merges nested plain objects
          // recursively, so a project/home layer makes the EFFECTIVE value a
          // SUPERSET of the raw USER override (keybindings/footerLayout/
          // footerCommand). Every whole-document writer spreads get() — the
          // merged view — so this shape must stay a NO-OP: an unset would
          // destroy the USER's partial override (and disarm a trusted
          // footerCommand), and a set would pin the merged superset into the
          // USER layer. The unset-removal drop path (requested undefined)
          // remains the explicit way to clear an owned object field.
        } else if (!fieldEquals(requested, effective)) {
          // No USER override: only a value that actually changes the
          // effective snapshot is written — inherited values are never
          // promoted into the profile.
          ops.push({ op: 'set', path: [field], value: requested })
        }
      } else if (effective !== undefined && owned !== undefined) {
        ops.push({ op: 'unset', path: [field] })
      }
    }
    if (ops.length === 0) return
    await forms.mutate(this.ns, ops, descriptor.revision)
  }
}
