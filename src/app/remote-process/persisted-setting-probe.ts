/**
 * Qualification-only two-Client probe for the persisted extension-setting
 * writer (R8-E PR-4).
 *
 * Two REAL surface Client processes each run on their own production
 * `ConfigPort` (the Remote adapter over the ONE Host Settings mirror). The
 * probe coordinates through files in the smoke work root:
 *
 * ```text
 * B reads A's revision  ->  A commits label=omega at that revision
 *                       ->  B's captured-revision Confirm is a conflict
 *                       ->  B refreshes and commits its OWN limit=11
 * ```
 *
 * No Context, mirror or Settings authority is created here. Production never
 * sets the enabling environment variable, and the result is a JSON-safe
 * qualification record in the existing Client record sink.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/persisted-setting-probe
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigPort } from '../../runtime/config-port.ts'
import type { ClientExtensionObservation } from '../client-extensions/mount-owner.ts'

interface ProbePackages {
  readonly a: string
  readonly b: string
}

function packagesEnv(): ProbePackages {
  const raw = process.env.SPLIT_PROCESS_CLIENT_PERSISTED_SETTING_PACKAGES
  if (raw === undefined || raw === '') {
    throw new Error('persisted-setting probe: SPLIT_PROCESS_CLIENT_PERSISTED_SETTING_PACKAGES is not set')
  }
  const parsed = JSON.parse(raw) as { a?: unknown; b?: unknown }
  if (typeof parsed.a !== 'string' || parsed.a === '' || typeof parsed.b !== 'string' || parsed.b === '') {
    throw new Error('persisted-setting probe: package names a and b are required')
  }
  return { a: parsed.a, b: parsed.b }
}

function probeRole(): 'A' | 'B' {
  const role = process.env.SPLIT_PROCESS_CLIENT_PERSISTED_SETTING_ROLE
  if (role !== 'A' && role !== 'B') {
    throw new Error('persisted-setting probe: SPLIT_PROCESS_CLIENT_PERSISTED_SETTING_ROLE must be A or B')
  }
  return role
}

function probeDir(): string {
  const dir = process.env.SPLIT_PROCESS_CLIENT_PERSISTED_SETTING_DIR
  if (dir === undefined || dir === '') {
    throw new Error('persisted-setting probe: SPLIT_PROCESS_CLIENT_PERSISTED_SETTING_DIR is not set')
  }
  return dir
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`)
}

async function waitJson(dir: string, name: string, label: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  const path = join(dir, name)
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`persisted-setting probe: timed out waiting for ${label}`)
}

function clientStatuses(observations: readonly ClientExtensionObservation[]): Record<string, string> {
  return Object.fromEntries(observations.map(observation => [observation.packageName, observation.phase]))
}

/**
 * Run the fixed two-Client persisted-setting probe.
 *
 * @param config - this surface revision's production ConfigPort.
 * @param observations - this Client's real Loader observations.
 */
export async function runPersistedSettingProbe(
  config: ConfigPort,
  observations: () => readonly ClientExtensionObservation[],
): Promise<Record<string, unknown>> {
  const packages = packagesEnv()
  const role = probeRole()
  const dir = probeDir()
  if (role === 'B') {
    const a0 = config.extensionConfigs.read(packages.a)
    const b0 = config.extensionConfigs.read(packages.b)
    if (a0.kind !== 'ready' || b0.kind !== 'ready') {
      throw new Error(`persisted-setting probe: both package rows must be readable (${a0.kind}/${b0.kind})`)
    }
    writeJson(dir, 'b-read.json', { revision: a0.revision })
    const committed = await waitJson(dir, 'a-commit.json', 'Client A commit')
    // The SAME field at the revision B captured before A wrote is a conflict.
    const stale = await config.extensionConfigs.mutate(packages.a, [
      { op: 'set', path: ['label'], value: 'stale-loser' },
    ], a0.revision, a0.generation)
    const aAfter = config.extensionConfigs.read(packages.a)
    await config.extensionConfigs.refresh()
    const bFresh = config.extensionConfigs.read(packages.b)
    if (bFresh.kind !== 'ready') throw new Error('persisted-setting probe: B row became unreadable after refresh')
    const bWrite = await config.extensionConfigs.mutate(packages.b, [
      { op: 'set', path: ['limit'], value: 11 },
    ], bFresh.revision, bFresh.generation)
    const bRead = config.extensionConfigs.read(packages.b)
    const result = {
      m4b2s: 'qualification',
      op: 'persisted-setting-probe',
      processRole: 'B',
      pid: process.pid,
      packageA: packages.a,
      packageB: packages.b,
      aBefore: a0.kind,
      bBefore: b0.kind,
      aCommitted: committed.kind,
      stale: stale.kind,
      aAfter: aAfter.kind === 'ready' ? { effective: aAfter.effective, user: aAfter.user } : { kind: aAfter.kind },
      bWrite: bWrite.kind,
      bAfter: bRead.kind === 'ready' ? { effective: bRead.effective, user: bRead.user } : { kind: bRead.kind },
      observations: clientStatuses(observations()),
    }
    writeJson(dir, 'b-result.json', result)
    return result
  }

  const a0 = config.extensionConfigs.read(packages.a)
  if (a0.kind !== 'ready') throw new Error('persisted-setting probe: A row must be readable')
  writeJson(dir, 'a-read.json', { revision: a0.revision })
  await waitJson(dir, 'b-read.json', 'Client B read')
  const writeA = await config.extensionConfigs.mutate(packages.a, [
    { op: 'set', path: ['label'], value: 'omega' },
  ], a0.revision, a0.generation)
  const a1 = config.extensionConfigs.read(packages.a)
  const result = {
    m4b2s: 'qualification',
    op: 'persisted-setting-probe',
    processRole: 'A',
    pid: process.pid,
    packageA: packages.a,
    packageB: packages.b,
    aBefore: a0.kind,
    writeA: writeA.kind,
    aAfter: a1.kind === 'ready' ? { effective: a1.effective, user: a1.user } : { kind: a1.kind },
    observations: clientStatuses(observations()),
  }
  writeJson(dir, 'a-commit.json', result)
  writeJson(dir, 'a-result.json', result)
  return result
}
