import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parse as parseYaml } from 'yaml'
import {
  assertClientHostFacts,
  lastSurfaceStatus,
  waitForCondition,
  waitForSurfaceStatus,
} from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError, redactWebQualificationText } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function reply(response, bizData) {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: bizData } }))
}

async function sanitizedFrame(client) {
  return (await client.viewport()).join('\n')
}

async function waitForAccountFrame(client, needle, label, trace, timeoutMs = 60_000) {
  let lastFrame = ''
  try {
    await waitForCondition(async () => {
      lastFrame = await sanitizedFrame(client)
      return lastFrame.includes(needle)
    }, label, timeoutMs)
  } catch (error) {
    const lines = lastFrame.split('\n')
      .filter(line => /Account|Status|Attempt|Profile|Balance|Error|failed|unavailable|waiting-browser|authorized|signed out|Sign out/iu.test(line))
    const safeLines = redactWebQualificationText(lines.slice(0, 12).join('\n'))
    const facts = {
      wanted: needle,
      sawCredentialStored: lastFrame.includes('Signed in (stored credential)'),
      sawSignedOut: lastFrame.includes('Signed out / no stored credential'),
      sawWaitingBrowser: lastFrame.includes('waiting-browser'),
      sawUnavailable: /unavailable|watch stopped/iu.test(lastFrame),
      diagnosticLines: safeLines,
    }
    trace('account.page-state-wait-failed', { label, ...facts })
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify(facts)}`, { cause: error })
  }
}

async function submitOnRealEditor(client, line, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = `m6-f2-editor-ready-${String(attempt + 1)}`
    client.send(marker)
    try {
      await client.waitForComposerDraft(marker, 8_000)
    } catch {
      client.send('\x15')
      await sleep(300)
      continue
    }
    client.send('\x15')
    let cleared = false
    for (let poll = 0; poll < 60; poll += 1) {
      const current = await client.composerText()
      if (current !== undefined && !current.includes(marker)) {
        cleared = true
        break
      }
      await sleep(100)
    }
    if (!cleared) continue
    client.send(`${line}\r`)
    return
  }
  const frame = redactWebQualificationText(await sanitizedFrame(client))
  throw new SplitSmokeAssertionError(`${label}: the editor seat never accepted the submitted prompt: ${frame}`)
}

async function selectAccountAction(client, actionLabel, label) {
  client.send('\x1b[H')
  const selected = new RegExp(`>\\s*${escapeRegex(actionLabel)}`, 'u')
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const frame = await sanitizedFrame(client)
    if (selected.test(frame)) return
    client.send('\x1b[B')
    await sleep(100)
  }
  const frame = redactWebQualificationText(await sanitizedFrame(client))
  throw new SplitSmokeAssertionError(`${label}: action was not selected in the painted frame: ${frame}`)
}

async function selectDeepseekAccountModel(client, label) {
  await submitOnRealEditor(client, '/model', `${label} opens official model picker`)
  await client.waitForScreen('Models', `${label} model picker opened`, 30_000)
  let initialFrame = ''
  await waitForCondition(async () => {
    initialFrame = await sanitizedFrame(client)
    const currentRow = initialFrame.split('\n').find(line => line.includes('[current]'))
    return currentRow !== undefined && /\bstub\b/iu.test(currentRow)
  }, `${label} live Session model picker resolved its isolated stub current route`, 30_000)
  client.send('deepseek-account')
  await waitForCondition(async () => (await sanitizedFrame(client)).includes('DeepSeek Flash'),
    `${label} filtered deepseek-account catalog row`, 30_000)
  client.send('\r')
  let frame = ''
  try {
    await waitForCondition(async () => {
      frame = await sanitizedFrame(client)
      return frame.includes('DeepSeek Flash') && frame.includes('←→ effort · Enter select · Esc back')
    }, `${label} selected DeepSeek Flash entered its inline effort phase`, 15_000)
  } catch (error) {
    throw new SplitSmokeAssertionError(
      `${label} model picker did not paint inline effort focus: ${redactWebQualificationText(frame)}`,
      { cause: error },
    )
  }
  client.send('\r')
}

async function completeAuthorizationInChromium(authorizeUrl, playwrightRoot) {
  const playwrightBrowsers = process.env.SPLIT_PROCESS_PLAYWRIGHT_BROWSERS ?? join(playwrightRoot, 'browsers')
  const chromiumLibs = process.env.SPLIT_PROCESS_CHROMIUM_LIBS ?? join(playwrightRoot, 'libs', 'usr', 'lib', 'x86_64-linux-gnu')
  const previousBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  const previousLdLibraryPath = process.env.LD_LIBRARY_PATH
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsers
  process.env.LD_LIBRARY_PATH = `${chromiumLibs}${previousLdLibraryPath === undefined ? '' : `:${previousLdLibraryPath}`}`
  let browser
  let browserFailure
  try {
    const { chromium } = createRequire(join(playwrightRoot, 'package.json'))('playwright')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const finalResponse = await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 60_000 })
    assert(finalResponse?.status() === 200, 'the real Browser did not complete the Host callback redirect chain')
    assert(new URL(page.url()).pathname === '/dsh/authorized',
      'the real Browser did not reach the official Platform completion page')
  } catch (error) {
    browserFailure = error
  } finally {
    if (browser !== undefined) await browser.close()
    if (previousBrowserPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserPath
    if (previousLdLibraryPath === undefined) delete process.env.LD_LIBRARY_PATH
    else process.env.LD_LIBRARY_PATH = previousLdLibraryPath
  }
  if (browserFailure !== undefined) {
    throw new SplitSmokeAssertionError(`the real Account authorization Browser failed: ${String(browserFailure?.name ?? 'Error')}`)
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export async function runF2AccountComposition(context) {
  const { EntryProcess, SurfaceEntryProcess, entries, base, workDir, dshHome, installation, trace } = context
  const { profileDir } = installation
  const auth = {
    init: undefined,
    attempts: [],
    initializeValid: false,
    browserStateValid: false,
    pkceValid: false,
    redirectValid: false,
    wrongCodeRejected: false,
    cancelValid: false,
    runningRequestEntered: false,
    runningRequestModel: undefined,
    runningRequestClosed: false,
  }
  const requests = []
  const mockFailures = []
  let mockServer
  let host
  const clients = []
  const credentialsPath = join(dshHome, '.credentials.yaml')
  const apiKeySentinel = 'm6-f2-isolated-api-key'

  try {
    mockServer = createServer((request, response) => {
      void (async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const bodyText = Buffer.concat(chunks).toString('utf8')
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        requests.push(`${request.method ?? 'GET'} ${url.pathname}`)
        const origin = `http://127.0.0.1:${mockServer.address().port}`

        if (request.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_init') {
          const input = JSON.parse(bodyText)
          auth.init = {
            state: input.state,
            challenge: input.code_challenge,
            challengeMethod: input.code_challenge_method,
            redirectUri: input.redirect_uri,
            loginSource: input.login_source,
            authorizeId: `m6-f2-authorize-id-${String(auth.attempts.length + 1)}`,
            authorizeCode: `m6-f2-one-time-code-${String(auth.attempts.length + 1)}`,
            exchangeValid: false,
            pkceValid: false,
            redirectValid: false,
          }
          auth.attempts.push(auth.init)
          const redirect = new URL(input.redirect_uri)
          auth.initializeValid = typeof input.state === 'string'
            && input.state !== ''
            && typeof input.code_challenge === 'string'
            && input.code_challenge_method === 'S256'
            && input.login_source === 'web'
            && redirect.pathname === '/oauth/callback'
            && redirect.hostname === '127.0.0.1'
          reply(response, {
            authorize_url: `${origin}/dsh/authorize?state=${encodeURIComponent(input.state)}`,
            authorize_id: auth.init.authorizeId,
            expires_in: 300,
          })
          return
        }
        if (request.method === 'GET' && url.pathname === '/dsh/authorize') {
          const state = url.searchParams.get('state')
          auth.browserStateValid = auth.init !== undefined && state === auth.init.state
          if (!auth.browserStateValid || auth.init === undefined) {
            response.writeHead(400, { 'cache-control': 'no-store' }).end()
            return
          }
          const callback = new URL(auth.init.redirectUri)
          callback.searchParams.set('code', auth.init.authorizeCode)
          callback.searchParams.set('state', state)
          response.writeHead(302, { location: callback.href, 'cache-control': 'no-store' }).end()
          return
        }
        if (request.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_exchange') {
          const input = JSON.parse(bodyText)
          const derived = createHash('sha256').update(input.code_verifier).digest('base64url')
          const validCode = auth.init !== undefined && input.code === auth.init.authorizeCode
          const validPkce = auth.init !== undefined
            && derived === auth.init.challenge
            && auth.init.challengeMethod === 'S256'
          const validRedirect = auth.init !== undefined && input.redirect_uri === auth.init.redirectUri
          if (auth.init !== undefined) {
            auth.init.exchangeValid = validCode && validPkce && validRedirect
            auth.init.pkceValid = validPkce
            auth.init.redirectValid = validRedirect
            auth.pkceValid ||= auth.init.exchangeValid
            auth.redirectValid ||= validRedirect
            if (!validCode && validPkce && validRedirect) auth.wrongCodeRejected = true
          }
          if (!validCode || !validPkce || !validRedirect) {
            response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              .end(JSON.stringify({ code: 1, data: { biz_code: 1, biz_msg: 'invalid test authorization' } }))
            return
          }
          reply(response, {
            token: 'm6-f2-mock-grant-token',
            authorized_url: `${origin}/dsh/authorized`,
            user: {
              id: 'm6-f2-account-id',
              email: 'qa@m6.invalid',
              id_profile: { name: 'M6 Account', picture: null },
            },
          })
          return
        }
        if (request.method === 'GET' && url.pathname === '/dsh/authorized') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            .end('<!doctype html><title>Authorization complete</title><p>Authorization complete.</p>')
          return
        }
        if (request.method === 'GET' && url.pathname === '/models') {
          assert(request.headers['x-dsh-auth-token'] === 'm6-f2-mock-grant-token',
            'the Host model-listing request did not use its committed mock grant')
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(JSON.stringify({ data: [{
              id: 'deepseek-flash',
              name: 'DeepSeek Flash',
              context_window: 32768,
              max_output_tokens: 4096,
              input_modalities: ['text'],
              output_modalities: ['text'],
              api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'addition-only' } },
            }] }))
          return
        }
        if (request.method === 'POST' && url.pathname === '/anthropic/v1/messages') {
          assert(request.headers['x-dsh-auth-token'] === 'm6-f2-mock-grant-token',
            'the Host model request did not use its committed mock grant')
          auth.runningRequestModel = JSON.parse(bodyText).model
          auth.runningRequestEntered = true
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          })
          response.flushHeaders()
          response.on('close', () => { auth.runningRequestClosed = true })
          return
        }
        if (request.method === 'GET' && url.pathname === '/auth-api/v0/users/current') {
          assert(request.headers['x-dsh-auth-token'] === 'm6-f2-mock-grant-token',
            'the Host profile request did not use its committed mock grant')
          reply(response, {
            id: 'm6-f2-account-id',
            email: 'qa@m6.invalid',
            id_profile: { name: 'M6 Account', picture: null },
          })
          return
        }
        if (request.method === 'GET' && url.pathname === '/api/v0/users/get_user_summary') {
          reply(response, {
            normal_wallets: [{ currency: 'CNY', balance: '12.50' }],
            bonus_wallets: [{ currency: 'CNY', balance: '3.0000' }],
          })
          return
        }
        if (request.method === 'POST' && url.pathname === '/auth-api/v0/users/logout') {
          assert(request.headers['x-dsh-auth-token'] === 'm6-f2-mock-grant-token',
            'the Host logout request did not use its committed mock grant')
          reply(response, {})
          return
        }
        if (request.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_cancel') {
          const input = JSON.parse(bodyText)
          const derived = createHash('sha256').update(input.code_verifier).digest('base64url')
          auth.cancelValid = auth.init !== undefined
            && input.authorize_id === auth.init.authorizeId
            && derived === auth.init.challenge
          reply(response, {})
          return
        }
        response.writeHead(404, { 'cache-control': 'no-store' }).end()
      })().catch(error => {
        mockFailures.push(error instanceof Error ? error.message : 'Account mock assertion failed')
        if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' }).end()
        else response.destroy()
      })
    })
    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve))
    const platformOrigin = `http://127.0.0.1:${mockServer.address().port}`
    const credentialsText = [
      'version: 1',
      'refs:',
      `  DEEPSEEK_API_KEY: ${apiKeySentinel}`,
      'records: {}',
      '',
    ].join('\n')
    writeFileSync(credentialsPath, credentialsText, { mode: 0o600 })

    const basePatchPath = base.env.SPLIT_PROCESS_EXTRA_PATCH
    assert(typeof basePatchPath === 'string' && basePatchPath !== '',
      'the isolated profile has no base Host LLM overlay')
    const accountPatchPath = join(workDir, 'm6-f2-account-host.patch.yml')
    const hostPatch = [
      readFileSync(basePatchPath, 'utf8').trimEnd(),
      '- id: deepseek-account',
      '  config:',
      `    platformOrigin: '${platformOrigin}'`,
      `    inferenceOrigin: '${platformOrigin}'`,
      `    baseURL: '${platformOrigin}/anthropic'`,
      '    allowLoopbackHttp: true',
      '    requestTimeoutMs: 3000',
      '    attemptTimeoutMs: 120000',
      '    logoutMaxRetries: 0',
      '- id: llm-deepseek-account',
      '  config:',
      `    baseURL: '${platformOrigin}/anthropic'`,
      '    modelsTimeoutMs: 3000',
      '',
    ].join('\n')
    writeFileSync(accountPatchPath, hostPatch, { mode: 0o600 })

    host = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: accountPatchPath },
    })
    const hostReady = await host.waitFor(record => record.m4a0 === 'ready', 'F2 Host Account Ready', 180_000)
    assert(hostReady.ownerEntries?.accountController?.length === 1
      && hostReady.ownerEntries.accountController[0] === 'split-host-account-controller',
    'the real Host did not publish exactly one official Account Controller owner')
    assert(hostReady.services?.accountController === true,
      'the real Host did not publish the official accountController/account binding')
    const webAccountRow = hostReady.entries?.find(entry => entry.id === 'ui-settings-account')
    assert(webAccountRow?.state === 'absent' || webAccountRow?.state === 'state-4',
      'the Web-only Account UI row must remain inactive while the official Host Account Controller is live')

    const launchClient = async label => {
      const client = new SurfaceEntryProcess(entries.client, { ...base, workDir })
      clients.push(client)
      const ready = await client.waitFor(record => record.m4a0 === 'ready', `${label} surface Client ready`, 180_000)
      assertClientHostFacts(ready.host, hostReady.localHost, `${label} Client authenticated Host`)
      await submitOnRealEditor(client, '/new', `${label} first Host Session`)
      await waitForSurfaceStatus(client,
        record => record.sessionOpen === true && typeof record.openSessionId === 'string',
        `${label} first Host Session opened`, 120_000)
      return client
    }
    const openAccountPage = async (client, label, expectedStatus) => {
      await submitOnRealEditor(client, '/login deepseek-account', `${label} opens Account page`)
      await client.waitForScreen('DeepSeek Account', `${label} Account page opened`, 60_000)
      const expectedLine = expectedStatus === 'signed-out'
        ? 'Signed out / no stored credential'
        : 'Signed in (stored credential)'
      await waitForAccountFrame(client, expectedLine,
        `${label} Account initial Host watch snapshot`, trace, 60_000)
      const initialFrame = await sanitizedFrame(client)
      const initialFacts = {
        signedOut: initialFrame.includes('Signed out / no stored credential'),
        credentialStored: initialFrame.includes('Signed in (stored credential)'),
        unavailable: /unavailable|watch stopped/iu.test(initialFrame),
      }
      trace('account.initial-watch-state', { client: label, ...initialFacts })
      assert(expectedStatus === 'signed-out' ? initialFacts.signedOut : initialFacts.credentialStored,
        `${label} Account initial watch disagreed with the Host state expectation: ${JSON.stringify(initialFacts)}`)
      if (expectedStatus === 'signed-out') {
        await client.waitForScreen('Sign in', `${label} Sign-in action painted`, 30_000)
      } else {
        await waitForAccountFrame(client, 'M6 Account', `${label} initial Account profile query`, trace)
        await client.waitForScreen('Sign out…', `${label} Sign-out action painted`, 30_000)
      }
    }

    const closeAccountPage = async (client, label) => {
      let frame = await sanitizedFrame(client)
      if (frame.includes('DeepSeek Account')) {
        client.send('\x1b')
        await waitForAccountFrame(client, '[Categories (9)]', `${label} Account page yielded to Settings`, trace, 20_000)
      }
      frame = await sanitizedFrame(client)
      if (frame.includes('[Categories (9)]')) client.send('\x1b')
      await waitForCondition(async () => {
        const current = await sanitizedFrame(client)
        return !current.includes('[Categories (9)]') && !current.includes('DeepSeek Account')
      }, `${label} Settings and Account surfaces closed`, 20_000)
      await waitForSurfaceStatus(client,
        record => record.sessionOpen === true && typeof record.openSessionId === 'string',
        `${label} returned to its Host Session`, 20_000)
    }

    const clientA = await launchClient('F2 A')
    const clientB = await launchClient('F2 B')
    await openAccountPage(clientA, 'F2 A', 'signed-out')
    await openAccountPage(clientB, 'F2 B', 'signed-out')
    await selectAccountAction(clientB, 'Sign in', 'F2 select first browser Sign-in')
    clientB.send('\r')
    await waitForAccountFrame(clientB, 'waiting-browser', 'F2 official Account attempt reached the browser phase', trace, 30_000)
    await waitForAccountFrame(clientA, 'waiting-browser', 'F2 first Client observes the shared Host attempt', trace, 30_000)
    await closeAccountPage(clientA, 'F2 A')
    await waitForAccountFrame(clientB, 'waiting-browser',
      'F2 closing Client A Account page left the Host browser attempt alive', trace, 20_000)
    const authorizeFrame = (await sanitizedFrame(clientB)).replace(/\s+/gu, '')
    const authorizeUrl = new RegExp(`${escapeRegex(platformOrigin)}/dsh/authorize\\?state=[A-Za-z0-9_-]{43}`, 'u').exec(authorizeFrame)?.[0]
    assert(authorizeUrl !== undefined, 'Client B did not paint the shared Host authorization URL')
    assert(!authorizeFrame.includes('m6-f2-mock-grant-token'), 'the Account page exposed a grant token')

    const callbackOrigin = hostReady.localHost?.origin
    assert(typeof callbackOrigin === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/u.test(callbackOrigin),
      'the authenticated Host identity did not carry its canonical loopback listener')
    const wrongState = await fetch(
      `${callbackOrigin}/oauth/callback?code=m6-f2-wrong-code&state=m6-f2-wrong-state`,
      { redirect: 'manual' },
    )
    assert(wrongState.status === 400, 'the real Host callback did not reject a mismatched state')
    assert(!requests.includes('POST /auth-api/v0/dsh/auth_exchange'),
      'a wrong callback state reached the Platform code exchange')

    const initialBeforeReconnect = lastSurfaceStatus(clientB)
    assert(initialBeforeReconnect?.transport === 'connected' && typeof initialBeforeReconnect.generationId === 'number',
      'F2 Client B has no live Connection generation before the active-attempt watch reconnect check')
    clientB.signalBusiness('SIGUSR1')
    const initialReconnected = await waitForSurfaceStatus(clientB,
      record => record.transport === 'connected'
        && typeof record.generationId === 'number'
        && record.generationId !== initialBeforeReconnect.generationId,
      'F2 active-attempt Account Client reconnected on a new official generation', 120_000)
    await waitForAccountFrame(clientB, 'waiting-browser',
      'F2 current-generation carrier failure retained the Host attempt on the same logical watch', trace, 30_000)
    assert(initialReconnected.generationId !== initialBeforeReconnect.generationId,
      'the Account watch recovery did not cross an actual Connection generation')

    const playwrightRoot = process.env.SPLIT_PROCESS_PLAYWRIGHT_ROOT
    assert(playwrightRoot !== undefined && playwrightRoot !== '',
      'F2-T04 requires the preinstalled real Chromium Browser callback witness')
    await completeAuthorizationInChromium(authorizeUrl, playwrightRoot)

    assert(auth.initializeValid, 'Platform auth_init did not receive state, S256 PKCE and the Host callback origin')
    assert(auth.init?.redirectUri === `${callbackOrigin}/oauth/callback`,
      'the official Controller did not send the exact authenticated Host listener callback URI')
    assert(auth.browserStateValid, 'the mock Browser authorization page did not use the exact initialized state')
    assert(auth.pkceValid && auth.redirectValid, 'Platform auth_exchange did not verify the exact PKCE verifier and callback URI')
    assert(requests.includes('GET /auth-api/v0/users/current'), 'the Host did not query the independent official profile endpoint')
    assert(requests.includes('GET /api/v0/users/get_user_summary'), 'the Host did not query the independent official balance endpoint')
    await waitForAccountFrame(clientB, 'M6 Account', 'F2 live Client received detached Host profile', trace)
    assert((await sanitizedFrame(clientB)).includes('12.50 CNY'),
      'the Account page did not paint the independent Host wallet balance')
    await selectAccountAction(clientB, 'Sign out…', 'F2 select known-false Sign out check')
    clientB.send('\r')
    await clientB.waitForScreen('Sign out confirmation', 'F2 pre-agent Account confirmation', 30_000)
    await waitForAccountFrame(clientB, 'No running account task is using this account.',
      'F2 signed-in Host task predicate returns known-false before the route switch', trace, 30_000)
    clientB.send('\x1b')
    await waitForAccountFrame(clientB, 'Sign out…', 'F2 pre-agent confirmation cancelled', trace, 20_000)

    await submitOnRealEditor(clientA, '/login deepseek-account',
      'F2 reopening the closed Account page through the Host Session')
    await waitForAccountFrame(clientA, 'Signed in (stored credential)',
      'F2 reopened Account page re-read the Host grant via its initial watch snapshot', trace)
    await waitForAccountFrame(clientA, 'M6 Account', 'F2 reopened Account page read the detached profile', trace)
    await closeAccountPage(clientA, 'F2 A')
    await selectDeepseekAccountModel(clientA, 'F2 A')
    await submitOnRealEditor(clientA, 'M6 account running-task authority proof',
      'F2 Account UI running-task agent prompt')
    await waitForCondition(() => auth.runningRequestEntered,
      'F2 official deepseek-account Messages request entered the Host model owner', 60_000)
    assert(auth.runningRequestModel === 'deepseek-flash',
      `F2 Session did not transition from stub to deepseek-account/deepseek-flash: ${String(auth.runningRequestModel)}`)
    await openAccountPage(clientA, 'F2 A', 'credential-stored')
    await waitForAccountFrame(clientB, 'Signed in (stored credential)',
      'F2 live peer Account page retained the Host grant', trace)
    await selectAccountAction(clientB, 'Sign out…', 'F2 select Account Sign out after Account-backed task started')
    clientB.send('\r')
    await clientB.waitForScreen('Sign out confirmation', 'F2 Account sign-out confirmation', 30_000)
    await waitForAccountFrame(clientB, 'A running agent is using a deepseek-account model',
      'F2 live Host running-account-task warning', trace, 30_000)
    clientB.send('\r')
    await waitForAccountFrame(clientB, 'Signed out / no stored credential',
      'F2 Host sign-out state after running-task warning', trace, 60_000)
    await waitForCondition(() => auth.runningRequestClosed,
      'F2 official signed-out listener cancelled the running account request', 30_000)
    await waitForCondition(() => requests.includes('POST /auth-api/v0/users/logout'),
      'F2 asynchronous Platform revocation request', 30_000)
    await waitForAccountFrame(clientA, 'Signed out / no stored credential',
      'F2 other Account page received the same Host sign-out', trace, 30_000)

    await selectAccountAction(clientB, 'Sign in', 'F2 select post-cancellation explicit Sign-in')
    clientB.send('\r')
    await waitForAccountFrame(clientB, 'waiting-browser',
      'F2 post-cancellation explicit Sign-in reached the Host attempt', trace, 30_000)
    const postCancelFrame = (await sanitizedFrame(clientB)).replace(/\s+/gu, '')
    const postCancelAuthorizeUrl = new RegExp(`${escapeRegex(platformOrigin)}/dsh/authorize\\?state=[A-Za-z0-9_-]{43}`, 'u').exec(postCancelFrame)?.[0]
    assert(postCancelAuthorizeUrl !== undefined,
      'post-cancellation Sign-in did not paint the Host Browser authorization link')
    await completeAuthorizationInChromium(postCancelAuthorizeUrl, playwrightRoot)
    await waitForAccountFrame(clientB, 'Signed in (stored credential)',
      'F2 post-cancellation Sign-in committed its Host credential', trace)
    await selectAccountAction(clientB, 'Sign out…', 'F2 select known-false post-cancellation task check')
    clientB.send('\r')
    await clientB.waitForScreen('Sign out confirmation', 'F2 post-cancellation task confirmation', 30_000)
    await waitForAccountFrame(clientB, 'No running account task is using this account.',
      'F2 Host predicate returns known-false after the running Agent was cancelled', trace, 30_000)
    clientB.send('\r')
    await waitForAccountFrame(clientB, 'Signed out / no stored credential',
      'F2 known-false Account sign-out result', trace, 60_000)
    await waitForCondition(() => requests.filter(path => path === 'POST /auth-api/v0/users/logout').length === 2,
      'F2 independent post-cancellation Platform revocation request', 30_000)

    // A correct state and S256 verifier carrying the wrong Platform code must
    // be rejected by the isolated endpoint; recovery requires fresh explicit
    // Sign-in and is never initiated by reconnect or observation.
    await selectAccountAction(clientB, 'Sign in', 'F2 select explicit fresh Sign in')
    clientB.send('\r')
    await clientB.waitForScreen('waiting-browser', 'F2 third explicit Host browser attempt', 30_000)
    assert(auth.attempts.length === 3, 'the third explicit Sign-in did not reach official auth_init')
    const wrongCodeAttempt = auth.attempts[2]
    const wrongCodeCallback = new URL(`${callbackOrigin}/oauth/callback`)
    wrongCodeCallback.searchParams.set('code', 'm6-f2-platform-rejected-code')
    wrongCodeCallback.searchParams.set('state', wrongCodeAttempt.state)
    const wrongCodeResponse = await fetch(wrongCodeCallback, { redirect: 'manual' })
    assert(wrongCodeResponse.status === 200, 'the Host did not finish the browser callback after Platform rejected the code')
    await waitForCondition(() => auth.wrongCodeRejected && wrongCodeAttempt.pkceValid && wrongCodeAttempt.redirectValid,
      'F2 Platform rejected wrong code after validating the exact S256 verifier and callback URI', 30_000)
    await waitForAccountFrame(clientB, 'Error code  network',
      'F2 wrong-code Host failure projection', trace, 30_000)

    // Retry only after an explicit new Sign-in. Its returned attempt id is the
    // one the user cancels through the Account page.
    clientB.send('\r')
    await clientB.waitForScreen('waiting-browser', 'F2 fourth explicit Host browser attempt', 30_000)
    assert(auth.attempts.length === 4, 'the fourth explicit Sign-in did not reach official auth_init')
    await selectAccountAction(clientB, 'Cancel current attempt', 'F2 select exact-attempt cancel')
    clientB.send('\r')
    await waitForAccountFrame(clientB, 'cancelled', 'F2 exact Host attempt cancellation state', trace, 30_000)
    await waitForCondition(() => auth.cancelValid,
      'F2 official auth_cancel matched the active attempt id and PKCE verifier', 30_000)
    assert(mockFailures.length === 0, 'the isolated Platform mock rejected an owned request assertion')
    assert(requests.filter(path => path === 'POST /auth-api/v0/dsh/auth_init').length === 4,
      'the four explicit Sign-in actions must each dispatch once; failed code is never replayed')
    assert(requests.filter(path => path === 'POST /auth-api/v0/dsh/auth_cancel').length === 1,
      'the exact active browser attempt is cancelled exactly once')

    const credentials = parseYaml(readFileSync(credentialsPath, 'utf8'))
    assert(credentials.refs?.DEEPSEEK_API_KEY === apiKeySentinel,
      'official Account sign-out removed the independent API-key reference')
    assert(credentials.records?.['deepseek-account-platform/default'] === undefined,
      'official Account sign-out retained its local grant record')
    assert(!readFileSync(credentialsPath, 'utf8').includes('m6-f2-mock-grant-token'),
      'the temporary mock Platform grant remains in the isolated credential file after sign-out')

    const captured = JSON.stringify([...host.records, ...clientA.records, ...clientB.records])
    for (const secret of [...auth.attempts.map(attempt => attempt.state), 'm6-f2-one-time-code', 'm6-f2-mock-grant-token']) {
      assert(secret === undefined || !captured.includes(secret),
        'the Host or Client diagnostic records retained an authorization state, code, or grant')
    }

    for (const client of clients) await client.dispose()
    clients.length = 0
    const normalExit = await host.shutdown()
    assert(normalExit.code === 0 && normalExit.signal === null,
      'the qualified Account Host did not stop cleanly before its negative composition control')
    host = undefined
    const disabledPatchPath = join(workDir, 'm6-f2-account-controller-disabled.patch.yml')
    writeFileSync(disabledPatchPath, '- id: split-host-account-controller\n  disabled: true\n', { mode: 0o600 })
    host = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: disabledPatchPath },
    })
    const failedReady = await host.waitFor(record => record.m4a0 === 'failure',
      'F2 disabled Account Controller row refuses Host Ready', 120_000)
    const failedExit = await host.waitForExit(60_000)
    assert(failedExit.code === 1 && failedExit.signal === null,
      'a Host missing its Account Controller exited without a readiness failure')
    assert(!host.records.some(record => record.m4a0 === 'ready'),
      'a Host missing its Account Controller emitted Ready')
    assert(String(failedReady.error).includes('expected exactly one active accountController owner row, found 0'),
      'the Host did not fail specifically on the absent Account Controller owner')
    host = undefined

    trace('account.official-composition', {
      hostControllerOwners: hostReady.ownerEntries.accountController.length,
      hostTypertBinding: hostReady.services.accountController,
      missingHostBinding: 'FAIL_CLOSED',
      webAccountUi: 'inactive',
      independentClients: 2,
      initialWatchSnapshots: 2,
      accountConnectionReconnect: {
        generationBefore: initialBeforeReconnect.generationId,
        generationAfter: initialReconnected.generationId,
        attemptRetained: true,
      },
      callbackStateNegative: 'rejected-before-exchange',
      wrongCodeWithValidPkce: auth.wrongCodeRejected,
      browserCallback: 'PASS',
      pkceExchange: 'PASS',
      profile: 'ready',
      balance: 'ready',
      sharedGrantObserved: true,
      signOutTaskCheck: 'known-true',
      hostAccountTaskCancelled: auth.runningRequestClosed,
      exactAttemptCancel: auth.cancelValid,
      signOut: 'complete-once',
      apiKeyPreserved: true,
      tokenTelemetry: 'absent',
      platformRequests: requests.slice(),
    })
    return {
      status: 'PASS',
      browser: 'PASS',
      hostAccountController: 'PASS',
      missingHostBinding: true,
      generatedAccountClients: 2,
      verifiedCallback: true,
      pkce: true,
      wrongCodeWithValidPkce: auth.wrongCodeRejected,
      initialSignedOutWatch: true,
      accountRouteChangedFromStub: auth.runningRequestModel === 'deepseek-flash',
      hostTaskKnownFalseObserved: true,
      profile: 'ready',
      balance: 'ready',
      runningTaskWarning: true,
      taskCancelled: true,
      exactAttemptCancel: true,
      signOut: 'PASS',
      apiKeyPreserved: true,
    }
  } finally {
    for (const client of clients) await client.dispose()
    if (host !== undefined) {
      try { await host.shutdown() } catch { /* the runner's process backstop owns leftovers */ }
    }
    if (mockServer !== undefined) await new Promise(resolve => mockServer.close(() => resolve()))
    if (existsSync(credentialsPath)) {
      assert(!lstatSync(credentialsPath).isSymbolicLink(), 'the isolated credentials fixture became a symlink')
      unlinkSync(credentialsPath)
    }
  }
}
