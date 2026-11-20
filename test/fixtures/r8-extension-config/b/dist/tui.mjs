/**
 * R8-E PR-1 fixture B's Client-only `./tui` entry.
 *
 * The qualification Host must never import or apply it: any import or apply
 * appends one JSONL line to the sentinel file the runner owns, so "0 lines" is
 * a real observation rather than an absent-log inference.
 */
import { appendFileSync } from 'node:fs'

const sentinel = process.env.R8_EXTENSION_CONFIG_SENTINEL

function record(event) {
  if (sentinel === undefined || sentinel === '') return
  appendFileSync(sentinel, `${JSON.stringify({ event, package: '@r8-pr1-fixture/b', pid: process.pid })}\n`)
}

record('tui-import')

export const name = 'r8-pr1-fixture-b-tui'

export function apply(ctx, config) {
  void ctx
  void config
  record('tui-apply')
}
