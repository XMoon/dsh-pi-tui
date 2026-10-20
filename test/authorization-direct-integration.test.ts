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
import { ModelsWorkspacePage, type ModelsWorkspaceSource } from '../src/tui/panels/models-workspace-page.ts'
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

test('REAL Direct cancel settles a provider that ignores abort exactly once', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-cancel-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'slow-oauth')
  let releaseUpstream: (() => void) | undefined
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key,
      label: 'Slow OAuth',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      // Deliberately ignores the abort signal and settles only when the test
      // releases it: the adapter must still terminate the consumer exactly once.
      run: async () => {
        await new Promise<void>(resolve => { releaseUpstream = resolve })
      },
    })

    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    const surface: AuthorizationSurface = {
      openOutputViewer: () => () => {},
      askQuestions: async () => [],
      openPicker: () => ({ close: () => {} }),
    }
    const flow = createAuthorizationFlow(surface, port)
    let settled = 0
    const off = port.onEvent(event => {
      if (event.kind === 'settled') settled += 1
      flow.onEvent(event)
    })
    try {
      const started = await port.begin({ key, method: 'oauth' })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') return
      flow.bind(started.attemptId)
      await port.cancel(started.attemptId)
      const outcome = await Promise.race([
        flow.outcome,
        new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 1_000)),
      ])
      assert.equal(outcome.status, 'cancelled')
      assert.equal(settled, 1)
      // A late upstream settlement after local finalization must be invisible.
      releaseUpstream?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, 1)
    } finally {
      off()
      flow.close()
    }
  }
})

test('REAL Direct attempt → Models page Esc: cancel settles and the page returns only after it (MA13 direct path)', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-page-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'page-slow-oauth')
  let releaseUpstream: (() => void) | undefined
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key,
      label: 'Page Slow OAuth',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async () => { await new Promise<void>(resolve => { releaseUpstream = resolve }) },
    })
    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    let settled = 0
    const runTasks: Promise<void>[] = []
    const row: import('../src/tui/panels/models-workspace-page.ts').ModelsProviderRow = {
      kind: 'authorization',
      identity: `auth:${key}`,
      route: 'page-slow-oauth',
      label: 'Page Slow OAuth',
      key,
      configured: false,
      declared: false,
      namesCredential: false,
      methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false,
      profile: { route: 'page-slow-oauth', configured: false, models: [] },
    }
    const source: ModelsWorkspaceSource = {
      available: true,
      rows: () => [row],
      accountSummary: async () => ({ available: false }),
      credentialState: async () => ({ kind: 'known', configured: false }),
      storedCredentials: async () => ({ rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }),
      describeReference: async () => ({ configured: false }),
      setReference: async () => {},
      clearReference: async () => {},
      deleteRecord: async () => {},
      beginAuthorization: async (targetKey, method, signal) => port.begin({ key: targetKey, method, signal }),
      authorizationEvents: listener => port.onEvent(event => {
        if (event.kind === 'settled') settled += 1
        listener(event)
      }),
      respondAuthorization: (attemptId, promptId, answer) => port.respond(attemptId, promptId, answer),
      cancelAuthorization: attemptId => port.cancel(attemptId),
      provisionKeylessProfile: async () => '',
      discoverModels: async () => [],
      createProvider: async () => ({ kind: 'rejected', text: 'not used' }),
      configGuide: () => ({}),
      openUrl: () => {},
      copy: () => {},
      run: (_label, task) => { runTasks.push(task()) },
    }
    const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
    page.setBodyHeight(24)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      page.render(100)
      page.handleInput('\u001b[B') // provider row
      page.handleInput('\r')
      page.render(100)
      page.handleInput('\r') // Sign in
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.match(page.render(100).join('\n'), /Page Slow OAuth/u)
      page.handleInput('\u001b') // Esc/back while running
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.match(page.render(100).join('\n'), /Models & Credentials/u)
      assert.equal(settled, 1)
      releaseUpstream?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, 1)
      await Promise.all(runTasks)
    } finally {
      page.dispose()
    }
  }
})

test('Direct cancel waits for the authoritative upstream outcome (commit window)', async () => {
  const key = credentialKey('llm-pi-ai', 'commit-window')
  let releaseUpstream: ((outcome: { status: 'authorized' | 'cancelled' }) => void) | undefined
  const entry = {
    key,
    label: 'Commit Window',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
  }
  const service = {
    list: () => [entry],
    describe: () => entry,
    begin: () => new Promise<{ status: 'authorized' | 'cancelled' }>(resolve => { releaseUpstream = resolve }),
    cancel: () => {},
  }
  const port = new DirectAuthorizationConfig({ get: name => name === 'authorization' ? service : undefined })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  const off = port.onEvent(event => {
    if (event.kind === 'settled') settled += 1
    flow.onEvent(event)
  })
  try {
    const started = await port.begin({ key })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await port.cancel(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, 0, 'cancel must not preempt a commit that may still resolve authorized')
    releaseUpstream?.({ status: 'authorized' })
    const outcome = await flow.outcome
    assert.equal(outcome.status, 'authorized')
    assert.equal(settled, 1)
  } finally {
    off()
    flow.close()
  }
})

test('Direct cancel with an outstanding prompt still waits for an authorized Host commit', async () => {
  const key = credentialKey('llm-pi-ai', 'prompt-commit-window')
  let releaseUpstream: ((outcome: { status: 'authorized' | 'cancelled' }) => void) | undefined
  let promptSeen = false
  const entry = {
    key,
    label: 'Prompt Commit Window',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
  }
  const service = {
    list: () => [entry],
    describe: () => entry,
    begin: async (request: {
      interaction: {
        prompt: (prompt: { kind: 'text'; message: string }) => Promise<string>
      }
    }) => {
      // Start a prompt but do not await its answer; the flow may still call
      // commit while this bridge remains outstanding.
      void request.interaction.prompt({ kind: 'text', message: 'held prompt' }).catch(() => {})
      promptSeen = true
      return await new Promise<{ status: 'authorized' | 'cancelled' }>(resolve => { releaseUpstream = resolve })
    },
    cancel: () => {},
  }
  const port = new DirectAuthorizationConfig({ get: name => name === 'authorization' ? service : undefined })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    // Keep the prompt OPEN so the cancellation actually has a pending bridge.
    askQuestions: () => new Promise(() => {}),
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  let withdrawn = 0
  const off = port.onEvent(event => {
    if (event.kind === 'settled') settled += 1
    if (event.kind === 'prompt-withdrawn') withdrawn += 1
    flow.onEvent(event)
  })
  try {
    const started = await port.begin({ key })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(promptSeen, true)
    await port.cancel(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(withdrawn, 1, 'the pending prompt UI closes immediately')
    assert.equal(settled, 0, 'a pending prompt does NOT prove the Host has not entered commit')
    releaseUpstream?.({ status: 'authorized' })
    const outcome = await flow.outcome
    assert.equal(outcome.status, 'authorized')
    assert.equal(settled, 1)
  } finally {
    off()
    flow.close()
  }
})
