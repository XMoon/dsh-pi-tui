/**
 * The private `piTuiPromptPresence` Remote contract (M6 PR-C C3): the ONE
 * authenticated per-Peer presence projection the Split Host folds into the
 * per-Turn Focus decision.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiPromptPresence/syncView
 * service    piTuiPromptPresence   (Host Cordis service key)
 * namespace  piTuiPromptPresence   (wire namespace)
 * method     syncView(viewedSessionId|null, displayPreset, revision, signal)
 *                                        -> applied | refused
 * ```
 *
 * The wire has EXACTLY ONE method (`syncView`): the Client pushes its own
 * current view and awaits the authoritative ACK. The Host-side per-Turn fold
 * (`snapshotVoters`) is a Host-internal service method — the voter roster is
 * never a Client query surface.
 *
 * Identity discipline: the Host keys every record by the EXACT
 * `RemoteInvocation.peer.id` of the calling Peer, never by a Client-supplied
 * id, a socket id or a Session id. A Client can therefore only speak for
 * itself, and one Client can never impersonate another's presence.
 *
 * The wire carries ONLY detached facts: a Session id (or null) and one of the
 * three display presets plus a monotonic Client revision. It never carries a
 * Host Session/Agent object, a workspace path, a prompt text or an executable
 * callback.
 *
 * The presence record is NOT a second Session or display authority: it is a
 * projection of what a live Client surface is currently showing, and the
 * display preset itself stays Client-local. `refused` is a definite
 * pre-commit Host refusal; `applied` means the map commit happened and the
 * ACK was emitted after it, so a Client that never saw the ACK knows its
 * presence is unconfirmed rather than applied.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-prompt-presence-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'
import type { DisplayPreset } from '../../domain/display/preset.ts'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_PROMPT_PRESENCE_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the private service. */
export const PI_TUI_PROMPT_PRESENCE_NAMESPACE = 'piTuiPromptPresence'

/** The sync endpoint's stable identity. */
export const PI_TUI_PROMPT_PRESENCE_SYNC_VIEW_ENDPOINT =
  '@xmoon76/dsh-pi-tui#piTuiPromptPresence/syncView'

/** Why a `syncView` call was refused. Closed vocabulary, never inferred. */
export type PiTuiPromptPresenceRefusal =
  /** The caller is not the authenticated Owner peer, or its lifetime ended. */
  | 'owner-required'
  /** The viewed Session id is not a live ordinary Host Session/Agent pair. */
  | 'session-not-live'
  /** The supplied revision is not newer than the committed one for this Peer. */
  | 'stale-revision'
  /** The Host presence scope is stopping (its fiber is being disposed). */
  | 'scope-unavailable'

/** The `syncView` result: exactly one of applied/refused. */
export type PiTuiPromptPresenceSyncResult =
  | { readonly kind: 'applied'; readonly revision: number }
  | { readonly kind: 'refused'; readonly reason: PiTuiPromptPresenceRefusal }

/** The folded per-Turn voter answer for one exact Session (Host-internal). */
export interface PiTuiPromptVoterSnapshot {
  /** At least one current verified TUI viewer is showing this Session. */
  readonly eligible: boolean
  /** At least one such viewer's display preset is Focus (any-Focus-wins). */
  readonly focus: boolean
}

const SYNC_RESULT_LABEL = 'piTuiPromptPresence/syncView result'

const REFUSAL_REASONS: readonly PiTuiPromptPresenceRefusal[] = [
  'owner-required',
  'session-not-live',
  'stale-revision',
  'scope-unavailable',
]

/** The three selectable display presets (the wire vocabulary). */
const DISPLAY_PRESETS: readonly DisplayPreset[] = ['focus', 'compact', 'full']

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

/**
 * Validate one wire Session identity: a non-empty string, or `null` for "this
 * Peer currently views no Session". An empty string is NOT the null form — a
 * Client must say exactly which of the two it means.
 */
export function parsePresenceViewedSessionId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('piTuiPromptPresence syncView: viewedSessionId must be a non-empty string or null')
  }
  return value
}

/** Validate one wire display preset. */
export function parsePresenceDisplayPreset(value: unknown): DisplayPreset {
  if (typeof value === 'string' && (DISPLAY_PRESETS as readonly string[]).includes(value)) {
    return value as DisplayPreset
  }
  throw new TypeError(`piTuiPromptPresence syncView: displayPreset must be one of ${DISPLAY_PRESETS.join('|')}`)
}

