/**
 * Lazy module boundary for the experimental Remote runtime (M3-1).
 *
 * M3-4: this is the lazy Remote composition boundary used by the internal
 * application runtime-selection seam (`app/bootstrap.ts`). It is NOT a
 * public/user backend selector — there is no CLI option, config field, env
 * var or cordis.patch backend row that selects Remote, and normal package
 * `apply()` stays Direct.
 *
 * It owns the ONE value dynamic import into the experimental Remote
 * composition — `app/remote/runtime.ts`, the single entry module that also
 * statically re-exports the application-runtime aggregate — so
 * `src/startup.ts` and its static import graph can never reach the Remote
 * graph, and the frozen "ONE dynamic edge into app/remote/**" contract stays
 * intact (ONE import expression, ONE target; the architecture gate enforces
 * exactly this owner, this single expression and this target).
 *
 * The loader results are intentionally inferred: a static type import of the
 * Remote composition would re-create the static edge this boundary exists to
 * prevent. Consumers describe the results with local structural types.
 *
 * @module runtime/backend-loader
 */

/**
 * Load the experimental Remote composition module (dynamic, non-static
 * edge). The module carries BOTH composition entries: the wire/backend
 * runtime constructors and the statically re-exported application-runtime
 * aggregate. The dynamic import happens exactly ONCE per process (cached);
 * both loaders below share it.
 */
const loadRemoteComposition = () => import('../app/remote/runtime.ts')

/** Load the experimental Remote composition module (the single dynamic edge). */
export function loadExperimentalRemoteRuntime() {
  return loadRemoteComposition()
}

/**
 * Load the Remote application runtime aggregate through the SAME single
 * dynamic edge: `app/remote/runtime.ts` statically re-exports
 * `createRemoteApplicationRuntime` (an intra-`app/remote` static edge, never
 * a second dynamic boundary).
 */
export function loadRemoteApplicationRuntime() {
  return loadRemoteComposition().then(module => ({
    createRemoteApplicationRuntime: module.createRemoteApplicationRuntime,
  }))
}
