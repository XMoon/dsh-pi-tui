/**
 * S4-D2 B02/B04/B06/B12 — web-anchored Optional bundle Host boundaries
 * (implementation plan §5 D2-7).
 *
 * No browser component is claimed as a PiTui surface. The test exercises the
 * REAL mounted Host prerequisite/route where the TUI profile can mount it, uses
 * a controlled local endpoint only for external transport, and records the
 * exact missing prerequisite instead of inventing a TUI Web UI.
 * @module @xmoon76/dsh-pi-tui/s4-d2-web-anchored.test
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  skippedInstallationReason,
  startS4D2Host,
  type S4D2BundleId,
} from './support/s4-d2-optional-bundle-fixture.ts'

const B02 = '@deepseek-ai/dsh-experimental-voice-input-bundle' satisfies S4D2BundleId
const B04 = '@deepseek-ai/dsh-experimental-inspector-profile' satisfies S4D2BundleId
const B06 = '@deepseek-ai/dsh-experimental-cot-translation-bundle' satisfies S4D2BundleId
const B12 = '@deepseek-ai/dsh-experimental-plugin-market-bundle' satisfies S4D2BundleId
const skip = skippedInstallationReason([B02, B04, B06, B12])

interface LocalServer {
  readonly url: string
  close(): Promise<void>
}

/** One controlled HTTP endpoint that replaces ONLY the external transport. */
async function localServer(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<LocalServer> {
  const bodies: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      bodies.push(body)
      handler(request, response, body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('local server did not bind')
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

test('B02 Voice: real speech registry/readiness, no model and no microphone claim', { skip }, async t => {
  let host = await startS4D2Host(t, { bundles: [B02] })
  const speech = host.ctx.get('speechToText') as {
    snapshot(): {
      selection: { providerId: string; language: string }
      providers: readonly {
        id: string
        location: string
        downloadSources?: readonly { url: string }[]
        setupEstimate?: { recommendedDiskBytes: number }
        preparation: { phase: string; message?: string }
      }[]
    }
  }
  const snapshot = speech.snapshot()
  assert.equal(snapshot.selection.providerId, 'sensevoice-local')
  const local = snapshot.providers.find(provider => provider.id === 'sensevoice-local')
  assert.ok(local !== undefined, 'the local SenseVoice provider is really registered')
  assert.equal(local.location, 'host-local')
  assert.ok((local.downloadSources?.length ?? 0) > 0, 'the local model download source is a real prerequisite')
  assert.ok(local.setupEstimate !== undefined, 'the model preparation estimate is exposed')
  assert.equal(local.preparation.phase, 'unprepared', 'the isolated Host has no model; readiness is exactly unprepared')
  assert.ok(host.ctx.get('speechController') !== undefined,
    'the authenticated API speech controller row is mounted separately from the local provider')
  // The TUI has no microphone surface: nothing in this Host test claims one.

  const disabled = await host.pluginManager.setBundleEnabled(B02, false) as { application: string }
  assert.equal(disabled.application, 'restart-required')
  host = await host.restart()
  assert.equal(host.ctx.get('speechToText'), undefined, 'the speech service is released with the bundle')
})

test('B04 Inspector: the web transport prerequisite is honestly pending, no capture in the TUI profile', { skip }, async t => {
  const host = await startS4D2Host(t, { bundles: [B04] })
  assert.equal(host.ctx.get('inspector'), undefined, 'no inspector service is fabricated without webServer/connection')
  const entry = host.loaderEntries().find(candidate => candidate.id === 'experimental-inspector')
  assert.ok(entry !== undefined, 'the real inspector Loader row is present')
  assert.equal(entry.state, 0, 'the real Loader row is pending (Cordis state 0), not active')
  // The exact prerequisites the row waits for are absent from this profile.
  assert.equal(host.ctx.get('webServer'), undefined)
  assert.equal(host.ctx.get('connection'), undefined)
  // The installed official patch declares the opt-in capture policy; the
  // capture behavior itself is NOT_VERIFIED because the Web transport row
  // (webServer/connection) is not mounted in a TUI profile.
  const { readFileSync } = await import('node:fs')
  const patch = readFileSync(join(host.installation.nodeModules, B04, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /captureFetch:\s*true/u, 'the installed B04 patch declares captureFetch: true')
  assert.equal(host.ctx.get('inspector'), undefined)
})

test('B06 CoT translation: real translator route through a controlled endpoint, error/cancel', { skip }, async t => {
  let mode: 'ok' | 'error' = 'ok'
  const server = await localServer((request, response, body) => {
    if (mode === 'error') {
      response.writeHead(500).end('failed')
      return
    }
    assert.equal(request.method, 'POST')
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url?.startsWith('/google')) {
      // google-form-v1: urlencoded q -> [[[translatedText, ...]]]
      const query = new URLSearchParams(body)
      response.end(JSON.stringify([[[`G:${query.get('q') ?? ''}`, 'source', null, null, 10]]]))
      return
    }
    // bing-edge-v1: JSON string array -> [{translations:[{text}]}]
    const text = JSON.parse(body) as string[]
    response.end(JSON.stringify([{ translations: [{ text: `TRANSLATED:${text[0]}` }] }]))
  })
  t.after(() => server.close())
  const host = await startS4D2Host(t, {
    bundles: [B06],
    patches: [{
      id: 'translator',
      config: {
        provider: 'bing',
        bingEndpoint: `${server.url}/translate`,
        googleEndpoint: `${server.url}/google`,
        timeoutMs: 5_000,
      },
    }] as never,
  })
  const translator = host.ctx.get('translator') as {
    availableProviders(signal?: AbortSignal): Promise<readonly string[]>
    resolve(request: { text: string; targetLanguage: string; provider?: 'google' | 'bing' }): unknown
    translate(spec: unknown, signal?: AbortSignal): Promise<string>
  }
  const providers = await translator.availableProviders()
  assert.deepEqual([...providers].sort(), ['bing', 'google'], 'only anonymous providers are available without an account')
  const spec = translator.resolve({ text: 'private reasoning text', targetLanguage: 'zh' })
  const translated = await translator.translate(spec)
  assert.equal(translated, 'TRANSLATED:private reasoning text',
    'the real translator route sent the reasoning text to the controlled endpoint and parsed its response')

  const googleSpec = translator.resolve({ text: 'google reasoning text', targetLanguage: 'zh', provider: 'google' })
  assert.equal(await translator.translate(googleSpec), 'G:google reasoning text',
    'the second anonymous provider route is exercised through the same real translator service')

  mode = 'error'
  const failing = translator.resolve({ text: 'another private reasoning', targetLanguage: 'zh' })
  await assert.rejects(() => translator.translate(failing), /TRANSLATION_HTTP_ERROR|failed/u)

  mode = 'ok'
  const controller = new AbortController()
  controller.abort()
  const cancelled = translator.resolve({ text: 'cancelled text', targetLanguage: 'zh' })
  await assert.rejects(() => translator.translate(cancelled, controller.signal))
  // The translator is a standalone Host service: no reasoning/TUI text is rewritten.
  assert.equal(host.ctx.get('translator') !== undefined, true)
})

test('B12 Plugin Market: real empty default, explicit offline index, unknown/invalid source negatives', { skip }, async t => {
  const index = {
    format: 1,
    title: { en: 'Local Test Index' },
    metadata: { categories: {}, labels: {}, sortKeys: {} },
    plugins: [{
      name: '@vendor/local-plugin',
      description: { en: 'A local-only market entry' },
      metadata: { keywords: [], labels: [], sortKeys: {} },
      versions: [{
        version: '1.0.0',
        publishTimestamp: 1,
        source: { type: 'npm' },
        engines: { dsh: '>=0.2.1-rc.2' },
      }],
    }],
  }
  const server = await localServer((request, response) => {
    if (request.url?.includes('broken')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"format":1,"title":{}}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(index))
  })
  t.after(() => server.close())
  const indexUrl = `${server.url}/index.json`
  const brokenUrl = `${server.url}/broken.json`
  // The composition carries a USER-CONFIGURED source; the bundle itself ships
  // no default marketplace (verified below on a plain Host).
  const plain = await startS4D2Host(t, { bundles: [B12] })
  const plainMarket = plain.ctx.get('pluginMarket') as { listIndexes(): readonly unknown[] }
  assert.deepEqual(plainMarket.listIndexes(), [], 'there is no official default marketplace')
  await plain.dispose()
  const host = await startS4D2Host(t, {
    bundles: [B12],
    presets: true,
    patches: [{ id: 'plugin-market', config: { indexes: [indexUrl, brokenUrl], fetchTimeoutMs: 5_000 } }] as never,
  })
  const market = host.ctx.get('pluginMarket') as {
    listIndexes(): readonly { url: string }[]
    search(url: string, query: { offset: number; limit: number; sort: { kind: 'index' } }): Promise<{ entries: readonly { name: string }[]; total: number }>
  }
  assert.deepEqual(market.listIndexes().map(source => source.url), [indexUrl, brokenUrl])
  const result = await market.search(indexUrl, { offset: 0, limit: 10, sort: { kind: 'index' } })
  assert.equal(result.total, 1)
  assert.equal(result.entries[0]?.name, '@vendor/local-plugin')
  await assert.rejects(
    () => market.search(`${server.url}/missing.json`, { offset: 0, limit: 10, sort: { kind: 'index' } }),
    /unknown-index|Not a configured index source/u,
  )
  await assert.rejects(
    () => market.search(brokenUrl, { offset: 0, limit: 10, sort: { kind: 'index' } }),
    /invalid-index|fetch-failed|invalid-index-url|must be an array/u,
  )
  // The market tool is a PRESET-scoped Host tool, not a global/TUI one. The
  // generated `standard`/`ptc` presets declare it disabled; `cordis` enables
  // it when the profile context + market service are mounted; `minimal` never
  // declares it. This is the real Creator/agent-scope boundary.
  assert.equal(host.ctx.tools.get('plugin_market'), undefined)
  const presets = host.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }
  const cordis = await host.createAgent(SessionId('s4-d2-b12-cordis'), { cwd: join(host.root, 'work') })
  await presets.select(cordis, 'cordis')
  assert.equal(host.hasTool('plugin_market', cordis), true,
    'the market tool is reachable in the cordis preset when the market service is mounted')
  const listed = await host.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('s4-d2-b12-market'),
    name: 'plugin_market',
    arguments: { action: 'list_indexes' },
    agent: cordis,
  }) as { isError?: boolean; content?: readonly { type?: string; text?: string }[] }
  assert.notEqual(listed.isError, true)
  const indexList = (listed.content ?? []).map(block => block.text ?? '').join('')
  assert.match(indexList, new RegExp(indexUrl.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
    'the Creator tool reads the SAME configured index source as the Host service')
  const plugins = await host.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('s4-d2-b12-market-plugins'),
    name: 'plugin_market',
    arguments: { action: 'list_plugins', target: indexUrl, query: 'local' },
    agent: cordis,
  }) as { isError?: boolean; content?: readonly { type?: string; text?: string }[] }
  assert.notEqual(plugins.isError, true)
  assert.match((plugins.content ?? []).map(block => block.text ?? '').join(''), /@vendor\/local-plugin/u,
    'the Creator tool lists the real plugin from the configured index')
  const standard = await host.createAgent(SessionId('s4-d2-b12-standard'), { cwd: join(host.root, 'work') })
  await presets.select(standard, 'standard')
  assert.equal(host.hasTool('plugin_market', standard), false,
    'standard declares the market tool row disabled')
  const minimal = await host.createAgent(SessionId('s4-d2-b12-minimal'), { cwd: join(host.root, 'work') })
  await presets.select(minimal, 'minimal')
  assert.equal(host.hasTool('plugin_market', minimal), false,
    'minimal never declares the market tool')
  const { readFileSync } = await import('node:fs')
  for (const preset of ['standard', 'ptc']) {
    const patch = readFileSync(join(process.cwd(), 'generated', 'dsh-presets', `${preset}.patch.yml`), 'utf8')
    assert.match(patch, /id: tool-plugin-market[\s\S]{0,160}?disabled: true/u,
      `${preset} declares the market tool row disabled`)
  }
  const cordisPatch = readFileSync(join(process.cwd(), 'generated', 'dsh-presets', 'cordis.patch.yml'), 'utf8')
  assert.match(cordisPatch, /id: tool-plugin-market[\s\S]{0,160}?ctx\.get\('profileContext'\)/u,
    'cordis keeps the profile-gated market row')

})
