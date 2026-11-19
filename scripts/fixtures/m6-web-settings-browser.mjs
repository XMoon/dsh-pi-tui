#!/usr/bin/env node
/**
 * M6 PR-A real-Browser settings persistence witness (Playwright + real Chromium).
 *
 * Drives the OFFICIAL Web UI on an isolated Host:
 *  1. the first-run Welcome notice is visible and its "Continue" button is
 *     clicked (a real Browser write, not an overlay-supplied value);
 *  2. the official USER Profile gains `ui-settings-general.welcomeNoticeVersion`;
 *  3. a reload no longer shows the notice (the acknowledgement is read back);
 *  4. Settings -> Appearance -> Dark is clicked, the official USER Profile gains
 *     `ui-theme.preference: dark`, and a reload paints Dark as the persisted
 *     preference.
 *
 * The launch token is read from the Host's private launch material and is never
 * written to the result, a log or stdout.
 *
 * Usage: node m6-web-settings-browser.mjs <result.json>
 * Env:   M6_DSH_HOME        isolated DSH home of the running Host
 *        M6_PROFILE_PATCH   the active profile's cordis.patch.yml
 *        M6_PLAYWRIGHT_ROOT directory owning the pinned Playwright install
 *
 * @module scripts/fixtures/m6-web-settings-browser
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parse } from 'yaml'

const [resultPath] = process.argv.slice(2)
if (resultPath === undefined) throw new Error('usage: m6-web-settings-browser.mjs <result.json>')
const dshHome = process.env.M6_DSH_HOME
const profilePatch = process.env.M6_PROFILE_PATCH
const playwrightRoot = process.env.M6_PLAYWRIGHT_ROOT
if (dshHome === undefined || dshHome === '') throw new Error('M6_DSH_HOME is required')
if (profilePatch === undefined || profilePatch === '') throw new Error('M6_PROFILE_PATCH is required')
if (playwrightRoot === undefined || playwrightRoot === '') throw new Error('M6_PLAYWRIGHT_ROOT is required')

/** The running Host's launch material (an origin plus this process's token). */
function launchRecord() {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  for (const name of readdirSync(root)) {
    const path = join(root, name, 'launch.json')
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  }
  throw new Error('no Host launch material in this DSH_HOME')
}

/** The USER row for one namespace, or undefined while it is not written yet. */
function userRow(ns) {
  if (!existsSync(profilePatch)) return undefined
  const rows = parse(readFileSync(profilePatch, 'utf8'))
  if (!Array.isArray(rows)) return undefined
  const row = rows.filter(entry => entry !== null && typeof entry === 'object' && entry.id === ns).at(-1)
  if (row === undefined || row.config === null || typeof row.config !== 'object') return undefined
  return row.config
}

