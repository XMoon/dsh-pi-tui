/**
 * M6-1 F3: the official Web Search / Fetch Settings across real Split clients.
 *
 * ONE real Host (the installed candidate package plus the inert qualification
 * fixture row) and TWO real authenticated TUI Clients prove, WITHOUT an open
 * Session (the Settings surface is sessionless):
 *
 *   1. the Host's OFFICIAL Settings service serves the isolated `web` /
 *      `web-deepseek-api` sections; Client A reads the shipped baseline back
 *      from the real page (`Messages`, `HTTP`, the official API base, `10`,
 *      Share Original Question `on`), and Client B reads the same Host facts —
 *      neither Client paints a locally guessed value (the page stays
 *      `Loading…` until the Host read answers, and `Unavailable` when it does
 *      not);
 *   2. every minimal edit through `/settings → Tools → Web Search / Fetch`
 *      (search provider, fetch provider, result count, Share Original
 *      Question, API base) is ONE verified official Settings CAS mutation that
 *      persists into the profile document for ITS OWN namespace only, while
 *      the other section's user layer is byte-identical;
 *   3. Client B keeps painting its already-read count after A's write (no
 *      optimistic push) and only a real `r` re-read shows the Host truth;
 *   4. a non-HTTPS API base is refused by the Remote adapter BEFORE any Host
 *      write, the durable section keeps its previous base, and the base never
 *      lands in the legacy `web` section as a synonym slot;
 *   5. the OFFICIAL Settings CAS rejects a stale revision at the REAL Gateway
 *      RPC seam: through the same official generated `settings` namespace the
 *      ConfigPort mirror uses, the Client reads revision R, commits once at R
 *      (R→R+1), then re-submits the OLD R — the Host accepts the first and
 *      rejects the second with the official revision-conflict vocabulary
 *      (`expected revision N, now N+1`), leaving exactly the accepted value;
 *   6. both Clients drop and re-establish their physical Gateway carrier; the
 *      official values do not roll back and the durable document does not
 *      change (no in-flight read is held across the generation here — the
 *      stale-generation settlement contract is proven by the ConfigPort unit
 *      and wire generation tests);
 *   7. the credential row stays a metadata-only reference witness: the official
 *      reference name plus presence/source, never a value.
 *
 * The trace and every failure label separate the two verdicts this case owns:
 *   - `UI_L6`              → the real TUI edits, cross-client read-back and the
 *     non-HTTPS refusal;
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
 * candidates and the four count presets, so an invalid provider id / an
 * out-of-range count cannot reach the Host through this surface (they are
 * Client-side refusals). A CUSTOM provider route or a pre-seeded non-preset
 * count needs a Host-side fixture write; no C1 scenario writes the `web`
 * sections and this case never edits the profile document itself. The
 * `HOST_GATEWAY_CAS` witness is the deterministic sequential official-CAS
 * probe described above.
 *
 * @module split-process/web-provider-settings-f3
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { parse as parseYaml } from 'yaml'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

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

/** The six rows in the page's FROZEN order. */
const WEB_ROW_LABELS = [
  'Web Search Provider',
  'Web Fetch Provider',
  'Search API Result Count',
  'Share Original Question',
  'Search / Fetch API Endpoint',
  'DeepSeek API Key',
]
const ROW = Object.freeze({
  searchProvider: 0,
  fetchProvider: 1,
  count: 2,
  sendOriginalQuestion: 3,
  endpoint: 4,
  credential: 5,
})

/** The official shipped baseline the isolated profile serves. */
const OFFICIAL = Object.freeze({
  searchProvider: 'deepseek-official',
  searchProviderLabel: 'Messages',
  fetchProvider: 'http',
  fetchProviderLabel: 'HTTP',
  baseURL: 'https://api.deepseek.com/v1/tools',
  count: 10,
  sendOriginalQuestion: true,
})
const SEARCH_API_PROVIDER_LABEL = 'DeepSeek Search API'
const FETCH_API_PROVIDER_LABEL = 'DeepSeek Fetch API'
const COUNT_CANDIDATES = ['5', '10', '20', '50']
const QUESTION_ON = 0
const QUESTION_OFF = 1
/** A short, obviously non-production base: it fits one Detail line WHOLE. */
const CONSUMER_ENDPOINT = 'https://gateway.example.test/f3/v1/tools'
const INSECURE_ENDPOINT = 'http://insecure.example.test/f3/v1/tools'
/** The official settings sections the page owns. */
const WEB_NS = 'web'
const WEB_API_NS = 'web-deepseek-api'
/** The ONE official credential reference the Web providers resolve. */
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

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

