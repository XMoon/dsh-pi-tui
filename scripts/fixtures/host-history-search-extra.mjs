import { appendFileSync } from 'node:fs'
export const name = 'host-history-search-extra'
export const inject = ['agents', 'workingDirectory', 'sessionController']
const proof = process.env.HISTORY_SEARCH_EXTRA_PROOF
const record = (kind, fields = {}) => {
  if (proof !== undefined && proof !== '') appendFileSync(proof, JSON.stringify({ kind, ...fields, time: Date.now() }) + '\n', { mode: 0o600 })
}
function textOf(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.content)) return ''
  return value.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
}
export function apply(ctx) {
  record('plugin-loaded')
  ctx.on('session/event', (session, event) => {
    const cwdMarker = (event.type === 'user/message' && textOf(event.data) === 'hsp-cwd-switch')
      || (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted) && event.data.inserted.some(message => textOf(message) === 'hsp-cwd-switch'))
    if (cwdMarker) {
      const agent = ctx.agents.get(String(session.id))
      const target = process.env.HISTORY_SEARCH_CWD_TARGET
      if (agent === undefined || target === undefined || target === '') { record('cwd-error', { sessionId: String(session.id) }); return }
      ctx.workingDirectory.set(agent, target).then(cwd => record('cwd-set', { sessionId: String(session.id), cwd })).catch(error => record('cwd-error', { sessionId: String(session.id), error: String(error) }))
    }
    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
      const sessionId = String(session.id)
      const target = event.data.inserted.find(message => textOf(message) === 'hsp-queue-target')
      if (target !== undefined) {
        const itemId = String(target.id)
        const run = async () => {
          record('queue-inserted', { sessionId, itemId })
          await ctx.sessionController.updateQueue({ sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text: 'hsp-queue-edited' }] } })
          record('queue-edited', { sessionId, itemId })
          await ctx.sessionController.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })
          record('queue-removed', { sessionId, itemId })
        }
        setTimeout(() => run().catch(error => record('queue-error', { sessionId, itemId, error: String(error) })), 0)
      }
      const steer = event.data.inserted.find(message => textOf(message) === 'hsp-queue-steer')
      if (steer !== undefined) {
        const itemId = String(steer.id)
        const run = async () => {
          record('queue-steer-inserted', { sessionId, itemId })
          await ctx.sessionController.updateQueue({ sessionId, itemId, action: { kind: 'steer' } })
          record('queue-steered', { sessionId, itemId })
        }
        setTimeout(() => run().catch(error => record('queue-error', { sessionId, itemId, error: String(error) })), 0)
      }
    }
  }, { global: true })
}
