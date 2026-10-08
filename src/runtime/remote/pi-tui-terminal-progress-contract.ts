/**
 * The private `piTuiTerminalProgress` Remote STREAM contract: ONE handwritten
 * invocation descriptor that BOTH the Host service and the Client contribution
 * derive from, so a namespace/method/parameter/frame drift is impossible by
 * construction.
 *
 * ```text
 * endpoint   @xmoon76/dsh-pi-tui#piTuiTerminalProgress/watch
 * service    piTuiTerminalProgress      (Host Cordis service key)
 * namespace  piTuiTerminalProgress      (wire namespace)
 * method     watch(sessionId, signal)
 * mode       stream
 * result     PiTuiTerminalProgressFrame (one frame per yielded Host item)
 * ```
 *
 * The descriptor is registered EXPLICITLY on the Host (`ctx.typert.register`)
 * and mounted EXPLICITLY on the Client (`ctx.remote.$mount`) — never discovered
 * from source-mode decorators, never generated, never a second literal.
 *
 * DOWNLINK CODEC HONESTY (R0 probe evidence, see
 * `test/remote-terminal-progress-wire.test.ts`): the Client stream handle
 * (`ClientStreamHandle.iterate()` in `@deepseek-ai/dsh-api-gateway`) yields
 * every downlink item RAW — `yield next.value` — so the `result` codec is NOT
 * applied to stream items (only unary results are decoded, in `invoke()`). The
 * Host stream path (`openStream()` + `cancellableStream()`) likewise forwards
 * the Host generator's items unwrapped. Therefore the Client-side source MUST
 * validate each frame structurally itself before trusting it (this module
 * exports `parsePiTuiTerminalProgressFrame` for exactly that), and a frame that
 * violates this strict codec travels to the Client unchanged.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-terminal-progress-contract
 */

import type {
  InvocationDescriptor,
  RemoteStreamHandle,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

/** The npm package that owns the private Remote methods. */
export const PI_TUI_TERMINAL_PROGRESS_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The wire namespace (and Host Cordis service key) of the private stream. */
export const PI_TUI_TERMINAL_PROGRESS_NAMESPACE = 'piTuiTerminalProgress'

/** The private method's stable endpoint identity. */
export const PI_TUI_TERMINAL_PROGRESS_WATCH_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiTerminalProgress/watch'

/**
 * One terminal-progress fact crossing the private wire. `snapshot` is the
 * authoritative read the Host answers a fresh `watch` with; `update` is one
 * real subsequent Host-side change. `hostEpoch` identifies one Host plugin
 * instance, `agentEpoch` one Agent lifetime inside that Host, and `revision`
 * fences updates within `hostEpoch + sessionId`.
 */
export interface PiTuiTerminalProgressFrame {
  readonly kind: 'snapshot' | 'update'
  readonly sessionId: string
  readonly hostEpoch: string
  readonly agentEpoch: number
  readonly revision: number
  readonly running: boolean
  readonly outcome: 'idle' | 'done' | 'error'
}

/** One strict JSON codec that validates a wire string. */
function stringCodec(typeSymbol: string): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: (value: unknown): string => {
        if (typeof value !== 'string') throw new TypeError(`${typeSymbol}: the wire value must be a string`)
        return value
      },
    }),
  }
}

/**
 * Validate and detach one `PiTuiTerminalProgressFrame`. This is the ONE
 * structural validator of the frame shape: the descriptor's `result` codec
 * uses it, and the R2 Client source must call it on every downlink item because
 * the framework does not (see the module JSDoc).
 */
export function parsePiTuiTerminalProgressFrame(value: unknown): PiTuiTerminalProgressFrame {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('piTuiTerminalProgress/watch: the frame must be an object')
  }
  const frame = value as {
    readonly kind?: unknown
    readonly sessionId?: unknown
    readonly hostEpoch?: unknown
    readonly agentEpoch?: unknown
    readonly revision?: unknown
    readonly running?: unknown
    readonly outcome?: unknown
  }
  if (frame.kind !== 'snapshot' && frame.kind !== 'update') {
    throw new TypeError('piTuiTerminalProgress/watch: the frame kind must be snapshot or update')
  }
  if (typeof frame.sessionId !== 'string') {
    throw new TypeError('piTuiTerminalProgress/watch: the frame needs a string sessionId')
  }
  if (typeof frame.hostEpoch !== 'string') {
    throw new TypeError('piTuiTerminalProgress/watch: the frame needs a string hostEpoch')
  }
  if (typeof frame.agentEpoch !== 'number') {
    throw new TypeError('piTuiTerminalProgress/watch: the frame needs a numeric agentEpoch')
  }
  if (typeof frame.revision !== 'number') {
    throw new TypeError('piTuiTerminalProgress/watch: the frame needs a numeric revision')
  }
  if (typeof frame.running !== 'boolean') {
    throw new TypeError('piTuiTerminalProgress/watch: the frame needs a boolean running')
  }
  if (frame.outcome !== 'idle' && frame.outcome !== 'done' && frame.outcome !== 'error') {
    throw new TypeError('piTuiTerminalProgress/watch: the frame outcome must be idle, done or error')
  }
  return {
    kind: frame.kind,
    sessionId: frame.sessionId,
    hostEpoch: frame.hostEpoch,
    agentEpoch: frame.agentEpoch,
    revision: frame.revision,
    running: frame.running,
    outcome: frame.outcome,
  }
}

const PI_TUI_TERMINAL_PROGRESS_FRAME_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@xmoon76/dsh-pi-tui#piTuiTerminalProgress/watch:frame',
  create: () => ({ parse: parsePiTuiTerminalProgressFrame }),
  decode: parsePiTuiTerminalProgressFrame,
}

/**
 * The ONE shared invocation descriptor both contributions derive from. The
 * Host registers this exact object; the Client mounts this exact object.
 */
export const PI_TUI_TERMINAL_PROGRESS_WATCH: InvocationDescriptor = {
  id: PI_TUI_TERMINAL_PROGRESS_WATCH_ENDPOINT,
  service: PI_TUI_TERMINAL_PROGRESS_NAMESPACE,
  namespace: PI_TUI_TERMINAL_PROGRESS_NAMESPACE,
  method: 'watch',
  mode: 'stream',
  invocation: { kind: 'direct' },
  parameters: [
    {
      name: 'sessionId',
      wire: 'sessionId',
      source: 'json',
      codec: stringCodec('@xmoon76/dsh-pi-tui#piTuiTerminalProgress/watch:sessionId'),
    },
  ],
  cancellation: { parameter: 'signal' },
  result: PI_TUI_TERMINAL_PROGRESS_FRAME_CODEC,
}

/*
 * The Host/Client contributions are NOT declared here: rc.2 admits exactly one
 * contribution per package identity, so the package's single contribution —
 * this descriptor together with the file-reference one — lives in
 * `pi-tui-remote-contribution.ts`.
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiTerminalProgress/watch': (
      sessionId: string,
      signal?: AbortSignal,
    ) => RemoteStreamHandle<PiTuiTerminalProgressFrame, never>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiTerminalProgress': {
      watch: (
        sessionId: string,
        signal?: AbortSignal,
      ) => RemoteStreamHandle<PiTuiTerminalProgressFrame, never>
    }
  }
}
