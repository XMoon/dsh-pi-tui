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
      // A DRAFT is not a submitted turn: text that belongs to the composer
      // (contenteditable textbox, textarea or input) can never satisfy a
      // conversation assertion, or a marker still sitting in the draft would
      // be counted as an already-sent message.
      const composerOwned = node.parentElement?.closest('textarea, input, [role=textbox], [contenteditable="true"]') ?? null
      if (composerOwned !== null) {
        node = walker.nextNode()
        continue
      }
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
  // A click that no longer submits (for example while an attachment is still
  // uploading) must fail HERE instead of letting a later conversation wait
  // match the previous turns. Arm the request barrier before the click.
  const promptRequest = page.waitForRequest(
    candidate => new URL(candidate.url()).pathname === '/api/session/prompt' && candidate.method() === 'POST',
    { timeout: 30_000 },
  )
  await clickSend(page)
  try {
    await promptRequest
  } catch {
    throw new Error('the Send gesture produced no POST /api/session/prompt request; the draft was never submitted')
  }
  result.browserClientActions.push('send-prompt')
}

/** Whether the composer still paints an in-flight upload card. */
async function composerUploading(page) {
  return page.evaluate(() => /Uploading/u.test(document.body.innerText ?? ''))
}

/**
 * Submit the live composer DRAFT with an explicit send gesture and prove the
 * Host prompt request really started. The quote-only draft is sent with Enter
 * in the focused composer, so a stale/hidden Send control cannot silently
 * swallow the submission.
 */
