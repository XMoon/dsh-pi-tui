/**
 * S5-PR6 real TUI lifecycle of the release-added Optional Experimental bundles:
 * one table-driven case per bundle (personalized recommendations, LiveShare,
 * Forge). The user path is the production `/plugins` workspace on the mounted
 * TUI: exact-name search → Detail → the painted Enable/Disable action →
 * the official Host `pluginManager` write → the profile's persisted
 * `dsh.profile.bundles` → a fresh boot of the SAME profile → TUI reread.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the published `@deepseek-ai/dsh-base`
 * family and the exact Optional bundle release packages, their real
 * `cordis.patch.yml`, the official `loadProfileDirectory`/`boot` Cordis Loader,
 * the real Agent/Session/ToolRuntime services, the official Host plugin
 * manager, the production TUI runner (`src/index.ts::apply`) and the shared
 * Direct port/reader.
 * `TEST STAND-INS`: the disposable profile/installation/HOME roots, the
 * `VirtualTerminal` and no other agent transport (this suite starts no turn).
 * `DELIBERATELY ABSENT`: the user's real DSH_HOME/credentials, a LiveShare
 * Relay/Owner identity, a GitHub login, a macOS Host and a real browser. Each
 * case proves the Host/profile/TUI path only; the Web/Relay/GitHub features
 * stay EXTERNAL_NOT_QUALIFIED.
 *
 * The bundle packages are never substituted: without the provisioned official
 * artifacts every case reports the fixture's explicit BLOCKED reason.
 * @module @xmoon76/dsh-pi-tui/experimental-bundle-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import {
  S5_OPTIONAL_BUNDLE_IDS,
  profileSelectsBundle,
  skippedInstallationReason,
  type S5OptionalBundleId,
} from '../support/optional-bundle-fixture.ts'
import { startS4D3Application, type S4D3Application } from '../support/application-fixture.ts'

const TARGET_VERSION = getDshRuntimeVersion()

/** The ONE official Loader row that identifies each bundle's purpose after the
 *  restart. A release that renames it must fail this case loudly. */
const CORE_ROW: Readonly<Record<S5OptionalBundleId, string>> = {
  '@deepseek-ai/dsh-personalized-recommendations': 'action-cards',
  '@deepseek-ai/dsh-experimental-liveshare': 'liveshare-share-host',
  '@deepseek-ai/dsh-experimental-forge-bundle': 'forge',
}

const CASE_TITLE: Readonly<Record<S5OptionalBundleId, string>> = {
  '@deepseek-ai/dsh-personalized-recommendations': 'the personalized recommendations bundle round-trips through the mounted TUI and the official Host profile',
  '@deepseek-ai/dsh-experimental-liveshare': 'the experimental LiveShare bundle round-trips through the mounted TUI without a Relay',
  '@deepseek-ai/dsh-experimental-forge-bundle': 'the experimental Forge bundle round-trips through the mounted TUI without a GitHub login',
}

interface BundleRow {
  readonly name: string
  readonly official: boolean
  readonly availability: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly version?: string
}

async function bundleRow(app: S4D3Application, name: string): Promise<BundleRow | undefined> {
  const rows = await app.host.pluginManager.listBundles() as readonly BundleRow[]
  return rows.find(row => row.name === name)
}

/** The painted Detail column of the embedded dual frame, whitespace-normalized. */
function detailView(app: S4D3Application): string {
  const lines = app.view().split('\n')
  const header = lines.find(line => line.includes('Plugins') && line.includes('Details'))
  if (header === undefined) throw new Error(`the dual Plugin Manager frame was not painted:\n${app.view()}`)
  // The pane title is `Details` while the List owns focus and `[Details]` after
  // the Detail is focused; both pin the same column.
  const bracket = header.lastIndexOf('[Details]')
  const start = bracket >= 0 ? bracket + 1 : header.indexOf('Details')
  return lines.map(line => line.slice(start)).join('\n').replace(/\s+/gu, ' ')
}

