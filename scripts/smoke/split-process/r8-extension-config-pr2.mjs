/**
 * R8-E PR-2 real split-process extension-config qualification.
 *
 * One real isolated Profile gets two genuinely `npm pack`ed third-party
 * fixtures installed through the official `dsh plugin --profile pi-tui add`
 * command. A real OS Host process and a real surface Client process then run
 * the product's own `ConfigPort.extensionConfigs` probe on the production
 * Remote port: inherited reads, two independent USER writes, a stale revision
 * conflict and the untouched canonical preferences row are observed from the
 * real official Settings USER patch.
 *
 * The probe is a qualification-only client control (`extension-config-probe`)
 * and never appears on a user product path. This case is Linux-only until a
 * native Darwin run proves its process/PTY path.
 *
 * @module split-process/r8-extension-config-pr2
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { installPlugin, runDsh } from '../../lib/dsh-smoke-harness.mjs'
import { extensionConfigRowId } from '../../../src/domain/extension-config/row-id.ts'
import { createC1Scene } from './c1-scene.mjs'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'r8-extension-config')
const PROFILE = 'pi-tui'
const PACKAGE_A = '@r8-pr1-fixture/a'
const PACKAGE_B = '@r8-pr1-fixture/b'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Copy one PR-1 fixture, declare the current candidate peer and `npm pack` it. */
function packFixture(name, candidateVersion, workDir) {
  const directory = join(workDir, 'fixtures', name)
  cpSync(join(FIXTURE_ROOT, name), directory, { recursive: true })
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.peerDependencies = { '@xmoon76/dsh-pi-tui': `^${candidateVersion}` }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', workDir], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert(packed.status === 0, `npm pack failed for fixture ${name}: ${packed.stderr ?? ''}`)
  return join(workDir, JSON.parse(packed.stdout)[0].filename)
}

/** The canonical preferences rows of one profile USER document. */
function preferencesRows(patchPath) {
  const rows = parseYaml(readFileSync(patchPath, 'utf8')) ?? []
  assert(Array.isArray(rows), 'the isolated profile patch must be a row list')
  return rows.filter(row => row?.id === 'pi-tui-preferences')
}

function userRow(patchPath, id) {
  const rows = parseYaml(readFileSync(patchPath, 'utf8')) ?? []
  return rows.filter(row => row?.id === id && row.config !== undefined).at(-1)?.config
}

export async function runExtensionConfigPr2(context) {
  const { trace, installation } = context
  const scene = createC1Scene(context)
  const workDir = join(context.workDir, 'r8-extension-config-pr2')
  mkdirSync(workDir, { recursive: true })
  const patchPath = join(installation.profileDir, 'cordis.patch.yml')
  let host
  let client
  let installedA = false
  let installedB = false
  try {
    const tarballA = packFixture('a', installation.manifest.version, workDir)
    const tarballB = packFixture('b', installation.manifest.version, workDir)
    installPlugin(installation.dshInvocation, tarballA, context.workDir, context.env)
    installedA = true
    installPlugin(installation.dshInvocation, tarballB, context.workDir, context.env)
    installedB = true
    const preferencesBefore = preferencesRows(patchPath)

    const startedHost = await scene.startC1Host('r8-extension-config-pr2', 'R8-E PR-2 Host')
    host = startedHost.host
    const startedClient = await scene.startC1Client('R8-E PR-2 Client', {
      SPLIT_PROCESS_CLIENT_EXTENSION_CONFIG_PROBE: '1',
    })
    client = startedClient.client
    assert(client.child.pid !== startedClient.ready.pid, 'the Client wrapper and business process must be distinct PIDs')

    const proof = client.records.find(record => record.op === 'extension-config-probe')
    assert(proof !== undefined, `the Client emitted no extension-config probe record: ${JSON.stringify(client.records.slice(-12))}`)
    assert(proof.packageA === PACKAGE_A && proof.packageB === PACKAGE_B, 'the probe targeted the installed fixture package names')
    assert(proof.a0?.kind === 'ready' && proof.a0.effective?.label === 'alpha' && proof.a0.effective?.limit === 3,
      `A must start from its inherited document: ${JSON.stringify(proof.a0)}`)
    assert(proof.b0?.kind === 'ready' && proof.b0.effective?.label === 'bravo' && proof.b0.effective?.limit === 7,
      `B must start from its inherited document: ${JSON.stringify(proof.b0)}`)
    assert(proof.writeA === 'accepted', `A write must be accepted: ${JSON.stringify(proof)}`)
    assert(proof.a1?.effective?.label === 'probe-a' && proof.a1?.effective?.nested?.flag === true,
      `A must read back its accepted edit: ${JSON.stringify(proof.a1)}`)
    assert(proof.b1?.effective?.label === 'bravo' && proof.b1?.effective?.limit === 7,
      `A write must not change B: ${JSON.stringify(proof.b1)}`)
    assert(proof.writeB === 'accepted', `B write must be accepted: ${JSON.stringify(proof)}`)
    assert(proof.b2?.effective?.limit === 11 && proof.a2?.effective?.label === 'probe-a',
      `B must read back its accepted edit while A stays independent: ${JSON.stringify({ a2: proof.a2, b2: proof.b2 })}`)
    assert(proof.stale === 'conflict', `a stale captured revision must conflict: ${JSON.stringify(proof)}`)
    assert(proof.a3?.effective?.label === 'probe-a', 'the stale loser must not overwrite the accepted A value')
    assert(proof.hasUnsettledWrites === false, 'the port must have no unsettled write after settlement')

    const rowA = userRow(patchPath, extensionConfigRowId(PACKAGE_A))
    const rowB = userRow(patchPath, extensionConfigRowId(PACKAGE_B))
    assert(rowA?.data?.label === 'probe-a', `the official USER patch must hold A's committed data: ${JSON.stringify(rowA)}`)
    assert(rowB?.data?.limit === 11, `the official USER patch must hold B's committed data: ${JSON.stringify(rowB)}`)
    assert(JSON.stringify(preferencesRows(patchPath)) === JSON.stringify(preferencesBefore),
      'the canonical pi-tui-preferences row must stay unchanged')

    const identity = await scene.hostIdentityFacts(host)
    trace('r8epr2.extension-config', {
      hostPid: identity?.hostPid ?? host.child.pid,
      clientPid: startedClient.ready.pid,
      packages: [PACKAGE_A, PACKAGE_B],
      writeA: proof.writeA,
      writeB: proof.writeB,
      stale: proof.stale,
    })
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      hostPid: identity?.hostPid ?? host.child.pid,
      clientPid: startedClient.ready.pid,
      packageA: PACKAGE_A,
      packageB: PACKAGE_B,
      writeA: proof.writeA,
      writeB: proof.writeB,
      staleConflict: proof.stale === 'conflict',
      preferencesUntouched: true,
    }
  } finally {
    try { if (client !== undefined) await scene.exitC1Client(client, 'R8-E PR-2 Client') } catch { /* runner owns the process backstop */ }
    try { if (host !== undefined) await scene.stopC1Host(host) } catch { /* runner owns the process backstop */ }
    try { await scene.dispose() } catch { /* runner owns the process backstop */ }
    for (const [name, installed] of [[PACKAGE_A, installedA], [PACKAGE_B, installedB]]) {
      if (!installed) continue
      const removal = runDsh(installation.dshInvocation, ['plugin', '--profile', PROFILE, 'remove', name], context.workDir, context.env)
      assert(removal.status === 0, `removing fixture ${name} from the shared qualification profile failed: ${removal.stderr ?? ''}`)
    }
  }
}
