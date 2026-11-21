/** R8-E Dual fixture's Client-only `./tui` entry (never a Host row). */
import { appendFileSync } from 'node:fs'

const sentinel = process.env.R8_EXTENSION_CONFIG_SENTINEL

function record(event, extra = {}) {
  if (sentinel === undefined || sentinel === '') return
  appendFileSync(sentinel, `${JSON.stringify({ event, package: '@r8-pr1-fixture/dual', pid: process.pid, ...extra })}\n`)
}

record('tui-import')

export const name = 'r8-pr1-fixture-dual-tui'
export const inject = ['piTuiExtensions']

export function apply(ctx, config) {
  void config
  record('tui-apply', { config: JSON.stringify(config ?? null) })
  ctx.effect(() => () => record('tui-dispose'))
  const service = ctx.piTuiExtensions
  service.register('chrome.footer.status', {
    id: 'r8-pr1-fixture-dual-footer',
    order: 30,
    description: 'R8 fixture Dual footer',
  }, { spans: [{ text: 'R8-DUAL-LIVE', tone: 'success' }] })
  service.registerCommand({
    id: 'r8-pr1-fixture-dual-command',
    name: 'r8-dual',
    description: 'R8 fixture Dual command',
    sessionless: true,
    handler: () => {
      record('command-call')
      return { kind: 'success', text: 'r8-dual' }
    },
  })
}
