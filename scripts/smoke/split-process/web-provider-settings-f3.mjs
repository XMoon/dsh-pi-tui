/**
 * M6-1 F3 (PR1 rc.2 adaptation): the official Web Search / Fetch Settings
 * across real Split clients.
 *
 * ONE real Host (the installed candidate package plus the inert qualification
 * fixture row) and TWO real authenticated TUI Clients prove, WITHOUT an open
 * Session (the Settings surface is sessionless):
 *
 *   1. the Host fixture seeds a KNOWN rc.2 baseline through the OFFICIAL
 *      Settings service (`web.searchProvider = deepseek-search-api`,
 *      `web.fetchProvider = deepseek-fetch-api`, `web-deepseek-api`: count
 *      `10`, Share Original Question `off`, both Billing modes `auto`, and NO
 *      advanced override); Client A reads that baseline back from the real
 *      nine-row page, and Client B reads the same Host facts — neither Client
 *      paints a locally guessed value (the page stays `Loading…` until the
 *      Host read answers, and `Unavailable` when it does not);
 *   2. both providers are edited through the real page (`Messages` and
 *      `HTTP`, then back to the two API providers): each is ONE verified
 *      official Settings CAS mutation, and a Billing row whose API provider is
 *      not the current route shows `Not selected` and offers no write;
 *   3. BOTH Billing rows are written through the real TUI CAS on their OWN
 *      exact `web-deepseek-api` field: Search Billing → `Account`, Fetch
 *      Billing → `API key`. Writing one field never touches the other;
 *   4. result count and Share Original Question are edited through the same
 *      page; Client B keeps painting its already-read count after A's writes
 *      (no optimistic push) and only a real `r` re-read shows the Host truth;
 *   5. AFTER those CAS phases the Host fixture sets the rc.2 YAML-only
 *      `searchBaseURL` override through one official `ctx.settings.mutate`
 *      (never the TUI): the `Search API Override` row paints the MASKED
 *      read-only Host fact, `Search Billing` becomes `Overridden by Host YAML`
 *      with ZERO write attempts (Enter is inert), while the `Fetch API
 *      Override` row stays `not set` and Fetch Billing remains independently
 *      writable with an exact CAS read-back;
 *   6. the retired endpoint is gone: there is NO `Search / Fetch API Endpoint` row, no
 *      endpoint editor and no `web-deepseek-api.baseURL/apiKeyEnv/apiKey`
 *      write anywhere; the page copy is the rc.2 one (`Not selected`,
 *      `Overridden by Host YAML`, `Current: …`);
 *   7. the OFFICIAL Settings CAS rejects a stale revision at the REAL Gateway
 *      RPC seam: through the same official generated `settings` namespace the
 *      ConfigPort mirror uses, the Client reads revision R, commits once at R
 *      (R→R+1), then re-submits the OLD R — the Host accepts the first and
 *      rejects the second with the official revision-conflict vocabulary
 *      (`expected revision N, now N+1`), leaving exactly the accepted value;
 *   8. both Clients drop and re-establish their physical Gateway carrier; the
 *      official values (including the advanced override fact) do not roll
 *      back and the durable document does not change;
 *   9. the Host fixture clears the YAML-only override again through the same
 *      official write, so the shared lane profile is left without a fabricated
 *      endpoint; Search Billing is writable again and both Billing modes are
 *      restored to `auto` through the real page;
 *  10. the Host fixture stored a NON-FUNCTIONAL unique credential sentinel
 *      through the official `ctx.credentials.set` path; the credential row
 *      stays a metadata-only reference witness (name + configured state, never
 *      a value) and the sentinel appears in NO pane, settings document, Host
 *      work proof or Client telemetry record;
 *  11. the MOUNTED Remote ConfigPort refuses an invalid provider id and an
 *      out-of-range count BEFORE any Host dispatch (the document is untouched)
 *      and refuses to replace a CUSTOM provider route seeded through the real
 *      official settings namespace.
 *
 * The trace and every failure label separate the two verdicts this case owns:
 *   - `UI_L6`              → the real TUI edits, cross-client read-back and
 *     the Billing/override writer gates;
 *   - `HOST_GATEWAY_CAS`   → the deterministic official Settings CAS rejection
 *     at the real Client Remote `settings` seam (the same
 *     `SettingsForms.mutate(ns, ops, expectedRevision)` the Host serves).
 *
 * A stale revision the page READS cannot be dispatched by ONE Client: the
 * command owner re-reads before every write and the Remote mirror re-reads on
 * `settings/document-updated`. The deterministic witness therefore drives the
 * SAME official generated `settings` namespace directly inside the real Client
 * composition (a qualification-only `settings-stale-cas` probe, gated by
 * `SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF`, never a product input): a
 * sequential read/commit/stale-commit against the real Host rejects the stale
 * one — no timing race and no fixture-injected state.
 *
 * Evidence scope: the page only ever offers the two official provider
 * candidates, the four count presets and the three official Billing modes, so
 * an invalid provider id / an out-of-range count cannot be TYPED into it; item
 * 11 drives them through the same mounted Remote ConfigPort the TUI uses, over
 * the real authenticated Host, and proves the refusals happen before any Host
 * write. The YAML-only overrides are read-only on purpose: the case injects
 * them through the fixture's official Settings mutation, because the page must
 * never provide a write path for them. This case never edits the profile
 * document itself.
 *
 * @module split-process/web-provider-settings-f3
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { parse as parseYaml } from 'yaml'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The frozen page title (the Settings row and the breadcrumb tail). */
const WEB_PAGE_TITLE = 'Web Search / Fetch'
const WEB_PAGE_BREADCRUMB = `Settings · Tools · ${WEB_PAGE_TITLE}`

/** The page's list Action Bar wordings, longest first: a narrow grant drops
 *  whole segments, never half a word. */
const WEB_LIST_BARS = [
  '↑/↓ choose · Enter open · r refresh · Back [Esc]',
  '↑/↓ · Enter open · r refresh · Back [Esc]',
  '↑/↓ · Enter · Back [Esc]',
  'Back [Esc]',
]

/** The NINE rows in the page's FROZEN rc.2 order (§5.5A E2.3). */
const WEB_ROW_LABELS = [
  'Web Search Provider',
  'Web Fetch Provider',
  'Search API Result Count',
  'Share Original Question',
  'Search Billing',
  'Fetch Billing',
  'Search API Override',
  'Fetch API Override',
  'DeepSeek API Key',
]
const ROW = Object.freeze({
  searchProvider: 0,
  fetchProvider: 1,
  count: 2,
  sendOriginalQuestion: 3,
  searchBilling: 4,
  fetchBilling: 5,
  searchAdvanced: 6,
  fetchAdvanced: 7,
  credential: 8,
})
/** The retired rc.1 row identity: it must NEVER be painted again. */
const LEGACY_ENDPOINT_ROW = 'Search / Fetch API Endpoint'

/** The KNOWN official baseline the Host fixture seeds through the official
 *  Settings service (never a shipped-default guess). */
const SEED_COUNT = 10
const SEED_SEND_ORIGINAL_QUESTION = false
const SEED_BILLING = Object.freeze({ search: 'auto', fetch: 'auto' })
/** The rc.2 YAML-only Search API override the fixture injects AFTER both TUI
 *  Billing CAS phases. It carries fake userinfo + a query ON PURPOSE: the page
 *  must paint the MASKED fact (`https://***@…`, query dropped) and never the
 *  credential-shaped source. */
const SEED_BASE_URL = 'https://f3-user:f3-masked@f3-seed.example.test/v1/tools?token=f3-query'
const SEED_BASE_URL_MASKED = 'https://***@f3-seed.example.test/v1/tools'
const BILLING_LABELS = Object.freeze({ auto: 'Automatic', account: 'Account', 'api-key': 'API key' })
const SEARCH_OVERRIDE_FACT = `searchBaseURL=${SEED_BASE_URL_MASKED}`
const OVERRIDE_UNSET_FACT = 'Host YAML: not set'
const SEARCH_API_PROVIDER_LABEL = 'DeepSeek Search API'
const FETCH_API_PROVIDER_LABEL = 'DeepSeek Fetch API'
const MESSAGES_PROVIDER_LABEL = 'Messages'
const HTTP_PROVIDER_LABEL = 'HTTP'
const COUNT_CANDIDATES = ['5', '10', '20', '50']
const QUESTION_ON = 0
const QUESTION_OFF = 1
/** The fixture's ONE official late-override control file (under the private
 *  C1 work root): `{ nonce, op: 'set' | 'clear' }`. */