/** Enter the production `/plugins` workspace through the real slash command. */
async function openPluginWorkspace(app: S4D3Application): Promise<void> {
  for (const character of '/plugins') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.settle()
  if (app.view().includes('❯ /plugins')) {
    app.vt.sendInput('\r')
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Settings · Plugins'), 'the Settings plugin workspace')
}

/**
 * Exact-name search → the one host-truth row → its Detail. The search seat is
 * the page's own `/` key, never a controller call.
 */
async function openSearchedDetail(app: S4D3Application, name: string): Promise<void> {
  app.vt.sendInput('/')
  await app.settle()
  for (const character of name) app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.settle()
  app.vt.sendInput('\r') // the selected exact row → Details
  await app.waitFor(() => app.view().includes('Official DSH catalog entry'), `the ${name} Detail`)
  // The DETAIL column (never the search box text) must carry the exact
  // identity: a failed search cannot pass by echoing its own query.
  await app.waitFor(() => detailView(app).includes(name), `the exact ${name} identity in the Detail`)
}

/** Page the Detail until the frame really paints the wanted primary action. */
async function revealPrimaryAction(app: S4D3Application, label: 'Enable…' | 'Disable…'): Promise<void> {
  for (let page = 0; page < 40; page += 1) {
    if (app.view().includes(label)) return
    app.vt.sendInput('\x1b[6~')
    await app.settle()
  }
  throw new Error(`the ${label} action was never painted:\n${app.view()}`)
}

const CASES = S5_OPTIONAL_BUNDLE_IDS.map(name => ({
  name,
  skip: skippedInstallationReason([name]),
  title: CASE_TITLE[name],
  coreRow: CORE_ROW[name],
}))

for (const { name, skip, title, coreRow } of CASES) {
  test(title, { skip }, async t => {
    let app = await startS4D3Application(t, { bundles: [], presets: true, installationBoot: true })

    // ── OFF: the authoritative Host row and the untouched profile ───────────
    const profileDir = app.host.profileDir
    const off = await bundleRow(app, name)
    assert.ok(off !== undefined, `the real Host catalog lists ${name}`)
    assert.equal(off.official, true)
    assert.equal(off.availability, 'installation', 'the official package ships with this installation')
    assert.equal(off.enabled, false, 'the profile does not select the bundle yet')
    assert.equal(off.version, TARGET_VERSION, 'the offered version is the running target')
    assert.equal(profileSelectsBundle(app.host.profileDir, name), false, 'the Profile layer is not selected')

    // ── The TUI user action: /plugins → exact search → Detail → Enable ──────
    await openPluginWorkspace(app)
    await openSearchedDetail(app, name)
    const offDetail = detailView(app)
    assert.match(offDetail, /\[experimental\]/u, 'the searched row is painted as Experimental')
    assert.match(offDetail, /Availability Installation/u, 'the Detail paints the Host installation availability')
    assert.doesNotMatch(offDetail, /Remove…/u, 'a shipped Optional bundle offers no Remove action')
    await revealPrimaryAction(app, 'Enable…')
    app.vt.sendInput('\r')
    // The official Host write completes and its restart-required outcome is
    // painted; the test never calls the plugin manager itself.
    await app.waitFor(() => /restart required/iu.test(app.view()), 'the painted restart-required outcome')

    assert.equal(profileSelectsBundle(app.host.profileDir, name), true,
      'the Host wrote the exact bundle into the persisted profile selection')
    const selected = await bundleRow(app, name)
    assert.equal(selected?.enabled, true, 'the authoritative Host reread reports the selection')

    // ── Restart: the SAME profile root composes the published patch ────────
    const previousContext = app.host.ctx
    app = await app.restart()
    assert.notEqual(app.host.ctx, previousContext, 'the restart boots a FRESH Host Context')
    assert.equal(app.host.profileDir, profileDir, 'the restart reuses the SAME profile root')
    assert.ok(app.host.activeBundles.includes(name), `the restarted Host selected ${name}`)
    const entry = app.host.loaderEntries().find(candidate => candidate.id === coreRow)
    assert.ok(entry !== undefined, `the restarted Loader carries the ${coreRow} row from the published patch`)
    assert.equal(entry.error, undefined, `${coreRow} carries no failure: ${String(entry.error)}`)
    if (name === '@deepseek-ai/dsh-experimental-liveshare') {
      // Without a Relay the share host row waits as a real PENDING entry (not
      // an error and not a claimed share); no share service exists.
      assert.equal((app.host.ctx as unknown as { get(service: string): unknown }).get('liveshare'), undefined,
        'no LiveShare service is created without a Relay connection')
      assert.equal(process.env.LIVESHARE_OWNER_CREDENTIAL_FILE, undefined, 'no Relay/Owner credential was created')
    }
    if (name === '@deepseek-ai/dsh-experimental-forge-bundle') {
      // The local Forge rows compose without any GitHub authorization; the
      // GitHub-backed row is a real Loader entry, not a TUI action.
      const github = app.host.loaderEntries().find(candidate => candidate.id === 'forge-github')
      assert.ok(github !== undefined, 'the official Forge bundle composes its forge-github row')
      assert.equal(github.error, undefined, 'the GitHub row is composed; no gh login is required to load it')
    }

    // ── The restarted TUI rereads the selected bundle and can disable it ───
    await openPluginWorkspace(app)
    await openSearchedDetail(app, name)
    assert.match(detailView(app), /Selected in profile Yes/u, 'the Detail paints the authoritative selected state')
    await revealPrimaryAction(app, 'Disable…')
    app.vt.sendInput('\r')
    await app.waitFor(() => /restart required/iu.test(app.view()), 'the painted disable outcome')
    assert.equal(profileSelectsBundle(app.host.profileDir, name), false,
      'the Host removed the exact bundle from the persisted profile selection')
    assert.equal((await bundleRow(app, name))?.enabled, false, 'the Host reread reports the removal')

    // ── Restart again: the layer is gone and the member stays manageable ──
    app = await app.restart()
    assert.equal(app.host.profileDir, profileDir, 'the disable restart keeps the SAME profile root')
    assert.equal(app.host.activeBundles.includes(name), false, `the restarted Host no longer loads ${name}`)
    assert.equal(app.host.loaderEntries().some(candidate => candidate.id === coreRow), false,
      `the ${coreRow} row is not composed by the disabled bundle`)
    const afterDisable = await bundleRow(app, name)
    assert.ok(afterDisable !== undefined, 'the official Host catalog still lists the member')
    assert.equal(afterDisable.enabled, false)
    assert.equal(afterDisable.availability, 'installation')
    await openPluginWorkspace(app)
    await openSearchedDetail(app, name)
    await revealPrimaryAction(app, 'Enable…')

    // ── The honest boundary: no phantom action, credential or public URI ──
    const detail = detailView(app)
    assert.doesNotMatch(detail, /Create…|Not now|Share…|Open PR/u,
      'the TUI paints no Action Card / share / GitHub write action')
    assert.doesNotMatch(detail, /https?:\/\//u, 'no external share/Forge URL was created or painted')
    assert.equal(process.env.LIVESHARE_OWNER_CREDENTIAL_FILE, undefined, 'no Relay/Owner credential was created')
  })
}
