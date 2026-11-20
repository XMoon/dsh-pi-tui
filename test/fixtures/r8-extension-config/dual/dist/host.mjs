/**
 * R8-E PR-1 Dual fixture's real Host row.
 *
 * The native DSH Loader executes it as ordinary Host business: it publishes
 * no service, watches nothing and records its own apply in the runner's
 * sentinel so the qualification can prove the row really ran.
 */
import { appendFileSync } from 'node:fs'

const sentinel = process.env.R8_EXTENSION_CONFIG_SENTINEL

export const name = 'r8-pr1-fixture-dual-host'

export function apply(ctx, config) {
  void ctx
  void config
  if (sentinel === undefined || sentinel === '') return
  appendFileSync(sentinel, `${JSON.stringify({ event: 'host-apply', package: '@r8-pr1-fixture/dual', pid: process.pid })}\n`)
}
