/** Internal owner for one Client's eligible continued Questions. */
export interface NativeContinuedGenerationSource {
  getSnapshot(): object | undefined
  subscribe(listener: () => void): () => void
}

export interface NativeContinuedQuestionHandle {
  readonly sessionId: string
  readonly isClosed: boolean
  bindingIdentity(): object
  isCurrentBinding(): boolean
  continuedEligible(callId: string): boolean
  observeUserQuestions(listener: (value: unknown) => void): () => void
}

export interface NativeContinuedQuestionCall {
  readonly callId: string
  readonly questions: unknown
  readonly state: 'open' | 'continued'
}

export interface NativeContinuedQuestionProjection {
  readonly active: readonly NativeContinuedQuestionCall[]
}

export interface NativeContinuedDeliveryReservation {
  readonly sessionId: string
  readonly binding: object
  readonly callId: string
  readonly generation: object | undefined
  readonly controller: AbortController
}

export interface NativeContinuedQuestionReceiverOptions {
  readonly generation: NativeContinuedGenerationSource
  readonly handles: Set<NativeContinuedQuestionHandle>
  readonly handlesBySession: Map<string, Set<NativeContinuedQuestionHandle>>
  readonly handleListeners: Set<() => void>
  readonly isClosed: () => boolean
  readonly parseProjection: (value: unknown) => NativeContinuedQuestionProjection
  readonly onInvalidProjection: (error: unknown) => void
  readonly onOffer: (reservation: NativeContinuedDeliveryReservation, call: NativeContinuedQuestionCall) => boolean
}

export interface NativeContinuedQuestionReceiver {
  reconcile(): void
  dispose(): void
}

/**
 * One exact-binding/native-callId owner. A projection event is the only
 * authority to offer; a generation or retention change revokes without
 * replaying a stale projection.
 */
export function createNativeContinuedQuestionReceiver(
  options: NativeContinuedQuestionReceiverOptions,
): NativeContinuedQuestionReceiver {
  let disposed = false
  const watched = new Map<NativeContinuedQuestionHandle, () => void>()
  const deliveries = new Map<string, NativeContinuedDeliveryReservation>()
  const keyOf = (sessionId: string, callId: string): string => `${sessionId}\u0000${callId}`
  const currentBindingHandle = (sessionId: string, binding: object): NativeContinuedQuestionHandle | undefined =>
    [...(options.handlesBySession.get(sessionId) ?? [])]
      .find(handle => !handle.isClosed && handle.bindingIdentity() === binding && handle.isCurrentBinding())

  const revokeInvalid = (): void => {
    for (const [key, reservation] of deliveries) {
      const handle = currentBindingHandle(reservation.sessionId, reservation.binding)
      if (!options.isClosed() && !disposed && handle !== undefined
        && Object.is(reservation.generation, options.generation.getSnapshot())
        && handle.continuedEligible(reservation.callId)) continue
      reservation.controller.abort(new Error('native-client: continued Question ownership revoked'))
      deliveries.delete(key)
    }
  }

  const offerContinued = (
    sessionId: string,
    binding: object,
    call: NativeContinuedQuestionCall,
  ): void => {
    revokeInvalid()
    if (disposed || options.isClosed() || call.state !== 'continued') return
    const key = keyOf(sessionId, call.callId)
    if (deliveries.has(key)) return
    const generation = options.generation.getSnapshot()
    const handle = currentBindingHandle(sessionId, binding)
    if (generation === undefined || handle === undefined || !handle.continuedEligible(call.callId)) return
    const reservation: NativeContinuedDeliveryReservation = {
      sessionId,
      binding,
      callId: call.callId,
      generation,
      controller: new AbortController(),
    }
    // Reserve before any owner callback can re-enter close/status.
    deliveries.set(key, reservation)
    const started = options.onOffer(reservation, call)
    if (!started || disposed) {
      reservation.controller.abort(new Error('native-client: continued Question delivery was not started'))
      deliveries.delete(key)
    }
  }

  const reconcileProjection = (sessionId: string, binding: object, value: unknown): void => {
    if (disposed || options.isClosed() || value === undefined) return
    let projection: NativeContinuedQuestionProjection
    try {
      projection = options.parseProjection(value)
    } catch (error) {
      options.onInvalidProjection(error)
      return
    }
    for (const call of projection.active) offerContinued(sessionId, binding, call)
  }

  const watchHandle = (handle: NativeContinuedQuestionHandle): void => {
    if (watched.has(handle)) return
    watched.set(handle, handle.observeUserQuestions(value => {
      if (!handle.isClosed) reconcileProjection(handle.sessionId, handle.bindingIdentity(), value)
    }))
  }

  const syncHandles = (): void => {
    for (const [handle, off] of watched) {
      if (!handle.isClosed) continue
      off()
      watched.delete(handle)
    }
    for (const handle of options.handles) watchHandle(handle)
    revokeInvalid()
  }

  const offGeneration = options.generation.subscribe(() => { revokeInvalid() })
  options.handleListeners.add(syncHandles)
  syncHandles()

  return {
    reconcile(): void {
      if (!disposed) revokeInvalid()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      offGeneration()
      options.handleListeners.delete(syncHandles)
      for (const off of watched.values()) off()
      watched.clear()
      for (const reservation of deliveries.values()) {
        reservation.controller.abort(new Error('native-client: interaction receivers disposed'))
      }
      deliveries.clear()
    },
  }
}
