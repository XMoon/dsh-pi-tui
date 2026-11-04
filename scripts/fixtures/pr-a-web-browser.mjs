#!/usr/bin/env node
/**
 * M5-W PR-A real-Browser qualification driver (Playwright + real Chromium).
 *
 * An isolated Host is already running with the candidate's 59 official Web
 * rows enabled by ONE private extra patch. This driver opens the official Web
 * UI through the Host's own authenticated index, creates ONE real Session with
 * the official "New session" control, waits for the TUI (started by the smoke
 * against the SAME Host instance) to attach, then submits the unique marker
 * prompt and waits for the Host Turn to finish. It NEVER reloads the page.
 *
 * Coordination with the smoke happens through files in `<coordination-dir>`:
 *   browser-session.json  this driver's new Session id
 *   browser-go            the smoke releases the marker prompt
 *   browser-result.json   the whitelisted result facts
 *
 * The launch token is read from the Host's own private launch material; it is
 * never written to the result, the logs, a screenshot name or stdout.
 *
 * Usage: node pr-a-web-browser.mjs <coordination-dir> <marker>
 * Env:   PR_A_DSH_HOME        isolated DSH home of the running Host
 *        PR_A_PLAYWRIGHT_ROOT directory that owns the pinned Playwright install
 *
 * @module scripts/fixtures/pr-a-web-browser
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [coordinationDir, marker] = process.argv.slice(2)
if (coordinationDir === undefined || marker === undefined) throw new Error('usage: pr-a-web-browser.mjs <coordination-dir> <marker>')
const dshHome = process.env.PR_A_DSH_HOME
const playwrightRoot = process.env.PR_A_PLAYWRIGHT_ROOT
if (dshHome === undefined || dshHome === '') throw new Error('PR_A_DSH_HOME is required')
if (playwrightRoot === undefined || playwrightRoot === '') throw new Error('PR_A_PLAYWRIGHT_ROOT is required')
mkdirSync(coordinationDir, { recursive: true, mode: 0o700 })
const resultPath = join(coordinationDir, 'browser-result.json')

/** The running Host's launch material (an origin plus this process's token). */
function launchRecord() {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  for (const name of readdirSync(root)) {
    const path = join(root, name, 'launch.json')
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  }
  throw new Error('no Host launch material in this DSH_HOME')
}

const result = {
  marker,
  indexStatus: null,
  sessionId: null,
  attached: false,
  answerSeen: false,
  consoleErrors: [],
  failedResponses: [],
  requestPaths: [],
  screenshot: null,
}

const { chromium } = createRequire(join(playwrightRoot, 'package.json'))('playwright')
const launchUrl = new URL(launchRecord().connectUrl)
const launchToken = launchUrl.searchParams.get('token')
const indexUrl = new URL('/', launchUrl.origin)
indexUrl.searchParams.set('token', launchToken)

/**
 * Remove every credential shape a Playwright error can carry before it is
 * retained or printed: this process's exact launch token, any `token=` query
 * value and any loopback origin. The plan forbids the authenticated URL/token
 * in trace files, stdout, screenshots and PR material.
 */
function redacted(text) {
  let value = String(text)
  if (typeof launchToken === 'string' && launchToken !== '') value = value.split(launchToken).join('<redacted-token>')
  return value
    .replace(/([?&]token=)[^&\s"']+/gu, '$1<redacted>')
    .replace(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:<port>')
}
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
page.on('console', message => {
  // Console text is retained evidence, so it passes the same redaction as every
  // other retained driver string: a future error message may carry the
  // authenticated page URL.
  if (message.type() === 'error') result.consoleErrors.push(redacted(message.text()).slice(0, 300))
})
page.on('response', response => {
  if (response.status() < 400 || result.failedResponses.length >= 20) return
  result.failedResponses.push(`${response.request().method()} ${new URL(response.url()).pathname} -> ${response.status()}`)
})
page.on('request', request => {
  const url = new URL(request.url())
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/plugins')) {
    result.requestPaths.push(`${request.method()} ${url.pathname}`)
  }
})

const bodyText = () => page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/gu, ' '))

/** Bounded wait for one body-text fact. */
async function waitBody(text, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await bodyText()).includes(text)) return true
    await page.waitForTimeout(250)
  }
  throw new Error(`browser timed out waiting for ${label}`)
}

/**
 * The answer must land in the CONVERSATION, not in the sidebar: the session
 * title legitimately repeats the assistant text, so a page-wide match would
 * pass while the chat pane stayed empty (plan PA-05 rejects a sidebar-only
 * match). The marker bubble is unique to the conversation, so its nearest
 * scroll container is the authoritative region to read the answer from.
 */
async function waitAnswerInConversation(markerText, answerText, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const seen = await page.evaluate(({ marker, answer }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node !== null) {
        if ((node.textContent ?? '').includes(marker)) {
          let element = node.parentElement
          while (element !== null && element !== document.body) {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            if (/(?:auto|scroll)/u.test(style.overflowY) && rect.height > 200) {
              return (element.innerText ?? '').includes(answer)
            }
            element = element.parentElement
          }
          return false
        }
        node = walker.nextNode()
      }
      return false
    }, { marker: markerText, answer: answerText })
    if (seen) return true
    await page.waitForTimeout(250)
  }
  throw new Error(`browser timed out waiting for the answer inside the conversation holding ${markerText}`)
}

/** Bounded wait for one coordination file. */
async function waitFile(name, timeoutMs) {
  const path = join(coordinationDir, name)
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return
    await sleep(100)
  }
  throw new Error(`browser timed out waiting for ${name}`)
}

/**
 * The centre point of one visible control, found in the REAL DOM by its text
 * or aria-label. The shell renders icon and row variants of the same action,
 * so the smallest usable height wins and Playwright's role filtering is not
 * relied on for the Web UI's own markup.
 */
