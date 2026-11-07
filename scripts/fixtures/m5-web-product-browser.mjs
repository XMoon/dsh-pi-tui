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
import { request as httpRequest } from 'node:http'
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
    // Playwright can echo request/response headers in an error or console
    // line. The plan forbids Cookie/Authorization values in retained evidence;
    // redact the header LINE and any `name=value` variant.
    .replace(/(^|\n)\s*(cookie|set-cookie|authorization)\s*:[^\n]*/giu, '$1$2: <redacted>')
    .replace(/\b(cookie|set-cookie|authorization)=([^\s;,]+)/giu, '$1=<redacted>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gu, '$1<redacted>')
}

/**
 * Sanitize EVERY retained string recursively, then reject a surviving header
 * shape outright. A sensitive value must never reach the result file before
 * the runner's own check: the file is the artifact, not a candidate for a
 * later filter.
 */
function sanitizeValue(value) {
  if (typeof value === 'string') {
    const clean = redacted(value)
    return /(?:^|\n)\s*(?:cookie|set-cookie|authorization)\s*:/iu.test(clean) ? '<redacted-header>' : clean
  }
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]))
  }
  return value
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

/** Retain only official request ids the driver itself observed. */
function recordRequestIds(value) {
  for (const candidate of [value?.id, value?.requestId, value?.result?.id, value?.result?.requestId]) {
    if (typeof candidate === 'string' && candidate !== '' && !result.requestIds.includes(candidate)) {
      result.requestIds.push(candidate)
    }
  }
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

/** Wait for one fact the RUNNER writes into the shared coordination directory. */
async function waitForFactFile(name, timeoutMs) {
  const path = join(coordinationDir, `browser-${name}.json`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return readJson(path)
    await sleep(100)
  }
  throw new Error(`browser timed out waiting for the runner fact "${name}"`)
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
  result.sessionId = sessionId
  result.browserClientActions.push('open-session')
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
  result.browserClientActions.push('new-session')
  recordRequestIds(created)
  return sessionId
}

async function clickSend(page) {
  const point = await controlCentre(page, { aria: 'Send message' })
    ?? await controlCentre(page, { text: 'Send message' })
    ?? await controlCentre(page, { aria: 'Send' })
  if (point === null) throw new Error('the composer has no usable Send control')
  await clickCentre(page, point)
}

/**
 * Create one Session inside a NAMED Workspace through that Workspace row's own
 * "New session in <name>" action, so the Session's authoritative cwd is the
 * Workspace folder the action names.
 */
async function newSessionInWorkspace(page, workspaceLabel) {
  // The Workspace row arrives through the live Workspace stream; wait for it.
  const rowDeadline = Date.now() + 60_000
  let rowPoint = null
  while (rowPoint === null && Date.now() < rowDeadline) {
    rowPoint = await page.evaluate(label => {
      for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
        if (!(row.innerText ?? '').includes(label)) continue
        row.scrollIntoView({ block: 'center' })
        const rect = row.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      return null
    }, workspaceLabel)
    if (rowPoint === null) await page.waitForTimeout(250)
  }
  if (rowPoint === null) throw new Error(`the Web sidebar never painted the workspace "${workspaceLabel}"`)
  // The row action is revealed by hover; the create itself is the official
  // per-Workspace start-session path.
  await page.mouse.move(rowPoint.x, rowPoint.y)
  await page.waitForTimeout(300)
  const capture = captureNextSessionCreate(page)
  const action = page.getByRole('button', { name: `New session in ${workspaceLabel}`, exact: true }).last()
  await action.waitFor({ state: 'visible', timeout: 30_000 })
  await action.click()
  const created = await capture.settle()
  const sessionId = created?.result?.value?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error(`the "${workspaceLabel}" New-session action created no Host Session`)
  }
  result.sessionId = sessionId
  result.browserClientActions.push(`new-session-in:${workspaceLabel}`)
  recordRequestIds(created)
  return sessionId
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

/** One raw HTTP status with EXPLICIT headers (Node's http, no Browser API). */
function httpStatus(url, headers) {
  return new Promise(resolve => {
    const request = httpRequest(url, { method: 'GET', headers, timeout: 10_000 }, response => {
      // Only the status is needed. SSE (/plugins/events) would otherwise keep
      // this socket open until the idle timeout even after the status arrived.
      response.destroy()
      resolve(response.statusCode ?? 0)
    })
    request.on('timeout', () => { request.destroy(); resolve('timeout') })
    request.on('error', error => resolve(`refused:${error?.code ?? error?.name ?? 'error'}`))
    request.end()
  })
}

/**
 * WP-01 unauth negative controls with NO cookie/token. Wrong Host/Origin are
 * repeated WITH the authenticated cookie by authenticatedOriginNegatives();
 * the unauth ones never stand in for the source policy.
 */
async function unauthenticatedNegatives() {
  const access = currentLaunch()
  const index = await httpStatus(`${access.url.origin}/`, {})
  const api = await httpStatus(`${access.url.origin}/api`, {})
  const plugins = await httpStatus(`${access.url.origin}/plugins/events`, {})
  const wrongHost = await httpStatus(`${access.url.origin}/`, { Host: 'wrong-host.example' })
  const wrongOrigin = await httpStatus(`${access.url.origin}/api`, { Origin: 'http://wrong-origin.example' })
  return { index, api, plugins, wrongHost, wrongOrigin }
}

/**
 * Authenticated source-policy negatives: the SAME valid official Cookie that
 * opened the shell, with a wrong Host / Origin. An unauthenticated request
 * cannot prove this: the server might reject it for the missing credential
 * while accepting the wrong source.
 */
async function authenticatedOriginNegatives(context) {
  const access = currentLaunch()
  const cookies = await context.cookies(access.url.origin)
  const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ')
  if (cookie === '') throw new Error('the Web shell has no authenticated Cookie for the origin negatives')
  const wrongHost = await httpStatus(`${access.url.origin}/`, { Cookie: cookie, Host: 'wrong-host.example' })
  const wrongOrigin = await httpStatus(`${access.url.origin}/api`, { Cookie: cookie, Origin: 'http://wrong-origin.example' })
  return { wrongHostAuthenticated: wrongHost, wrongOriginAuthenticated: wrongOrigin }
}

/** The shared prompt/answer assertion for the deterministic C1 long-turn model. */
async function promptAndWait(page, text, answerNeedle, timeoutMs = 240_000) {
  await sendPrompt(page, text)
  return waitConversation(page, text, [answerNeedle], timeoutMs, `the answer of "${text.slice(0, 40)}"`)
}

/**
 * Run one harmless command in the official Web terminal (a Host-owned PTY in
 * the Session workspace) and write two sentinel files on the HOST side. This
 * is the WP-09 Host-owned workspace shell/path action: the browser-local and
 * TUI-local files never prove it.
 */
async function hostShellCommand(page, nonce) {
  const openSidebar = await findControlMatching(page, /open right sidebar/iu, 2_000)
  if (openSidebar !== null) {
    await clickCentre(page, openSidebar)
    await page.waitForTimeout(500)
  }
  let terminal = await findControlMatching(page, /new terminal/iu, 2_000)
  if (terminal === null) {
    const newTab = await findControlMatching(page, /new tab/iu, 2_000)
    if (newTab !== null) {
      await clickCentre(page, newTab)
      await page.waitForTimeout(500)
      terminal = await findControlMatching(page, /new terminal/iu, 3_000)
    }
  }
  if (terminal === null) throw new Error('the official Web shell exposed no New terminal control')
  await clickCentre(page, terminal)
  await page.locator('.xterm').last().waitFor({ state: 'visible', timeout: 30_000 })
  const textarea = page.locator('.xterm-helper-textarea').last()
  await textarea.click({ timeout: 10_000 })
  const marker = `host-shell-${nonce}`
  await page.keyboard.type('pwd > host-shell-pwd.txt\r')
  await page.waitForTimeout(1_000)
  await page.keyboard.type(`printf ${marker} > host-shell-marker.txt\r`)
  await page.waitForTimeout(1_000)
  result.browserClientActions.push('host-terminal-command')
  return { marker }
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
  /** Per-generation failure boundaries captured BEFORE a Host stop/kill. */
  const offlineMarks = new Map()
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
      } else if (command.kind === 'send') {
        // WP-07 pending/unknown: submit the real prompt but do NOT wait for an
        // answer. The runner kills the Host after the Host has accepted it.
        await sendPrompt(page, command.prompt)
        fact = { sent: true, prompt: command.prompt }
      } else if (command.kind === 'mark') {
        const name = command.name ?? `seq-${seq}`
        offlineMarks.set(name, {
          failed: result.network.failedPaths.length,
          console: result.consoleErrors.length,
        })
        fact = { marked: true, name }
        step(`mark:${name}`, true, { ...offlineMarks.get(name) })
      } else if (command.kind === 'expect-offline') {
        const marks = offlineMarks.get(command.mark) ?? { failed: 0, console: 0 }
        fact = await waitOffline(page, command.timeoutMs ?? 120_000, marks)
        step(`offline:${command.mark ?? 'unmarked'}`, true, { ...marks, ...fact })
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
async function waitOffline(page, timeoutMs, marks = { failed: 0, console: 0 }) {
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
    const failed = result.network.failedPaths.slice(marks.failed)
      .some(path => /ERR_CONNECTION|ERR_INCOMPLETE|remote\.mux/iu.test(path))
    const consoleFailure = result.consoleErrors.slice(marks.console)
      .some(text => /ERR_CONNECTION|ECONNREFUSED|WebSocket|failed to fetch|offline/iu.test(text))
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

/** A bounded "find one visible control whose aria/text matches a regex" probe. */
async function findControlMatching(page, pattern, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const point = await page.evaluate(source => {
      const re = new RegExp(source, 'iu')
      for (const node of document.querySelectorAll('button,[role=button]')) {
        const label = `${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`.replace(/\s+/gu, ' ').trim()
        if (!re.test(label)) continue
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 && rect.height >= 20) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      return null
    }, pattern.source)
    if (point !== null) return point
    await page.waitForTimeout(150)
  }
  return null
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

  // Stop/interrupt: a core Turn control; this inventory did not drive it.
  result.features.push({
    feature: 'turn.stop/interrupt',
    entryVisible: true,
    actualAction: 'not driven in this inventory pass',
    hostApi: 'official Agent turn cancellation',
    durableOrUiResult: 'no stop action was executed',
    status: 'NOT_VERIFIED',
    reason: 'the Web stop/interrupt control was not exercised in this run; the held-turn lanes do not claim it',
    evidence: [],
    supportText: '',
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
  await probeFeature(page, 'session.rename/delete', async () => {
    const row = page.locator(`[data-row-key="session:${createdSession}"]`).first()
    await row.hover()
    const buttons = await page.evaluate(id => {
      const rowNode = document.querySelector(`[data-row-key="session:${id}"]`)
      if (rowNode === null) return []
      return [...rowNode.querySelectorAll('button')].map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim())
    }, createdSession)
    return {
      actualAction: `hovered the Session row; rename/delete controls=${JSON.stringify(buttons)}`,
      durableOrUiResult: 'row action controls were observed but not driven',
      status: 'NOT_VERIFIED',
      reason: 'the row rename/delete action menu was not driven by this automated inventory probe',
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

  // Web terminal / PTY: report the real visible control, never a claimed action.
  await probeFeature(page, 'web terminal/PTY', async () => {
    const labels = await page.evaluate(() => [...document.querySelectorAll('button,[role=button]')]
      .map(node => (node.getAttribute('aria-label') ?? node.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .filter(label => label !== ''))
    const control = labels.find(label => /terminal|shell/iu.test(label))
    return control === undefined
      ? {
          entryVisible: false,
          actualAction: 'read the shell control inventory',
          hostApi: 'none',
          durableOrUiResult: 'no terminal/shell control visible',
          status: 'UNAVAILABLE_BY_DESIGN',
          reason: 'the official Web shell exposed no terminal/shell control in this composition',
          evidence: ['no terminal/shell control'],
          supportText: 'A Web terminal/PTY is not offered by this Web shell; no Host PTY action is claimed.',
        }
      : {
          entryVisible: true,
          actualAction: `found the "${control}" control but did not drive it`,
          hostApi: 'official Web terminal/PTY (not exercised)',
          durableOrUiResult: 'control visible only',
          status: 'NOT_VERIFIED',
          reason: 'a terminal control is visible; this inventory did not execute a Host command through it',
          evidence: [`control=${control}`],
          supportText: '',
        }
  })

  // Downloaded deliverables / export: no UI action was driven.
  await probeFeature(page, 'downloaded deliverables/export', async () => {
    const labels = await page.evaluate(() => [...document.querySelectorAll('button,a[href],[role=button]')]
      .map(node => (node.getAttribute('aria-label') ?? node.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .filter(label => label !== ''))
    const control = labels.find(label => /download|export|deliverable/iu.test(label))
    return control === undefined
      ? {
          entryVisible: false,
          actualAction: 'read the shell control inventory',
          hostApi: 'none',
          durableOrUiResult: 'no download/export control visible',
          status: 'UNAVAILABLE_BY_DESIGN',
          reason: 'the observed Web shell exposed no download/export deliverable control',
          evidence: ['no download/export control'],
          supportText: '',
        }
      : {
          entryVisible: true,
          actualAction: `found the "${control}" control but did not drive it`,
          hostApi: 'official deliverables/download (not exercised)',
          durableOrUiResult: 'control visible only',
          status: 'NOT_VERIFIED',
          reason: 'a download/export control is visible; this inventory did not execute the file transfer',
          evidence: [`control=${control}`],
          supportText: '',
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


/** The shared context-menu popup's live rows (label + disabled), read from its real DOM. */
async function menuRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('button[role="menuitem"]')]
    .map(node => ({
      label: (node.textContent ?? '').replace(/\s+/gu, ' ').trim(),
      disabled: node.getAttribute('aria-disabled') === 'true' || node.disabled === true,
    })))
}

/** Wait until the ONE shared context-menu popup owns no row (its exit finished). */
async function waitMenuClosed(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await menuRows(page)).length === 0) return
    await page.waitForTimeout(100)
  }
  throw new Error('the shared context menu did not close')
}

/**
 * Open the REAL right-click menu of one visible control and return its rows.
 * The shared popup is single: the previous menu's exit animation must finish
 * BEFORE the next read, or a stale (enabled) row would answer for the new
 * target.
 */
async function openContextMenu(page, locator, label) {
  await waitMenuClosed(page)
  await locator.waitFor({ state: 'visible', timeout: 120_000 })
  await locator.click({ button: 'right' })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const rows = await menuRows(page)
    // The file-actions contribution resolves asynchronously (an authorized
    // stat); only a menu that already carries its Download row is complete.
    if (rows.some(row => row.label === 'Download')) return rows
    await page.waitForTimeout(150)
  }
  throw new Error(`the context menu of ${label} exposed no complete file-action menu`)
}

/** Close the shared menu without selecting an action. */
async function dismissMenu(page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
}

/** The composer's live draft text (the LAST role=textbox is the official composer). */
async function composerDraft(page) {
  return page.evaluate(() => {
    const node = [...document.querySelectorAll('[role=textbox]')].at(-1)
    if (node === undefined) return null
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value
    return node.innerText
  })
}

/** The atomic Quote previews currently inside the composer (exact visible text). */
async function composerQuotes(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role=textbox] [data-quote-preview-text]')]
    .map(node => node.textContent ?? ''))
}

/**
 * The model-visible Markdown of the live composer draft. The official editor
 * exposes it through its OWN clipboard serialization, so a real select-all +
 * copy runs the production path; an unavailable Clipboard API is reported as a
 * refusal, never as a claimed success.
 */
async function composerMarkdownDraft(page) {
  const composer = page.locator('[role=textbox]').last()
  await composer.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  await page.waitForTimeout(250)
  return page.evaluate(async () => {
    try {
      return { ok: true, text: await navigator.clipboard.readText() }
    } catch (error) {
      return { ok: false, reason: String(error?.name ?? error) }
    }
  })
}

/**
 * Select one occurrence of `text` with a REAL pointer drag (pointerdown inside
 * the conversation, move, pointerup) and return the resulting DOM selection.
 */
async function dragSelectText(page, text) {
  const rect = await page.evaluate(needle => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null) {
      const content = node.textContent ?? ''
      const at = content.indexOf(needle)
      if (at >= 0) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        const box = range.getBoundingClientRect()
        if (box.width > 0 && box.height > 0) {
          return { x: box.x, y: box.y, width: box.width, height: box.height }
        }
      }
      node = walker.nextNode()
    }
    return null
  }, text)
  if (rect === null) throw new Error(`the conversation does not paint "${text}"`)
  const y = rect.y + rect.height / 2
  await page.mouse.move(rect.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width - 1, y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  return page.evaluate(() => document.getSelection()?.toString() ?? '')
}

/** The number of official turn-completion lines the conversation paints. */
async function completedTurnCount(page) {
  return page.evaluate(() => (document.body.innerText.match(/Completed in/gu) ?? []).length)
}

/**
 * Wait until a NEW official turn-completion line is painted. The Web client
 * applies the ORDERED Session event stream, and a turn's `workspace/changes`
 * event (when one exists) is appended BEFORE its `turn/end`; observing this
 * turn's completion therefore proves every earlier event of the turn has
 * already been applied.
 */
async function waitCompletedTurn(page, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let count = await completedTurnCount(page)
  while (count <= before && Date.now() < deadline) {
    await page.waitForTimeout(150)
    count = await completedTurnCount(page)
  }
  return count
}

/**
 * Read the Browser Clipboard's image/png content: type, byte length, PNG
 * signature and sha256. A refused Clipboard API is reported, never guessed.
 */
async function readClipboardPng(page) {
  return page.evaluate(async () => {
    const sha = async value => {
      const digest = await crypto.subtle.digest('SHA-256', value)
      return [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, '0')).join('')
    }
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (!item.types.includes('image/png')) continue
        const blob = await item.getType('image/png')
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const signature = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
        // The stable contract is the DECODED image, not the byte encoding:
        // Chromium is free to re-encode the PNG on the clipboard.
        const bitmap = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data
        return {
          ok: true,
          type: 'image/png',
          bytes: bytes.length,
          pngSignature: signature,
          sha256: await sha(bytes),
          width: bitmap.width,
          height: bitmap.height,
          pixelSha256: await sha(rgba),
        }
      }
      return { ok: false, reason: 'no image/png clipboard item' }
    } catch (error) {
      return { ok: false, reason: String(error?.name ?? error) }
    }
  })
}