const OVERRIDE_REQUEST_FILE = 'f3-search-override-request.json'
/** The official settings sections the page owns. */
const WEB_NS = 'web'
const WEB_API_NS = 'web-deepseek-api'
/** The ONE official credential reference the Web providers resolve. */
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
/** The retired rc.1 endpoint keys: rc.2 never writes them. */
const LEGACY_ENDPOINT_KEYS = ['baseURL', 'apiKeyEnv', 'apiKey']

/** The display a Billing row paints for the STORED mode while its capability
 *  is owned by a non-empty YAML-only override. */
function overriddenBilling(mode) {
  return `Overridden by Host YAML (stored: ${BILLING_LABELS[mode]})`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function frameOf(client) {
  return (await client.viewport()).join('\n')
}

/**
 * The Detail facts as ONE whitespace-collapsed text. The page composes the
 * list cell and the Detail cell RIGHT-ALIGNED on the same physical rows, so a
 * fixed column does not exist: the Detail's own tokens (`Current: `, `› `, the
 * verdicts) are unambiguous within the page region and are matched WHEREVER
 * their whole cell landed. The list cell never prints `Current: `.
 */
function pageDetailText(frame) {
  return frame.split('\n').join('\n').replace(/\s+/gu, ' ').trim()
}

/** The profile document the official Settings service persists into. It is
 *  read ONLY: this case never writes a settings value itself. */
function settingsDocumentPath(profileDir) {
  return join(profileDir, 'cordis.patch.yml')
}

function settingsRows(path) {
  if (!existsSync(path)) return []
  const document = parseYaml(readFileSync(path, 'utf8'))
  return Array.isArray(document) ? document : []
}

/** One namespace's persisted user-layer config, or undefined when the official
 *  service never wrote that section. */
function namespaceConfig(path, ns) {
  const rows = settingsRows(path)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    if (row.id !== ns || row.insert !== undefined) continue
    if (row.config === null || typeof row.config !== 'object' || Array.isArray(row.config)) return undefined
    return row.config
  }
  return undefined
}

function snapshot(config) {
  return config === undefined ? 'undefined' : JSON.stringify(config)
}

/** Search the collapsed Detail text (the two-column frame may wrap a long
 *  `field=value` fact across physical lines). */
async function waitForDetailText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => pageDetailText(await frameOf(client)).includes(text), label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the Detail never stated ${JSON.stringify(text)}: ${JSON.stringify(pageDetailText(await frameOf(client)))}`, { cause: error })
  }
}

async function waitForScreenText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => (await frameOf(client)).includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /Web|Search|Fetch|Provider|Current|State|Saved|Verified|Billing|Override|Question|Settings/u.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, diagnosticLines: lines.slice(-18) })}`, { cause: error })
  }
}

/** Wait until the Detail pane's CURRENT fact equals `value` WHOLE (a number
 *  value never matches its longer neighbour, e.g. `5` vs `50`). */
async function waitForCurrentValue(client, value, label, timeoutMs = 60_000) {
  const pattern = new RegExp(`Current: ${escapeRegExp(value)}(?![\\w])`, 'u')
  let detail
  try {
    await waitForCondition(async () => {
      detail = pageDetailText(await frameOf(client))
      return pattern.test(detail)
    }, label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the Detail never stated ${JSON.stringify(value)}: ${JSON.stringify(detail ?? '')}`, { cause: error })
  }
  return detail
}

/** Submit one slash command / line after the editor seat is provably ready. A
 *  reconnect banner can share the composer, so readiness is the prompt-glyph
 *  ROW rather than a byte-exact empty draft; leftover draft text is cleared with
 *  the editor's OWN Ctrl+U before the line. */
async function submitLine(client, line, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let ready = false
    for (let poll = 0; poll < 40; poll += 1) {
      const composer = await client.composerText()
      const rows = composer === undefined ? [] : composer.split('\n').map(text => text.replace(/[│┌┐└┘─]/gu, ' ').trim())
      if (rows.some(row => row.startsWith('❯'))) {
        ready = true
        break
      }
      await sleep(150)
    }
    if (!ready) {
      client.send('\x1b')
      await sleep(300)
      continue
    }
    client.send('\x15')
    await sleep(120)
    client.send(`${line}\r`)
    return
  }
  throw new SplitSmokeAssertionError(`${label}: the editor seat never accepted the submitted line`)
}

/** Open the real `/settings` workspace rail from the Welcome editor. */
async function openSettingsWorkspace(client, label) {
  await submitLine(client, '/settings', `${label} /settings`)
  await waitForScreenText(client, 'Settings ·', `${label} Settings workspace`)
}

/** Reach the Web launcher row. When the page is closed the workspace returns
 *  directly to the Tools ROWS list; from a fresh `/settings` open it returns to
 *  the category RAIL, which must be walked onto Tools first. */
async function navigateToWebLauncher(client, label) {
  const onToolsRows = async () => {
    const frame = await frameOf(client)
    return frame.includes('Settings · Tools') && !frame.includes(WEB_PAGE_BREADCRUMB)
  }
  if (!(await onToolsRows())) {
    // The rail order is frozen: About, Models, Account, Agent, Appearance,
    // Conversation, Input & Terminal, Tools, Plugins.
    for (let step = 0; step < 16; step += 1) {
      if (/^\s*> Tools\b/mu.test(await frameOf(client))) break
      client.send('\x1b[B')
      await sleep(160)
    }
    const rail = await frameOf(client)
    assert(/^\s*> Tools\b/mu.test(rail), `${label}: the Tools category was never selected: ${JSON.stringify(rail)}`)
    client.send('\r')
    await waitForScreenText(client, WEB_PAGE_TITLE, `${label} Tools rows`)
  }
  await selectWebLauncherRow(client, label)
  client.send('\r')
  await waitForWebPage(client, label)
}

/** Open the Web page from the Welcome in one step. */
async function openWebSettingsPage(client, label) {
  await openSettingsWorkspace(client, label)
  await navigateToWebLauncher(client, label)
}

/** Walk the Tools row list onto the Web launcher row and prove the cursor. */
async function selectWebLauncherRow(client, label) {
  client.send('\x1b[H')
  await sleep(160)
  for (let step = 0; step < 12; step += 1) {
    if (/^> Web Search \/ Fetch(?:\s|$)/mu.test(await frameOf(client))) return
    client.send('\x1b[B')
    await sleep(160)
  }
  const rows = await frameOf(client)
  assert(/^> Web Search \/ Fetch(?:\s|$)/mu.test(rows), `${label}: the Web launcher row was never selected: ${JSON.stringify(rows)}`)
}

/** Leave the Web page back to the Settings workspace (or the Welcome). */
async function leaveWebPage(client, label) {
  await returnToWebList(client, label)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await frameOf(client)).includes(WEB_PAGE_BREADCRUMB)) return
    client.send('\x1b')
    await sleep(260)
  }
  assert(!(await frameOf(client)).includes(WEB_PAGE_BREADCRUMB), `${label}: never left the Web page`)
}

/** Wait for the page's settled Host read (never a guess before `Loading…`). */
async function waitForWebPage(client, label, timeoutMs = 60_000) {
  await waitForScreenText(client, WEB_PAGE_BREADCRUMB, `${label} Web page`, timeoutMs)
  await waitForScreenText(client, WEB_ROW_LABELS[0], `${label} Web rows`, timeoutMs)
  try {
    await waitForCondition(async () => !(await frameOf(client)).includes('Loading…'), `${label} settled Host read`, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the page never settled its Host read: ${JSON.stringify(await frameOf(client))}`, { cause: error })
  }
  const frame = await frameOf(client)
  // The page must paint BOTH regions for the navigation below: the pane header
  // names both columns only while the row grant keeps the Detail visible.
  assert(frame.includes('Current / Detail'),
    `${label}: the Web page did not paint the two-region layout (the PTY grant must keep the Detail pane visible)`)
  // The retired rc.1 endpoint row must be ABSENT: rc.2 has two read-only
  // YAML-only override rows instead.
  assert(!frame.includes(LEGACY_ENDPOINT_ROW),
    `${label}: the retired rc.1 "${LEGACY_ENDPOINT_ROW}" row is still painted: ${JSON.stringify(frame)}`)
}

