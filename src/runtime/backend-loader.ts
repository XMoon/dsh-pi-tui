/**
 * Lazy module boundary for the experimental Remote runtime (M3-1).
 *
 * This is a lazy module boundary ONLY: it is not a product backend selector
 * and nothing in normal startup calls it (`BackendKind` stays `'direct'`).
 * It owns the only value dynamic import of the experimental app runtime, so
 * `src/startup.ts` and its static import graph can never reach the Remote
 * composition — the architecture gate enforces exactly this owner.
 *
 * The loader result is intentionally inferred: a static type import of the
 * Remote composition would re-create the static edge this boundary exists to
 * prevent. Consumers describe the result with a local structural type.
 *
 * @module runtime/backend-loader
 */

/** Load the experimental Remote composition module (dynamic, non-static edge). */
export function loadExperimentalRemoteRuntime() {
  return import('../app/remote/runtime.ts')
}
