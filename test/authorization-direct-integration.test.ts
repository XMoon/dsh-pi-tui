/**
 * Phase 3C / C2-MA — the REAL provider-authorization seam behind the Models
 * page. The official `AuthorizationService` owns the attempt lifecycle; a
 * registered flow emits a notice and select/secret prompts and commits its
 * credential record. The TUI's `DirectAuthorizationConfig` bridges those
 * callback interactions into detached events, and the REAL
 * `createAuthorizationFlow` drives the page-style surface.
 *
 * The flow itself is a stand-in for a provider protocol (the protocol is the
 * provider's business); every lifecycle/commit path is the official service.
 *
 * @module @xmoon76/dsh-pi-tui/authorization-direct-integration.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { DirectAuthorizationConfig } from '../src/runtime/direct/config-direct.ts'
import { createAuthorizationFlow, type AuthorizationSurface } from '../src/app/command/authorization.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

const KEY = credentialKey('llm-pi-ai', 'acme-oauth')

test('REAL AuthorizationService → Direct bridge → authorization flow: notice, select/secret prompts, committed record', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Acme OAuth',
      methods: [{ id: 'oauth', label: 'Sign in with Acme' }],
      run: async session => {
        session.notify({ message: 'Continue in your browser', url: 'https://acme.example/authorize', code: 'ABCD' })
        const method = await session.prompt({
          kind: 'select',
          message: 'Choose a method',
          options: [{ id: 'oauth', label: 'OAuth' }, { id: 'device', label: 'Device code' }],
        })
        const code = await session.prompt({ kind: 'secret', message: 'Paste the code' })
        await session.commit({ kind: 'grant', payload: { method, code } })
      },
    })

    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    const targets = port.listTargets()
    assert.equal(targets.length, 1)
    assert.equal(targets[0]!.key, KEY)
    assert.equal(targets[0]!.route, 'acme-oauth')
    assert.deepEqual(targets[0]!.methods, [{ id: 'oauth', label: 'Sign in with Acme' }])

    const notices: string[] = []
    const asked: string[] = []
    const surface: AuthorizationSurface = {
      openOutputViewer: options => {
        notices.push(options.initial)
        return () => {}
      },
      askQuestions: async questions => {
        asked.push(questions[0]!.question)
        return [{ id: questions[0]!.id, selected: [], custom: questions[0]!.masked === true ? 'code-123' : 'text-answer' }]
      },
      openPicker: (items, onSelect) => {
        asked.push('picker')
        onSelect(items[0]!.value)
        return { close: () => {} }
      },
    }

    const flow = createAuthorizationFlow(surface, port)
    const off = port.onEvent(flow.onEvent)
    try {
      const started = await port.begin({ key: KEY, method: 'oauth' })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') return
      flow.bind(started.attemptId)
      const outcome = await flow.outcome
      assert.equal(outcome.status, 'authorized')
      assert.ok(notices.some(notice => notice.includes('Continue in your browser') && notice.includes('ABCD')), notices.join('\n'))
      assert.deepEqual(asked, ['picker', 'Paste the code'])

      const credentials = ctx.get('credentials') as { listRecords(): Promise<readonly { key: string; kind?: string }[]> }
      const records = await credentials.listRecords()
      assert.ok(records.some(record => record.key === KEY && record.kind === 'grant'))
    } finally {
      off()
      flow.close()
    }
  }
})