/** The page's Action Bar is its LAST non-empty body line; its wording is the
 *  authoritative region oracle (list vs read-only Detail vs a Detail whose
 *  candidate is cropped). */
function actionBarOf(frame) {
  const lines = frame.split('\n').map(line => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] !== '') return lines[index]
  }
  return ''
}

function regionOf(frame) {
  const bar = actionBarOf(frame)
  // The credential Detail advertises `Enter open in Models` — check the DETAIL
  // verbs BEFORE the list's generic `Enter open` substring.
  if (bar.includes('Enter open in Models') || bar.includes('Enter confirm')) return 'detail'
  if (bar.includes('Enter open')) return 'list'
  if (bar.includes('refresh') || bar === 'Back [Esc]') return 'detail'
  return 'other'
}

/** Return to the page's LIST region. ONE Esc leaves the read-only Detail; a
 *  SECOND Esc at the list closes the page — so an Esc is sent ONLY while the
 *  bar proves a non-list region, and the list is proven before returning. */
async function returnToWebList(client, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const frame = await frameOf(client)
    const region = regionOf(frame)
    if (region === 'list') return
    if (region === 'other') {
      await sleep(150)
      continue
    }
    client.send('\x1b')
    await sleep(250)
  }
  const frame = await frameOf(client)
  assert(regionOf(frame) === 'list', `${label}: never returned to the list; bar=${JSON.stringify(actionBarOf(frame))}`)
}

/** Home + Down*index on the page LIST and prove the painted cursor landed. */
async function selectListRow(client, index, label) {
  await returnToWebList(client, label)
  const assertList = async phase => {
    const frame = await frameOf(client)
    assert(regionOf(frame) === 'list',
      `${label} (${phase}): the list region was lost; bar=${JSON.stringify(actionBarOf(frame))}`)
  }
  client.send('\x1b[H')
  await sleep(160)
  await assertList('after Home')
  for (let step = 0; step < index; step += 1) {
    client.send('\x1b[B')
    await sleep(160)
    await assertList(`after Down ${String(step + 1)}`)
  }
  const frame = await frameOf(client)
  // The wide layout can TRUNCATE the row label (the value/phase cell shares the
  // line), so the cursor is proven by the longest label prefix that still fits.
  const rowLabel = WEB_ROW_LABELS[index]
  const prefixes = [rowLabel, rowLabel.slice(0, 14), rowLabel.slice(0, 12), rowLabel.slice(0, 10), rowLabel.slice(0, 8)]
  const owned = frame.split('\n').some(line => line.startsWith('> ')
    && prefixes.some(prefix => line.slice(2).startsWith(prefix)))
  assert(owned,
    `${label}: row ${String(index)} (${WEB_ROW_LABELS[index]}) never owned the list cursor: ${JSON.stringify(frame)}`)
}

/** Select one page row and open its read-only Detail (Enter on the LIST
 *  region). Every rc.2 row — including the two override rows — opens its
 *  Detail; no row owns an editor. */
async function openWebRow(client, index, label, needle = 'Current: ') {
  await selectListRow(client, index, label)
  client.send('\r')
  await waitForScreenText(client, needle, `${label} ${WEB_ROW_LABELS[index]} detail`, 30_000)
  await waitForCondition(async () => regionOf(await frameOf(client)) === 'detail',
    `${label} ${WEB_ROW_LABELS[index]} Detail region`, 15_000)
}

/** Home + Down*index inside the Detail's candidate list and prove the marker
 *  landed on the requested candidate (`› ` is the Detail's only candidate
 *  marker; `>` is the list cursor). */
async function selectCandidate(client, index, label, candidateLabel) {
  client.send('\x1b[H')
  await sleep(140)
  for (let step = 0; step < index; step += 1) {
    client.send('\x1b[B')
    await sleep(140)
  }
  const frame = await frameOf(client)
  const line = frame.split('\n').find(entry => entry.includes('› ') && entry.includes(candidateLabel))
  assert(line !== undefined,
    `${label}: the Detail cursor never reached ${JSON.stringify(candidateLabel)}: ${JSON.stringify(frame.split('\n'))}`)
}

/** ONE explicit Detail confirm; the read-back is the authority (a verdict on
 *  its own could still describe an older write of the same row). */
async function confirmCandidate(client, expectedCurrent, label) {
  client.send('\r')
  await waitForCurrentValue(client, expectedCurrent, `${label} authoritative read-back`)
  await waitForScreenText(client, 'Verified', `${label} verified verdict`, 20_000)
  return pageDetailText(await frameOf(client))
}

/** Every page row's Host-returned value, read through the real Detail. Each
 *  read leaves the Detail open, so the list cursor is re-established between
 *  rows (the Detail owns Enter/↓; the list owns row navigation). */
async function assertPageFacts(client, expected, label) {
  await openWebRow(client, ROW.searchProvider, `${label} search provider`)
  await waitForCurrentValue(client, expected.searchProviderLabel, `${label} search provider value`)
  await returnToWebList(client, `${label} search provider list`)
  await openWebRow(client, ROW.fetchProvider, `${label} fetch provider`)
  await waitForCurrentValue(client, expected.fetchProviderLabel, `${label} fetch provider value`)
  await returnToWebList(client, `${label} fetch provider list`)
  await openWebRow(client, ROW.count, `${label} result count`)
  await waitForCurrentValue(client, String(expected.count), `${label} result count value`)
  await returnToWebList(client, `${label} result count list`)
  await openWebRow(client, ROW.sendOriginalQuestion, `${label} original question`)
  await waitForCurrentValue(client, expected.sendOriginalQuestion ? 'on' : 'off', `${label} original question value`)
  await returnToWebList(client, `${label} original question list`)
  await openWebRow(client, ROW.searchBilling, `${label} search billing`)
  await waitForCurrentValue(client, expected.searchBilling, `${label} search billing value`)
  await returnToWebList(client, `${label} search billing list`)
  await openWebRow(client, ROW.fetchBilling, `${label} fetch billing`)
  await waitForCurrentValue(client, expected.fetchBilling, `${label} fetch billing value`)
  await returnToWebList(client, `${label} fetch billing list`)
  await openWebRow(client, ROW.searchAdvanced, `${label} search override`)
  await waitForDetailText(client, expected.searchAdvanced, `${label} search override value`)
  await returnToWebList(client, `${label} search override list`)
  await openWebRow(client, ROW.fetchAdvanced, `${label} fetch override`)
  await waitForDetailText(client, expected.fetchAdvanced, `${label} fetch override value`)
  await returnToWebList(client, `${label} fetch override list`)
  await openWebRow(client, ROW.credential, `${label} credential`, 'Reference: ')
  await waitForScreenText(client, `Reference: ${CREDENTIAL_REF}`, `${label} official credential reference`)
  await waitForScreenText(client, `State: ${expected.credentialState}`, `${label} credential state`)
  await returnToWebList(client, `${label} credential list`)
}

/** Persist evidence for ONE page write: the exact namespace's user layer owns
 *  the requested field while the OTHER section did not move. */
function assertNamespaceWrite(documentPath, ns, before, assertConfig, label) {
  const other = ns === WEB_NS ? WEB_API_NS : WEB_NS
  const after = namespaceConfig(documentPath, ns)
  assert(after !== undefined, `${label}: the official Settings service persisted no "${ns}" user layer`)
  assertConfig(after)
  assert(snapshot(namespaceConfig(documentPath, other)) === before[other],
    `${label}: the write mutated the other official section too: ${ns}=${JSON.stringify(after)} other=${snapshot(namespaceConfig(documentPath, other))}`)
  return snapshot(after)
}

/** The official Settings service PRUNES a `web` user layer when every value
 *  equals the shipped default. The effective value is then the default; a
 *  missing section is a PASS, not a lost write. */
