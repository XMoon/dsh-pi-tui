/** Pure directory/effort presentation shared by the PiTui and TSP model pickers. */
import type { ModelDirectoryDto } from '../../runtime/catalog-port.ts'

/** The loaded/effective selection the picker highlights and badges. */
export interface ModelPickerCurrent {
  readonly provider: string
  readonly model: string
  /** The EXPLICIT effective reasoning effort, when the Session projection has
   *  one; absent means the picker must NOT invent a "current effort". */
  readonly reasoningEffort?: string
}

/** One flattened model presentation row, identity-complete: provider/model are
 *  kept separately so duplicate model ids across providers never collapse. */
export interface ModelPickerModelRow {
  readonly providerId: string
  readonly providerName: string
  readonly modelId: string
  readonly modelName: string
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
  readonly isCurrent: boolean
  readonly isDefault: boolean
  /** The explicit effort of the CURRENT Session selection (fact badge only). */
  readonly currentEffort?: string
  /**
   * The explicit effort of the picker's CONFIGURED selection (the live Session
   * selection, or — sessionless — the directory default). Seeds the inline
   * effort value WITHOUT implying a `current` badge, so a sessionless global
   * default of high never silently downgrades to the model default.
   */
  readonly configuredEffort?: string
}

/** One provider whose catalog read failed; inert in the list. */
export interface ModelPickerFailureRow {
  readonly providerId: string
  readonly providerName: string
  readonly message: string
}

export interface ModelPickerProjection {
  readonly models: readonly ModelPickerModelRow[]
  readonly failures: readonly ModelPickerFailureRow[]
}

const IDENTITY_SEP = '\u0000'
export const PROVIDER_DEFAULT = `${IDENTITY_SEP}provider-default`

/** Full logical identity of a model row. Model ids are not globally unique. */
export function modelIdentity(providerId: string, modelId: string): string {
  return `${providerId}${IDENTITY_SEP}${modelId}`
}

/**
 * Project the Host directory into identity-complete presentation rows. Pure:
 * no terminal/component state, so the current/default/effort rules are unit
 * testable without a rendering snapshot.
 */
export function projectModelDirectory(
  directory: ModelDirectoryDto,
  current: ModelPickerCurrent | undefined,
  sessionless: boolean,
): ModelPickerProjection {
  const models: ModelPickerModelRow[] = []
  for (const group of directory.groups) {
    for (const model of group.models) {
      // Full (provider, model) identity: a same-id model under another
      // provider must never be marked current/default.
      const matchesConfigured =
        current !== undefined && current.provider === group.id && current.model === model.id
      const isCurrentModel = !sessionless && matchesConfigured
      const isDefault =
        directory.default.provider === group.id && directory.default.model === model.id
      models.push({
        providerId: group.id,
        providerName: group.name,
        modelId: model.id,
        modelName: model.name,
        efforts: model.reasoning?.efforts ?? [],
        ...(model.reasoning?.defaultEffort === undefined
          ? {}
          : { defaultEffort: model.reasoning.defaultEffort }),
        isCurrent: isCurrentModel,
        isDefault,
        // Only the current model can carry a current effort; it must be the
        // EXPLICIT projection effort (an absent one stays absent).
        ...(isCurrentModel && current?.reasoningEffort !== undefined
          ? { currentEffort: current.reasoningEffort }
          : {}),
        // The configured selection's effort is independent of the `current`
        // badge: sessionless has no current model, yet its global default's
        // effort must still seed the inline effort value.
        ...(matchesConfigured && current?.reasoningEffort !== undefined
          ? { configuredEffort: current.reasoningEffort }
          : {}),
      })
    }
  }
  const failures: ModelPickerFailureRow[] = directory.failures.map((failure) => ({
    providerId: failure.id,
    providerName: failure.name,
    message: failure.message,
  }))
  return { models, failures }
}

/** One picker-local effort candidate: the PROTOCOL `value` (effort id, or the
 *  synthetic provider-default sentinel) plus the HUMAN-facing `label` the row
 *  renders. State and write payloads use `value`; only the display uses the
 *  label, so a renamed effort can never change what is submitted. */
export interface InlineEffortChoice {
  readonly value: string
  readonly label: string
}

/** The picker-local effort CHOICES for one model, in cycle order. A model with
 *  NO effort metadata has none — the effort keys must be a true no-op there.
 *  The synthetic `provider default` joins the cycle only when the model
 *  declares efforts but no concrete default. */
export function effortChoicesOf(row: ModelPickerModelRow): readonly InlineEffortChoice[] {
  if (row.efforts.length === 0) return []
  const efforts = row.efforts.map((effort) => ({ value: effort.id, label: effort.name }))
  return row.defaultEffort === undefined
    ? [{ value: PROVIDER_DEFAULT, label: 'Default' }, ...efforts]
    : efforts
}

/** The initial picker-local effort VALUE for one model: the configured/current
 *  explicit effort when advertised, else the model default, else the first
 *  candidate (provider default); `undefined` for a model with no effort
 *  metadata at all. */
export function initialEffortOf(
  row: ModelPickerModelRow,
  choices: readonly InlineEffortChoice[],
): string | undefined {
  if (choices.length === 0) return undefined
  const advertised = (value: string | undefined): string | undefined =>
    value !== undefined && choices.some((choice) => choice.value === value) ? value : undefined
  return advertised(row.configuredEffort) ?? advertised(row.defaultEffort) ?? choices[0]!.value
}
