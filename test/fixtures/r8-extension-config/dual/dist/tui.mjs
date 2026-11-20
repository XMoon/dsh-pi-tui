/** R8-E PR-1 Dual fixture's Client-only `./tui` entry (never a Host row). */
import { appendFileSync } from 'node:fs'

const sentinel = process.env.R8_EXTENSION_CONFIG_SENTINEL

function record(event) {
  if (sentinel === undefined || sentinel === '') return
  appendFileSync(sentinel, `${JSON.stringify({ event, package: '@r8-pr1-fixture/dual', pid: process.pid })}\n`)
}

record('tui-import')

export const name = 'r8-pr1-fixture-dual-tui'

export function apply(ctx, config) {
  void ctx
  void config
  record('tui-apply')
}
