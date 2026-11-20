/**
 * R8-E UI-only fixture B's Client-local `./tui` entry.
 *
 * The qualification Host must never import or apply it: any import, apply,
 * Footer/Command execution or disposal appends one JSONL line to the sentinel
 * file the runner owns, so "0 lines" is a real observation rather than an
 * absent-log inference.
 */
import { appendFileSync } from 'node:fs'

const sentinel = process.env.R8_EXTENSION_CONFIG_SENTINEL
const fault = process.env.R8_EXTENSION_CLIENT_FAULT

function record(event, extra = {}) {
  if (sentinel === undefined || sentinel === '') return
  appendFileSync(sentinel, `${JSON.stringify({ event, package: '@r8-pr1-fixture/b', pid: process.pid, ...extra })}\n`)
}

if (fault === 'b-import') throw new Error('r8-extension-client-b-import-fault')
record('tui-import')

export const name = 'r8-pr1-fixture-b-tui'
export const inject = ['piTuiExtensions']

export function apply(ctx, config) {
  if (fault === 'b-apply') throw new Error('r8-extension-client-b-apply-fault')
  void config
  record('tui-apply', { config: JSON.stringify(config ?? null) })
  ctx.effect(() => () => record('tui-dispose'))
  const service = ctx.piTuiExtensions
  service.register('chrome.footer.status', {
    id: 'r8-pr1-fixture-b-footer',
    order: 20,
    description: 'R8 fixture B footer',
  }, { spans: [{ text: 'R8-B-LIVE', tone: 'success' }] })
  service.registerCommand({
    id: 'r8-pr1-fixture-b-command',
    name: 'r8-b',
    description: 'R8 fixture B command',
    sessionless: true,
    handler: () => {
      record('command-call')
      return { kind: 'success', text: 'r8-b' }
    },
  })
}
