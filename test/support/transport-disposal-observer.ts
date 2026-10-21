/**
 * The transport-disposal observer shared by the Remote runner suites.
 *
 * The transport's teardown is the release of its DOWNSTREAM owners — the
 * Client-UI subtree, the task watch, the backend runtime, the official
 * Client runtime and the Host additive runtime. The production disposer is
 * idempotent (`if (transportDisposed) return` BEFORE it reaches any of
 * them), so a repeated CALL of the disposer never reaches them and never
 * changes their counts: the counts are the teardown, not the calls. They are
 * also the counts that react to a REGRESSION of that production idempotence
 * — then a second call would reach the owners again, their counts would
 * become 2, and the assertions would fail.
 *
 * The observer separates two facts that a single counter cannot:
 *
 *  - the CALLS: the owner's disposer was reached. A call is not a release.
 *  - the RELEASES: the owner's disposer actually COMPLETED. A disposer that
 *    throws, rejects or returns early has not released the owner, and a
 *    count that was incremented before the call would wrongly report a
 *    release that never happened. The release count is therefore taken when
 *    the disposer SETTLES SUCCESSFULLY.
 *
 * A disposer that fails is NOT swallowed here: the failure propagates to the
 * caller, and the release count stays at its previous value, so a broken
 * teardown is visible both as a failure and as a missing release.
 *
 * @module @xmoon76/dsh-pi-tui/transport-disposal-observer
 */

/** The transport's downstream owners — the releases that ARE the teardown. */
export const TRANSPORT_TEARDOWN_OWNER_NAMES = [
  'clientUi',
  'task',
  'backendRuntime',
  'client',
  'host',
] as const

/** One downstream owner's name. */
export type TransportTeardownOwnerName = typeof TRANSPORT_TEARDOWN_OWNER_NAMES[number]

/** The aggregate shape the observer needs (the Remote application runtime). */
export interface TransportTeardownAggregate {
  readonly clientUi: { dispose(): Promise<void> }
  readonly presentation: { readonly task: { dispose(): Promise<void> | void } }
  readonly backendRuntime: { dispose(): Promise<void> | void }
  readonly wire: {
    readonly client: { dispose(): Promise<void> }
    readonly host: { dispose(): Promise<void> }
  }
  readonly selected: { disposeTransport(): Promise<void> }
}

/** The observed transport teardown. */
export interface TransportDisposalObserver {
  /** The disposer CALLS, real or idempotent no-op. */
  readonly calls: () => number
  /** Each downstream owner's CALL count, by owner name. */
  readonly ownerCalls: Readonly<Record<TransportTeardownOwnerName, number>>
  /** Each downstream owner's COMPLETED release count, by owner name. */
  readonly ownerReleases: Readonly<Record<TransportTeardownOwnerName, number>>
  /** The observed order of the teardown markers. */
  readonly observed: readonly string[]
}

/**
 * Install the observer on the aggregate.
 *
 * The `observed` array receives the `transport-dispose` marker when the
 * disposer is called, so the cases can assert the production order.
 */
export function observeTransportDisposal(
  aggregate: TransportTeardownAggregate,
  observed: string[],
): TransportDisposalObserver {
  const owners: ReadonlyArray<{ readonly name: TransportTeardownOwnerName; readonly owner: object; readonly key: string }> = [
    { name: 'clientUi', owner: aggregate.clientUi, key: 'dispose' },
    { name: 'task', owner: aggregate.presentation.task, key: 'dispose' },
    { name: 'backendRuntime', owner: aggregate.backendRuntime, key: 'dispose' },
    { name: 'client', owner: aggregate.wire.client, key: 'dispose' },
    { name: 'host', owner: aggregate.wire.host, key: 'dispose' },
  ]
  const ownerCalls = {} as Record<TransportTeardownOwnerName, number>
  const ownerReleases = {} as Record<TransportTeardownOwnerName, number>
  for (const { name, owner, key } of owners) {
    ownerCalls[name] = 0
    ownerReleases[name] = 0
    const record = owner as unknown as Record<string, unknown>
    const original = record[key] as (...args: unknown[]) => Promise<void> | void
    record[key] = (...args: unknown[]): Promise<void> | void => {
      ownerCalls[name] += 1
      const result = original.apply(owner, args)
      if (result === undefined || typeof (result as Promise<void>).then !== 'function') {
        // A synchronous disposer that returned normally completed its work.
        ownerReleases[name] += 1
        return result
      }
      // An asynchronous disposer COMPLETES only when it settles: a rejection
      // is a failed release, and the count must not claim otherwise. The
      // rejection is NOT swallowed — it travels to the caller.
      return (result as Promise<void>).then(
        (value: void) => {
          ownerReleases[name] += 1
          return value
        },
      )
    }
  }
  const selected = aggregate.selected
  const originalDispose = selected.disposeTransport.bind(selected)
  let calls = 0
  selected.disposeTransport = async (): Promise<void> => {
    calls += 1
    observed.push('transport-dispose')
    await originalDispose()
  }
  return {
    calls: () => calls,
    ownerCalls,
    ownerReleases,
    observed,
  }
}

/**
 * The assertion for "the transport was torn down exactly once": every
 * downstream owner was REACHED once and RELEASED once.
 *
 * The per-owner shape matters: a total cannot tell "one owner twice, one
 * owner never" from "every owner once".
 */
export function assertTransportTeardownOnce(
  observer: TransportDisposalObserver,
  message: string,
): void {
  const expected = Object.fromEntries(
    TRANSPORT_TEARDOWN_OWNER_NAMES.map(name => [name, 1]),
  ) as Record<TransportTeardownOwnerName, number>
  const released = Object.fromEntries(
    TRANSPORT_TEARDOWN_OWNER_NAMES.map(name => [name, observer.ownerReleases[name]]),
  ) as Record<TransportTeardownOwnerName, number>
  const called = Object.fromEntries(
    TRANSPORT_TEARDOWN_OWNER_NAMES.map(name => [name, observer.ownerCalls[name]]),
  ) as Record<TransportTeardownOwnerName, number>
  const same = (actual: Record<TransportTeardownOwnerName, number>): boolean =>
    TRANSPORT_TEARDOWN_OWNER_NAMES.every(name => actual[name] === expected[name])
  // The RELEASES are checked first: a disposer that failed released nothing,
  // and that is the more important fact than the call that reached it.
  if (!same(released)) {
    throw new Error(`${message}\n  owner releases: ${JSON.stringify(released)}\n  expected:       ${JSON.stringify(expected)}`)
  }
  if (!same(called)) {
    throw new Error(`${message}\n  owner calls:    ${JSON.stringify(called)}\n  expected calls: ${JSON.stringify(expected)}`)
  }
}
