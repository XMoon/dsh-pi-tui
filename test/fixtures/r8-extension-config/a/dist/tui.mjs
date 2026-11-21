/**
 * R8-E UI-only fixture A's Client-local `./tui` entry.
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
  appendFileSync(sentinel, `${JSON.stringify({ event, package: '@r8-pr1-fixture/a', pid: process.pid, ...extra })}\n`)
}

if (fault === 'a-import') throw new Error('r8-extension-client-a-import-fault')
record('tui-import')

export const name = 'r8-pr1-fixture-a-tui'
export const inject = ['piTuiExtensions']

export function apply(ctx, config) {
  if (fault === 'a-apply') throw new Error('r8-extension-client-a-apply-fault')
  void config
  record('tui-apply', { config: JSON.stringify(config ?? null) })
  ctx.effect(() => () => {
    record('tui-dispose')
    if (fault === 'a-dispose') throw new Error('r8-extension-client-a-dispose-fault')
  })
  const service = ctx.piTuiExtensions
  service.register('chrome.footer.status', {
    id: 'r8-pr1-fixture-a-footer',
    order: 10,
    description: 'R8 fixture A footer',
  }, { spans: [{ text: 'R8-A-LIVE', tone: 'success' }] })
  service.registerCommand({
    id: 'r8-pr1-fixture-a-command',
    name: 'r8-a',
    description: 'R8 fixture A command',
    sessionless: true,
    handler: () => {
      record('command-call')
      return { kind: 'success', text: 'r8-a' }
    },
  })
  // R8-E PR-4: one author-declared persisted setting over package A's official
  // Config data. The Host Profile is the only persistence authority.
  service.registerSetting({
    id: 'r8-a-label',
    label: 'R8 A label',
    description: 'Fixture A persisted label',
    currentValue: 'alpha',
    persisted: {
      path: ['label'],
      choices: [
        { id: 'alpha', op: 'set', value: 'alpha' },
        { id: 'omega', label: 'Omega', op: 'set', value: 'omega' },
        { id: 'inherit', label: 'Use inherited', op: 'unset' },
      ],
    },
  })
}
