#!/usr/bin/env node
/**
 * M4-A0 Host-only process entry.
 *
 * Boots the ordinary DSH profile through the real launcher owner
 * (`@deepseek-ai/dsh/profile-boot` → `@deepseek-ai/dsh-app-boot` → Loader /
 * Include) rather than a hand-built Context. The launcher-owned Host-only
 * overlay disables exactly the TUI runner and the Client extension host /
 * builtins; every Host-plane row (including `tuiStartup`-gated workspace files,
 * the loopback webserver and the performance projection) keeps its production
 * source.
 *
 * The entry is an internal qualification artifact, not a package export or a
 * CLI command: the launcher supplies the DSH installation anchor, profile name
 * and scratch directory through `SPLIT_PROCESS_DSH_ANCHOR` / `SPLIT_PROCESS_PROFILE` / `SPLIT_PROCESS_SCRATCH`.
 *
 * @module app/remote-process/local-host-entry
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachEntryControl, readProcessStartIdentity, writeEntryRecord } from './entry-control.ts'

/**
 * The Host-only overlay applied over the profile's own patch stack. It keeps
 * `tui-startup` mounted (the Host rows gated on `tuiStartup` need its parsed
 * facts) and disables only the three surface rows that must not exist in a
 * Host-only PID.
 */
export const HOST_ONLY_PATCH = `# M4-A0 Host-only profile overlay: production Host rows only.
- id: tui-app
  disabled: true
- id: pi-tui-extension-host
  disabled: true
- id: pi-tui-builtins
  disabled: true
`

interface OfficialDshModules {
  readonly runProfile: (options: {
    environment: unknown
    profile: string
    patchFiles: readonly string[]
    args: readonly string[]
  }) => Promise<{
    ctx: import('@deepseek-ai/cordis').Context
    shutdown: { shutdown(code: number): Promise<void> }
  }>
  readonly loadLayeredEnv: (binName: string, cwd?: string) => unknown
}

