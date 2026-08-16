# Async failure & cancellation model

This is the contract that keeps the TUI's fire-and-forget work from leaking
unhandled rejections or misclassifying cancellations. It exists because a
bare `void somePromise()` in this codebase means the failure either crashes
nothing (silent), escapes to nowhere (unhandled rejection), or gets
misreported as a cancellation when it was a real failure.

## Diagnostics sink (`src/diag.ts`)

`ctx.logger` is invisible in this process (no exporter), so the TUI's own
diagnostics go to **stderr + `$DSH_HOME/logs/pi-tui-<pid>.log`** (env
`DSH_PI_TUI_LOG` / `DSH_PI_TUI_LOG_LEVEL`, default `info`). Keep new
lifecycle logging in diag, not just ctx.logger — a log line that only goes to
ctx.logger is a log line that never exists here.

## Detached tasks (`src/detached.ts`)

Rule: **never a bare `void somePromise()`**. Two entries, both taking a TASK
FACTORY that is invoked SYNCHRONOUSLY before the helper returns:

- `runDetached(label, () => task, opts)` — detached work with NO result
  consumer: settings writes, theme autodetect, skill refresh.
- `runOwned(label, () => task, { isCancellation?, onResult, onCancel, onError })`
  — result-consuming main flows: submit/steer dispatch, command execution,
  local commands, local-shell card settle, session switch, question flows,
  model-menu loads, external editor.

Why a synchronous factory: ownership actions (e.g. Ctrl+G's `stop()`) take
effect immediately, and a synchronous throw is converted to a rejection and
classified like any other failure — nothing escapes classification.

## The failure phases are distinct (the core trap)

1. **TASK phase** (factory throw / task rejection) — classifies
   cancellations using the error shape (`isCancellation`,
   `cancellationError(...)`) plus the task-local `isCancellation` predicate
   (use it when only the task knows it was cancelled:
   `() => localSignal.aborted`, `() => this.disposed`). Records DEBUG for
   cancellations, ERROR for failures.
2. **`onResult`** is the RESULT CONSUMER. Its sync/async failure is a
   PRIMARY failure — ERROR + `onError`, **never a cancellation**, regardless
   of error shape (even an AbortError) or task-local state, because the task
   already settled.
3. **`onCancel` / `onError`** are TERMINAL side-effect handlers and the
   task-local classifier. Their own sync/async failures land exactly once in
   the `${label} handler failed` sink, are never re-classified or repeated,
   and produce zero unhandled rejections. Thrown values are never mutated:
   primitives, null and frozen errors are carried by an internal wrapper.

## Error observation (`src/error-boundary.ts`)

Error observation is SYNC-TOTAL: describing any legal thrown value (hostile
Proxy/getter/coercion) can never make a chain reject. Honest limit: an
observer that spawns its OWN detached async work while being observed (e.g.
`void Promise.reject(...)` inside `toString`) is OUTSIDE the contract — do
not describe this module as a strict "any legal value, zero side effects"
guarantee.

## Lifecycle roots are equally total

Startup and exit (`src/index.ts` root catch, `src/exit.ts`) protect every
step individually (session read, diag, cleanup, warn, hint, exit), so no
throw can skip teardown or leak a rejection. `flushWithTimeout` returns a
deterministic `failed` outcome for any hostile rejection (never a misreported
`timed-out`), and the disabled-timeout path always settles.

## Where the contract is wired in

- Owned callbacks do CORRECTNESS FIRST (draft restore, card settle,
  controller release) and best-effort formatting/notify afterwards, all
  through the shared `safeErrorMessage`.
- UI-layer modules receive the owned entry by injection
  (`TuiAppEvents.runOwned`, `SubmenuDeps.runOwned`) — never their own bare
  `void`.
- The external-editor hook is a BOUND pair in `TuiAppEvents`:
  `openExternalEditor` requires `runOwned` (type union + constructor check),
  and the launch is SINGLE-FLIGHT with the ownership latch cleared in the
  outermost `finally` — a `stop`/`start` throw can never leave it stuck.

## The bare-`void` allowlist (and its static guard)

The ONLY bare-`void` exceptions are the terminal sinks inside
`src/detached.ts` (exempt **by filename** in `rules.test.ts` — the helpers'
own sinks need no marker) and the two lifecycle roots (startup in
`index.ts`, exit in `exit.ts`), which carry an `allowlist` comment on the
same line. `test/rules.test.ts` statically detects COMMON SINGLE-LINE
`void call()` discards (recursive over `src/`, with matcher self-tests). It
is deliberately NOT a substitute for review or a type-aware lint
(`@typescript-eslint/no-floating-promises`) — new hand-written `void` chains
in the detected forms fail the suite.
