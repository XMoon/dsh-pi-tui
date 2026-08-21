/**
 * Headless tests for the credential surface lifecycle: the dsh 0.1.1-rc.1
 * split of `credentials/updated` into `credentials/reference-updated` and
 * `credentials/record-updated`, both of which must refresh the same
 * surface. The old event name is a TYPE error under the rc.1 event map, so
 * the type system itself enforces the rename; this suite pins the wiring
 * and the shared-callback contract.
 * @module @xmoon76/dsh-pi-tui/credential-events.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { registerCredentialSurfaceRefresh } from '../src/index.ts'

test('credentials/reference-updated refreshes the credential surface', async () => {
  const ctx = new Context()
  const refreshes: string[] = []
  registerCredentialSurfaceRefresh(ctx, () => { refreshes.push('refresh') })
  ctx.emit('credentials/reference-updated', credentialRef('DEEPSEEK_API_KEY'))
  // The event fan-out is synchronous for sync listeners; the assertion
  // still awaits a tick so a future async delivery cannot slip past.
  await Promise.resolve()
  assert.deepEqual(refreshes, ['refresh'])
})

test('credentials/record-updated refreshes the credential surface', async () => {
  const ctx = new Context()
  const refreshes: string[] = []
  registerCredentialSurfaceRefresh(ctx, () => { refreshes.push('refresh') })
  ctx.emit('credentials/record-updated', credentialKey('llm-pi-ai', 'openai'))
  await Promise.resolve()
  assert.deepEqual(refreshes, ['refresh'])
})

test('both credential events refresh once each, sharing one callback', async () => {
  const ctx = new Context()
  const refreshes: string[] = []
  registerCredentialSurfaceRefresh(ctx, () => { refreshes.push('refresh') })
  ctx.emit('credentials/reference-updated', credentialRef('OPENAI_API_KEY'))
  ctx.emit('credentials/record-updated', credentialKey('llm-pi-ai', 'openai-codex'))
  await Promise.resolve()
  assert.deepEqual(refreshes, ['refresh', 'refresh'])
})

test('an unrelated event does not refresh the credential surface', async () => {
  const ctx = new Context()
  const refreshes: string[] = []
  registerCredentialSurfaceRefresh(ctx, () => { refreshes.push('refresh') })
  ctx.emit('llm/adapters-updated')
  await Promise.resolve()
  assert.deepEqual(refreshes, [])
})