/** Poll the Clipboard until the Copy action's async write lands (bounded). */
async function waitForClipboardPng(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = { ok: false, reason: 'not read' }
  while (Date.now() < deadline) {
    last = await readClipboardPng(page)
    if (last.ok === true) return last
    await page.waitForTimeout(200)
  }
  return last
}

/** Wait for the official file-actions copy-failure feedback. */
async function waitForCopyFailure(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText ?? '')
    if (text.includes('Could not copy. Check that the content is available, then retry.')) {
      return { failureFeedback: true }
    }
    await page.waitForTimeout(150)
  }
  return { failureFeedback: false }
}

/** Every changed-files card the conversation currently paints. */
async function changedCards(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-changed-files]')]
    .map(node => ({ text: (node.innerText ?? '').replace(/\s+/gu, ' ').trim() })))
}

/** The case programs. A case name is the frozen coordination interface. */
const cases = {
  /** WP-01: login, dynamic resources, a real Session UI action. */
  'wp01-login': async context => {
    const unauth = await unauthenticatedNegatives()
    const page = await login(context)
    result.negatives = { ...unauth, ...await authenticatedOriginNegatives(context) }
    const marker = `wp01-${nonce}`
    const sessionId = await newSession(page)
    driverFact('session', { sessionId })
    await promptAndWait(page, marker, caseConfig.expectedAnswer ?? 'long-turn answer')
    await screenshot(page, 'home-session')
    step('login-and-session', true, { sessionId, marker, negatives: result.negatives })
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
    step('opened-tui-session', true, { sessionId })
  },

  /** WP-02B: the Browser creates a Session; the runner resumes it in the TUI. */
  'wp02b-browser-session': async context => {
    const page = await login(context)
    const sessionId = await newSession(page)
    const marker = caseConfig.marker ?? `wp02b-${nonce}`
    await promptAndWait(page, marker, caseConfig.expectedAnswer ?? 'long-turn answer')
    driverFact('session', { sessionId })
    step('created-browser-session', true, { sessionId, marker })
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
    result.sessionId = sessionId
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

  /** WP-07 pending/unknown Browser write across a Host SIGKILL. */
  'wp07-pending-write': async context => {
    const page = await login(context)
    const sessionId = await newSession(page)
    driverFact('session', { sessionId })
    driverFact('ready', {})
    const current = await commandLoop(page, context)
    step('pending-write-killed-and-not-replayed', true, { sessionId })
    await screenshot(current, 'pending-write')
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
    const hostShell = await hostShellCommand(page, nonce)
    driverFact('host-shell', hostShell)
    await screenshot(page, 'host-terminal')
    step('browser-local-upload', true, { fileName: 'browser-local-sentinel.txt' })
    step('host-owned-terminal-command', true, hostShell)
  },


  /**
   * WP-11 (S5-PR5): the official Web file actions, message quotes and
   * Host-recorded changed files on ONE real Host + Browser.
   */
  'wp11-official-web-capabilities': async context => {
    const changesNonce = caseConfig.changesNonce
    if (typeof changesNonce !== 'string' || changesNonce === '') throw new Error('wp11 requires caseConfig.changesNonce')
    const page = await login(context)
    const origin = currentLaunch().url.origin
    // The Clipboard API is permission-gated by the browser; the W5-FILE case
    // records a refusal honestly instead of claiming a copy.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => undefined)
    // The Session's authoritative cwd must be the isolated, disposable
    // Default-workspace folder (the fixture's dedicated Git work tree), never
    // the profile directory or the developer's repository.
    const sessionId = await newSessionInWorkspace(page, 'w5-changed-files')
    result.sessionId = sessionId
    driverFact('session', { sessionId })
    await waitSignal('workspace-ready')

    // ── W5-CHANGES positive: one real official `write` tool call changed the
    // working tree; the official recorder announces the turn and the card must
    // render it.
    const changesMarker = `w5-changes-${changesNonce}`
    await sendPrompt(page, changesMarker)
    await waitConversation(page, changesMarker, ['w5-editing'], 240_000, 'the changed-files answer')
    const card = page.locator('[data-changed-files]').last()
    await card.waitFor({ state: 'visible', timeout: 120_000 })
    const cardText = (await card.innerText()).replace(/\s+/gu, ' ').trim()
    if (!cardText.includes('changed.txt')) throw new Error(`the changed-files card does not name changed.txt: ${cardText}`)
    await screenshot(page, 'changed-files-card')
    driverFact('changes-card', { text: cardText })
    await waitSignal('changes-review-go')

    // The card opens the REAL review tab; its summary/diff come from the
    // official authenticated Host routes.
    const sidebar = await findControlMatching(page, /open right sidebar/iu, 1_500)
    if (sidebar !== null) {
      await clickCentre(page, sidebar)
      await page.waitForTimeout(400)
    }
    await card.locator('button').first().click()
    await page.locator('[data-changes-review]').last().waitFor({ state: 'visible', timeout: 120_000 })
    let reviewFacts = null
    const reviewDeadline = Date.now() + 120_000
    while (Date.now() < reviewDeadline) {
      reviewFacts = await page.evaluate(() => {
        const root = [...document.querySelectorAll('[data-changes-review]')].at(-1)
        if (root === undefined) return null
        return {
          state: root.getAttribute('data-review-state'),
          file: root.querySelector('[data-review-file]')?.getAttribute('data-review-file') ?? null,
          text: (root.innerText ?? '').replace(/\s+/gu, ' ').trim(),
        }
      })
      if (reviewFacts?.state === 'ready' && (reviewFacts.text ?? '').includes(`w5-change-${changesNonce}`)) break
      await page.waitForTimeout(250)
    }
    if (reviewFacts?.state !== 'ready') throw new Error(`the changes review did not become ready (${String(reviewFacts?.state)})`)
    if (typeof reviewFacts.file !== 'string' || !reviewFacts.file.endsWith('changed.txt')) {
      throw new Error(`the changes review opened ${String(reviewFacts.file)}, not changed.txt`)
    }
    if (!reviewFacts.text.includes(`w5-change-${changesNonce}`)) {
      throw new Error('the review does not paint the exact changed content the Host recorded')
    }
    await screenshot(page, 'changes-review')
    const routeReads = result.network.statuses
      .filter(entry => entry.path === '/api/changes.summary' || entry.path === '/api/changes.diff')
    driverFact('review', { ...reviewFacts, network: { statuses: routeReads } })
    step('changes-card-to-review', true, { file: reviewFacts.file })

    // ── W5-FILE positive: the official right-click Download of a Session file.
    const fileLink = page.getByRole('button', { name: 'changed.txt', exact: true }).last()
    const fileRows = await openContextMenu(page, fileLink, 'changed.txt')
    const fileLabels = fileRows.map(row => row.label)
    if (!fileLabels.includes('Download')) throw new Error(`the file menu exposes no Download: ${JSON.stringify(fileLabels)}`)
    if (fileLabels.some(label => /^Save as/u.test(label))) {
      throw new Error('the Web file menu exposed the Desktop-only Save as')
    }
    const downloadsDir = join(coordinationDir, 'downloads')
    mkdirSync(downloadsDir, { recursive: true, mode: 0o700 })
    chmodSync(downloadsDir, 0o700)
    await screenshot(page, 'file-menu')
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
    await page.getByRole('menuitem', { name: 'Download', exact: true }).last().click()
    const download = await downloadPromise
    const savedPath = join(downloadsDir, `changed-${nonce}.txt`)
    await download.saveAs(savedPath)
    const bytes = readFileSync(savedPath)
    const downloadFacts = {
      suggestedFilename: download.suggestedFilename(),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      labels: fileLabels,
    }
    result.downloads = [downloadFacts]
    driverFact('download', downloadFacts)

    // W5-FILE negative: a missing Session file cannot start a download and its
    // action is disabled by the official metadata read.
    const missingRows = await openContextMenu(page,
      page.getByRole('button', { name: 'missing-sentinel.txt', exact: true }).last(), 'missing-sentinel.txt')
    const missingDownload = missingRows.find(row => row.label === 'Download')
    if (missingDownload === undefined) throw new Error('the missing file menu exposes no Download row to refuse')
    await screenshot(page, 'file-menu-missing')
    if (missingDownload.disabled !== true) throw new Error('a missing Session file left Download enabled')
    const attempted = page.waitForEvent('download', { timeout: 3_000 }).then(() => true, () => false)
    await page.getByRole('menuitem', { name: 'Download', exact: true }).last().click({ force: true }).catch(() => undefined)
    const started = await attempted
    await dismissMenu(page)
    if (started) throw new Error('a missing Session file still started a download')
    driverFact('file-negative', { rows: missingRows, downloadStarted: false })

    // W5-FILE image: the official image menu's Copy image must put the ORIGINAL
    // PNG on the real browser clipboard. A permission denial must surface the
    // official failure feedback, never a fake success.
    const image = page.locator('img[alt="shot"]').last()
    await image.scrollIntoViewIfNeeded({ timeout: 30_000 }).catch(() => undefined)
    await image.waitFor({ state: 'visible', timeout: 60_000 })
    const imageRows = await openContextMenu(page, image, 'shot.png')
    await screenshot(page, 'image-menu')
    const imageLabels = imageRows.map(row => row.label)
    if (!imageLabels.includes('Copy image')) {
      throw new Error(`the image menu exposes no Copy image: ${JSON.stringify(imageLabels)}`)
    }
    await page.bringToFront()
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).last().click()
    // The official copy action is async (authorized read + clipboard write); the
    // menu click returns first, so the clipboard is polled to a bounded settle.
    const copied = await waitForClipboardPng(page, 15_000)
    if (copied.ok !== true) throw new Error(`Copy image put no PNG on the clipboard: ${JSON.stringify(copied)}`)
    if (copied.pngSignature !== true) throw new Error('the clipboard image/png is not a real PNG')
    // Equivalence is pixel-level: Chromium may re-encode the PNG bytes.
    const source = await image.evaluate(async element => {
      const response = await fetch(element.src, { cache: 'no-store' })
      const blob = await response.blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      const digest = await crypto.subtle.digest('SHA-256', rgba)
      return {
        width: bitmap.width,
        height: bitmap.height,
        pixelSha256: [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, '0')).join(''),
      }
    })
    const pixelsEqual = source.width === copied.width && source.height === copied.height
      && source.pixelSha256 === copied.pixelSha256
    if (!pixelsEqual) {
      throw new Error(`the clipboard PNG pixels differ from the source image: clipboard ${JSON.stringify(copied)} source ${JSON.stringify(source)}`)
    }
    result.copyImage = { ...copied, source, pixelsEqual, labels: imageLabels }
    driverFact('copy-image', { ...copied, source, pixelsEqual, labels: imageLabels })

    // Chromium's permission type behind the clipboard API is
    // `clipboardReadWrite`; the Chrome "denied" setting is a real browser
    // permission denial (not a JS mock), so the official failure path runs.
    const cdp = await context.newCDPSession(page)
    await cdp.send('Browser.setPermission', { permission: { name: 'clipboardReadWrite' }, setting: 'denied', origin })
    try {
      const deniedRows = await openContextMenu(page, image, 'shot.png (clipboard denied)')
      if (!deniedRows.some(row => row.label === 'Copy image')) {
        throw new Error('the image menu exposes no Copy image for the denial case')
      }
      await page.getByRole('menuitem', { name: 'Copy image', exact: true }).last().click()
      const denied = await waitForCopyFailure(page)
      if (denied.failureFeedback !== true) throw new Error('a denied Copy image surfaced no official failure feedback')
      driverFact('copy-negative', denied)
    } finally {
      await cdp.send('Browser.setPermission', { permission: { name: 'clipboardReadWrite' }, setting: 'granted', origin }).catch(() => undefined)
      await cdp.detach().catch(() => undefined)
    }
    step('image-copy-and-refusal', true, { bytes: copied.bytes, sha256: copied.sha256 })
    step('file-download-and-refusal', true, downloadFacts)

    // ── W5-QUOTE: a real selection becomes a composer draft, never a Session write.
    const sentence = `w5-editing ${changesNonce}`
    const selected = await dragSelectText(page, sentence)
    if (!selected.includes(sentence)) throw new Error(`the pointer drag selected ${JSON.stringify(selected)}, not the fixture sentence`)
    const quoteButton = page.getByRole('button', { name: 'Quote text', exact: true }).last()
    await quoteButton.waitFor({ state: 'visible', timeout: 30_000 })
    await quoteButton.click()
    const quoteNodes = await composerQuotes(page)
    if (!quoteNodes.some(text => text.includes(sentence))) {
      throw new Error(`the Quote action inserted no atomic quote into the composer: ${JSON.stringify(quoteNodes)}`)
    }
    const markdown = await composerMarkdownDraft(page)
    if (markdown.ok && !markdown.text.includes(`> ${sentence}`)) {
      throw new Error(`the composer's Markdown draft is not a blockquote: ${JSON.stringify(markdown.text)}`)
    }
    await screenshot(page, 'quote-draft')
    driverFact('quote-draft', { quoteNodes, markdownDraft: markdown.ok ? markdown.text : null, clipboardRefused: markdown.ok ? null : markdown.reason })

    // Negative: the draft belongs to the current Session. Opening another
    // Session must not carry it there, so the quoted text cannot be sent into
    // the wrong Session.
    const other = await waitForFactFile('other-session', 180_000)
    await openSession(page, other.sessionId)
    const otherDraft = await composerDraft(page)
    const otherQuotes = await composerQuotes(page)
    if ((typeof otherDraft === 'string' && otherDraft.includes(sentence))
      || otherQuotes.some(text => text.includes(sentence))) {
      throw new Error('the Quote draft leaked into another Session')
    }
    driverFact('quote-other-session', { sessionId: other.sessionId, draft: otherDraft ?? null, quotes: otherQuotes })
    await openSession(page, sessionId)
    const restored = await composerQuotes(page)
    if (!restored.some(text => text.includes(sentence))) {
      throw new Error(`the current Session lost its Quote draft on navigation: ${JSON.stringify(restored)}`)
    }
    await waitSignal('quote-send-go')
    await clickSend(page)
    await waitConversation(page, changesMarker, ['w5-quote answer'], 240_000, 'the quoted prompt answer')
    driverFact('quote-sent', { quoted: `> ${sentence}` })
    step('quote-draft-then-send', true, { quoted: `> ${sentence}` })

    // ── W5-CHANGES negative: a tool-active Turn with NO file change paints no card.
    const cardsBefore = (await changedCards(page)).length
    const completedBefore = await completedTurnCount(page)
    const noChangeMarker = `w5-nochange-${changesNonce}`
    await promptAndWait(page, noChangeMarker, 'w5-nochange answer')
    // The rendered card list is not the authority: the runner waits for the
    // durable turn/end AND proves no `workspace/changes` event was appended.
    driverFact('nochange-prompted', {})
    await waitSignal('nochange-settled')
    // Official render barrier, not a fixed sleep: this turn's completion line
    // proves the ordered event stream was applied through its `turn/end`, so a
    // changed-files event for the turn (which would precede `turn/end`) cannot
    // still be pending in the client.
    const completedAfter = await waitCompletedTurn(page, completedBefore, 30_000)
    if (completedAfter <= completedBefore) {
      throw new Error('the no-change Turn never rendered its official completion state')
    }
    const cardsAfter = await changedCards(page)
    if (cardsAfter.length !== cardsBefore) {
      throw new Error(`a no-change Turn painted ${String(cardsAfter.length - cardsBefore)} new changed-files card(s)`)
    }
    await screenshot(page, 'no-change-turn')
    driverFact('nochange', { cardsBefore, cardsAfter: cardsAfter.length, completedBefore, completedAfter })
    step('no-false-changed-files-card', true, { cardsBefore })

    // ── A5 same-Host isolation: Web disable -> TUI keeps working -> re-enable.
    // The old recorder/summary must not be reused, and a NEW real write must
    // record through the freshly composed chain.
    driverFact('toggle-ready', {})
    await waitSignal('toggle-reenabled')
    await page.reload({ waitUntil: 'load', timeout: 120_000 })
    await waitShell(page)
    await assertNoPreviewNotice(page)
    await openSession(page, sessionId)
    const secondMarker = `w5-changes2-${changesNonce}`
    await sendPrompt(page, secondMarker)
    await waitConversation(page, secondMarker, ['w5-editing2'], 240_000, 'the post-re-enable changed-files answer')
    const cardsAfterReenable = await changedCards(page)
    if (!cardsAfterReenable.some(card => card.text.includes('changed2.txt'))) {
      throw new Error(`the post-re-enable Turn painted no changed2.txt card: ${JSON.stringify(cardsAfterReenable)}`)
    }
    await screenshot(page, 'post-reenable-change')
    driverFact('toggle-second-change', { cards: cardsAfterReenable.length, text: cardsAfterReenable.map(card => card.text) })
    step('same-host-toggle-isolation', true, { cards: cardsAfterReenable.length })
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
  writeJson(join(coordinationDir, 'browser-result.json'), sanitizeValue(result))
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
