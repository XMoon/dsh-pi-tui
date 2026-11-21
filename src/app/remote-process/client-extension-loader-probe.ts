/**
 * Qualification-only probe for the Client-local `./tui` loader lifecycle.
 *
 * Runs on ONE real surface revision AFTER the production Client extension
 * activation. It drives the official Plugin Manager port to disable and
 * re-enable package A's trusted Config carrier row, then reconciles the
 * CURRENT revision's mount owner exactly like the Plugin Manager's committed
 * refresh callback would. Production never sets the enabling env variable.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/client-extension-loader-probe
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginManagerPort, PluginManagerSnapshot } from '../../runtime/plugin-manager-port.ts'
import type { ClientExtensionObservation } from '../client-extensions/mount-owner.ts'
import type { CurrentClientPackageLookup } from '../client-extensions/discovery.ts'
import { extensionConfigRowId } from '../plugin-manager/client-extension-discovery.ts'

const PACKAGES_ENV = 'SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_PACKAGES'

interface ProbePackages {
  readonly a: string
  readonly b: string
}

function probePackages(): ProbePackages {
  const raw = process.env[PACKAGES_ENV]
  if (raw === undefined || raw === '') throw new Error(`client extension probe: ${PACKAGES_ENV} is not set`)
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`client extension probe: ${PACKAGES_ENV} must be an object`)
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.a !== 'string' || value.a === '' || typeof value.b !== 'string' || value.b === '') {
    throw new Error(`client extension probe: ${PACKAGES_ENV} requires package names a and b`)
  }
  return { a: value.a, b: value.b }
}

function phaseOf(observations: readonly ClientExtensionObservation[], packageName: string): string {
  return observations.find(entry => entry.packageName === packageName)?.phase ?? 'absent'
}

function carrierEntryId(snapshot: PluginManagerSnapshot, packageName: string): string {
  const rowId = extensionConfigRowId(packageName)
  const row = snapshot.plugins.find(entry => entry.patchId === rowId)
  if (row === undefined) throw new Error(`client extension probe: no addressable carrier row for "${packageName}"`)
  return row.entryId
}

/** The narrow live UI face the probe drives. */
export interface ClientExtensionProbeUi {
  clientExtensionObservation(): readonly ClientExtensionObservation[]
  reconcileClientExtensions(snapshot: PluginManagerSnapshot): Promise<void>
}

/** Resolve the installed package's own `./tui` file for this qualification-only
 * byte-change control. Production never reads a path this way. */
function tuiFile(packageName: string, packages: CurrentClientPackageLookup, parentURL: string): string {
  const pkg = packages.packageOf(packageName, parentURL)
  if (pkg === undefined) throw new Error(`client extension probe: package "${packageName}" is not resolvable`)
  const entry = pkg.manifest.exports
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`client extension probe: package "${packageName}" declares no exports`)
  }
  const tui = (entry as Record<string, unknown>)['./tui']
  if (typeof tui !== 'string') throw new Error(`client extension probe: package "${packageName}" has no string ./tui export`)
  return join(pkg.dir, tui)
}

/** One fixed disable -> reconcile -> enable -> reconcile lifecycle probe. */
export async function runClientExtensionLoaderProbe(input: {
  readonly pluginManager: PluginManagerPort
  readonly ui: ClientExtensionProbeUi
  readonly pluginPackages?: CurrentClientPackageLookup
  readonly parentURL?: string
}): Promise<Record<string, unknown>> {
  const packages = probePackages()
  const initial = input.ui.clientExtensionObservation()
  const entryId = carrierEntryId(await input.pluginManager.snapshot(), packages.a)
  const disable = await input.pluginManager.setPluginEnabled(entryId, false)
  await input.ui.reconcileClientExtensions(await input.pluginManager.snapshot())
  const afterDisable = input.ui.clientExtensionObservation()
  const enable = await input.pluginManager.setPluginEnabled(entryId, true)
  await input.ui.reconcileClientExtensions(await input.pluginManager.snapshot())
  const afterEnable = input.ui.clientExtensionObservation()
  let afterBytesA: string | undefined
  let afterBytesB: string | undefined
  let afterRestoreA: string | undefined
  if (input.pluginPackages !== undefined && input.parentURL !== undefined) {
    const file = tuiFile(packages.a, input.pluginPackages, input.parentURL)
    const original = readFileSync(file, 'utf8')
    if (!original.includes('R8-A-LIVE')) throw new Error('client extension probe: fixture A footer marker is missing')
    const keepBytes = process.env.SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_KEEP_BYTES === '1'
    writeFileSync(file, original.replace('R8-A-LIVE', 'R8-A-NEW'))
    try {
      await input.ui.reconcileClientExtensions(await input.pluginManager.snapshot())
      const afterBytes = input.ui.clientExtensionObservation()
      afterBytesA = phaseOf(afterBytes, packages.a)
      afterBytesB = phaseOf(afterBytes, packages.b)
    } finally {
      if (!keepBytes) writeFileSync(file, original)
    }
    if (!keepBytes) {
      await input.ui.reconcileClientExtensions(await input.pluginManager.snapshot())
      afterRestoreA = phaseOf(input.ui.clientExtensionObservation(), packages.a)
    }
  }
  return {
    op: 'client-extension-loader-probe',
    initialA: phaseOf(initial, packages.a),
    initialB: phaseOf(initial, packages.b),
    disable: disable.application,
    afterDisableA: phaseOf(afterDisable, packages.a),
    afterDisableB: phaseOf(afterDisable, packages.b),
    enable: enable.application,
    afterEnableA: phaseOf(afterEnable, packages.a),
    afterEnableB: phaseOf(afterEnable, packages.b),
    ...(afterBytesA === undefined ? {} : { afterBytesA }),
    ...(afterBytesB === undefined ? {} : { afterBytesB }),
    ...(afterRestoreA === undefined ? {} : { afterRestoreA }),
    bytesKept: process.env.SPLIT_PROCESS_CLIENT_EXTENSION_LOADER_KEEP_BYTES === '1',
  }
}

/** One qualification-only changed-bytes notification probe, run after the
 * physical surface is ready so the REAL notification seam is live. */
export async function runClientExtensionReloadNoticeProbe(input: {
  readonly pluginManager: PluginManagerPort
  readonly ui: ClientExtensionProbeUi
  readonly pluginPackages?: CurrentClientPackageLookup
  readonly parentURL?: string
}): Promise<Record<string, unknown>> {
  const packages = probePackages()
  if (input.pluginPackages === undefined || input.parentURL === undefined) {
    throw new Error('client extension notice probe: package lookup was not supplied')
  }
  const file = tuiFile(packages.a, input.pluginPackages, input.parentURL)
  const original = readFileSync(file, 'utf8')
  if (!original.includes('R8-A-LIVE')) throw new Error('client extension notice probe: fixture A footer marker is missing')
  writeFileSync(file, original.replace('R8-A-LIVE', 'R8-A-NEW'))
  try {
    await input.ui.reconcileClientExtensions(await input.pluginManager.snapshot())
    return {
      op: 'client-extension-reload-notice-probe',
      phaseA: phaseOf(input.ui.clientExtensionObservation(), packages.a),
      phaseB: phaseOf(input.ui.clientExtensionObservation(), packages.b),
    }
  } finally {
    writeFileSync(file, original)
  }
}