function assertWebEffective(documentPath, expected, label) {
  const after = namespaceConfig(documentPath, WEB_NS) ?? {}
  assert((after.searchProvider ?? 'deepseek-search-api') === expected.searchProvider,
    `${label}: effective searchProvider must be ${expected.searchProvider}: ${JSON.stringify(after)}`)
  assert((after.fetchProvider ?? 'http') === expected.fetchProvider,
    `${label}: effective fetchProvider must be ${expected.fetchProvider}: ${JSON.stringify(after)}`)
}

/** The rc.2 `web-deepseek-api` schema NEVER writes the retired single-endpoint
 *  keys: their presence would mean the page still offered a legacy write. */
function assertNoLegacyEndpointKeys(config, label) {
  for (const field of LEGACY_ENDPOINT_KEYS) {
    assert(config?.[field] === undefined,
      `${label}: the retired rc.1 field "${field}" reached the official RC.2 section: ${JSON.stringify(config)}`)
  }
}

/** The exact `web-deepseek-api` facts after ONE write: independent per-field
 *  CAS values (never a synthesized single endpoint). */
function assertApiSection(documentPath, before, expected, label) {
  return assertNamespaceWrite(documentPath, WEB_API_NS, before, config => {
    assert(config.count === expected.count,
      `${label}: the official count must be ${String(expected.count)}: ${JSON.stringify(config)}`)
    assert(config.sendOriginalQuestion === expected.sendOriginalQuestion,
      `${label}: the official sendOriginalQuestion must be ${String(expected.sendOriginalQuestion)}: ${JSON.stringify(config)}`)
    assert(config.searchBilling === expected.searchBilling,
      `${label}: the official searchBilling must be ${String(expected.searchBilling)}: ${JSON.stringify(config)}`)
    assert(config.fetchBilling === expected.fetchBilling,
      `${label}: the official fetchBilling must be ${String(expected.fetchBilling)}: ${JSON.stringify(config)}`)
    assert(config.searchBaseURL === expected.searchBaseURL,
      `${label}: the official searchBaseURL must be ${String(expected.searchBaseURL)}: ${JSON.stringify(config)}`)
    assert(config.fetchBaseURL === expected.fetchBaseURL,
      `${label}: the official fetchBaseURL must be ${String(expected.fetchBaseURL)}: ${JSON.stringify(config)}`)
    assertNoLegacyEndpointKeys(config, label)
  }, label)
}

/** Snapshot both official sections before one write. */
function sectionsSnapshot(documentPath) {
  return {
    [WEB_NS]: snapshot(namespaceConfig(documentPath, WEB_NS)),
    [WEB_API_NS]: snapshot(namespaceConfig(documentPath, WEB_API_NS)),
  }
}

/**
 * The page must be able to paint the given Billing value while offering NO
 * Confirm affordance, and ONE Enter must produce ZERO Host writes. A stale
 * presentation could still offer a candidate; the command owner's OWN override
 * guard must then refuse it — but the real page already gates the candidate, so
 * this proves the UI gate and the durable non-write together.
 */
async function assertInertBilling(client, documentPath, row, expectedValue, expectedNote, label) {
  await openWebRow(client, row, label)
  const detail = await waitForCurrentValue(client, expectedValue, `${label} current`)
  assert(detail.includes(expectedNote),
    `${label}: the inert Billing Detail must state its cause ${JSON.stringify(expectedNote)}: ${JSON.stringify(detail)}`)
  assert(!actionBarOf(await frameOf(client)).includes('Enter confirm'),
    `${label}: an inert Billing row advertised a Confirm affordance: ${JSON.stringify(actionBarOf(await frameOf(client)))}`)
  const before = snapshot(namespaceConfig(documentPath, WEB_API_NS))
  client.send('\r')
  await sleep(700)
  assert(snapshot(namespaceConfig(documentPath, WEB_API_NS)) === before,
    `${label}: an inert Billing row reached the official Host document`)
  assert(!(await frameOf(client)).includes('Verified'),
    `${label}: an inert Billing row painted a Verified verdict`)
  await returnToWebList(client, `${label} list`)
  return detail
}

/** Ask the Host fixture to apply/clear the rc.2 YAML-only override through ONE
 *  official Settings mutation. The event is nonce-matched so a previous phase's
 *  record can never satisfy this wait. */
