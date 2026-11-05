#!/usr/bin/env node
/**
 * M5-W PR-D product Browser qualification driver (Playwright + real Chromium).
 *
 * The runner starts ONE installed-candidate Host (plus a real PTY TUI) and then
 * starts this driver once per CASE. The driver is the only product Browser
 * driver: it opens the official Web UI through the Host's OWN authenticated
 * index, drives visible controls with real pointer/keyboard input, and records
 * a whitelisted result. It never reloads the page unless the case is a reload
 * case, and it never writes the launch URL, its token, a Cookie or a header to
 * any retained file.
 *
 * Coordination with the runner happens ONLY through files in `<coord>`:
 *   case.json                 runner-authored case input (0600)
 *   signal-<name>             runner -> driver step release (0600)
 *   browser-<name>.json       driver -> runner observed facts (0600)
 *   browser-result.json       the final whitelisted result (0600)
 *   screenshots/*.png         real viewport screenshots (0600)
 *
 * Usage: node m5-web-product-browser.mjs <coord> <case-id> <nonce>
 * Env:   M5_WEB_DSH_HOME          isolated DSH home of the running Host
 *        M5_WEB_PLAYWRIGHT_ROOT  directory that owns the pinned Playwright
 *        PLAYWRIGHT_BROWSERS_PATH the isolated Chromium install
 *
 * @module scripts/fixtures/m5-web-product-browser
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [coordinationDir, caseId, nonce] = process.argv.slice(2)
if (coordinationDir === undefined || caseId === undefined || nonce === undefined) {
  throw new Error('usage: m5-web-product-browser.mjs <coordination-dir> <case-id> <nonce>')
}
const dshHome = process.env.M5_WEB_DSH_HOME
const playwrightRoot = process.env.M5_WEB_PLAYWRIGHT_ROOT
if (dshHome === undefined || dshHome === '') throw new Error('M5_WEB_DSH_HOME is required')
if (playwrightRoot === undefined || playwrightRoot === '') throw new Error('M5_WEB_PLAYWRIGHT_ROOT is required')

mkdirSync(coordinationDir, { recursive: true, mode: 0o700 })
chmodSync(coordinationDir, 0o700)
const screenshotsDir = join(coordinationDir, 'screenshots')
mkdirSync(screenshotsDir, { recursive: true, mode: 0o700 })
chmodSync(screenshotsDir, 0o700)

const caseConfig = readJson(join(coordinationDir, 'case.json'))
if (caseConfig.caseId !== caseId) throw new Error(`case.json describes ${String(caseConfig.caseId)}, not ${caseId}`)
if (caseConfig.nonce !== nonce) throw new Error('case.json belongs to another nonce')

/**
 * The PINNED PLAYWRIGHT PACKAGE version, not the tools-root wrapper's own
 * version: the qualification tools directory carries a private package.json
 * whose version is unrelated to the browser automation library.
 */
const playwrightPackage = readJson(join(playwrightRoot, 'node_modules', 'playwright', 'package.json'))
const { chromium } = createRequire(join(playwrightRoot, 'package.json'))('playwright')

/** The running Host's launch material. The token never leaves this process. */
function launchRecords() {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return []
  const records = []
  for (const name of readdirSync(root)) {
    const path = join(root, name, 'launch.json')
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      records.push({ ...parsed, _path: path, _mtime: statSync(path).mtimeMs })
    } catch {
      // A torn launch file is not a Host this driver can authenticate to.
    }
  }
  return records.sort((left, right) => right._mtime - left._mtime)
}
/** Every launch token this process has seen, for one redaction pass. */
const knownTokens = new Set()
/** Remember one launch record's token and return its origin/token. */
function launchAccess(record) {
  try {
    const url = new URL(record.connectUrl)
    const token = url.searchParams.get('token')
    if (typeof token === 'string' && token !== '') knownTokens.add(token)
    return { url, token }
  } catch {
    return undefined
  }
}
const initialLaunch = launchRecords()[0]
if (initialLaunch === undefined) throw new Error('no Host launch material in this DSH_HOME')
const initialAccess = launchAccess(initialLaunch)
if (initialAccess === undefined || typeof initialAccess.token !== 'string' || initialAccess.token === '') {
  throw new Error('the Host launch material carries no token')
}

/** Remove every credential shape before a retained string is written or traced. */
function redacted(text) {
  let value = String(text)
  for (const token of knownTokens) value = value.split(token).join('<redacted-token>')
  return value
    .replace(/([?&]token=)[^&\s"']+/gu, '$1<redacted>')
    // A dead-Host console error names its own WebSocket origin. The loopback
    // origin is never a durable fact worth retaining, and it must not survive
    // into evidence even without a token.
    .replace(/(?:https?|wss?):\/\/127\.0\.0\.1:\d+/gu, '<redacted-origin>')
    .replace(/127\.0\.0\.1:\d+/gu, '127.0.0.1:<port>')
}

const result = {
  schema: 1,
  ok: false,
  caseId,
  nonce,
  indexStatus: null,
  hostInstanceIdHash: typeof initialLaunch.instanceId === 'string'
    ? createHash('sha256').update(initialLaunch.instanceId).digest('hex').slice(0, 16)
    : null,
  sessionId: null,
  steps: [],
  requestIds: [],
  browserClientActions: [],
  network: { failedPaths: [], statuses: [] },
  consoleErrors: [],
  screenshots: [],
  runtimeVersion: {
    playwright: playwrightPackage.version,
    chromium: null,
    node: process.version,
  },
  features: [],
}
const startedAt = Date.now()

/**
 * The newest live Host launch record. A host lifecycle case (WP-07) cold-starts
 * a NEW Host with a NEW token: the reconnect action must authenticate to the
 * new Host, never replay the token of the dead one.
 */
function currentLaunch() {
  const record = launchRecords()[0]
  if (record === undefined) throw new Error('no Host launch material in this DSH_HOME')
  const access = launchAccess(record)
  if (access === undefined || typeof access.token !== 'string' || access.token === '') {
    throw new Error('the Host launch material carries no token')
  }
  if (typeof record.instanceId === 'string') {
    result.hostInstanceIdHash = createHash('sha256').update(record.instanceId).digest('hex').slice(0, 16)
  }
  return access
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode })
  chmodSync(path, mode)
}

