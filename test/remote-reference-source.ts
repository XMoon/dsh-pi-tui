/**
 * Test double for the alpha2 Client reference lifetime.
 *
 * An id is "known" only while at least one reference is held, and `binding()`
 * borrows the live generation without extending it — the same borrow-only rule
 * the official `ClientSessions` enforces. Tests use this instead of an
 * ad-hoc `{ binding }` object so the generation-fencing behavior under test is
 * the real alpha2 one.
 */

import type {
  RemoteReferenceSessionsSource,
  RemoteSessionReferenceLike,
  TuiSessionReferenceSource,
} from '../src/runtime/remote/session-reference.ts'

export interface RetainRecord {
  readonly target: string
  readonly source: TuiSessionReferenceSource
}

export interface RetainableSource<B extends object> {
  readonly source: RemoteReferenceSessionsSource<B>
  readonly retains: RetainRecord[]
  readonly releases: string[]
  /** The currently-retained generation, or undefined once fully released. */
  live(id: string): B | undefined
  /** Install/replace one id's generation; absent input drops it entirely. */
  setBinding(id: string, binding: B | undefined): void
  /** Release one EXTERNALLY-held reference (the navigation owner's), modeling
   * an owner handoff while an operation still pins the generation. Not counted
   * in `releases`, which tracks references this double created. */
  releaseHeld(id: string): void
}

/** Build a borrow-only sessions double whose generations live only while
 * retained. Initial entries model a generation already held by a navigation
 * owner (reference count 1). */
export function retainableSource<B extends object>(
  initial: Readonly<Record<string, B>> = {},
): RetainableSource<B> {
  const bindings = new Map<string, B>(Object.entries(initial))
  const counts = new Map<string, number>(Object.keys(initial).map(id => [id, 1]))
  const retains: RetainRecord[] = []
  const releases: string[] = []
  const source: RemoteReferenceSessionsSource<B> = {
    binding: id => (counts.get(id) ?? 0) > 0 ? bindings.get(id) : undefined,
    retain: (target, options): RemoteSessionReferenceLike => {
      const id = String(target)
      retains.push({ target: id, source: options.source })
      options.signal?.throwIfAborted()
      const binding = bindings.get(id)
      if (binding === undefined) throw new Error(`sessions.retain: unknown session ${id}`)
      counts.set(id, (counts.get(id) ?? 0) + 1)
      let held = true
      return {
        sessionId: id,
        get binding(): unknown {
          if (!held) throw new Error(`Session reference "${id}" is released`)
          return binding
        },
        ready: Promise.resolve(binding),
        release: (): void => {
          if (!held) return
          held = false
          releases.push(id)
          const next = (counts.get(id) ?? 1) - 1
          if (next <= 0) counts.delete(id)
          else counts.set(id, next)
        },
      }
    },
  }
  return {
    source,
    retains,
    releases,
    live: id => source.binding(id),
    releaseHeld(id) {
      const next = (counts.get(id) ?? 0) - 1
      if (next <= 0) counts.delete(id)
      else counts.set(id, next)
    },
    setBinding(id, binding) {
      if (binding === undefined) {
        bindings.delete(id)
        counts.delete(id)
        return
      }
      bindings.set(id, binding)
      if ((counts.get(id) ?? 0) === 0) counts.set(id, 1)
    },
  }
}
