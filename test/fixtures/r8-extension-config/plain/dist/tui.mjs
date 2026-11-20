/** R8-E PR-1 native negative control's own `./tui` module (no dshPiTui opt-in). */
import { appendFileSync } from 'node:fs'

const sentinel = process.env.R8_EXTENSION_CONFIG_SENTINEL

export const name = 'r8-pr1-fixture-plain-tui'

export function apply(ctx, config) {
  void ctx
  void config
}

if (sentinel !== undefined && sentinel !== '') {
  appendFileSync(sentinel, `${JSON.stringify({ event: 'plain-tui-import', package: '@r8-pr1-fixture/plain', pid: process.pid })}\n`)
}