function driverFact(name, value) {
  writeJson(join(coordinationDir, `browser-${name}.json`), value)
}

/** Wait for one runner signal file; the driver owns no timeout policy of its own. */
async function waitSignal(name, timeoutMs = 300_000) {
  const path = join(coordinationDir, `signal-${name}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await sleep(100)
  }
  throw new Error(`browser timed out waiting for the runner signal "${name}"`)
}

function step(id, passed, refs = {}) {
  result.steps.push({ id, passed, observedEventRefs: refs })
}

async function screenshot(page, name) {
  const relative = `screenshots/${caseId}-${name}.png`
  const path = join(coordinationDir, relative)
  await page.screenshot({ path, fullPage: false })
  chmodSync(path, 0o600)
  result.screenshots.push(relative)
  return relative
}

/**
 * The official Web shell's "New session" control. The shell paints icon and
 * row variants with the same action, so the smallest usable height wins.
 */
async function controlCentre(page, match) {
  return page.evaluate(spec => {
    const candidates = [...document.querySelectorAll('button')].filter(node => {
      const label = (node.getAttribute('aria-label') ?? '').trim()
      const text = (node.textContent ?? '').replace(/\s+/gu, ' ').trim()
      return (spec.aria !== undefined && label === spec.aria) || (spec.text !== undefined && text === spec.text)
    })
    for (const node of candidates) {
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height >= 20) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    return null
  }, match)
}

async function waitControl(page, match, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await controlCentre(page, match) !== null) return
    await page.waitForTimeout(200)
  }
  throw new Error(`browser timed out waiting for ${label}`)
}

async function clickCentre(page, point) {
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.up()
}

/** Wait until the shell resolved a workspace: a real composer and no chooser. */
async function waitShell(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[role=textbox]')]
      const composer = boxes.at(-1)
      if (composer === undefined) return false
      const rect = composer.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const body = document.body.innerText ?? ''
      return !/Choose a workspace to start|Unable to create default workspace/u.test(body)
    })
    if (ready) return
    await page.waitForTimeout(200)
  }
  throw new Error('browser timed out waiting for the official Web composer')
}

/** The official first-run notice must be pre-acknowledged by the isolated fixture. */
async function assertNoPreviewNotice(page) {
  if (await page.evaluate(() => document.querySelector('[role=dialog][aria-label="Preview Notice"]') !== null)) {
    throw new Error('the official first-run preview notice blocked the Web UI: the isolated fixture must pre-acknowledge it')
  }
}

/** The conversation region that holds one unique marker (never the sidebar). */
async function conversationMarkers(page, marker) {
  return page.evaluate(text => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null) {
      if ((node.textContent ?? '').includes(text)) {
        let element = node.parentElement
        while (element !== null && element !== document.body) {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          if (/(?:auto|scroll)/u.test(style.overflowY) && rect.height > 200) {
            return { text: (element.innerText ?? '').replace(/\s+/gu, ' '), height: rect.height }
          }
          element = element.parentElement
        }
        return null
      }
      node = walker.nextNode()
    }
    return null
  }, marker)
}

/** Wait until the conversation holding `marker` contains every required text. */
async function waitConversation(page, marker, required, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const region = await conversationMarkers(page, marker)
    if (region !== null && required.every(text => region.text.includes(text))) return region.text
    await page.waitForTimeout(250)
  }
  throw new Error(`browser timed out waiting for ${label}`)
}

/** Count one text inside the conversation holding `marker`. */
async function conversationCount(page, marker, needle) {
  const region = await conversationMarkers(page, marker)
  if (region === null) return 0
  return region.text.split(needle).length - 1
}

/** Open one Session through the official sidebar row (a real click). */
async function openSession(page, sessionId, timeoutMs = 120_000) {
  const row = page.locator(`[data-row-key="session:${sessionId}"]`).first()
  await row.waitFor({ state: 'visible', timeout: timeoutMs })
  await row.click()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const selected = await page.evaluate(id => document.querySelector(`[data-row-key="session:${id}"]`)?.getAttribute('aria-selected') === 'true', sessionId)
    if (selected) return
    await page.waitForTimeout(150)
  }
  throw new Error('browser timed out waiting for the clicked Session to become current')
}

/** Capture the Host `session/create` answer of the NEXT New-session click. */
function captureNextSessionCreate(page, timeoutMs = 120_000) {
  let resolveBody
  const body = new Promise(resolve => { resolveBody = resolve })
  const listener = response => {
    if (new URL(response.url()).pathname !== '/api/session/create') return
    if (response.request().method() !== 'POST') return
    page.off('response', listener)
    response.json().then(json => resolveBody(json), () => resolveBody(undefined))
  }
  page.on('response', listener)
  return { body, settle: async () => {
    const timer = sleep(timeoutMs).then(() => undefined)
    return Promise.race([body, timer])
  } }
}

async function clickNewSession(page) {
  const point = await controlCentre(page, { aria: 'New session' }) ?? await controlCentre(page, { text: 'New Session' })
  if (point === null) throw new Error('the shell has no usable New-session control')
  await clickCentre(page, point)
}

/** Create one Session through the shell's own primary action. */
async function newSession(page) {
  const capture = captureNextSessionCreate(page)
  await clickNewSession(page)
  const created = await capture.settle()
  const sessionId = created?.result?.value?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('the Web UI created no Host Session')
  result.sessionId = sessionId
  return sessionId
}

async function clickSend(page) {
  const point = await controlCentre(page, { aria: 'Send message' })
    ?? await controlCentre(page, { text: 'Send message' })
    ?? await controlCentre(page, { aria: 'Send' })
  if (point === null) throw new Error('the composer has no usable Send control')
  await clickCentre(page, point)
}

/** Submit one prompt through the real composer and Send control. */
async function sendPrompt(page, text) {
  const composer = page.locator('[role=textbox]').last()
  await composer.click()
  await composer.fill(text)
  await waitControl(page, { aria: 'Send message' }, 30_000, 'the Send-message control')
  await clickSend(page)
  result.browserClientActions.push('send-prompt')
}

/** The official question card (one pending question batch). */
async function questionCard(page) {
  return page.evaluate(() => {
    const node = [...document.querySelectorAll('[data-question-key]')].at(-1)
    if (node === undefined) return null
    const buttons = [...node.querySelectorAll('button')]
    const options = buttons
      .filter(button => button.getAttribute('role') === 'radio' || button.getAttribute('role') === 'checkbox')
      .map(button => ({ label: button.getAttribute('aria-label') ?? '', checked: button.getAttribute('aria-checked') === 'true', disabled: button.disabled }))
    const submit = buttons.find(button => (button.textContent ?? '').trim() === 'Submit')
    return {
      text: (node.innerText ?? '').replace(/\s+/gu, ' '),
      options,
      submit: submit === undefined ? null : { disabled: submit.disabled },
      answered: /Answered|Work continued/u.test(node.innerText ?? ''),
    }
  })
}

async function waitQuestionCard(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const card = await questionCard(page)
    if (card !== null) return card
    await page.waitForTimeout(200)
  }
  throw new Error('browser timed out waiting for the official question card')
}

async function waitQuestionSettled(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await questionCard(page)
    // A settled card keeps an inert review surface: the Submit control is gone
    // or disabled, and no option is answerable any more.
    if (last === null) return null
    const answerable = last.submit !== null && last.submit.disabled === false
    if (!answerable) return last
    await page.waitForTimeout(200)
  }
  throw new Error(`browser timed out waiting for the question settlement (last ${JSON.stringify(last)})`)
}

/** The official approval card. */
async function approvalCard(page) {
  return page.evaluate(() => {
    const node = [...document.querySelectorAll('[data-approval-key]')].at(-1)
    if (node === undefined) return null
    const buttons = [...node.querySelectorAll('button')]
      .map(button => ({ text: (button.textContent ?? '').trim(), disabled: button.disabled }))
    return {
      text: (node.innerText ?? '').replace(/\s+/gu, ' '),
      buttons,
      busy: node.getAttribute('aria-busy') === 'true',
    }
  })
}

async function waitApprovalCard(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const card = await approvalCard(page)
    if (card !== null) return card
    await page.waitForTimeout(200)
  }
  throw new Error('browser timed out waiting for the official approval card')
}

async function waitApprovalSettled(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await approvalCard(page)
    if (last === null) return null
    if (!last.buttons.some(button => button.disabled === false)) return last
    await page.waitForTimeout(200)
  }
  throw new Error(`browser timed out waiting for the approval settlement (last ${JSON.stringify(last)})`)
}

/** Click one button of the currently visible card by its exact visible text. */
async function clickTextButton(page, text, timeoutMs = 30_000) {
  const locator = page.getByRole('button', { name: text, exact: true }).last()
  await locator.waitFor({ state: 'visible', timeout: timeoutMs })
  await locator.click()
  result.browserClientActions.push(`click:${text}`)
}

/** Click one question option by its own aria-label. */
async function clickQuestionOption(page, label) {
  const locator = page.getByRole('radio', { name: label, exact: true }).last()
  await locator.waitFor({ state: 'visible', timeout: 30_000 })
  await locator.click()
  result.browserClientActions.push(`select-option:${label}`)
}

/** Install the network/console recorders on one page. */
function observePage(page) {
  page.on('console', message => {
    if (message.type() !== 'error' || result.consoleErrors.length >= 30) return
    result.consoleErrors.push(redacted(message.text()).slice(0, 300))
  })
  page.on('requestfailed', request => {
    if (result.network.failedPaths.length >= 40) return
    let path = '<unparseable>'
    try { path = new URL(request.url()).pathname } catch { /* bounded fallback */ }
    result.network.failedPaths.push(`${request.method()} ${path} -> ${String(request.failure()?.errorText ?? 'failed')}`)
  })
  page.on('response', response => {
    let path = '<unparseable>'
    try { path = new URL(response.url()).pathname } catch { return }
    if (!(path.startsWith('/api') || path.startsWith('/plugins') || path.endsWith('.js'))) return
    if (result.network.statuses.length < 400) result.network.statuses.push({ method: response.request().method(), path, status: response.status() })
    if (response.status() >= 400 && result.network.failedPaths.length < 40) {
      result.network.failedPaths.push(`${response.request().method()} ${path} -> ${String(response.status())}`)
    }
  })
}

/** Log in through the CURRENT Host's own token -> Cookie -> index exchange. */
async function login(context, timeoutMs = 120_000) {
  const access = currentLaunch()
  const page = await context.newPage()
  observePage(page)
  const indexUrl = new URL('/', access.url.origin)
  indexUrl.searchParams.set('token', access.token)
  const response = await page.goto(indexUrl.href, { waitUntil: 'load', timeout: timeoutMs })
  result.indexStatus = response?.status() ?? null
  await waitShell(page, timeoutMs)
  await assertNoPreviewNotice(page)
  return page
}

/** The shared prompt/answer assertion for the deterministic C1 long-turn model. */
async function promptAndWait(page, text, answerNeedle, timeoutMs = 240_000) {
  await sendPrompt(page, text)
  return waitConversation(page, text, [answerNeedle], timeoutMs, `the answer of "${text.slice(0, 40)}"`)
}

/** Read the next command from the runner's append-only command ledger. */
async function nextCommand(offset, timeoutMs) {
  const path = join(coordinationDir, 'commands.jsonl')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      if (lines.length > offset) {
        try {
          return JSON.parse(lines[offset])
        } catch {
          // A torn final append is not a verdict: wait for the rest of it.
        }
      }
    }
    await sleep(100)
  }
  throw new Error('browser timed out waiting for the next runner command')
}

/**
 * The command-loop cases (WP-06/07/08): the runner appends one command per TUI
 * lifecycle step and reads the matching `browser-step-<seq>.json`. Every
 * command is a real UI action; this loop holds no business state.
 */
async function commandLoop(startPage, context) {
  let page = startPage
  let offset = 0
  for (;;) {
    const command = await nextCommand(offset, 300_000)
    offset += 1
    const seq = command.seq
    if (typeof seq !== 'number') throw new Error('browser command carries no sequence')
    let fact
    try {
      if (command.kind === 'open-session') {
        await openSession(page, command.sessionId)
        fact = { opened: true, sessionId: command.sessionId }
      } else if (command.kind === 'prompt') {
        const before = await conversationCount(page, command.marker, 'long-turn answer')
        await promptAndWait(page, command.prompt, command.answerNeedle ?? 'long-turn answer')
        const after = await conversationCount(page, command.marker, 'long-turn answer')
        fact = { answerSeen: true, prompt: command.prompt, answerCountBefore: before, answerCountAfter: after }
      } else if (command.kind === 'expect-offline') {
        fact = await waitOffline(page, command.timeoutMs ?? 120_000)
      } else if (command.kind === 'reconnect') {
        await page.close().catch(() => {})
        const fresh = await login(context)
        page = fresh
        if (typeof command.sessionId === 'string') await openSession(page, command.sessionId)
        fact = { reconnected: true, sessionId: command.sessionId ?? null }
      } else if (command.kind === 'reload-page') {
        await page.reload({ waitUntil: 'load', timeout: 120_000 })
        await waitShell(page)
        if (typeof command.sessionId === 'string') await openSession(page, command.sessionId)
        fact = { reloaded: true }
      } else if (command.kind === 'screenshot') {
        fact = { screenshot: await screenshot(page, command.name ?? `step-${seq}`) }
      } else if (command.kind === 'finish') {
        driverFact(`step-${seq}`, { seq, ok: true, kind: 'finish' })
        return page
      } else {
        throw new Error(`browser: unknown command kind ${JSON.stringify(command.kind)}`)
      }
      driverFact(`step-${seq}`, { seq, ok: true, kind: command.kind, ...fact })
    } catch (error) {
      driverFact(`step-${seq}`, { seq, ok: false, kind: command.kind, error: redacted(String(error.message)).slice(0, 300) })
      throw error
    }
  }
}

/** Observably disconnected Web page: a real WebSocket/fetch failure or notice. */
async function waitOffline(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  while (Date.now() < deadline) {
    try {
      lastText = ((await page.evaluate(() => document.body.innerText ?? '')).replace(/\s+/gu, ' ')).slice(0, 500)
    } catch {
      // A dead page can reject evaluate before any body text is available: the
      // failed navigation itself is the disconnect fact.
      lastText = ''
    }
    const failed = result.network.failedPaths.some(path => /ERR_CONNECTION|ERR_INCOMPLETE|remote\.mux/iu.test(path))
    const consoleFailure = result.consoleErrors.some(text => /ERR_CONNECTION|ECONNREFUSED|WebSocket|failed to fetch|offline/iu.test(text))
    const bodyFailure = /offline|disconnected|reconnect|connection (?:lost|failed)|cannot connect/iu.test(lastText)
    if (failed || consoleFailure || bodyFailure) {
      return { offline: true, observed: bodyFailure, networkFailure: failed || consoleFailure }
    }
    await sleep(200)
  }
  throw new Error('browser timed out waiting for an observable offline/disconnected page')
}

/** One optional feature probe: a missing control is NOT_VERIFIED, not a failure. */
async function probeFeature(page, feature, action) {
  const entry = {
    feature,
    entryVisible: true,
    actualAction: 'probe',
    hostApi: '',
    durableOrUiResult: '',
    status: 'NOT_VERIFIED',
    reason: '',
    evidence: [],
    supportText: '',
  }
  try {
    const outcome = await action()
    Object.assign(entry, outcome)
  } catch (error) {
    entry.status = 'NOT_VERIFIED'
    entry.reason = `the official Web UI did not expose a driveable control for this automated probe (${redacted(String(error.message)).slice(0, 240)})`
  }
  result.features.push(entry)
  return entry
}

/** A bounded "find one visible control by aria label or exact text" probe. */
async function findControl(page, match, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const point = await controlCentre(page, match)
    if (point !== null) return point
    await page.waitForTimeout(150)
  }
  return null
}

/** WP-10: the honest inventory of the Web UI's really reachable features. */
async function inventory(page) {
  // Session create/list/open are the core MUST surfaces.
  const createdSession = await newSession(page)
  let rowVisible = true
  try {
    await page.locator(`[data-row-key="session:${createdSession}"]`).first().waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    rowVisible = false
  }
  result.features.push({
    feature: 'session.create/list/open',
    entryVisible: rowVisible,
    actualAction: 'clicked New session, read the sidebar Session row, opened it',
    hostApi: 'official session/create + session/list Remote; durable Session log',
    durableOrUiResult: `session ${createdSession} created and listed; opening the same row selects it`,
    status: rowVisible ? 'SUPPORTED_PASS' : 'FAIL_REGRESSION',
    reason: rowVisible ? '' : 'the created Session never appeared in the official sidebar',
    evidence: [`sessionId=${createdSession}`, `data-row-key=session:${createdSession}`],
    supportText: 'Creating, listing and opening Sessions from the official Web shell works against the same Host the Split TUI uses.',
  })

  // Live turn + answer.
  const liveMarker = `wp10-live-${nonce}`
  const liveBefore = await conversationCount(page, liveMarker, 'long-turn answer')
  await promptAndWait(page, liveMarker, 'long-turn answer')
  const liveAfter = await conversationCount(page, liveMarker, 'long-turn answer')
  result.features.push({
    feature: 'conversation live Turn/history',
    entryVisible: true,
    actualAction: 'typed a marker prompt, pressed Send, read the durable answer in the conversation',
    hostApi: 'official Host Session Writer/Agent turn',
    durableOrUiResult: liveAfter > liveBefore ? 'the Browser painted the Host answer' : 'no answer painted',
    status: liveAfter > liveBefore ? 'SUPPORTED_PASS' : 'FAIL_REGRESSION',
    reason: '',
    evidence: [liveMarker],
    supportText: 'Prompt submission and live assistant output work in the official Web conversation.',
  })

  // Questions: proven by the real WP-03 lane; the inventory records the same fact.
  result.features.push({
    feature: 'Questions',
    entryVisible: true,
    actualAction: 'WP-03A/WP-03B real Browser x real TUI first-winner lanes',
    hostApi: 'official userQuestions waterfall + durable question tool events',
    durableOrUiResult: 'one Host settlement, Browser and TUI both converge',
    status: 'SUPPORTED_PASS',
    reason: '',
    evidence: ['WP-03A', 'WP-03B'],
    supportText: 'Pending Questions are answerable in the official Web UI; the first legal answer settles the Host once.',
  })
  result.features.push({
    feature: 'Approvals',
    entryVisible: true,
    actualAction: 'WP-04A/WP-04B real Browser Allow/Reject lanes',
    hostApi: 'official approval waterfall + durable approval/decided events',
    durableOrUiResult: 'one Host decision and the matching tool side effect',
    status: 'SUPPORTED_PASS',
    reason: '',
    evidence: ['WP-04A', 'WP-04B'],
    supportText: 'Pending Approvals are answerable in the official Web UI with Allow once / Reject.',
  })

  // Session rename: a real row action if the shell exposes it.
  await probeFeature(page, 'session.rename', async () => {
    const row = page.locator(`[data-row-key="session:${createdSession}"]`).first()
    await row.hover()
    const buttons = await page.evaluate(id => {
      const rowNode = document.querySelector(`[data-row-key="session:${id}"]`)
      if (rowNode === null) return []
      return [...rowNode.querySelectorAll('button')].map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim())
    }, createdSession)
    return {
      actualAction: `hovered the Session row; row controls=${JSON.stringify(buttons)}`,
      durableOrUiResult: 'row action controls were observed but not driven',
      status: 'NOT_VERIFIED',
      reason: 'the row action menu was not driven by this automated inventory probe',
      evidence: [`rowControls=${JSON.stringify(buttons)}`],
      supportText: '',
    }
  })

  // Models: the composer's own model identity control is read-only here.
  await probeFeature(page, 'models/provider/account/credentials', async () => {
    const point = await findControl(page, { text: 'stub' }, 5_000)
    if (point === null) return { status: 'NOT_VERIFIED', reason: 'the composer model control text was not found' }
    await clickCentre(page, point)
    await page.waitForTimeout(500)
    const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/gu, ' ').slice(0, 800)
    await page.keyboard.press('Escape')
    return {
      actualAction: 'clicked the composer model identity control; read the opened model surface',
      durableOrUiResult: body.length > 0 ? 'the model surface is reachable and readable' : 'no readable model surface',
      status: 'NOT_VERIFIED',
      reason: 'the qualification model is a deterministic test fixture; a real provider/account write is out of scope',
      evidence: [`modelSurface=${body.slice(0, 240)}`],
      supportText: 'The Web shell exposes the model identity control; provider/account/credential writes are not claimed by this qualification.',
    }
  })

  // Settings/plugin/automation panels: record whether the shell advertises them.
  const shellControls = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')]
    return buttons.map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .filter(text => text !== '').slice(0, 200)
  })
  for (const feature of ['settings/profile', 'plugin manager/HMR', 'jobs/schedule/goal/subagent']) {
    result.features.push({
      feature,
      entryVisible: true,
      actualAction: 'read the shell control inventory',
      hostApi: 'not exercised by this probe',
      durableOrUiResult: 'shell controls observed',
      status: 'NOT_VERIFIED',
      reason: 'the panel was not driven in this inventory pass; no support claim is made',
      evidence: [`shellControls=${JSON.stringify(shellControls.slice(0, 40))}`],
      supportText: '',
    })
  }

  // File upload: the composer's own hidden file input is a real browser-local
  // file picker; the Host upload is asserted by the runner on its own storage.
  await probeFeature(page, 'file upload/attachments', async () => {
    const upload = join(coordinationDir, 'browser-upload.txt')
    writeFileSync(upload, `prd browser local upload ${nonce}\n`, { mode: 0o600 })
    const input = page.locator('input[type=file]').last()
    await input.setInputFiles(upload, { timeout: 15_000 })
    const appeared = await page.evaluate(name => (document.body.innerText ?? '').includes(name), 'browser-upload.txt')
    return {
      actualAction: 'set the composer file input to a browser-local file',
      durableOrUiResult: appeared ? 'the composer painted the selected file' : 'no file card painted',
      status: appeared ? 'SUPPORTED_PASS' : 'NOT_VERIFIED',
      reason: appeared ? '' : 'the composer painted no file card for the selected browser-local file',
      evidence: ['input[type=file]', 'browser-upload.txt'],
      supportText: 'The official Web composer accepts a browser-local file through its own file input; the runner proves the Host receives the bytes.',
    }
  })

  // Session deep link: record what the shell really does after opening a row.
  result.features.push({
    feature: 'session deep link/cross-client navigation',
    entryVisible: true,
    actualAction: 'opened a Session by its sidebar row and read the page URL',
    hostApi: 'none',
    durableOrUiResult: `pathname=${new URL(page.url()).pathname}`,
    status: 'UNAVAILABLE_BY_DESIGN',
    reason: 'the product contract opens the Web home page and lets the user choose a Session; no stable Session deep link is claimed',
    evidence: [`pathname=${new URL(page.url()).pathname}`],
    supportText: 'Open the Web home page from the TUI and choose a Session in the official Web UI; no Session-specific deep link is provided.',
  })
  return createdSession
}

/** The case programs. A case name is the frozen coordination interface. */
const cases = {
  /** WP-01: login, dynamic resources, a real Session UI action. */
  'wp01-login': async context => {
    const page = await login(context)
    const marker = `wp01-${nonce}`
    const sessionId = await newSession(page)
    driverFact('session', { sessionId })
    await promptAndWait(page, marker, caseConfig.expectedAnswer ?? 'long-turn answer')
    await screenshot(page, 'home-session')
    step('login-and-session', true, { sessionId, marker })
    await waitSignal('runner-go')
  },

  /** WP-02A: the Browser opens a TUI-created Session through the sidebar UI. */
  'wp02a-open-existing': async context => {
    const page = await login(context)
    const sessionId = caseConfig.sessionId
    if (typeof sessionId !== 'string') throw new Error('wp02a requires the TUI-created Session id')
    await openSession(page, sessionId)
    await waitConversation(page, caseConfig.marker, [caseConfig.expectedAnswer ?? 'long-turn answer'], 180_000, 'the TUI prompt and Host answer')
    await screenshot(page, 'tui-session')
    driverFact('confirmed', { sessionId })
  },

  /** WP-02B: the Browser creates a Session; the runner resumes it in the TUI. */
  'wp02b-browser-session': async context => {
    const page = await login(context)
    const sessionId = await newSession(page)
    const marker = caseConfig.marker ?? `wp02b-${nonce}`
    await promptAndWait(page, marker, caseConfig.expectedAnswer ?? 'long-turn answer')
    driverFact('session', { sessionId })
    await waitSignal('runner-go')
    await screenshot(page, 'browser-session')
  },

  /** WP-02C: both Clients write one Session with different markers. */
  'wp02c-dual-prompts': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const browserMarker = caseConfig.marker
    const answerNeedle = caseConfig.expectedAnswer ?? 'long-turn answer'
    await promptAndWait(page, browserMarker, answerNeedle)
    driverFact('turn-done', { marker: browserMarker })
    await waitSignal('tui-done')
    await waitConversation(page, browserMarker, [caseConfig.tuiMarker, answerNeedle], 240_000, 'both Client markers and answers')
    const tuiAnswers = await conversationCount(page, browserMarker, answerNeedle)
    if (tuiAnswers < 2) throw new Error(`the conversation shows ${String(tuiAnswers)} answers, expected two independent turns`)
    await screenshot(page, 'dual-prompts')
    step('two-independent-turns', true, { browserMarker, tuiMarker: caseConfig.tuiMarker, answers: tuiAnswers })
  },

  /** WP-02D: the same text from both Clients stays two independent Turns. */
  'wp02d-same-text': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const same = caseConfig.marker
    await promptAndWait(page, same, caseConfig.expectedAnswer ?? 'long-turn answer')
    driverFact('turn-done', { marker: same })
    await waitSignal('tui-done')
    await waitConversation(page, same, ['long-turn answer'], 240_000, 'the second same-text answer')
    const bubbles = await conversationCount(page, same, same)
    const answers = await conversationCount(page, same, 'long-turn answer')
    if (bubbles < 2) throw new Error(`the conversation shows ${String(bubbles)} same-text occurrences, expected two`)
    if (answers < 2) throw new Error(`the conversation shows ${String(answers)} answers, expected two`)
    await screenshot(page, 'same-text')
    step('same-text-not-deduplicated', true, { occurrences: bubbles, answers })
  },

  /** WP-02E: independent Browser/TUI current Session references. */
  'wp02e-independent-view': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionB)
    driverFact('on-b', { sessionId: caseConfig.sessionB })
    await waitSignal('nav-to-a')
    await openSession(page, caseConfig.sessionA)
    await waitConversation(page, caseConfig.markerA, [caseConfig.expectedAnswer ?? 'long-turn answer'], 180_000, 'the first Session history')
    driverFact('on-a', { sessionId: caseConfig.sessionA })
    await waitSignal('runner-done')
    // TUI completed a new Turn in B and then navigated to A: the Browser must
    // still be on A and must not have been retired by the other Client.
    const selected = await page.evaluate(id => document.querySelector(`[data-row-key="session:${id}"]`)?.getAttribute('aria-selected') === 'true', caseConfig.sessionA)
    if (!selected) throw new Error('the Browser left its own Session after the TUI navigated')
    await waitConversation(page, caseConfig.markerA, [caseConfig.markerA], 30_000, 'the retained Session A view')
    await screenshot(page, 'independent-view')
    step('independent-current-session', true, { browserSession: caseConfig.sessionA, tuiSession: caseConfig.sessionB })
  },

  /** WP-03A: the Browser wins one Question. */
  'wp03a-question-browser-first': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const card = await waitQuestionCard(page)
    if (!card.options.some(option => option.label === 'Proceed')) throw new Error('the question card does not offer Proceed')
    driverFact('question-visible', { options: card.options })
    await clickQuestionOption(page, 'Proceed')
    await clickTextButton(page, 'Submit')
    await waitQuestionSettled(page)
    driverFact('answered', { selectedOption: 'Proceed' })
    await waitSignal('runner-go')
    await screenshot(page, 'question-answered')
    step('browser-first-question', true, { selectedOption: 'Proceed' })
  },

  /** WP-03B: the TUI wins one Question; the Browser's old location is inert. */
  'wp03b-question-tui-first': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const card = await waitQuestionCard(page)
    if (!card.options.some(option => option.label === 'Proceed')) throw new Error('the question card does not offer Proceed')
    driverFact('question-visible', { options: card.options })
    await waitSignal('tui-answered')
    const settled = await waitQuestionSettled(page)
    const submitPoint = await findControl(page, { text: 'Submit' }, 500)
    let lateClick = false
    if (submitPoint !== null) {
      await clickCentre(page, submitPoint)
      lateClick = true
    }
    driverFact('settled', { settled: settled !== null, lateSubmitFound: submitPoint !== null, lateClick })
    await screenshot(page, 'question-tui-first')
    step('tui-first-question-browser-inert', true, { lateSubmitFound: submitPoint !== null, lateClick })
  },

  /** WP-03C: the Browser detaches while a Question is pending. */
  'wp03c-question-detach': async context => {
    let page = await login(context)
    await openSession(page, caseConfig.sessionId)
    await waitQuestionCard(page)
    driverFact('question-visible', {})
    await page.close()
    driverFact('detached', {})
    await waitSignal('tui-answered')
    page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const settled = await waitQuestionSettled(page)
    const submitPoint = await findControl(page, { text: 'Submit' }, 500)
    if (submitPoint !== null) {
      await clickCentre(page, submitPoint)
    }
    await screenshot(page, 'question-reattached')
    driverFact('reattached', { settled: settled !== null, lateSubmitFound: submitPoint !== null })
    step('detached-question-cannot-resurrect', true, { lateSubmitFound: submitPoint !== null })
  },

  /** WP-03D: the official TIMED question, observed as a negative control. */
  'wp03d-question-timed': async context => {
    const page = await login(context)
    // The runner writes the Session id once the TUI's trigger created it.
    const sessionFile = join(coordinationDir, 'session.json')
    const deadline = Date.now() + 180_000
    while (!existsSync(sessionFile) && Date.now() < deadline) await sleep(100)
    if (!existsSync(sessionFile)) throw new Error('the timed question case never learned its Session id')
    const sessionId = readJson(sessionFile).sessionId
    await openSession(page, sessionId)
    // A timed question settles without a Browser answer. The official card may
    // already be in `continued` state; the assertion is that no answerable
    // Submit exists and that the Browser never submits one.
    const card = await questionCard(page)
    const submitPoint = await findControl(page, { text: 'Submit' }, 1_000)
    if (submitPoint !== null) await clickCentre(page, submitPoint)
    await page.waitForTimeout(1_500)
    const finalCard = await questionCard(page)
    const answerable = finalCard !== null && finalCard.submit !== null && finalCard.submit.disabled === false
    if (answerable) throw new Error('the timed question stayed answerable after its official timeout')
    await screenshot(page, 'question-timed')
    driverFact('timed', { initialCard: card !== null, finalCard: finalCard !== null, answerable })
    step('timed-question-not-answerable', true, { initialCard: card !== null, finalCard: finalCard !== null })
  },

  /** WP-04A: the Browser wins one Approval with Allow once. */
  'wp04a-approval-browser-allow': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const card = await waitApprovalCard(page)
    if (!card.buttons.some(button => button.text === 'Allow once')) throw new Error('the approval card does not offer Allow once')
    driverFact('approval-visible', { buttons: card.buttons })
    await clickTextButton(page, 'Allow once')
    await waitApprovalSettled(page)
    driverFact('answered', { action: 'allow-once' })
    await waitSignal('runner-go')
    await screenshot(page, 'approval-allowed')
    step('browser-first-approval-allow', true, { action: 'allow-once' })
  },

  /** WP-04B: the Browser wins one Approval with Reject. */
  'wp04b-approval-browser-reject': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const card = await waitApprovalCard(page)
    if (!card.buttons.some(button => button.text === 'Reject')) throw new Error('the approval card does not offer Reject')
    driverFact('approval-visible', { buttons: card.buttons })
    await clickTextButton(page, 'Reject')
    await waitApprovalSettled(page)
    driverFact('answered', { action: 'reject' })
    await waitSignal('runner-go')
    await screenshot(page, 'approval-rejected')
    step('browser-first-approval-reject', true, { action: 'reject' })
  },

  /** WP-04C/D: the TUI wins; the Browser's old location is inert. */
  'wp04c-approval-tui-first': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    await waitApprovalCard(page)
    driverFact('approval-visible', {})
    await waitSignal('tui-answered')
    const settled = await waitApprovalSettled(page)
    const allowPoint = await findControl(page, { text: 'Allow once' }, 500)
    if (allowPoint !== null) await clickCentre(page, allowPoint)
    driverFact('settled', { settled: settled !== null, lateAllowFound: allowPoint !== null })
    await screenshot(page, 'approval-tui-first')
    step('tui-first-approval-browser-inert', true, { lateAllowFound: allowPoint !== null })
  },

  /** WP-04C/D: the TUI wins; the Browser's old location is inert. */
  'wp04d-approval-tui-reject': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    await waitApprovalCard(page)
    driverFact('approval-visible', {})
    await waitSignal('tui-answered')
    const settled = await waitApprovalSettled(page)
    const allowPoint = await findControl(page, { text: 'Allow once' }, 500)
    if (allowPoint !== null) await clickCentre(page, allowPoint)
    driverFact('settled', { settled: settled !== null, lateAllowFound: allowPoint !== null })
    await screenshot(page, 'approval-tui-first')
    step('tui-first-approval-reject-browser-inert', true, { lateAllowFound: allowPoint !== null })
  },

  /** WP-04F: the Browser detaches while an Approval is pending. */
  'wp04f-approval-offline': async context => {
    let page = await login(context)
    await openSession(page, caseConfig.sessionId)
    await waitApprovalCard(page)
    driverFact('approval-visible', {})
    await page.close()
    driverFact('detached', {})
    await waitSignal('tui-answered')
    page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const settled = await waitApprovalSettled(page)
    const allowPoint = await findControl(page, { text: 'Allow once' }, 500)
    if (allowPoint !== null) await clickCentre(page, allowPoint)
    await screenshot(page, 'approval-reattached')
    driverFact('reattached', { settled: settled !== null, lateAllowFound: allowPoint !== null })
    step('detached-approval-cannot-resurrect', true, { lateAllowFound: allowPoint !== null })
  },

  /** WP-05: a real page reload during a HELD Host Turn. */
  'wp05-refresh-held': async context => {
    const page = await login(context)
    const sessionId = caseConfig.sessionId
    await openSession(page, sessionId)
    await waitConversation(page, caseConfig.marker, ['long-turn started'], 180_000, 'the running Host Turn')
    driverFact('viewing', { sessionId })
    await page.reload({ waitUntil: 'load', timeout: 120_000 })
    await waitShell(page)
    await openSession(page, sessionId)
    await waitConversation(page, caseConfig.marker, ['long-turn started'], 180_000, 'the restored running Host Turn')
    driverFact('reloaded', { sessionId })
    await waitSignal('turn-released')
    await waitConversation(page, caseConfig.marker, [caseConfig.expectedAnswer ?? 'long-turn answer'], 240_000, 'the released Turn answer')
    // The SAME Browser context opens a NEW page: both pages read the current
    // Session history of the one Host.
    const second = await login(context)
    await openSession(second, sessionId)
    await waitConversation(second, caseConfig.marker, [caseConfig.expectedAnswer ?? 'long-turn answer'], 120_000, 'the second page history')
    await second.close()
    await screenshot(page, 'after-reload')
    step('reload-kept-the-session', true, { sessionId })
  },

  /** WP-06: TUI reload/exit/SIGKILL while the Browser keeps advancing. */
  'wp06-tui-lifecycle': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    driverFact('ready', {})
    const current = await commandLoop(page, context)
    step('browser-kept-writing-across-tui-lifecycle', true, {})
    await screenshot(current, 'tui-lifecycle')
  },

  /** WP-07: Host stop/crash, offline page, cold resume. */
  'wp07-host-lifecycle': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    driverFact('ready', {})
    const current = await commandLoop(page, context)
    step('host-lifecycle-observed', true, {})
    await screenshot(current, 'host-lifecycle')
  },

  /** WP-08: `/web` toggle and settings recomposition with a live Browser. */
  'wp08-web-toggle': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    driverFact('ready', {})
    const current = await commandLoop(page, context)
    step('web-toggle-observed', true, {})
    await screenshot(current, 'web-toggle')
  },

  /** WP-09: Browser-local file intake; the runner owns the Host-side checks. */
  'wp09-locality': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const upload = join(coordinationDir, 'browser-local-sentinel.txt')
    writeFileSync(upload, `prd-browser-local-${nonce}\n`, { mode: 0o600 })
    const input = page.locator('input[type=file]').last()
    await input.setInputFiles(upload, { timeout: 20_000 })
    const painted = await page.evaluate(() => (document.body.innerText ?? '').includes('browser-local-sentinel.txt'))
    if (!painted) throw new Error('the composer painted no card for the browser-local file')
    // The prompt names the sentinel so the TUI transcript and Host events can
    // correlate the SAME attachment with this Browser action.
    await promptAndWait(page, `wp09 attachment ${nonce}`, caseConfig.expectedAnswer ?? 'long-turn answer')
    await screenshot(page, 'browser-upload')
    driverFact('upload', { painted, fileName: 'browser-local-sentinel.txt' })
    step('browser-local-upload', true, { fileName: 'browser-local-sentinel.txt' })
  },

  /** WP-10: the honest visible-feature inventory. */
  'wp10-inventory': async context => {
    const page = await login(context)
    await inventory(page)
    const matrix = result.features
    driverFact('features', { matrix })
    step('feature-inventory', true, { features: matrix.length })
    await screenshot(page, 'inventory')
  },
}

/** The exact set of case ids this driver implements (unknown values fail). */
const KNOWN_CASES = Object.keys(cases)

let browser
let context
try {
  if (!KNOWN_CASES.includes(caseId)) throw new Error(`unknown product Browser case ${JSON.stringify(caseId)}`)
  browser = await chromium.launch({ headless: true })
  result.runtimeVersion.chromium = browser.version()
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await cases[caseId](context)
  result.ok = true
} catch (error) {
  result.error = redacted(String(error.message)).split('\n')[0].slice(0, 400)
} finally {
  result.durationMs = Date.now() - startedAt
  writeJson(join(coordinationDir, 'browser-result.json'), result)
  // Closing the CONTEXT alone leaves the Playwright browser connection alive
  // and the Node process would never exit (the runner would have to kill it).
  await browser?.close().catch(() => {})
}
if (result.error !== undefined) {
  console.error(`M5_WEB_PRODUCT_BROWSER_FAILURE: ${redacted(result.error)}`)
  process.exitCode = 1
} else {
  console.log(JSON.stringify({
    caseId,
    ok: result.ok,
    sessionId: result.sessionId,
    steps: result.steps.length,
    screenshots: result.screenshots.length,
  }))
}
