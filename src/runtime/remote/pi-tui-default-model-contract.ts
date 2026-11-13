/**
 * The private `piTuiDefaultModel` Remote contract (M6): ONE handwritten unary
 * invocation descriptor that BOTH the Host service and the Client contribution
 * derive from, so a namespace/method/parameter/result drift is impossible by
 * construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiDefaultModel/saveSelection
 * service    piTuiDefaultModel   (Host Cordis service key)
 * namespace  piTuiDefaultModel   (wire namespace)
 * method     saveSelection(selection, signal) -> saved | refused
 * ```
 *
 * The Host delegates the write to the OFFICIAL `agentDefaultModel.saveSelection`
 * business service; this namespace is a DTO transport bridge, never a second
 * settings/config writer. The wire carries ONLY the three model-selection
 * fields — never a Session id, a cwd/path, a settings namespace, a config patch
 * or an executable callback. `refused` is a definite pre-write Host refusal;
 * `saved` means the official promise fulfilled. There is no `cancelled`/echo
 * business result: a post-dispatch failure stays a CLIENT-side `indeterminate`.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-default-model-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

/** The npm package that owns the private Remote method. */
export const PI_TUI_DEFAULT_MODEL_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the private service. */
export const PI_TUI_DEFAULT_MODEL_NAMESPACE = 'piTuiDefaultModel'

/** The sessionless default-model save endpoint's stable identity. */
export const PI_TUI_DEFAULT_MODEL_SAVE_SELECTION_ENDPOINT =
  '@xmoon76/dsh-pi-tui#piTuiDefaultModel/saveSelection'

/** The exact model-selection fields the wire accepts. Provider/model are the
 *  normalized identifiers (NOT trimmed), effort is present only when chosen. */
export interface PiTuiDefaultModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Why a supported Host declined to persist the default. */
export type PiTuiDefaultModelSaveRefusal =
  | 'owner-required'
  | 'default-model-service-unavailable'
  | 'profile-persistence-unavailable'
  | 'profile-entry-unavailable'

/** The strict, detached, non-sensitive Host result: no echo, no Host object. */
export type PiTuiDefaultModelSaveResult =
  | { readonly kind: 'saved' }
  | { readonly kind: 'refused'; readonly reason: PiTuiDefaultModelSaveRefusal }

const SELECTION_LABEL = 'piTuiDefaultModel/saveSelection selection'
const RESULT_LABEL = 'piTuiDefaultModel/saveSelection result'

const REFUSAL_REASONS: readonly PiTuiDefaultModelSaveRefusal[] = [
  'owner-required',
  'default-model-service-unavailable',
  'profile-persistence-unavailable',
  'profile-entry-unavailable',
]

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}: the value must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new TypeError(`${label}: unexpected field ${JSON.stringify(key)}`)
  }
}

/** A model identifier: a NON-EMPTY string, deliberately NOT trimmed (whitespace
 *  is part of an identifier if a provider elected to use it, matching
 *  `normalizeModelSelection`). */
function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label}: expected a non-empty string`)
  }
  return value
}

/**
 * Validate and detach one wire selection. Exact keys only: `provider` and
 * `model` (non-empty strings) plus an OPTIONAL non-empty `reasoningEffort`.
 * `null`, a number, an array or any extra field is refused at the boundary.
 */
export function parseDefaultModelSelection(value: unknown): PiTuiDefaultModelSelection {
  const record = recordOf(value, SELECTION_LABEL)
  exactKeys(record, ['provider', 'model', 'reasoningEffort'], SELECTION_LABEL)
  if (!Object.hasOwn(record, 'provider')) throw new TypeError(`${SELECTION_LABEL}: missing field "provider"`)
  if (!Object.hasOwn(record, 'model')) throw new TypeError(`${SELECTION_LABEL}: missing field "model"`)
  const provider = parseIdentifier(record.provider, `${SELECTION_LABEL} provider`)
  const model = parseIdentifier(record.model, `${SELECTION_LABEL} model`)
  if (record.reasoningEffort === undefined) return { provider, model }
  return { provider, model, reasoningEffort: parseIdentifier(record.reasoningEffort, `${SELECTION_LABEL} reasoningEffort`) }
}

/** Validate and detach one Host result (closed union, exact keys). */
export function parseDefaultModelSaveResult(value: unknown): PiTuiDefaultModelSaveResult {
  const record = recordOf(value, RESULT_LABEL)
  if (record.kind === 'saved') {
    exactKeys(record, ['kind'], RESULT_LABEL)
    return { kind: 'saved' }
  }
  if (record.kind === 'refused') {
    exactKeys(record, ['kind', 'reason'], RESULT_LABEL)
    if (!REFUSAL_REASONS.includes(record.reason as PiTuiDefaultModelSaveRefusal)) {
      throw new TypeError(`${RESULT_LABEL}: unknown refusal reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'refused', reason: record.reason as PiTuiDefaultModelSaveRefusal }
  }
  throw new TypeError(`${RESULT_LABEL}: unknown kind ${JSON.stringify(record.kind)}`)
}

const SELECTION_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_DEFAULT_MODEL_SAVE_SELECTION_ENDPOINT}:selection`,
  create: () => ({ parse: parseDefaultModelSelection }),
  decode: parseDefaultModelSelection,
}

const RESULT_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_DEFAULT_MODEL_SAVE_SELECTION_ENDPOINT}:result`,
  create: () => ({ parse: parseDefaultModelSaveResult }),
  decode: parseDefaultModelSaveResult,
}

/** The ONE shared invocation descriptor both contributions derive from. The
 *  Host registers this exact object; the Client mounts this exact object. */
export const PI_TUI_DEFAULT_MODEL_SAVE_SELECTION: InvocationDescriptor = {
  id: PI_TUI_DEFAULT_MODEL_SAVE_SELECTION_ENDPOINT,
  service: PI_TUI_DEFAULT_MODEL_NAMESPACE,
  namespace: PI_TUI_DEFAULT_MODEL_NAMESPACE,
  method: 'saveSelection',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'selection', wire: 'selection', source: 'json', codec: SELECTION_CODEC },
  ],
  cancellation: { parameter: 'signal' },
  result: RESULT_CODEC,
}

/** The `saveSelection` call result as the Client receives it. */
export type PiTuiDefaultModelSaveCall = RemoteResult<PiTuiDefaultModelSaveResult>

/** The mounted Client namespace slice this adapter consumes. */
export interface PiTuiDefaultModelNamespace {
  saveSelection(
    selection: PiTuiDefaultModelSelection,
    signal?: AbortSignal,
  ): Promise<PiTuiDefaultModelSaveCall>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiDefaultModel/saveSelection': (
      selection: PiTuiDefaultModelSelection,
      signal?: AbortSignal,
    ) => Promise<PiTuiDefaultModelSaveCall>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiDefaultModel': {
      saveSelection: (
        selection: PiTuiDefaultModelSelection,
        signal?: AbortSignal,
      ) => Promise<PiTuiDefaultModelSaveCall>
    }
  }
}