function isWebPage(frame) {
  return frame.includes(WEB_PAGE_BREADCRUMB) && frame.includes(WEB_ROW_LABELS[0])
}

function isWebList(frame) {
  return isWebPage(frame) && frame.split('\n').some(line => WEB_LIST_BARS.includes(line.trim()))
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

async function waitForScreenText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => (await frameOf(client)).includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /Web|Search|Fetch|Provider|Current|State|Saved|Verified|Endpoint|Question|Settings/u.test(line))
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

/** Wait until the Detail pane shows one of the frozen write verdicts. */
async function waitForWriteVerdict(client, label, timeoutMs = 60_000) {
  let detail
  try {
    await waitForCondition(async () => {
      detail = pageDetailText(await frameOf(client))
      return detail.includes('Verified') || detail.includes('Not saved') || detail.includes('Outcome unknown')
    }, label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the page painted no write verdict: ${JSON.stringify(detail ?? '')}`, { cause: error })
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
  // The page must paint BOTH regions for the navigation below: the pane header
  // names both columns only while the row grant keeps the Detail visible (a
  // narrow single-region layout could not reach the endpoint row's fact).
  assert((await frameOf(client)).includes('Current / Detail'),
    `${label}: the Web page did not paint the two-region layout (the PTY grant must keep the Detail pane visible)`)
}

/** The page's Action Bar is its LAST non-empty body line; its wording is the
 *  authoritative region oracle (list vs read-only Detail vs a Detail whose
 *  candidate is cropped, vs the endpoint editor). */
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
  if (bar.includes('Enter open in Models') || bar.includes('Enter edit endpoint') || bar.includes('Enter confirm')) return 'detail'
  if (bar.includes('Esc cancel')) return 'editor'
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
 *  region). The endpoint row opens its editor instead and is driven by
 *  writeEndpoint; every read row here enters the Detail region. */
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

/** Open the endpoint editor, replace the draft WHOLE and confirm it. */
async function writeEndpoint(client, url, expectedCurrent, label) {
  await selectListRow(client, ROW.endpoint, label)
  client.send('\r')
  await waitForScreenText(client, 'Enter confirm · Esc cancel', `${label} endpoint editor`)
  client.send('\x15')
  client.send(url)
  await waitForScreenText(client, url, `${label} endpoint draft`)
  client.send('\r')
  await waitForCurrentValue(client, expectedCurrent, `${label} authoritative endpoint read-back`)
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
  // The endpoint row's Enter opens its editor, so its read-only Detail is
  // reached through the region toggle (Tab) instead.
  await selectListRow(client, ROW.endpoint, `${label} endpoint`)
  client.send('\t')
  await waitForScreenText(client, 'Enter edit endpoint', `${label} endpoint detail region`, 20_000)
  await waitForCurrentValue(client, expected.baseURL, `${label} endpoint value`)
  await returnToWebList(client, `${label} endpoint list`)
  await openWebRow(client, ROW.credential, `${label} credential`, 'Reference: ')
  await waitForScreenText(client, `Reference: ${CREDENTIAL_REF}`, `${label} official credential reference`)
  await waitForScreenText(client, 'State: ', `${label} credential presence`)
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

/**
 * One case: `web-settings.official-provider-f3`.
 */
export async function runWebProviderSettingsF3(context) {
  const { trace, installation } = context
  const scene = createC1Scene(context)
  const root = scene.c1WorkRoot('f3-web-provider-settings')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const requestPath = join(context.workDir, 'f3-settings-stale-cas-request.json')
  const documentPath = settingsDocumentPath(installation.profileDir)
  let clientA
  let clientB
  let host

  try {
    // The qualification fixture has NO scenario that writes the official Web
    // settings sections, so the baseline is exactly what the real Host's
    // official Settings service serves for this isolated profile: the shipped
    // defaults. Every later value is produced by that SAME service through the
    // real `/settings` page (the case never edits the profile document).
    const started = await scene.startC1Host('skills-standing', 'F3 Web provider settings Host', {}, root)
    host = started.host
    const hostPid = started.ready.pid
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'host',
      hostPid,
      sections: [WEB_NS, WEB_API_NS],
      baseline: OFFICIAL,
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
    await assertPageFacts(clientA, OFFICIAL, 'UI_L6 A baseline')
    await returnToWebList(clientA, 'UI_L6 A baseline list')
    await openWebSettingsPage(clientB, 'UI_L6 Client B')
    await assertPageFacts(clientB, OFFICIAL, 'UI_L6 B baseline')
    // Client B stays on the result-count Detail so A's next writes can prove
    // that B never receives an optimistic push.
    await openWebRow(clientB, ROW.count, 'UI_L6 B baseline count')
    await waitForCurrentValue(clientB, String(OFFICIAL.count), 'UI_L6 B baseline count value')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'baseline-read',
      searchProvider: OFFICIAL.searchProviderLabel,
      fetchProvider: OFFICIAL.fetchProviderLabel,
      count: OFFICIAL.count,
      sendOriginalQuestion: OFFICIAL.sendOriginalQuestion,
      baseURL: OFFICIAL.baseURL,
      sessionless: true,
      clients: 2,
    })

    // ── 2. Client A edits each field through the real page. ─────────────────
    const beforeWrites = {
      [WEB_NS]: snapshot(namespaceConfig(documentPath, WEB_NS)),
      [WEB_API_NS]: snapshot(namespaceConfig(documentPath, WEB_API_NS)),
    }
    await openWebRow(clientA, ROW.searchProvider, 'UI_L6 A search provider')
    await selectCandidate(clientA, 1, 'UI_L6 A search provider', SEARCH_API_PROVIDER_LABEL)
    await confirmCandidate(clientA, SEARCH_API_PROVIDER_LABEL, 'UI_L6 A search provider write')
    assertNamespaceWrite(documentPath, WEB_NS, beforeWrites, config => {
      assert(config.searchProvider === 'deepseek-search-api',
        `UI_L6 A search provider: the official "web" user layer must hold the new provider id: ${JSON.stringify(config)}`)
      assert(config.baseURL === undefined,
        `UI_L6 A search provider: the legacy "web" section must not gain the API base: ${JSON.stringify(config)}`)
    }, 'UI_L6 A search provider')

    await openWebRow(clientA, ROW.fetchProvider, 'UI_L6 A fetch provider')
    await selectCandidate(clientA, 1, 'UI_L6 A fetch provider', FETCH_API_PROVIDER_LABEL)
    await confirmCandidate(clientA, FETCH_API_PROVIDER_LABEL, 'UI_L6 A fetch provider write')
    assertNamespaceWrite(documentPath, WEB_NS, beforeWrites, config => {
      assert(config.fetchProvider === 'deepseek-fetch-api',
        `UI_L6 A fetch provider: the official "web" user layer must hold the new fetch id: ${JSON.stringify(config)}`)
    }, 'UI_L6 A fetch provider')

    const beforeCount = {
      [WEB_NS]: snapshot(namespaceConfig(documentPath, WEB_NS)),
      [WEB_API_NS]: snapshot(namespaceConfig(documentPath, WEB_API_NS)),
    }
    await openWebRow(clientA, ROW.count, 'UI_L6 A result count')
    await selectCandidate(clientA, COUNT_CANDIDATES.indexOf('20'), 'UI_L6 A result count', '20')
    await confirmCandidate(clientA, '20', 'UI_L6 A result count write')
    assertNamespaceWrite(documentPath, WEB_API_NS, beforeCount, config => {
      assert(config.count === 20,
        `UI_L6 A result count: the official "web-deepseek-api" user layer must hold count 20: ${JSON.stringify(config)}`)
    }, 'UI_L6 A result count')

    const beforeQuestion = {
      [WEB_NS]: snapshot(namespaceConfig(documentPath, WEB_NS)),
      [WEB_API_NS]: snapshot(namespaceConfig(documentPath, WEB_API_NS)),
    }
    await openWebRow(clientA, ROW.sendOriginalQuestion, 'UI_L6 A original question')
    await selectCandidate(clientA, QUESTION_OFF, 'UI_L6 A original question', 'off')
    await confirmCandidate(clientA, 'off', 'UI_L6 A original question write')
    assertNamespaceWrite(documentPath, WEB_API_NS, beforeQuestion, config => {
      assert(config.sendOriginalQuestion === false,
        `UI_L6 A original question: the official user layer must hold off: ${JSON.stringify(config)}`)
    }, 'UI_L6 A original question')

    await writeEndpoint(clientA, CONSUMER_ENDPOINT, CONSUMER_ENDPOINT, 'UI_L6 A endpoint write')
    await waitForScreenText(clientA, 'Verified', 'UI_L6 A endpoint verified verdict', 20_000)
    const endpointConfig = namespaceConfig(documentPath, WEB_API_NS)
    assert(endpointConfig?.baseURL === CONSUMER_ENDPOINT,
      `UI_L6 A endpoint: the official "web-deepseek-api" user layer must hold the confirmed base: ${JSON.stringify(endpointConfig)}`)
    assert(namespaceConfig(documentPath, WEB_NS)?.baseURL === undefined,
      `UI_L6 A endpoint: the base must NOT be written to the legacy "web" section as a synonym: ${JSON.stringify(namespaceConfig(documentPath, WEB_NS))}`)
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'edited',
      writes: ['searchProvider', 'fetchProvider', 'count', 'sendOriginalQuestion', 'baseURL'],
      searchProvider: 'deepseek-search-api',
      fetchProvider: 'deepseek-fetch-api',
      count: 20,
      sendOriginalQuestion: false,
      baseURL: CONSUMER_ENDPOINT,
    })

    // ── 3. B never received an optimistic push; its own `r` reads the Host. ─
    const staleB = pageDetailText(await frameOf(clientB))
    assert(staleB.includes(`Current: ${String(OFFICIAL.count)}`),
      `UI_L6 B: another Client's write must not silently repaint B's already-read count: ${JSON.stringify(staleB)}`)
    clientB.send('r')
    await waitForCurrentValue(clientB, '20', 'UI_L6 B refreshed result count')
    await assertPageFacts(clientB, {
      ...OFFICIAL,
      searchProviderLabel: SEARCH_API_PROVIDER_LABEL,
      fetchProviderLabel: FETCH_API_PROVIDER_LABEL,
      count: 20,
      sendOriginalQuestion: false,
      baseURL: CONSUMER_ENDPOINT,
    }, 'UI_L6 B cross-client')
    await returnToWebList(clientB, 'UI_L6 B cross-client list')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'cross-client',
      staleBeforeRefresh: OFFICIAL.count,
      refreshedCount: 20,
      sameHostTruth: true,
    })

    // ── 4. Fail closed over the REAL TUI/Host stack. ────────────────────────
    // The endpoint editor is the ONE field that accepts free text: a non-HTTPS
    // base must be refused by the Remote adapter BEFORE any Host write, and the
    // durable section must keep its previous base.
    const apiBeforeInvalid = snapshot(namespaceConfig(documentPath, WEB_API_NS))
    await selectListRow(clientA, ROW.endpoint, 'UI_L6 A insecure endpoint')
    clientA.send('\r')
    await waitForScreenText(clientA, 'Enter confirm · Esc cancel', 'UI_L6 A insecure endpoint editor')
    clientA.send('\x15')
    clientA.send(INSECURE_ENDPOINT)
    await waitForScreenText(clientA, INSECURE_ENDPOINT, 'UI_L6 A insecure endpoint draft')
    clientA.send('\r')
    await waitForScreenText(clientA, 'the Search/Fetch API endpoint must use https://', 'UI_L6 A insecure endpoint refusal', 30_000)
    await waitForScreenText(clientA, 'Not saved', 'UI_L6 A insecure endpoint not-saved', 15_000)
    assert(snapshot(namespaceConfig(documentPath, WEB_API_NS)) === apiBeforeInvalid,
      'UI_L6 A insecure endpoint: a refused base must never reach the official Host document')
    clientA.send('\x1b')
    await returnToWebList(clientA, 'UI_L6 A insecure endpoint cancel')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'fail-closed',
      refused: 'non-https baseURL',
      hostWrites: 0,
      durableBaseKept: CONSUMER_ENDPOINT,
    })

    // ── 5. HOST_GATEWAY_CAS: the REAL official Settings CAS rejects a stale
    // revision. The TUI/ConfigPort always fresh-reads before dispatch, so ONE
    // Client can NEVER send a stale revision through the UI. The deterministic
    // witness therefore drives the SAME official generated `settings` namespace
    // (the exact face the ConfigPort mirror uses) inside the real Client
    // composition: it reads revision R, commits once at R (R→R+1), then
    // re-submits the OLD R — which the Host must reject with the official
    // revision-conflict, leaving exactly the accepted value.
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
    assert(String(casRecord.secondMessage).includes(`expected revision ${String(casRecord.expectedRevision)}`),
      `HOST_GATEWAY_CAS: the rejection must name the stale expected revision: ${JSON.stringify(casRecord)}`)
    const casDurableValue = namespaceConfig(documentPath, WEB_API_NS)?.count
    assert(casDurableValue === 11,
      `HOST_GATEWAY_CAS: the Host must hold exactly the ACCEPTED value (11), never the rejected 12: durable=${String(casDurableValue)}`)
    // Both Clients recover to the winning Host truth (no silent overwrite). A
    // fresh page open triggers the authoritative read; the raw-namespace probe
    // write does not repaint the already-open page by itself.
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
      mergedDocument: false,
      bothClientsReread: true,
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

    // ── 7. Restore the official defaults through the SAME page. ─────────────
    // The isolated profile is shared by later cases of the lane: putting the
    // effective values back through the official service (never a file edit)
    // leaves the next case the shipped baseline.
    await openWebRow(clientA, ROW.searchProvider, 'UI_L6 restore search provider')
    await selectCandidate(clientA, 0, 'UI_L6 restore search provider', OFFICIAL.searchProviderLabel)
    await confirmCandidate(clientA, OFFICIAL.searchProviderLabel, 'UI_L6 restore search provider write')
    await openWebRow(clientA, ROW.fetchProvider, 'UI_L6 restore fetch provider')
    await selectCandidate(clientA, 0, 'UI_L6 restore fetch provider', OFFICIAL.fetchProviderLabel)
    await confirmCandidate(clientA, OFFICIAL.fetchProviderLabel, 'UI_L6 restore fetch provider write')
    await openWebRow(clientA, ROW.count, 'UI_L6 restore result count')
    await selectCandidate(clientA, COUNT_CANDIDATES.indexOf(String(OFFICIAL.count)), 'UI_L6 restore result count', String(OFFICIAL.count))
    await confirmCandidate(clientA, String(OFFICIAL.count), 'UI_L6 restore result count write')
    await openWebRow(clientA, ROW.sendOriginalQuestion, 'UI_L6 restore original question')
    await selectCandidate(clientA, QUESTION_ON, 'UI_L6 restore original question', 'on')
    await confirmCandidate(clientA, 'on', 'UI_L6 restore original question write')
    await writeEndpoint(clientA, OFFICIAL.baseURL, OFFICIAL.baseURL, 'UI_L6 restore endpoint write')
    // The official Settings service PRUNES a user layer whose values all equal
    // the shipped defaults (the whole section row may disappear). The authority
    // that matters is the EFFECTIVE value: an absent key applies the default, so
    // a missing/empty section is back on the baseline, and a leftover non-default
    // value is a real restore failure.
    const restoredWeb = namespaceConfig(documentPath, WEB_NS) ?? {}
    const restoredApi = namespaceConfig(documentPath, WEB_API_NS) ?? {}
    assert((restoredWeb.searchProvider ?? OFFICIAL.searchProvider) === OFFICIAL.searchProvider
      && (restoredWeb.fetchProvider ?? OFFICIAL.fetchProvider) === OFFICIAL.fetchProvider,
    `UI_L6 restore: the "web" section still holds a non-default value: ${JSON.stringify(restoredWeb)}`)
    assert((restoredApi.baseURL ?? OFFICIAL.baseURL) === OFFICIAL.baseURL
      && (restoredApi.count ?? OFFICIAL.count) === OFFICIAL.count
      && (restoredApi.sendOriginalQuestion ?? OFFICIAL.sendOriginalQuestion) === OFFICIAL.sendOriginalQuestion,
    `UI_L6 restore: the "web-deepseek-api" section still holds a non-default value: ${JSON.stringify(restoredApi)}`)
    // Authoritative effective read-back through the real page proves the baseline.
    await assertPageFacts(clientA, OFFICIAL, 'UI_L6 restored effective')

    // ── 8. The credential reference stays metadata-only. ────────────────────
    await openWebRow(clientA, ROW.credential, 'UI_L6 credential reference', 'Reference: ')
    await waitForScreenText(clientA, `Reference: ${CREDENTIAL_REF}`, 'UI_L6 credential reference name')
    assert(/Reference: DEEPSEEK_API_KEY/u.test(await frameOf(clientA)), 'UI_L6 credential: the official reference is painted by name')
    assert(!/^\s*apiKey:/mu.test(readFileSync(documentPath, 'utf8')),
      'UI_L6 credential: a secret value must never be persisted into the settings document')
    const corpus = [
      await frameOf(clientA),
      await frameOf(clientB),
      typeof host.raw === 'string' ? host.raw : typeof host.stderr === 'string' ? host.stderr : '',
      readFileSync(documentPath, 'utf8'),
    ].join('\n')
    assert(!/\bsk-[A-Za-z0-9]{8,}/u.test(corpus), 'UI_L6 credential: a secret-shaped token must never appear in a pane or diagnostic record')
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'credential-reference',
      reference: CREDENTIAL_REF,
      secretPainted: false,
      secretPersisted: false,
    })
    trace('f3.ui-l6', {
      verdict: 'UI_L6_PASS',
      phase: 'restored',
      searchProvider: OFFICIAL.searchProvider,
      fetchProvider: OFFICIAL.fetchProvider,
      baseURL: OFFICIAL.baseURL,
      count: OFFICIAL.count,
      sendOriginalQuestion: OFFICIAL.sendOriginalQuestion,
    })

    return { status: 'PASS' }
  } finally {
    await scene.dispose()
  }
}
