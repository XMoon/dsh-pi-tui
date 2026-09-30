/**
 * Lazy module boundary for the experimental Remote runtime (M3-1).
 *
 * M3-4: this is the lazy Remote composition boundary used by the internal
 * application runtime-selection seam (`app/bootstrap.ts`). It is NOT a
 * public/user backend selector — there is no CLI option, config field, env
 * var or cordis.patch backend row that selects Remote, and normal package
 * `apply()` stays Direct.
 *
 * It owns the only value dynamic imports of the experimental Remote
 * composition, so `src/startup.ts` and its static import graph can never
 * reach the Remote graph — the architecture gate enforces exactly these
 * owners and targets.
 *
 * The loader results are intentionally inferred: a static type import of the
 * Remote composition would re-create the static edge this boundary exists to
 * prevent. Consumers describe the results with local structural types.
 *
 * @module runtime/backend-loader
 */

/** Load the experimental Remote composition module (dynamic, non-static edge). */
export function loadExperimentalRemoteRuntime() {
  return import('../app/remote/runtime.ts')
}

/** Load the Remote application runtime aggregate (dynamic, non-static edge). */
export function loadRemoteApplicationRuntime() {
  return import('../app/remote/application-runtime.ts')
}
