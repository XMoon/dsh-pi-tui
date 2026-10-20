/**
 * The shared APP-LIFECYCLE teardown guard.
 *
 * Most TUI tests start a `TuiApp` and must not leak it into the next test
 * (the process slot is process-global). The guard is a small, repeated
 * implementation of that rule: it disposes every started app after each
 * test, and it disposes them in a way that a THROWING dispose does not
 * abort the remaining disposals.
 *
 * The guard's SEMANTICS are fixed by its first consumer and must not
 * change silently:
 *
 *   - a DISPOSED app is skipped (`isDisposed()` is the app's own fact);
 *   - a dispose that THROWS is swallowed, so one broken app cannot leave
 *     the others undisposed;
 *   - the app is REMOVED from the set BEFORE it is disposed, so a dispose
 *     that re-enters the guard cannot double-dispose it;
 *   - the iteration is over a COPY, so disposing an app may add to the set
 *     without affecting the current pass.
 *
 * A test that needs a DIFFERENT teardown semantics (an ASYNC disposer, a
 * failure that must be AGGREGATED rather than swallowed) keeps its own
 * local implementation: the variants are deliberately not unified, because
 * unifying them would change what a failure means.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/app-lifecycle-guard
 */

/**
 * The app's own lifetime fact. The guard reads it, so the type stays
 * structural: a consumer's app only has to answer `isDisposed()` and
 * `dispose()`.
 */
export interface DisposableApp {
  isDisposed(): boolean
  dispose(): void
}

/**
 * Create the teardown guard for a set of apps.
 *
 * The returned `started` set is the registry the test adds its apps to; the
 * returned `disposeAll` is the teardown itself.
 */
export function createAppLifecycleGuard<App extends DisposableApp>(): {
  readonly started: Set<App>
  disposeAll(): void
} {
  const started = new Set<App>()
  return {
    started,
    disposeAll() {
      for (const app of [...started]) {
        // REMOVE first: a dispose that re-enters this guard must not
        // dispose the same app twice.
        started.delete(app)
        if (app.isDisposed()) continue
        try {
          app.dispose()
        } catch {
          // A THROWING dispose must not abort the remaining disposals: one
          // broken app cannot leave the others undisposed.
        }
      }
    },
  }
}
