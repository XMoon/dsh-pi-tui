/**
 * Qualification-only probe for the per-package extension-config port.
 *
 * Runs on the REAL surface revision's production `ConfigPort` after the
 * application was composed; it never creates a Context, Connection, mirror or
 * second Settings authority. The Client entry enables it only when
 * `SPLIT_PROCESS_CLIENT_EXTENSION_CONFIG_PROBE` is set, and the split-process
 * smoke asserts the resulting qualification record. Production never sets the
 * variable and no public CLI/API reaches this module.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/extension-config-probe
 */

import type { ConfigPort, ExtensionConfigRead } from '../../runtime/config-port.ts'

const PROBE_PACKAGE_A = '@r8-pr1-fixture/a'
const PROBE_PACKAGE_B = '@r8-pr1-fixture/b'

function factsOf(read: ExtensionConfigRead): Record<string, unknown> {
  return read.kind === 'ready'
    ? {
        kind: 'ready',
        revision: read.revision,
        effective: read.effective,
        inherited: read.inherited,
        user: read.user,
        userDataPresent: read.userDataPresent,
      }
    : { kind: read.kind, reason: read.reason }
}

/**
 * Run the fixed two-package read/write/conflict probe on the mounted port.
 *
 * @param config - the production application ConfigPort of this surface revision.
 * @returns one JSON-safe qualification record for the Client record sink.
 */
export async function runExtensionConfigProbe(config: ConfigPort): Promise<Record<string, unknown>> {
  const a0 = config.extensionConfigs.read(PROBE_PACKAGE_A)
  const b0 = config.extensionConfigs.read(PROBE_PACKAGE_B)
  if (a0.kind !== 'ready' || b0.kind !== 'ready') {
    throw new Error(`extension-config probe: both package rows must be readable (${a0.kind}/${b0.kind})`)
  }

  const writeA = await config.extensionConfigs.mutate(PROBE_PACKAGE_A, [
    { op: 'set', path: ['label'], value: 'probe-a' },
    { op: 'set', path: ['nested', 'flag'], value: true },
  ], a0.revision, a0.generation)
  const a1 = config.extensionConfigs.read(PROBE_PACKAGE_A)
  const b1 = config.extensionConfigs.read(PROBE_PACKAGE_B)

  const writeB = await config.extensionConfigs.mutate(PROBE_PACKAGE_B, [
    { op: 'set', path: ['limit'], value: 11 },
  ], b0.revision, b0.generation)
  const a2 = config.extensionConfigs.read(PROBE_PACKAGE_A)
  const b2 = config.extensionConfigs.read(PROBE_PACKAGE_B)

  const stale = a2.kind === 'ready'
    ? await config.extensionConfigs.mutate(PROBE_PACKAGE_A, [
        { op: 'set', path: ['label'], value: 'probe-stale-loser' },
      ], a0.revision, a2.generation)
    : { kind: 'not-run' }
  const a3 = config.extensionConfigs.read(PROBE_PACKAGE_A)

  await config.extensionConfigs.refresh()
  return {
    m4b2s: 'qualification',
    op: 'extension-config-probe',
    processRole: 'client',
    pid: process.pid,
    packageA: PROBE_PACKAGE_A,
    packageB: PROBE_PACKAGE_B,
    a0: factsOf(a0),
    b0: factsOf(b0),
    writeA: writeA.kind,
    a1: factsOf(a1),
    b1: factsOf(b1),
    writeB: writeB.kind,
    a2: factsOf(a2),
    b2: factsOf(b2),
    stale: stale.kind,
    a3: factsOf(a3),
    hasUnsettledWrites: config.hasUnsettledWrites(),
  }
}