/** Resolve one published DSH subpath from the installation anchor supplied by the launcher. */
async function loadOfficialDsh(anchor: string): Promise<OfficialDshModules> {
  const requireFromDsh = createRequire(realpathSync(anchor))
  const importResolved = async (specifier: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
  const profileBoot = await importResolved('@deepseek-ai/dsh/profile-boot')
  const appBoot = await importResolved('@deepseek-ai/dsh-app-boot')
  return {
    runProfile: profileBoot.runProfile as OfficialDshModules['runProfile'],
    loadLayeredEnv: appBoot.loadLayeredEnv as OfficialDshModules['loadLayeredEnv'],
  }
}

/** The launcher-supplied facts one Host-only process needs. */
export interface LocalHostEntryOptions {
  /** Absolute path of the installed `@deepseek-ai/dsh/package.json`. */
  readonly dshAnchor: string
  /** Profile to boot; defaults to `pi-tui`. */
  readonly profile: string
  /** Scratch directory for the generated Host-only overlay. */
  readonly scratchDir: string
  /** Extra overlay applied after the Host-only overlay (negative controls). */
  readonly extraPatchFiles?: readonly string[]
}

/**
 * Run one Host-only process until its launcher requests shutdown. Exported so
 * the process-level qualification harness can document its exact contract; the
 * module's `import.meta.main` block is the only caller in production.
 */
export async function runLocalHostEntry(options: LocalHostEntryOptions): Promise<void> {
  const { dshAnchor, profile, scratchDir } = options
  mkdirSync(scratchDir, { recursive: true })
  const overlayPath = join(scratchDir, 'host-only.patch.yml')
  writeFileSync(overlayPath, HOST_ONLY_PATCH)
  const dsh = await loadOfficialDsh(dshAnchor)
  const processStartIdentity = readProcessStartIdentity()
  // The profile's startup row reads these launcher facts. The identity marker
  // binds the role to THIS executable, so a regular CLI that inherits the role
  // string cannot suppress the TUI-surface verdict (see startup.ts).
  process.env.DSH_PI_TUI_ROLE = 'host'
  if (process.argv[1] !== undefined) {
    process.env.DSH_PI_TUI_HOST_ENTRY = realpathSync(process.argv[1])
  }
  const handle = await dsh.runProfile({
    environment: dsh.loadLayeredEnv('dsh', process.cwd()),
    profile,
    patchFiles: [overlayPath, ...options.extraPatchFiles ?? []],
    args: [],
  })
  // From here on the Host root exists. EVERY step — first record, the lazy
  // audit import, the audit itself, ready publication and control installation
  // — is owned by the launcher shutdown controller on failure.
  try {
    writeEntryRecord({
      m4a0: 'profile-booted', processRole: 'host', pid: process.pid, phase: 'profile-booted',
    })
    // Importing the audit chunk AFTER the launcher boot guarantees the profile's
    // runtime package interception is installed before any bare DSH import runs.
    const { settleHostEntries, collectHostEntryStatus } = await import('./host-bootstrap.ts')
    await settleHostEntries(handle.ctx)
    const status = collectHostEntryStatus(handle.ctx, { profile, processStartIdentity })
    writeEntryRecord({ m4a0: 'ready', ...status })
    attachEntryControl(async request => {
      if (request.op === 'status') {
        writeEntryRecord({
          m4a0: 'status',
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          ...collectHostEntryStatus(handle.ctx, { profile, processStartIdentity }),
        })
        return false
      }
      if (request.op === 'shutdown') {
        await handle.shutdown.shutdown(0)
        return true
      }
      writeEntryRecord({ m4a0: 'control-error', error: `local host entry: unknown op ${JSON.stringify(request.op)}` })
      return false
    })
  } catch (error) {
    writeEntryRecord({
      m4a0: 'failure',
      processRole: 'host',
      phase: 'after-boot',
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    await finishHostFailureCleanup(handle.shutdown)
    process.exitCode = 1
  }
}

/**
 * Finish one failed Host startup with the launcher's official shutdown owner.
 * A successful disposal emits exactly one `cleanup: completed`; a rejecting
 * disposal emits one `cleanup-failure` and NEVER a completed record. Exported
 * for the review-fix negative control.
 */
export async function finishHostFailureCleanup(
  shutdownOwner: { shutdown(code: number): Promise<void> },
  emit: (record: Record<string, unknown>) => void = writeEntryRecord,
): Promise<boolean> {
  try {
    await shutdownOwner.shutdown(1)
    emit({ m4a0: 'cleanup', processRole: 'host', phase: 'after-boot', pid: process.pid, status: 'completed' })
    return true
  } catch (cleanupError) {
    emit({
      m4a0: 'cleanup-failure',
      processRole: 'host',
      phase: 'after-boot',
      pid: process.pid,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    })
    return false
  }
}

/** Read the launcher environment; a missing anchor is a hard startup failure. */
function optionsFromEnvironment(): LocalHostEntryOptions {
  const dshAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  if (dshAnchor === undefined || dshAnchor === '') {
    throw new Error('local host entry: SPLIT_PROCESS_DSH_ANCHOR must name the installed @deepseek-ai/dsh/package.json')
  }
  return {
    dshAnchor,
    profile: process.env.SPLIT_PROCESS_PROFILE ?? 'pi-tui',
    scratchDir: process.env.SPLIT_PROCESS_SCRATCH ?? mkdtempSync(join(tmpdir(), 'split-process-host-')),
    ...(process.env.SPLIT_PROCESS_EXTRA_PATCH === undefined || process.env.SPLIT_PROCESS_EXTRA_PATCH === ''
      ? {}
      : { extraPatchFiles: [process.env.SPLIT_PROCESS_EXTRA_PATCH] }),
  }
}

if (import.meta.main) {
  try {
    await runLocalHostEntry(optionsFromEnvironment())
  } catch (error) {
    writeEntryRecord({
      m4a0: 'failure',
      processRole: 'host',
      phase: 'startup',
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    process.exit(1)
  }
}