/** Bounded wait for one USER field to reach an expected value. */
async function waitUserField(ns, field, expected, timeoutMs) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = userRow(ns)?.[field]
    if (last === expected) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${ns}.${field} = ${JSON.stringify(expected)} (last ${JSON.stringify(last)})`)
}

const result = {
  welcomeVisible: false,
  welcomeAcknowledged: null,
  welcomePersisted: false,
  welcomeStayedHiddenAfterReload: false,
  themePersisted: false,
  themeStayedSelectedAfterReload: false,
  settingsTriggerFound: false,
  buttons: [],
  launchers: [],
  consoleErrors: [],
  failedResponses: [],
}

const { chromium } = createRequire(join(playwrightRoot, 'package.json'))('playwright')
const launchUrl = new URL(launchRecord().connectUrl)
const launchToken = launchUrl.searchParams.get('token')
const indexUrl = new URL('/', launchUrl.origin)
indexUrl.searchParams.set('token', launchToken)

/** Remove every credential shape this process can observe before retaining it. */
function redacted(text) {
  let value = String(text)
  if (typeof launchToken === 'string' && launchToken !== '') value = value.split(launchToken).join('<redacted-token>')
  return value
    .replace(/([?&]token=)[^&\s"']+/gu, '$1<redacted>')
    .replace(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:<port>')
}

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
  const page = await context.newPage()
  page.on('console', message => {
    if (message.type() === 'error') result.consoleErrors.push(redacted(message.text()).slice(0, 300))
  })
  page.on('response', response => {
    if (response.status() < 400 || result.failedResponses.length >= 20) return
    result.failedResponses.push(`${response.request().method()} ${new URL(response.url()).pathname} -> ${response.status()}`)
  })

  /** Wait for the Web shell's own composer/sidebar, not just a painted body. */
  async function waitShell(timeoutMs) {
    await page.getByRole('textbox').last().waitFor({ state: 'visible', timeout: timeoutMs })
  }

  await page.goto(indexUrl.href, { waitUntil: 'load', timeout: 120_000 })
  await waitShell(120_000)

  const welcomeButton = page.getByRole('button', { name: 'Continue', exact: true }).last()
  await welcomeButton.waitFor({ state: 'visible', timeout: 60_000 })
  result.welcomeVisible = true
  await welcomeButton.click()
  await welcomeButton.waitFor({ state: 'hidden', timeout: 60_000 })
  const acknowledgedStarted = Date.now()
  while (Date.now() - acknowledgedStarted < 30_000) {
    const value = userRow('ui-settings-general')?.welcomeNoticeVersion
    if (typeof value === 'string' && value !== '') {
      result.welcomeAcknowledged = value
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (result.welcomeAcknowledged === null) {
    throw new Error('the Welcome acknowledgement was not written to the official USER Profile')
  }
  result.welcomePersisted = true

  // A real reload must read the acknowledgement back and paint no notice.
  await page.reload({ waitUntil: 'load', timeout: 120_000 })
  await waitShell(120_000)
  await page.getByRole('button', { name: 'Continue', exact: true }).last().waitFor({ state: 'hidden', timeout: 10_000 })
  result.welcomeStayedHiddenAfterReload = true

  // Settings -> Appearance -> Dark. The trigger's accessible name is the
  // official shell copy; the Appearance row's cubes are real buttons.
  // The credential onboarding is a second first-run step on a profile without
  // credentials; dismissing it is the product's explicit "Configure later".
  const later = page.getByRole('button', { name: 'Configure later', exact: true }).last()
  if (await later.isVisible().catch(() => false)) {
    await later.click()
    await later.waitFor({ state: 'hidden', timeout: 10_000 })
  }

  /** Open the settings panel through a real shortcut first, then the launcher. */
  async function openSettings() {
    const panel = page.locator('[data-shortcut-modal="settings"]').last()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
    try {
      await panel.waitFor({ state: 'visible', timeout: 5_000 })
      return panel
    } catch {
      // The shell may expose only the launcher button on this build.
    }
    const candidates = [
      page.locator('button[aria-haspopup="dialog"]').last(),
      page.getByRole('button', { name: /settings|设置/iu }).last(),
      page.getByLabel(/settings|设置/iu).last(),
      page.getByText('Settings', { exact: true }).last(),
    ]
    for (const candidate of candidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout: 10_000 })
        await candidate.click()
        await panel.waitFor({ state: 'visible', timeout: 10_000 })
        result.settingsTriggerFound = true
        return panel
      } catch {
        // try the next launcher shape
      }
    }
    // The official shell's account/ellipsis launcher owns the Settings entry.
    try {
      await page.getByRole('button', { name: 'Account menu', exact: true }).last().click()
      const item = page.getByRole('menuitem', { name: /settings|设置/iu }).last()
      await item.waitFor({ state: 'visible', timeout: 10_000 })
      await item.click()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      result.settingsTriggerFound = true
      return panel
    } catch {
      // try the next launcher shape
    }
    // The official shell nests other items under the sidebar's "More" menu.
    try {
      await page.getByRole('button', { name: 'More', exact: true }).last().click()
      const item = page.getByRole('menuitem', { name: /settings|设置/iu }).last()
      await item.waitFor({ state: 'visible', timeout: 10_000 })
      await item.click()
      await panel.waitFor({ state: 'visible', timeout: 10_000 })
      result.settingsTriggerFound = true
      return panel
    } catch {
      // fall through to the diagnostics
    }
    result.buttons = await page.locator('button').evaluateAll(nodes => nodes.map(node => ({
      text: (node.innerText ?? '').trim().slice(0, 60),
      aria: node.getAttribute('aria-label'),
      popup: node.getAttribute('aria-haspopup'),
    })).slice(0, 80))
    result.launchers = await page.locator('[aria-label], [aria-haspopup], [data-shortcut-modal]').evaluateAll(nodes => nodes.map(node => ({
      tag: node.tagName,
      text: (node.innerText ?? '').trim().slice(0, 60),
      aria: node.getAttribute('aria-label'),
      popup: node.getAttribute('aria-haspopup'),
      modal: node.getAttribute('data-shortcut-modal'),
    })).slice(0, 120))
    console.error(`settings launcher not found; buttons=${JSON.stringify(result.buttons)}`)
    throw new Error('the official settings launcher was not reachable')
  }
  await openSettings()
  await page.getByRole('button', { name: 'Dark', exact: true }).last().waitFor({ state: 'visible', timeout: 60_000 })
  await page.getByRole('button', { name: 'Dark', exact: true }).last().click()
  await waitUserField('ui-theme', 'preference', 'dark', 60_000)
  result.themePersisted = true
  await page.keyboard.press('Escape')

  // The persisted preference, not the resolved palette, must survive reload.
  await page.reload({ waitUntil: 'load', timeout: 120_000 })
  await waitShell(120_000)
  await openSettings()
  const dark = page.getByRole('button', { name: 'Dark', exact: true }).last()
  await dark.waitFor({ state: 'visible', timeout: 60_000 })
  if ((await dark.getAttribute('aria-pressed')) !== 'true') {
    throw new Error('the Dark Appearance cube did not read back as the persisted preference after reload')
  }
  result.themeStayedSelectedAfterReload = true
} finally {
  await browser.close()
  result.consoleErrors = result.consoleErrors.filter(entry => !/favicon/iu.test(entry))
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
}