async function requestSearchOverride(root, op, label) {
  const nonce = `f3-override-${op}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  writeFileSync(join(root, OVERRIDE_REQUEST_FILE), JSON.stringify({ nonce, op }), { mode: 0o600 })
  const event = await waitForC1WorkEvent(root,
    entry => (entry.kind === 'f3-search-override' || entry.kind === 'f3-search-override-failed') && entry.nonce === nonce,
    label,
    120_000)
  assert(event.kind === 'f3-search-override',
    `${label}: the Host refused the official YAML-only override mutation: ${JSON.stringify(event)}`)
  return event
}

/** Drop and re-establish one Client's physical Gateway carrier. */
async function reconnectClient(client, label) {
  const generation = client.records.filter(record => record.m4b2s === 'surface-status').at(-1)?.generationId
  assert(typeof generation === 'number', `${label}: the Client reported no live Gateway generation before the reconnect`)
  client.signalBusiness('SIGUSR1')
  await waitForCondition(() => client.records.some(record => record.m4b2s === 'surface-status'
    && record.transport === 'connected'
    && typeof record.generationId === 'number'
    && record.generationId !== generation), `${label} authenticated reconnect generation`, 120_000)
  return generation
}

/** Leave the Web page and re-enter it: a NEW page instance owns empty write
 *  phases, so a repeated row can never be judged by an older verdict. */
async function reopenWebPage(client, label) {
  await leaveWebPage(client, label)
  if ((await frameOf(client)).includes('Settings ·')) {
    await navigateToWebLauncher(client, label)
  } else {
    await openWebSettingsPage(client, label)
  }
}

/** Re-enter the page after a carrier drop: the workspace normally survives on
 *  the same page, and a surface that returned to its editor opens it again. The
 *  reconnected surface repaints connection banners first, so wait for a stable
 *  frame before choosing the path. */
async function restoreWebPageAfterReconnect(client, label) {
  for (let poll = 0; poll < 40; poll += 1) {
    const frame = await frameOf(client)
    const composer = (await client.composerText()) ?? ''
    if (frame.includes('Settings ·') || composer.includes('❯')) break
    await sleep(200)
  }
  if ((await frameOf(client)).includes('Settings ·')) {
    await reopenWebPage(client, label)
    return
  }
  await openWebSettingsPage(client, label)
}

/** The effective page baseline the Host fixture seeded (asserted against the
 *  fixture's OWN `f3-host-seed` descriptor facts, never a guessed default). */
function baselineFacts(seed) {
  return {
    searchProviderLabel: SEARCH_API_PROVIDER_LABEL,
    fetchProviderLabel: FETCH_API_PROVIDER_LABEL,
    count: seed.api.count,
    sendOriginalQuestion: seed.api.sendOriginalQuestion,
    searchBilling: BILLING_LABELS[seed.api.searchBilling],
    fetchBilling: BILLING_LABELS[seed.api.fetchBilling],
    searchAdvanced: OVERRIDE_UNSET_FACT,
    fetchAdvanced: OVERRIDE_UNSET_FACT,
    credentialState: 'Configured',
  }
}

/**
 * One case: `web-settings.official-provider-f3`.
 */
export async function runWebProviderSettingsF3(context) {
  const { trace, installation } = context
  const scene = createC1Scene(context, { webSettingsProbe: true })
  const root = scene.c1WorkRoot('f3-web-provider-settings')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const requestPath = join(context.workDir, 'f3-settings-stale-cas-request.json')
  const documentPath = settingsDocumentPath(installation.profileDir)
  let clientA
  let clientB
  let host
  let disposed = false

  try {
    // The qualification fixture seeds the official rc.2 Web settings sections
    // and stores the credential sentinel through the official Host services:
    // every later value is produced by those SAME services (the case never
    // edits the profile document).
    const sentinel = `sk-f3sentinel-${String(process.pid)}-${Date.now().toString(36)}`
    const started = await scene.startC1Host('web-settings-f3', 'F3 Web provider settings Host', {
      C1_F3_BASE_URL: SEED_BASE_URL,
      C1_F3_SECRET: sentinel,
    }, root)
    host = started.host
    const hostPid = started.ready.pid
    // The fixture's seed IS the authority: the page baseline below must match it.
    const seed = await waitForC1WorkEvent(root, event => event.kind === 'f3-host-seed', 'F3 official Host seed')
    assert(seed.web?.searchProvider === 'deepseek-search-api'
      && seed.web?.fetchProvider === 'deepseek-fetch-api',
    `F3 the official Host seed did not select both API providers: ${JSON.stringify(seed.web)}`)
    assert(seed.api?.count === SEED_COUNT
      && seed.api?.sendOriginalQuestion === SEED_SEND_ORIGINAL_QUESTION
      && seed.api?.searchBilling === SEED_BILLING.search
      && seed.api?.fetchBilling === SEED_BILLING.fetch,
    `F3 the official Host seed is not the frozen baseline: ${JSON.stringify(seed.api)}`)
    // No advanced override at the start: BOTH Billing rows must be TUI-writable.
    assert(seed.api?.searchBaseURL === undefined && seed.api?.fetchBaseURL === undefined,
      `F3 the official Host seed already carries an advanced override: ${JSON.stringify(seed.api)}`)
    assert(Array.isArray(seed.api?.legacyKeys) && seed.api.legacyKeys.length === 0,
      `F3 the official Host seed wrote a retired rc.1 endpoint key: ${JSON.stringify(seed.api)}`)
    assert(typeof seed.revisions?.[WEB_NS] === 'number' && typeof seed.revisions?.[WEB_API_NS] === 'number',
      `F3 the official seed recorded no revisions: ${JSON.stringify(seed.revisions)}`)
    const baseline = baselineFacts(seed)
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'host',
      hostPid,
      sections: [WEB_NS, WEB_API_NS],
      baseline,
      advanced: { searchBaseURL: 'unset', fetchBaseURL: 'unset' },
      seededRevision: seed.revisions[WEB_API_NS],
      seededWebRevision: seed.revisions[WEB_NS],
      credentialSeeded: true,
    })

    const a = await scene.startC1Client('F3 Web settings Client A', { SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF: requestPath })
    const b = await scene.startC1Client('F3 Web settings Client B')
    clientA = a.client
    clientB = b.client
    // Both surfaces are SESSIONLESS: the Settings workspace must not need one.
    for (const [label, client] of [['A', clientA], ['B', clientB]]) {
      assert(!client.records.some(record => record.m4b2s === 'surface-status' && record.sessionOpen === true),
        `UI_L6 ${label}: the Client opened a Session; the F3 surface must qualify sessionless`)
    }

    // ── 1. The Host-returned baseline, read by BOTH Clients. ────────────────
    await openWebSettingsPage(clientA, 'UI_L6 Client A')
    await assertPageFacts(clientA, baseline, 'UI_L6 A baseline')
    await openWebSettingsPage(clientB, 'UI_L6 Client B')
    await assertPageFacts(clientB, baseline, 'UI_L6 B baseline')
    // Client B stays on the result-count Detail so A's next writes can prove
    // that B never receives an optimistic push.
    await openWebRow(clientB, ROW.count, 'UI_L6 B baseline count')
    await waitForCurrentValue(clientB, String(baseline.count), 'UI_L6 B baseline count value')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'baseline-read',
      searchProvider: baseline.searchProviderLabel,
      fetchProvider: baseline.fetchProviderLabel,
      count: baseline.count,
      sendOriginalQuestion: baseline.sendOriginalQuestion,
      searchBilling: baseline.searchBilling,
      fetchBilling: baseline.fetchBilling,
      advancedOverrides: 'unset',
      sessionless: true,
      clients: 2,
    })

    // ── 2. Provider edits through the real page, and the Billing route gate. ─
    const beforeSearchProvider = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.searchProvider, 'UI_L6 A search provider')
    await selectCandidate(clientA, 0, 'UI_L6 A search provider', MESSAGES_PROVIDER_LABEL)
    await confirmCandidate(clientA, MESSAGES_PROVIDER_LABEL, 'UI_L6 A search provider write')
    assertNamespaceWrite(documentPath, WEB_NS, beforeSearchProvider, config => {
      assert(config.searchProvider === 'deepseek-official',
        `UI_L6 A search provider: the official "web" user layer must hold Messages: ${JSON.stringify(config)}`)
      assert(config.fetchProvider === 'deepseek-fetch-api',
        `UI_L6 A search provider: the Fetch provider must stay unchanged: ${JSON.stringify(config)}`)
      assertNoLegacyEndpointKeys(config, 'UI_L6 A search provider')
    }, 'UI_L6 A search provider')
    // Messages Search is not the billed Search API: its Billing row is inert
    // and says so instead of pretending to be writable.
    await assertInertBilling(clientA, documentPath, ROW.searchBilling, 'Not selected',
      'only the DeepSeek Search API uses Search Billing', 'UI_L6 A search billing route gate')

    const beforeSearchProviderBack = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.searchProvider, 'UI_L6 A search provider back')
    await selectCandidate(clientA, 1, 'UI_L6 A search provider back', SEARCH_API_PROVIDER_LABEL)
    await confirmCandidate(clientA, SEARCH_API_PROVIDER_LABEL, 'UI_L6 A search provider back write')
    assertWebEffective(documentPath, { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
      'UI_L6 A search provider back')

    const beforeFetchProvider = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.fetchProvider, 'UI_L6 A fetch provider')
    await selectCandidate(clientA, 0, 'UI_L6 A fetch provider', HTTP_PROVIDER_LABEL)
    await confirmCandidate(clientA, HTTP_PROVIDER_LABEL, 'UI_L6 A fetch provider write')
    // HTTP is the shipped default: the official service may prune the whole
    // `web` user layer, which is the effective HTTP/Search-API baseline.
    assertWebEffective(documentPath, { searchProvider: 'deepseek-search-api', fetchProvider: 'http' },
      'UI_L6 A fetch provider')
    await assertInertBilling(clientA, documentPath, ROW.fetchBilling, 'Not selected',
      'only the DeepSeek Fetch API uses Fetch Billing', 'UI_L6 A fetch billing route gate')

    const beforeFetchProviderBack = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.fetchProvider, 'UI_L6 A fetch provider back')
    await selectCandidate(clientA, 1, 'UI_L6 A fetch provider back', FETCH_API_PROVIDER_LABEL)
    await confirmCandidate(clientA, FETCH_API_PROVIDER_LABEL, 'UI_L6 A fetch provider back write')
    assertNamespaceWrite(documentPath, WEB_NS, beforeFetchProviderBack, config => {
      assert(config.fetchProvider === 'deepseek-fetch-api',
        `UI_L6 A fetch provider back: the official "web" user layer must hold the Fetch API: ${JSON.stringify(config)}`)
    }, 'UI_L6 A fetch provider back')

    // ── 3. BOTH Billing rows through the REAL TUI CAS, on their OWN fields. ─
    const beforeSearchBilling = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.searchBilling, 'UI_L6 A search billing')
    await selectCandidate(clientA, 1, 'UI_L6 A search billing', BILLING_LABELS.account)
    await confirmCandidate(clientA, BILLING_LABELS.account, 'UI_L6 A search billing write')
    assertApiSection(documentPath, beforeSearchBilling, {
      count: SEED_COUNT,
      sendOriginalQuestion: SEED_SEND_ORIGINAL_QUESTION,
      searchBilling: 'account',
      fetchBilling: SEED_BILLING.fetch,
      searchBaseURL: undefined,
      fetchBaseURL: undefined,
    }, 'UI_L6 A search billing')

    const beforeFetchBilling = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.fetchBilling, 'UI_L6 A fetch billing')
    await selectCandidate(clientA, 2, 'UI_L6 A fetch billing', BILLING_LABELS['api-key'])
    await confirmCandidate(clientA, BILLING_LABELS['api-key'], 'UI_L6 A fetch billing write')
    assertApiSection(documentPath, beforeFetchBilling, {
      count: SEED_COUNT,
      sendOriginalQuestion: SEED_SEND_ORIGINAL_QUESTION,
      searchBilling: 'account',
      fetchBilling: 'api-key',
      searchBaseURL: undefined,
      fetchBaseURL: undefined,
    }, 'UI_L6 A fetch billing')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'billing-cas',
      searchBilling: { requested: 'account', durable: 'account', otherField: 'untouched' },
      fetchBilling: { requested: 'api-key', durable: 'api-key', otherField: 'untouched' },
      advancedOverrides: 'unset',
      evidence: 'real TUI Confirm → official revision-checked settings mutation → Host read-back',
    })

    // ── 4. Count / Share Original Question through the same page. ───────────
    const beforeCount = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.count, 'UI_L6 A result count')
    await selectCandidate(clientA, COUNT_CANDIDATES.indexOf('20'), 'UI_L6 A result count', '20')
    await confirmCandidate(clientA, '20', 'UI_L6 A result count write')
    assertApiSection(documentPath, beforeCount, {
      count: 20,
      sendOriginalQuestion: SEED_SEND_ORIGINAL_QUESTION,
      searchBilling: 'account',
      fetchBilling: 'api-key',
      searchBaseURL: undefined,
      fetchBaseURL: undefined,
    }, 'UI_L6 A result count')

    const beforeQuestion = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.sendOriginalQuestion, 'UI_L6 A original question')
    await selectCandidate(clientA, QUESTION_ON, 'UI_L6 A original question', 'on')
    await confirmCandidate(clientA, 'on', 'UI_L6 A original question write')
    assertApiSection(documentPath, beforeQuestion, {
      count: 20,
      sendOriginalQuestion: true,
      searchBilling: 'account',
      fetchBilling: 'api-key',
      searchBaseURL: undefined,
      fetchBaseURL: undefined,
    }, 'UI_L6 A original question')

    // ── 4b. B never received an optimistic push; its own `r` reads the Host. ─
    const crossExpected = {
      searchProviderLabel: SEARCH_API_PROVIDER_LABEL,
      fetchProviderLabel: FETCH_API_PROVIDER_LABEL,
      count: 20,
      sendOriginalQuestion: true,
      searchBilling: BILLING_LABELS.account,
      fetchBilling: BILLING_LABELS['api-key'],
      searchAdvanced: OVERRIDE_UNSET_FACT,
      fetchAdvanced: OVERRIDE_UNSET_FACT,
      credentialState: 'Configured',
    }
    const staleB = pageDetailText(await frameOf(clientB))
    assert(staleB.includes(`Current: ${String(SEED_COUNT)}`),
      `UI_L6 B: another Client's write must not silently repaint B's already-read count: ${JSON.stringify(staleB)}`)
    clientB.send('r')
    await waitForCurrentValue(clientB, '20', 'UI_L6 B refreshed result count')
    await assertPageFacts(clientB, crossExpected, 'UI_L6 B cross-client')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'cross-client',
      staleBeforeRefresh: SEED_COUNT,
      refreshedCount: 20,
      sameHostTruth: true,
      searchBilling: 'account',
      fetchBilling: 'api-key',
      advancedOverrides: 'unset',
    })

    // ── 5. The Host applies the rc.2 YAML-only Search override (outside the
    // TUI): its row must paint the MASKED read-only fact, Search Billing must
    // become inert with ZERO writes while Fetch Billing stays independently
    // writable. ──────────────────────────────────────────────────────────────
    const overrideEvent = await requestSearchOverride(root, 'set', 'UI_L6 Host YAML search override')
    assert(overrideEvent.api?.searchBaseURL === SEED_BASE_URL,
      `UI_L6 override: the official Host did not store the YAML-only searchBaseURL: ${JSON.stringify(overrideEvent.api)}`)
    assert(overrideEvent.api?.searchBilling === 'account' && overrideEvent.api?.fetchBilling === 'api-key',
      `UI_L6 override: injecting the Search override must not move either Billing field: ${JSON.stringify(overrideEvent.api)}`)
    assert(overrideEvent.api?.count === 20 && overrideEvent.api?.sendOriginalQuestion === true,
      `UI_L6 override: injecting the Search override must not move count/Question: ${JSON.stringify(overrideEvent.api)}`)
    assert(Array.isArray(overrideEvent.api?.legacyKeys) && overrideEvent.api.legacyKeys.length === 0,
      `UI_L6 override: the official Host section gained a retired rc.1 key: ${JSON.stringify(overrideEvent.api)}`)
    assert(typeof overrideEvent.revision === 'number',
      `UI_L6 override: the official Host reported no revision: ${JSON.stringify(overrideEvent)}`)

    const overriddenSearchBilling = overriddenBilling('account')
    const overrideExpected = {
      ...crossExpected,
      searchBilling: overriddenSearchBilling,
      searchAdvanced: SEARCH_OVERRIDE_FACT,
    }
    await reopenWebPage(clientA, 'UI_L6 override A re-read')
    await assertPageFacts(clientA, overrideExpected, 'UI_L6 override A')
    // The override row is READ-ONLY: it paints the masked Host YAML fact, never
    // the credential-shaped source, and Enter opens no editor and writes
    // nothing.
    const beforeOverrideEnter = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.searchAdvanced, 'UI_L6 A search override read-only')
    await waitForDetailText(clientA, SEARCH_OVERRIDE_FACT, 'UI_L6 A search override masked fact')
    const overridePane = pageDetailText(await frameOf(clientA))
    assert(overridePane.includes('Host YAML:') && overridePane.includes(SEARCH_OVERRIDE_FACT),
      `UI_L6 override: the Search API Override row must paint the real masked Host fact: ${JSON.stringify(overridePane)}`)
    assert(!overridePane.includes('f3-masked') && !overridePane.includes('token='),
      `UI_L6 override: the raw override value (userinfo/query) reached the pane: ${JSON.stringify(overridePane)}`)
    assert(!actionBarOf(await frameOf(clientA)).includes('Enter confirm'),
      'UI_L6 A search override: a read-only YAML-only row advertised a Confirm affordance')
    clientA.send('\r')
    await sleep(700)
    assert(snapshot(namespaceConfig(documentPath, WEB_NS)) === beforeOverrideEnter[WEB_NS]
      && snapshot(namespaceConfig(documentPath, WEB_API_NS)) === beforeOverrideEnter[WEB_API_NS],
    'UI_L6 A search override: Enter on the read-only override row reached the official Host document')
    await returnToWebList(clientA, 'UI_L6 A search override list')
    // The override owns Search Billing: no candidate, no Confirm, zero writes.
    await assertInertBilling(clientA, documentPath, ROW.searchBilling, overriddenSearchBilling,
      'Overridden by Host YAML: the advanced searchBaseURL field(s) own',
      'UI_L6 A overridden search billing')
    // Fetch Billing is NOT overridden: it stays independently writable, and its
    // second exact CAS read-back cannot move the Search field or the override.
    const beforeFetchBillingAfterOverride = sectionsSnapshot(documentPath)
    await openWebRow(clientA, ROW.fetchBilling, 'UI_L6 A fetch billing after override')
    await selectCandidate(clientA, 1, 'UI_L6 A fetch billing after override', BILLING_LABELS.account)
    await confirmCandidate(clientA, BILLING_LABELS.account, 'UI_L6 A fetch billing after override write')
    assertApiSection(documentPath, beforeFetchBillingAfterOverride, {
      count: 20,
      sendOriginalQuestion: true,
      searchBilling: 'account',
      fetchBilling: 'account',
      searchBaseURL: SEED_BASE_URL,
      fetchBaseURL: undefined,
    }, 'UI_L6 A fetch billing after override')
    // The other Client reads the override fact and the independent Billing
    // values from the SAME Host after its own `r`.
    const overrideCrossExpected = { ...overrideExpected, fetchBilling: BILLING_LABELS.account }
    clientB.send('r')
    await sleep(400)
    await assertPageFacts(clientB, overrideCrossExpected, 'UI_L6 B override cross-client')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'billing-and-override',
      override: { field: 'searchBaseURL', source: 'Host YAML', maskedFact: SEED_BASE_URL_MASKED },
      searchBilling: { value: 'account', inert: true, writes: 0, cause: 'Overridden by Host YAML' },
      fetchBilling: { value: 'account', writable: true, exactField: 'fetchBilling' },
      bothClientsReadOverride: true,
    })

    // ── 5b. HOST_GATEWAY_CAS: the REAL official Settings CAS rejects a stale
    // revision. The script previously proved the same at the same Gateway RPC
    // face; keep it on the rc.2 section.
    const probeNonce = `f3-cas-${String(Date.now())}`
    writeFileSync(requestPath, JSON.stringify({ nonce: probeNonce, op: 'settings-stale-cas', namespace: WEB_API_NS }), { mode: 0o600 })
    clientA.signalBusiness('SIGUSR2')
    const casRecord = await clientA.waitFor(record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === probeNonce
      && record.phase === 'settings-stale-cas',
    'HOST_GATEWAY_CAS official settings stale-CAS probe', 120_000)
    assert(casRecord.firstOk === true,
      `HOST_GATEWAY_CAS: the first official CAS at revision ${String(casRecord.expectedRevision)} must succeed: ${JSON.stringify(casRecord)}`)
    assert(casRecord.secondOk === false,
      `HOST_GATEWAY_CAS: a second CAS at the SAME stale revision must be rejected: ${JSON.stringify(casRecord)}`)
    assert(String(casRecord.secondMessage).includes('changed since it was read'),
      `HOST_GATEWAY_CAS: the rejection must use the official revision-conflict vocabulary: ${JSON.stringify(casRecord)}`)
    const casDurableValue = namespaceConfig(documentPath, WEB_API_NS)?.count
    assert(casDurableValue === 11,
      `HOST_GATEWAY_CAS: the Host must hold exactly the ACCEPTED value (11), never the rejected 12: durable=${String(casDurableValue)}`)
    await reopenWebPage(clientA, 'HOST_GATEWAY_CAS A re-read')
    await openWebRow(clientA, ROW.count, 'HOST_GATEWAY_CAS A re-read')
    await waitForCurrentValue(clientA, String(casDurableValue), 'HOST_GATEWAY_CAS A authoritative count')
    await returnToWebList(clientA, 'HOST_GATEWAY_CAS A list')
    await reopenWebPage(clientB, 'HOST_GATEWAY_CAS B re-read')
    await openWebRow(clientB, ROW.count, 'HOST_GATEWAY_CAS B re-read')
    await waitForCurrentValue(clientB, String(casDurableValue), 'HOST_GATEWAY_CAS B authoritative count')
    await returnToWebList(clientB, 'HOST_GATEWAY_CAS B list')
    trace('f3.host-gateway-cas', {
      verdict: 'HOST_GATEWAY_CAS_PASS',
      phase: 'stale-revision-refused',
      namespace: WEB_API_NS,
      path: 'count',
      expectedRevision: casRecord.expectedRevision,
      rejectedMessage: casRecord.secondMessage,
      durableValue: casDurableValue,
      silentOverwrite: false,
      bothClientsReread: true,
    })

    // ── 5c. L5 REAL-PATH negative controls (unchanged contract: invalid
    // provider/count writes are refused BEFORE any Host dispatch; a custom
    // route is never silently replaced).
    const beforeNegativeApi = snapshot(namespaceConfig(documentPath, WEB_API_NS))
    const beforeNegativeWeb = snapshot(namespaceConfig(documentPath, WEB_NS))
    const negativeNonce = `f3-neg-${String(Date.now())}`
    writeFileSync(requestPath, JSON.stringify({ nonce: negativeNonce, op: 'settings-negative-writes' }), { mode: 0o600 })
    clientA.signalBusiness('SIGUSR2')
    const negative = await clientA.waitFor(record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === negativeNonce
      && record.phase === 'settings-negative-writes',
    'UI_L6 real-path settings negative controls', 120_000)
    const attemptOf = label => (negative.attempts ?? []).find(entry => entry.attempt === label)
    const expectRejected = (label, pattern) => {
      const attempt = attemptOf(label)
      assert(attempt?.rejected === true,
        `UI_L6 negative: ${label} was NOT rejected by the mounted Remote ConfigPort: ${JSON.stringify(negative.attempts)}`)
      assert(pattern.test(attempt?.message ?? ''),
        `UI_L6 negative: ${label} rejection does not carry the official reason: ${JSON.stringify(attempt)}`)
    }
    expectRejected('invalid-search-provider', /unsupported web search provider id/u)
    expectRejected('invalid-fetch-provider', /unsupported web fetch provider id/u)
    expectRejected('count-zero', /must be an integer from 1 through 50/u)
    expectRejected('count-51', /must be an integer from 1 through 50/u)
    assert(snapshot(namespaceConfig(documentPath, WEB_API_NS)) === beforeNegativeApi,
      'UI_L6 negative: an invalid provider/count write reached the official API section')
    const webAfterNegative = namespaceConfig(documentPath, WEB_NS) ?? {}
    const webBeforeNegative = JSON.parse(beforeNegativeWeb === 'undefined' ? '{}' : beforeNegativeWeb)
    assert((webAfterNegative.searchProvider ?? 'deepseek-search-api') === (webBeforeNegative.searchProvider ?? 'deepseek-search-api'),
      `UI_L6 negative: the web section's search provider changed during the negative probe: before=${beforeNegativeWeb} after=${JSON.stringify(webAfterNegative)}`)
    const customRouteSeeded = negative.customRouteSeeded === true
    if (customRouteSeeded) {
      assert((webAfterNegative.fetchProvider ?? 'http') === 'http',
        `UI_L6 negative: the custom-route restore did not return the official fetch provider: ${JSON.stringify(webAfterNegative)}`)
      assert(negative.customRouteRefusal?.rejected === true,
        `UI_L6 negative: the port accepted replacing a CUSTOM provider route: ${JSON.stringify(negative.customRouteRefusal)}`)
      assert(/custom route/u.test(negative.customRouteRefusal?.message ?? ''),
        `UI_L6 negative: the custom-route refusal lacks the official reason: ${JSON.stringify(negative.customRouteRefusal)}`)
    } else {
      assert((webAfterNegative.fetchProvider ?? 'deepseek-fetch-api') === 'deepseek-fetch-api',
        `UI_L6 negative: the refused custom-route seed still changed the fetch provider: before=${beforeNegativeWeb} after=${JSON.stringify(webAfterNegative)}`)
      trace('f3.ui-l6', {
        verdict: 'UI_L6_PASS',
        phase: 'custom-route-protection',
        status: 'NOT_VERIFIED',
        reason: `the official Host refused the custom-route seed: ${String(negative.customRouteSeedMessage)}`,
      })
    }
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'negative-controls',
      refused: ['invalid-search-provider', 'invalid-fetch-provider', 'count-zero', 'count-51'],
      illegalHostWrites: 0,
      customRouteSeeded,
      customRouteReplaceRefused: negative.customRouteRefusal?.rejected === true,
    })

    // ── 6. Both Clients drop and re-establish their Gateway carrier. ────────
    const documentBeforeReconnect = readFileSync(documentPath, 'utf8')
    const apiBeforeReconnect = snapshot(namespaceConfig(documentPath, WEB_API_NS))
    const generationB = await reconnectClient(clientB, 'UI_L6 Client B')
    const generationA = await reconnectClient(clientA, 'UI_L6 Client A')
    assert((await hostStatus(host)).pid === hostPid, 'UI_L6 reconnect: the Host process must not change')
    assert(readFileSync(documentPath, 'utf8') === documentBeforeReconnect,
      'UI_L6 reconnect: a stale generation must never rewrite the official settings document')
    assert(snapshot(namespaceConfig(documentPath, WEB_API_NS)) === apiBeforeReconnect,
      'UI_L6 reconnect: the official values must not roll back after the carrier drop')
    await restoreWebPageAfterReconnect(clientA, 'UI_L6 reconnect A')
    await openWebRow(clientA, ROW.count, 'UI_L6 reconnect A count')
    await waitForCurrentValue(clientA, String(casDurableValue), 'UI_L6 reconnect A count value')
    await returnToWebList(clientA, 'UI_L6 reconnect A list')
    await restoreWebPageAfterReconnect(clientB, 'UI_L6 reconnect B')
    await openWebRow(clientB, ROW.count, 'UI_L6 reconnect B count')
    await waitForCurrentValue(clientB, String(casDurableValue), 'UI_L6 reconnect B count value')
    await returnToWebList(clientB, 'UI_L6 reconnect B list')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'reconnect',
      generationA,
      generationB,
      sameHostProcess: true,
      documentRewritten: false,
      rolledBack: false,
    })

    // ── 7. Clear the Host YAML override through the official write, then
    // restore the shared profile through the SAME page.
    const cleared = await requestSearchOverride(root, 'clear', 'UI_L6 clear Host YAML search override')
    assert(cleared.api?.searchBaseURL === undefined,
      `UI_L6 clear override: the official Host still carries searchBaseURL: ${JSON.stringify(cleared.api)}`)
    await reopenWebPage(clientA, 'UI_L6 clear override A re-read')
    const clearedExpected = {
      ...crossExpected,
      count: casDurableValue,
      searchBilling: BILLING_LABELS.account,
      // The negative-probe custom-route seed may have restored the Fetch
      // provider to the shipped HTTP default; when the schema refused that
      // seed the Fetch API remains selected. The page must show the truth.
      fetchProviderLabel: customRouteSeeded ? HTTP_PROVIDER_LABEL : FETCH_API_PROVIDER_LABEL,
      fetchBilling: customRouteSeeded ? 'Not selected' : BILLING_LABELS.account,
      searchAdvanced: OVERRIDE_UNSET_FACT,
      fetchAdvanced: OVERRIDE_UNSET_FACT,
    }
    await assertPageFacts(clientA, clearedExpected, 'UI_L6 cleared override')
    // Restore the Fetch API provider first when the negative probe left HTTP,
    // then both Billing rows are writable again.
    if (customRouteSeeded) {
      await openWebRow(clientA, ROW.fetchProvider, 'UI_L6 restore fetch provider after negative')
      await selectCandidate(clientA, 1, 'UI_L6 restore fetch provider after negative', FETCH_API_PROVIDER_LABEL)
      await confirmCandidate(clientA, FETCH_API_PROVIDER_LABEL, 'UI_L6 restore fetch provider after negative write')
    }
    // Billing is writable again: restore both modes to Automatic through the page.
    await openWebRow(clientA, ROW.searchBilling, 'UI_L6 restore search billing')
    await selectCandidate(clientA, 0, 'UI_L6 restore search billing', BILLING_LABELS.auto)
    await confirmCandidate(clientA, BILLING_LABELS.auto, 'UI_L6 restore search billing write')
    await openWebRow(clientA, ROW.fetchBilling, 'UI_L6 restore fetch billing')
    await selectCandidate(clientA, 0, 'UI_L6 restore fetch billing', BILLING_LABELS.auto)
    await confirmCandidate(clientA, BILLING_LABELS.auto, 'UI_L6 restore fetch billing write')
    // Count / Question back to the seeded values.
    await openWebRow(clientA, ROW.count, 'UI_L6 restore result count')
    await selectCandidate(clientA, COUNT_CANDIDATES.indexOf(String(SEED_COUNT)), 'UI_L6 restore result count', String(SEED_COUNT))
    await confirmCandidate(clientA, String(SEED_COUNT), 'UI_L6 restore result count write')
    await openWebRow(clientA, ROW.sendOriginalQuestion, 'UI_L6 restore original question')
    await selectCandidate(clientA, QUESTION_OFF, 'UI_L6 restore original question', 'off')
    await confirmCandidate(clientA, 'off', 'UI_L6 restore original question write')
    // Providers back to the shipped stored defaults (Messages / HTTP).
    await openWebRow(clientA, ROW.searchProvider, 'UI_L6 restore search provider')
    await selectCandidate(clientA, 0, 'UI_L6 restore search provider', MESSAGES_PROVIDER_LABEL)
    await confirmCandidate(clientA, MESSAGES_PROVIDER_LABEL, 'UI_L6 restore search provider write')
    await openWebRow(clientA, ROW.fetchProvider, 'UI_L6 restore fetch provider')
    await selectCandidate(clientA, 0, 'UI_L6 restore fetch provider', HTTP_PROVIDER_LABEL)
    await confirmCandidate(clientA, HTTP_PROVIDER_LABEL, 'UI_L6 restore fetch provider write')
    const restored = {
      searchProviderLabel: MESSAGES_PROVIDER_LABEL,
      fetchProviderLabel: HTTP_PROVIDER_LABEL,
      count: SEED_COUNT,
      sendOriginalQuestion: false,
      // Messages/HTTP are not the billed API providers: both Billing rows are
      // correctly inert on the restored route. The stored values are `auto`.
      searchBilling: 'Not selected',
      fetchBilling: 'Not selected',
      searchAdvanced: OVERRIDE_UNSET_FACT,
      fetchAdvanced: OVERRIDE_UNSET_FACT,
      credentialState: 'Configured',
    }
    const restoredWeb = namespaceConfig(documentPath, WEB_NS) ?? {}
    const restoredApi = namespaceConfig(documentPath, WEB_API_NS) ?? {}
    assert((restoredWeb.searchProvider ?? 'deepseek-official') === 'deepseek-official'
      && (restoredWeb.fetchProvider ?? 'http') === 'http',
    `UI_L6 restore: the "web" section still holds a non-default value: ${JSON.stringify(restoredWeb)}`)
    assert((restoredApi.count ?? SEED_COUNT) === SEED_COUNT
      && (restoredApi.sendOriginalQuestion ?? false) === false
      && (restoredApi.searchBilling ?? 'auto') === 'auto'
      && (restoredApi.fetchBilling ?? 'auto') === 'auto'
      && (restoredApi.searchBaseURL ?? undefined) === undefined,
    `UI_L6 restore: the "web-deepseek-api" section still holds a non-default value: ${JSON.stringify(restoredApi)}`)
    await assertPageFacts(clientA, restored, 'UI_L6 restored effective')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'restored',
      searchProvider: 'deepseek-official',
      fetchProvider: 'http',
      count: SEED_COUNT,
      sendOriginalQuestion: false,
      searchBilling: 'auto',
      fetchBilling: 'auto',
      advancedOverrides: 'unset',
    })

    // ── 8. The credential reference stays metadata-only. ────────────────────
    await openWebRow(clientA, ROW.credential, 'UI_L6 credential reference', 'Reference: ')
    await waitForScreenText(clientA, `Reference: ${CREDENTIAL_REF}`, 'UI_L6 credential reference name')
    await waitForScreenText(clientA, 'State: Configured', 'UI_L6 credential configured state')
    assert(!(await frameOf(clientA)).includes(sentinel),
      'UI_L6 credential: the stored secret value reached the Settings pane')
    assert(!/^\s*apiKey:/mu.test(readFileSync(documentPath, 'utf8')),
      'UI_L6 credential: a secret value must never be persisted into the settings document')
    const proofPath = join(root, 'events.jsonl')
    const corpusFiles = [
      proofPath,
      ...readdirSync(context.workDir).filter(name => name.startsWith('surface-client-')).map(name => join(context.workDir, name)),
    ]
    const corpus = [
      await frameOf(clientA),
      await frameOf(clientB),
      typeof host.raw === 'string' ? host.raw : '',
      typeof host.stderr === 'string' ? host.stderr : '',
      readFileSync(documentPath, 'utf8'),
      ...corpusFiles.filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8')),
    ].join('\n')
    assert(!corpus.includes(sentinel),
      'UI_L6 credential: the stored secret value leaked into a pane, the document or a diagnostics record')
    assert(!/\bsk-[A-Za-z0-9]{8,}/u.test(corpus), 'UI_L6 credential: a secret-shaped token must never appear in a pane or diagnostic record')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'credential-reference',
      reference: CREDENTIAL_REF,
      configuredState: true,
      sentinelStored: true,
      secretPainted: false,
      secretPersisted: false,
    })
    await scene.dispose()
    disposed = true
    const restoredCredential = await waitForC1WorkEvent(root, event => event.kind === 'f3-credential-restored', 'F3 credential restore')
    assert(!readFileSync(join(context.dshHome, '.credentials.yaml'), 'utf8').includes(sentinel),
      'F3: the fixture sentinel reference survived teardown')
    trace('f3.credential-restored', { hadPrevious: restoredCredential.hadPrevious === true })
    return { status: 'PASS' }

  } finally {
    if (!disposed) await scene.dispose()
  }
}
