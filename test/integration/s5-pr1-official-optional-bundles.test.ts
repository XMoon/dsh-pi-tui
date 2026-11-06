/**
 * S5-PR1 official Optional-bundle qualification: the three Optional bundles
 * the current release adds beyond the legacy B01–B14 verified subset, plus the
 * Host's OWN platform refusal for the darwin-only CUA on-demand catalog entry.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the published `@deepseek-ai/dsh-base`
 * family and the three published Optional bundle packages at this checkout's
 * exact target, the official profile manifest/patch reader, the official
 * `loadProfileDirectory`/`boot` Loader composition, the real Host services and
 * the real Host plugin manager catalog.
 * `TEST STAND-INS`: a temporary profile/installation root whose `node_modules`
 * is the provisioned official installation tree, and a temporary LOCAL Git
 * repository for the Forge bundle's prerequisite (never a GitHub repository).
 * `DELIBERATELY ABSENT`: the user's real `DSH_HOME`, network installs inside the
 * tests, Relay/Owner credentials, a GitHub login, a macOS Host and a real
 * browser. Those downstream capabilities stay EXTERNAL_NOT_QUALIFIED: loading a
 * bundle row is a HOST_COMPOSED fact, never a claim that its Web/GUI/native
 * feature is usable from the TUI.
 *
 * The bundle packages are NEVER substituted: without the provisioned official
 * artifacts every case reports the fixture's explicit BLOCKED reason.
 * @module @xmoon76/dsh-pi-tui/s5-pr1-official-optional-bundles.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { getDshRuntimeVersion, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import {
  S5_OPTIONAL_BUNDLE_IDS,
  skippedInstallationReason,
  startOptionalBundleHost,
  type OptionalBundleHost,
} from '../support/optional-bundle-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const TARGET_VERSION = getDshRuntimeVersion()
const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'

/** A real profile row a bundle patch declares (insert rows, possibly nested in
 *  a group). Read from the INSTALLED patch, never from a hardcoded copy. */
interface ProfileRowLike {
  readonly id?: unknown
  readonly group?: unknown
  readonly config?: readonly ProfileRowLike[]
}

interface ProfileLayerLike {
  readonly packageName: string
  readonly patches: readonly { readonly insert?: readonly ProfileRowLike[] }[]
}

function insertedRowIds(layer: ProfileLayerLike): string[] {
  const rows = layer.patches.flatMap(patch => patch.insert ?? [])
  const collect = (list: readonly ProfileRowLike[]): string[] => list.flatMap(row => [
    ...(typeof row.id === 'string' ? [row.id] : []),
    ...(row.group === true ? collect(row.config ?? []) : []),
  ])
  return collect(rows)
}

/** The ONE key row whose real Loader entry identifies each bundle's purpose:
 *  a release that renames it must fail this test loudly, not pass vacuously. */
const CORE_ROW = {
  '@deepseek-ai/dsh-personalized-recommendations': 'action-cards',
  '@deepseek-ai/dsh-experimental-liveshare': 'liveshare-share-host',
  '@deepseek-ai/dsh-experimental-forge-bundle': 'forge',
} as const

function readManifest(host: OptionalBundleHost, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(host.installation.nodeModules, name, 'package.json'), 'utf8')) as Record<string, unknown>
}

/** The resolved official composition of THIS host's profile. */
function profileOf(host: OptionalBundleHost): { layers: readonly ProfileLayerLike[]; skipped: readonly unknown[] } {
  const profile = loadProfileDirectory(
    'dsh',
    host.profileDir,
    join(host.root, 'installation', 'package.json'),
  ) as unknown as { layers: readonly ProfileLayerLike[]; skippedBundles: readonly unknown[] }
  return { layers: profile.layers, skipped: profile.skippedBundles }
}

/** One local Git repository: the Forge bundle's real prerequisite, with NO
 *  external GitHub origin or credential. */
function localGitRepository(t: TestContext): string {
  const life = testLifecycle(t)
  const root = life.tempDir('s5-pr1-forge-git-')
  const run = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  }
  run(['init', '--quiet'])
  run(['-c', 'user.name=S5 PR1', '-c', 'user.email=s5-pr1@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'])
  return root
}