async function controlCentre(match) {
  return page.evaluate(spec => {
    const candidates = [...document.querySelectorAll('button')].filter(node => {
      const label = (node.getAttribute('aria-label') ?? '').trim()
      const text = (node.textContent ?? '').replace(/\s+/gu, ' ').trim()
      return (spec.aria !== undefined && label === spec.aria) || (spec.text !== undefined && text === spec.text)
    })
    for (const node of candidates) {
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height >= 20) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, height: rect.height }
      }
    }
    return null
  }, match)
}

/** Bounded wait for one control of the shell. */
async function waitControl(match, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await controlCentre(match) !== null) return
    await page.waitForTimeout(250)
  }
  throw new Error(`browser timed out waiting for the ${String(match.text ?? match.aria)} control`)
}

/** One real pointer click at a control's own centre. */
async function clickCentre(point) {
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.up()
}

/** Create a Session with the shell's own primary action. */
async function clickNewSession() {
  const point = await controlCentre({ aria: 'New session' }) ?? await controlCentre({ text: 'New Session' })
  if (point === null) throw new Error('the shell has no usable New-session control')
  await clickCentre(point)
}

/** Submit the composer with the shell's own Send control. */
async function clickSend() {
  const point = await controlCentre({ aria: 'Send message' })
    ?? await controlCentre({ text: 'Send message' })
    ?? await controlCentre({ aria: 'Send' })
  if (point === null) throw new Error('the composer has no usable Send control')
  await clickCentre(point)
}

/**
 * The Host's OWN `session/create` answer is the authoritative new Session
 * identity: a freshly created Session has no durable log yet, so polling the
 * session directory would report "no Session" for a perfectly good create.
 * The shell may create the first Session of a fresh workspace by itself while
 * the workspace initializes, so the collector is reset immediately before the
 * explicit "New session" click and only that answer is used.
 */
let createdSessionBody
page.on('response', response => {
  if (createdSessionBody !== undefined) return
  if (new URL(response.url()).pathname !== '/api/session/create') return
  if (response.request().method() !== 'POST') return
  createdSessionBody = response.json().catch(() => undefined)
})

/**
 * Wait until the shell has RESOLVED A WORKSPACE: a painted composer while the
 * workspace chooser is gone. A textbox alone is not enough — the chooser paints
 * one too, and a "New session" click there creates nothing.
 */
async function waitComposer(timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ready = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[role=textbox]')]
      const composer = boxes.at(-1)
      if (composer === undefined) return false
      const rect = composer.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const body = document.body.innerText ?? ''
      return !/Choose a workspace to start|Unable to create default workspace/u.test(body)
    })
    if (ready) return true
    await page.waitForTimeout(250)
  }
  throw new Error('browser timed out waiting for the composer')
}

try {
  const response = await page.goto(indexUrl.href, { waitUntil: 'load', timeout: 90_000 })
  result.indexStatus = response?.status() ?? null
  await waitControl({ aria: 'New session' }, 120_000)
  await waitComposer(120_000)
  // The official first-run preview notice covers the shell until its
  // acknowledgement is persisted. The isolated qualification writes that
  // acknowledgement as the row config, so a notice here means the fixture is
  // stale: fail loudly instead of driving a half-blocked UI.
  if (await page.evaluate(() => document.querySelector('[role=dialog][aria-label="Preview Notice"]') !== null)) {
    throw new Error('the official first-run preview notice blocked the Web UI: the isolated fixture must pre-acknowledge it')
  }
  // The workspace is resolved: from here the explicit shell action — not a
  // load-time auto-create — owns the Session this case uses.
  createdSessionBody = undefined
  await clickNewSession()
  const createdWaitStart = Date.now()
  while (createdSessionBody === undefined && Date.now() - createdWaitStart < 120_000) await sleep(100)
  if (createdSessionBody === undefined) throw new Error('the Web UI created no Host Session')
  const createdBody = await createdSessionBody
  const sessionId = createdBody?.result?.value?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error(`the Web UI Session create returned no Session id: ${JSON.stringify(createdBody).slice(0, 300)}`)
  }
  result.sessionId = sessionId
  writeFileSync(join(coordinationDir, 'browser-session.json'), `${JSON.stringify({ sessionId }, null, 2)}\n`, { mode: 0o600 })
  await waitFile('browser-go', 240_000)
  result.attached = true
  const composer = page.locator('[role=textbox]').last()
  await composer.click()
  await composer.fill(marker)
  // The Send control only paints once the draft exists: wait for the control,
  // not for a guessed delay.
  await waitControl({ aria: 'Send message' }, 30_000)
  await clickSend()
  result.answerSeen = await waitAnswerInConversation(marker, 'stub answer', 120_000)
  const shot = join(coordinationDir, 'pr-a-browser-composed.png')
  await page.screenshot({ path: shot, fullPage: false })
  result.screenshot = 'pr-a-browser-composed.png'
} catch (error) {
  // Only a REDACTED, first-line category travels: a navigation/interaction
  // error message can embed the authenticated page URL (with its token).
  result.error = redacted(String(error.message)).split('\n')[0].slice(0, 400)
} finally {
  result.finalPath = new URL(page.url()).pathname
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  await browser.close()
}
if (result.error !== undefined) {
  console.error(`PR_A_BROWSER_FAILURE: ${redacted(result.error)}`)
  process.exitCode = 1
} else {
  console.log(JSON.stringify({
    sessionId: result.sessionId,
    indexStatus: result.indexStatus,
    answerSeen: result.answerSeen,
    screenshot: result.screenshot,
    consoleErrors: result.consoleErrors.length,
  }))
}
