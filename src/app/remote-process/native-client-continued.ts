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
  continuedCalls(): readonly { readonly callId: string; readonly questions: unknown; readonly state: 'open' | 'continued' }[]
  continuedEligible(callId: string): boolean
  observeOfficialQuestionFacts(listener: () => void): () => void
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
  readonly onInvalidProjection: (error: unknown) => void
  readonly onOffer: (reservation: NativeContinuedDeliveryReservation, callId: string, questions: unknown) => boolean
}

export interface NativeContinuedQuestionReceiver {
  reconcile(): void
  dispose(): void
}

/**
 * One exact-binding/native-callId owner. Both official question and inbox
 * faces are live inputs; revocation always precedes any new offer.
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
      const current = !options.isClosed() && !disposed && handle !== undefined
        && Object.is(reservation.generation, options.generation.getSnapshot())
        && handle.continuedEligible(reservation.callId)
      // Remove ownership BEFORE aborting: a callback re-entry must not delete
      // a successor reservation through this stale key.
      if (current) continue
      deliveries.delete(key)
      reservation.controller.abort(new Error('native-client: continued Question ownership revoked'))
    }
  }

  const offerContinued = (
    handle: NativeContinuedQuestionHandle,
    callId: string,
    questions: unknown,
  ): void => {
    if (disposed || options.isClosed()) return
    const binding = handle.bindingIdentity()
    const key = keyOf(handle.sessionId, callId)
    if (deliveries.has(key)) return
    const generation = options.generation.getSnapshot()
    if (generation === undefined || !handle.continuedEligible(callId)) return
    const reservation: NativeContinuedDeliveryReservation = {
      sessionId: handle.sessionId,
      binding,
      callId,
      generation,
      controller: new AbortController(),
    }
    deliveries.set(key, reservation)
    const started = options.onOffer(reservation, callId, questions)
    if (!started || disposed) {
      if (deliveries.get(key) === reservation) deliveries.delete(key)
      reservation.controller.abort(new Error('native-client: continued Question delivery was not started'))
    }
  }

  const reconcileHandle = (handle: NativeContinuedQuestionHandle): void => {
    if (disposed || options.isClosed() || handle.isClosed) return
    revokeInvalid()
    let calls: readonly { readonly callId: string; readonly questions: unknown; readonly state: 'open' | 'continued' }[]
    try {
      calls = handle.continuedCalls()
    } catch (error) {
      options.onInvalidProjection(error)
      return
    }
    for (const call of calls) {
      if (call.state === 'continued') offerContinued(handle, call.callId, call.questions)
    }
  }

  const reconcileAll = (): void => {
    revokeInvalid()
    for (const handle of options.handles) reconcileHandle(handle)
  }

  const watchHandle = (handle: NativeContinuedQuestionHandle): void => {
    if (watched.has(handle)) return
    // Claim ownership before subscribing: an initial notification can re-enter
    // handle sync through a public close and must not double-register faces.
    watched.set(handle, () => {})
    watched.set(handle, handle.observeOfficialQuestionFacts(() => { reconcileHandle(handle) }))
  }

  const syncHandles = (): void => {
    for (const [handle, off] of watched) {
      if (!handle.isClosed) continue
      off()
      watched.delete(handle)
    }
    for (const handle of options.handles) watchHandle(handle)
    reconcileAll()
  }

  const offGeneration = options.generation.subscribe(() => { revokeInvalid() })
  options.handleListeners.add(syncHandles)
  syncHandles()

  return {
    reconcile(): void {
      if (!disposed) reconcileAll()
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