for (const name of S5_OPTIONAL_BUNDLE_IDS) {
  const skip = skippedInstallationReason([name])
  test(`${name}: the real npm manifest/patch composes through the official Host Loader`, { skip }, async t => {
    const sessionCwd = name === '@deepseek-ai/dsh-experimental-forge-bundle' ? localGitRepository(t) : undefined
    const host = await startOptionalBundleHost(t, {
      bundles: [name],
      ...(sessionCwd === undefined ? {} : { sessionCwd }),
    })

    // 1. The REAL published package identity this composition consumed.
    const manifest = readManifest(host, name)
    assert.equal(manifest['name'], name)
    assert.equal(manifest['version'], TARGET_VERSION, 'the provisioned package is the exact release target')
    const repository = manifest['repository'] as { readonly url?: unknown } | string | undefined
    const repositoryUrl = typeof repository === 'string' ? repository : repository?.url
    assert.match(String(repositoryUrl), /deepseek-ai\/deepseek-harness/u,
      'the package is the official published artifact, not a local stand-in')

    // 2. The profile selected ONLY base + this exact bundle, and the official
    //    reader resolved its real patch layer with no skipped bundle.
    assert.deepEqual([...host.activeBundles], ['@deepseek-ai/dsh-base', name])
    const profile = profileOf(host)
    assert.deepEqual(profile.skipped, [])
    const layer = profile.layers.find(candidate => candidate.packageName === name)
    assert.ok(layer !== undefined, `${name} composed a real profile patch layer`)
    const declared = insertedRowIds(layer)
    assert.ok(declared.length > 0, `${name}'s installed patch declares rows`)
    assert.ok(declared.includes(CORE_ROW[name]), `${name} declares its ${CORE_ROW[name]} row`)

    // 3. Every declared row is a REAL Loader entry of this boot, and no row
    //    failed: a row waiting for its environment prerequisite is `0`, never
    //    an error. Loading the bundle row is HOST_COMPOSED only.
    const entries = new Map(host.loaderEntries().map(entry => [entry.id, entry]))
    for (const rowId of declared) {
      const entry = entries.get(rowId)
      assert.ok(entry !== undefined, `${name}: the real Loader carries the ${rowId} entry`)
      assert.equal(entry.error, undefined, `${name}: the ${rowId} row failed: ${String(entry.error)}`)
    }

    // 4. The Host catalog proves the same selection and shipped availability.
    const bundles = await host.pluginManager.listBundles() as readonly {
      readonly name: string
      readonly official: boolean
      readonly availability: string
      readonly enabled: boolean
      readonly installed: boolean
      readonly version?: string
      readonly listedByDefault?: boolean
    }[]
    const fact = bundles.find(candidate => candidate.name === name)
    assert.ok(fact !== undefined, 'the real Host catalog lists the bundle')
    assert.equal(fact.official, true)
    assert.equal(fact.availability, 'installation')
    assert.equal(fact.enabled, true, 'the profile selection is the Host fact')
    assert.equal(fact.version, TARGET_VERSION)

    // 5. The feature itself is NOT qualified by this composition.
    if (name === '@deepseek-ai/dsh-experimental-forge-bundle') {
      // The local Git repository is the whole prerequisite this case proves;
      // GitHub login, remote writes and the Web Forge panel stay NOT_IN_PR1.
      assert.ok(sessionCwd !== undefined)
      assert.ok(entries.get('forge-github') !== undefined,
        'the forge-github row is composed even though no GitHub authorization is exercised')
    }
    if (name === '@deepseek-ai/dsh-experimental-liveshare') {
      // No Relay/Owner identity is configured: the share host row exists as a
      // pending Loader entry, and this case never claims a real share.
      assert.equal(process.env.LIVESHARE_OWNER_CREDENTIAL_FILE, undefined)
      assert.ok(entries.get('liveshare-share-host') !== undefined)
    }
  })
}

test('the darwin-only CUA on-demand entry is a REAL Host catalog negative on this platform', { skip: skippedInstallationReason([]) }, async t => {
  const host = await startOptionalBundleHost(t, { bundles: [] })
  const bundles = await host.pluginManager.listBundles() as readonly {
    readonly name: string
    readonly official: boolean
    readonly availability: string
    readonly enabled: boolean
    readonly installed: boolean
    readonly listedByDefault?: boolean
    readonly installTarget?: { readonly spec: string; readonly version: string }
    readonly error?: { readonly code: string; readonly diagnostic?: string }
  }[]
  const cua = bundles.find(candidate => candidate.name === CUA_BUNDLE)
  assert.ok(cua !== undefined, 'the real Host catalog carries the CUA on-demand entry')
  assert.equal(cua.official, true)
  assert.equal(cua.availability, 'missing')
  assert.equal(cua.enabled, false)
  assert.equal(cua.listedByDefault, false, 'the Host hides it from the default listing')
  assert.equal(cua.installTarget?.version, TARGET_VERSION)
  assert.equal(cua.installTarget?.spec, `${CUA_BUNDLE}@${TARGET_VERSION}`)
  if (process.platform === 'darwin') {
    // On its supported Host the platform refusal is absent; the native
    // Accessibility/Consent/desktop operations remain EXTERNAL_NOT_QUALIFIED.
    assert.equal(cua.error, undefined)
  } else {
    assert.equal(cua.error?.code, 'unsupported-platform')
  }
  // This Host never loads the bundle: the case is a catalog/platform negative,
  // not a native CUA qualification.
  assert.equal(host.activeBundles.includes(CUA_BUNDLE), false)
})