/** Validate one monotonic Client revision (a positive safe integer). */
export function parsePresenceRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('piTuiPromptPresence syncView: revision must be a positive safe integer')
  }
  return value
}

/** Validate and detach one `syncView` result. */
export function parsePresenceSyncResult(value: unknown): PiTuiPromptPresenceSyncResult {
  const record = recordOf(value, SYNC_RESULT_LABEL)
  if (record.kind === 'applied') {
    exactKeys(record, ['kind', 'revision'], SYNC_RESULT_LABEL)
    return { kind: 'applied', revision: parsePresenceRevision(record.revision) }
  }
  if (record.kind === 'refused') {
    exactKeys(record, ['kind', 'reason'], SYNC_RESULT_LABEL)
    if (!REFUSAL_REASONS.includes(record.reason as PiTuiPromptPresenceRefusal)) {
      throw new TypeError(`${SYNC_RESULT_LABEL}: unknown refusal reason ${JSON.stringify(record.reason)}`)
    }
    return { kind: 'refused', reason: record.reason as PiTuiPromptPresenceRefusal }
  }
  throw new TypeError(`${SYNC_RESULT_LABEL}: unknown kind ${JSON.stringify(record.kind)}`)
}

/** The ONE wire codec per parameter (the Gateway parses PER PARAMETER). */
const SESSION_ID_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_PROMPT_PRESENCE_SYNC_VIEW_ENDPOINT}:viewedSessionId`,
  create: () => ({ parse: parsePresenceViewedSessionId }),
  decode: parsePresenceViewedSessionId,
}

const DISPLAY_PRESET_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_PROMPT_PRESENCE_SYNC_VIEW_ENDPOINT}:displayPreset`,
  create: () => ({ parse: parsePresenceDisplayPreset }),
  decode: parsePresenceDisplayPreset,
}

const REVISION_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_PROMPT_PRESENCE_SYNC_VIEW_ENDPOINT}:revision`,
  create: () => ({ parse: parsePresenceRevision }),
  decode: parsePresenceRevision,
}

const SYNC_RESULT_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_PROMPT_PRESENCE_SYNC_VIEW_ENDPOINT}:result`,
  create: () => ({ parse: parsePresenceSyncResult }),
  decode: parsePresenceSyncResult,
}

/** The ONE shared `syncView` descriptor both contributions derive from. */
export const PI_TUI_PROMPT_PRESENCE_SYNC_VIEW: InvocationDescriptor = {
  id: PI_TUI_PROMPT_PRESENCE_SYNC_VIEW_ENDPOINT,
  service: PI_TUI_PROMPT_PRESENCE_NAMESPACE,
  namespace: PI_TUI_PROMPT_PRESENCE_NAMESPACE,
  method: 'syncView',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'viewedSessionId', wire: 'viewedSessionId', source: 'json', codec: SESSION_ID_CODEC },
    { name: 'displayPreset', wire: 'displayPreset', source: 'json', codec: DISPLAY_PRESET_CODEC },
    { name: 'revision', wire: 'revision', source: 'json', codec: REVISION_CODEC },
  ],
  cancellation: { parameter: 'signal' },
  result: SYNC_RESULT_CODEC,
}

/** The `syncView` call result as the Client receives it. */
export type PiTuiPromptPresenceSyncCall = RemoteResult<PiTuiPromptPresenceSyncResult>

/** The mounted Client namespace slice this adapter consumes. */
export interface PiTuiPromptPresenceNamespace {
  syncView(
    viewedSessionId: string | null,
    displayPreset: DisplayPreset,
    revision: number,
    signal?: AbortSignal,
  ): Promise<PiTuiPromptPresenceSyncCall>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiPromptPresence/syncView': (
      viewedSessionId: string | null,
      displayPreset: DisplayPreset,
      revision: number,
      signal?: AbortSignal,
    ) => Promise<PiTuiPromptPresenceSyncCall>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiPromptPresence': {
      syncView: (
        viewedSessionId: string | null,
        displayPreset: DisplayPreset,
        revision: number,
        signal?: AbortSignal,
      ) => Promise<PiTuiPromptPresenceSyncCall>
    }
  }
}