async function sendDraft(page) {
  const composer = page.locator('[role=textbox]').last()
  await composer.click()
  await page.waitForTimeout(200)
  const promptRequest = timeout => page.waitForRequest(
    candidate => new URL(candidate.url()).pathname === '/api/session/prompt' && candidate.method() === 'POST',
    { timeout },
  )
  try {
    // The composer's own Enter send; a quote-only draft never relies on a
    // possibly stale Send control from a previous Session.
    const sent = promptRequest(2_500)
    await page.keyboard.press('Enter')
    await sent
  } catch {
    // Fallback for a composer that does not submit on Enter: click the Send
    // control with the same request barrier.
    const point = await controlCentre(page, { aria: 'Send message' })
    if (point === null) throw new Error('the composer has no Send control for the quote draft')
    const sent = promptRequest(30_000)
    await clickCentre(page, point)
    await sent
  }
  result.browserClientActions.push('send-draft')
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

/**
 * RC.5 Host-wiring observation: open Settings -> Built-in plugins and observe
 * the real Browser `pluginInventory/list` Remote response. The Settings tab is
 * the official consumer of that response; reading its payload proves the
 * Browser reached the Host inventory Remote over the authenticated transport.
 */
async function openBuiltInPluginInventory(page) {
  const inventoryResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/pluginInventory/list'
    && response.request().method() === 'POST'
    && response.status() === 200, { timeout: 60_000 }).catch(() => undefined)
  // Open Settings through the official sidebar account menu, the same
  // user-reachable path the upstream Web tests use. The narrow rail may need
  // its own "Open sidebar" action before the menu trigger is visible.
  const accountMenu = page.getByRole('button', { name: 'Account menu', exact: true, includeHidden: true })
  await accountMenu.waitFor({ state: 'attached', timeout: 30_000 })
  if (!(await accountMenu.isVisible())) {
    const openSidebar = page.getByRole('button', { name: 'Open sidebar', exact: true })
    if (await openSidebar.count() > 0) await openSidebar.click()
  }
  await accountMenu.click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByText('Settings', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 })
  const pluginsNav = await findControlMatching(page, /Built-in plugins/iu, 10_000)
  if (pluginsNav === null) throw new Error('Settings exposes no Built-in plugins section')
  await clickCentre(page, pluginsNav)
  const response = await inventoryResponse
  if (response === undefined) throw new Error('the Browser never issued the pluginInventory/list Remote request')
  const payload = await response.json().catch(() => undefined)
  const value = payload?.result?.value ?? payload?.result ?? payload?.value
  const entries = Array.isArray(value?.entries) ? value.entries : undefined
  if (entries === undefined) throw new Error('the pluginInventory/list reply carries no entry array')
  const entry = entries.find(candidate =>
    candidate.moduleName === '@deepseek-ai/dsh-client-connection' && candidate.enabled === true)
  if (entry === undefined) {
    throw new Error(`the Host inventory has no enabled dsh-client-connection entry (${entries.length} entries)`)
  }
  driverFact('plugin-inventory', {
    remote: 'pluginInventory/list',
    entryId: entry.entryId,
    moduleName: entry.moduleName,
    enabled: entry.enabled,
    fiberPhase: entry.fiberPhase,
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  return entry
}

/**
 * RC.5 Host-wiring observation: one real Like opens the official feedback
 * dialog; choosing a category and submitting writes through
 * `messageFeedback.put` into the same Session log.
 */
async function submitPositiveFeedback(page) {
  const like = page.getByRole('button', { name: 'Good response', exact: true }).last()
  await like.waitFor({ state: 'visible', timeout: 60_000 })
  await like.click()
  await page.getByText('Submit feedback', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByRole('button', { name: 'Task result', exact: true }).last().click()
  await page.locator('button').filter({ hasText: /^submit$/iu }).last().click()
  const deadline = Date.now() + 60_000
  let submitted = false
  while (Date.now() < deadline) {
    const body = await page.evaluate(() => document.body.innerText ?? '')
    if (body.includes('Thanks for your feedback') || !body.includes('Submit feedback')) {
      submitted = true
      break
    }
    await page.waitForTimeout(150)
  }
  if (!submitted) throw new Error('the feedback dialog did not settle after Submit')
  driverFact('message-feedback', { rating: 'positive', category: 'task-result' })
}

/**
 * RC.5 Host-wiring observation: create a second real Session, return to the
 * original one, open the official `@` candidate menu (the real Browser
 * `sessionReferenceResolver/candidates` Remote), then submit a canonical
 * session mention. The Host-side `agent/pre-step` listener is what turns that
 * mention into model input; the runner verifies the resulting prompt record.
 */
async function observeSessionReference(page, originalSessionId) {
  const siblingId = await newSession(page)
  await openSession(page, originalSessionId)
  const candidates = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/sessionReferenceResolver/candidates'
    && response.request().method() === 'POST'
    && response.status() === 200, { timeout: 60_000 }).catch(() => undefined)
  const composer = page.locator('[role=textbox]').last()
  await composer.click()
  await composer.type('@')
  const response = await candidates
  if (response === undefined) throw new Error('the Browser never issued the sessionReferenceResolver/candidates Remote request')
  const payload = await response.json().catch(() => undefined)
  const value = payload?.result?.value ?? payload?.result ?? payload?.value
  const candidatesList = Array.isArray(value) ? value : undefined
  if (candidatesList === undefined) throw new Error('the sessionReferenceResolver/candidates reply carries no candidate array')
  const candidate = candidatesList.find(entry => entry?.sessionId === siblingId)
  if (candidate === undefined) throw new Error('the sessionReferenceResolver candidates did not include the sibling Session')
  const label = candidate.displayTitle ?? candidate.label ?? siblingId
  const option = page.getByRole('option').filter({ hasText: label }).first()
  await option.waitFor({ state: 'visible', timeout: 30_000 })
  await option.click()
  const draftDeadline = Date.now() + 10_000
  let draft = ''
  while (Date.now() < draftDeadline) {
    draft = (await composer.innerText()).replace(/\s+/gu, ' ').trim()
    if (draft.includes(candidate.mention) || draft.includes(label)) break
    await page.waitForTimeout(100)
  }
  if (!draft.includes(candidate.mention) && !draft.includes(label)) {
    throw new Error(`the official candidate choice did not insert a mention into the composer: ${JSON.stringify({ label, mention: candidate.mention, draft })}`)
  }
  const marker = `wp01-ref-${nonce}`
  driverFact('session-reference-armed', { siblingId, candidateLabel: label, marker })
  await waitSignal('session-reference-send', 120_000)
  await composer.click()
  await composer.type(` ${marker}`)
  const promptRequest = page.waitForRequest(candidate =>
    new URL(candidate.url()).pathname === '/api/session/prompt' && candidate.method() === 'POST',
    { timeout: 30_000 })
  await clickSend(page)
  await promptRequest
  driverFact('session-reference', { siblingId, marker, candidatesStatus: response.status(), candidateLabel: label, selectedFromCandidates: true })
  return { siblingId, marker }
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
    // RC.5 Host-wiring facts on the SAME authenticated Browser Session: one
    // real message-feedback write and the real PluginInventory Remote read.
    await submitPositiveFeedback(page)
    const inventory = await openBuiltInPluginInventory(page)
    const reference = await observeSessionReference(page, sessionId)
    driverFact('rc5-host-wiring', {
      inventoryEntry: inventory.entryId,
      inventoryModule: inventory.moduleName,
      inventoryPhase: inventory.fiberPhase,
      feedback: 'positive',
      sessionReference: true,
      referenceMarker: reference.marker,
    })
    await screenshot(page, 'home-session')
    step('login-and-session', true, { sessionId, marker, negatives: result.negatives })
    step('rc5-official-host-wiring', true, { inventoryEntry: 'split-host-connection', feedback: 'positive' })
    await waitSignal('runner-go')
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

  /** WP-06: a TUI SIGKILL leaves the Browser writing; a fresh TUI resumes. */
  'wp06-tui-lifecycle': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    driverFact('ready', {})
    await waitSignal('tui-killed', 300_000)
    const marker = caseConfig.marker ?? `wp06-${nonce}`
    await promptAndWait(page, marker, caseConfig.expectedAnswer ?? 'long-turn answer')
    driverFact('browser-wrote-after-tui-kill', { marker })
    await waitSignal('fresh-tui-resumed', 300_000)
    await screenshot(page, 'tui-lifecycle')
    step('browser-kept-writing-after-tui-kill', true, { marker })
  },

  /** WP-07: Host SIGKILL, new Host instance, Browser reconnect and write. */
  'wp07-host-lifecycle': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const marks = { failed: result.network.failedPaths.length, console: result.consoleErrors.length }
    driverFact('ready', {})
    await waitSignal('host-killed', 300_000)
    const offline = await waitOffline(page, 180_000, marks)
    driverFact('host-killed', offline)
    await waitSignal('new-host-ready', 300_000)
    const fresh = await login(context)
    await openSession(fresh, caseConfig.sessionId)
    await waitConversation(fresh, caseConfig.seedMarker, [caseConfig.expectedAnswer ?? 'long-turn answer'], 180_000,
      'the durable Session after the Host restart')
    driverFact('browser-reconnected', {})
    const marker = caseConfig.marker ?? `wp07-${nonce}`
    await promptAndWait(fresh, marker, caseConfig.expectedAnswer ?? 'long-turn answer')
    driverFact('browser-wrote-after-reconnect', { marker })
    await screenshot(fresh, 'host-lifecycle')
    step('host-sigkill-cold-resume', true, { marker })
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

  /** WP-09: Browser-local file intake; the runner owns the Host-side checks. */
  'wp09-locality': async context => {
    const page = await login(context)
    await openSession(page, caseConfig.sessionId)
    const upload = join(coordinationDir, 'browser-local-sentinel.txt')
    writeFileSync(upload, `prd-browser-local-${nonce}\n`, { mode: 0o600 })
    const input = page.locator('input[type=file]').last()
    // The card appears BEFORE the bytes reach the Host: arm the real upload
    // response first and require it to complete, then require the card to
    // leave its in-flight state. Sending while the card still says Uploading
    // produces no prompt at all.
    const uploadResponse = page.waitForResponse(
      candidate => new URL(candidate.url()).pathname === '/api/session/uploadFileBinary'
        && candidate.request().method() === 'POST',
      { timeout: 120_000 },
    )
    await input.setInputFiles(upload, { timeout: 20_000 })
    const uploaded = await uploadResponse
    if (uploaded.status() !== 200) {
      throw new Error(`the browser-local upload answered HTTP ${String(uploaded.status())}, not 200`)
    }
    const uploadDeadline = Date.now() + 120_000
    while (await composerUploading(page)) {
      if (Date.now() > uploadDeadline) throw new Error('the composer stayed in the Uploading state for the browser-local file')
      await page.waitForTimeout(250)
    }
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
   * WP-11: the official Host changed-files chain, same-Host Web toggle and
   * cold-restart stale refusal, with Browser and TUI on ONE real Host.
   */
  'wp11-host-changes': async context => {
    const changesNonce = caseConfig.changesNonce
    if (typeof changesNonce !== 'string' || changesNonce === '') throw new Error('wp11 requires caseConfig.changesNonce')
    const page = await login(context)
    const sessionId = await newSessionInWorkspace(page, 'w5-changed-files')
    result.sessionId = sessionId
    driverFact('session', { sessionId })
    await waitSignal('workspace-ready', 300_000)
    const firstMarker = `w5-changes-${changesNonce}`
    await sendPrompt(page, firstMarker)
    await waitConversation(page, firstMarker, ['w5-editing'], 240_000, 'the changed-files answer')
    await waitSignal('first-write-verified', 300_000)
    const noChangeMarker = `w5-nochange-${changesNonce}`
    await sendPrompt(page, noChangeMarker)
    driverFact('nochange-sent', { marker: noChangeMarker })
    await waitSignal('nochange-verified', 300_000)
    await waitSignal('toggle-reenabled', 300_000)
    await page.reload({ waitUntil: 'load', timeout: 120_000 })
    await waitShell(page)
    await assertNoPreviewNotice(page)
    await openSession(page, sessionId)
    const secondMarker = `w5-changes2-${changesNonce}`
    await sendPrompt(page, secondMarker)
    await waitConversation(page, secondMarker, ['w5-editing2'], 240_000, 'the post-re-enable changed-files answer')
    driverFact('second-write-sent', { marker: secondMarker })
    await waitSignal('second-write-verified', 300_000)
    await screenshot(page, 'host-changes')
    step('first-write-nochange-second-write', true, { sessionId })
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
