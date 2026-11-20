/**
 * R8-E PR-1 native negative control's Host row.
 *
 * It imports the package's own non-opted-in `./tui` module: an author sample
 * the native DSH Loader is free to run. PiTui must neither block it nor count
 * the import as a PiTui-created Host UI entry; the sentinel records both facts
 * separately.
 */
import { appendFileSync } from 'node:fs'
import './tui.mjs'

const sentinel = process.env.R8_EXTENSION_CONFIG_SENTINEL

export const name = 'r8-pr1-fixture-plain-host'

export function apply(ctx, config) {
  void ctx
  void config
  if (sentinel === undefined || sentinel === '') return
  appendFileSync(sentinel, `${JSON.stringify({ event: 'host-apply', package: '@r8-pr1-fixture/plain', pid: process.pid })}\n`)
}
