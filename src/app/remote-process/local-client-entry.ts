#!/usr/bin/env node
/**
 * M4-A0 Client-only process entry.
 *
 * The Client PID owns a real Cordis root and mounts only the Client-local
 * subtree (TUI startup facts, extension host, first-party builtins). It never
 * imports the Host runtime, the in-process carrier, or the application
 * aggregate, and it reports `transport: not-connected` until M4-B1 supplies
 * the official authenticated Connection.
 *
 * The launcher supplies the DSH installation anchor and profile name through
 * `SPLIT_PROCESS_DSH_ANCHOR` / `SPLIT_PROCESS_PROFILE` so this process can install the same official
 * package-resolution interception the dsh launcher uses. The package's own
 * `dist/` location stays the installation point — no repository source path or
 * tsx loader is involved.
 *
 * @module app/remote-process/local-client-entry
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mergeCause } from '../remote/dispose-cause.ts'
import type { LocalClientHandle } from './client-bootstrap.ts'
import { pathToFileURL } from 'node:url'
import { attachEntryControl, createEntryDiag, readProcessStartIdentity, writeEntryRecord } from './entry-control.ts'
import { runDetached } from '../../runtime/process/tasks.ts'

interface OfficialClientHostModules {
  readonly Context: new () => import('@deepseek-ai/cordis').Context
  readonly PluginPackages: abstract new (...args: never[]) => unknown
  readonly loadProfile: (binName: string, name: string, installAnchor: string) => unknown
  readonly createRuntimeResolution: (options: {
    installAnchor: string
    profile: unknown
  }) => Promise<unknown>
}

/** Load the published DSH modules this entry needs, from the installation anchor. */
async function loadOfficialClientHost(anchor: string): Promise<OfficialClientHostModules> {
  const requireFromDsh = createRequire(realpathSync(anchor))
  const importResolved = async (specifier: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
  const appBoot = await importResolved('@deepseek-ai/dsh-app-boot')
  const cordis = await importResolved('@deepseek-ai/cordis')
  return {
    Context: cordis.Context as OfficialClientHostModules['Context'],
    PluginPackages: appBoot.PluginPackages as OfficialClientHostModules['PluginPackages'],
    loadProfile: appBoot.loadProfile as OfficialClientHostModules['loadProfile'],
    createRuntimeResolution: appBoot.createRuntimeResolution as OfficialClientHostModules['createRuntimeResolution'],
  }
}

/** The launcher-supplied facts one Client-only process needs. */
export interface LocalClientEntryOptions {
  /** Absolute path of the installed `@deepseek-ai/dsh/package.json`. */
  readonly dshAnchor: string
  /** Profile whose installed package table supplies the peer-resolution layer. */
  readonly profile: string
}

/**
 * Run one Client-only process until its launcher requests shutdown. Exported
 * for the qualification harness; `import.meta.main` is the only production
 * caller.
 */
export async function runLocalClientEntry(options: LocalClientEntryOptions): Promise<void> {
  const host = await loadOfficialClientHost(options.dshAnchor)
  const loadedProfile = host.loadProfile('split-process-client', options.profile, options.dshAnchor)
  const resolution = await host.createRuntimeResolution({
    installAnchor: options.dshAnchor,
    profile: loadedProfile,
  })
  const context = new host.Context()
  let handle: LocalClientHandle | undefined
  try {
    const packageFiber = context.plugin(host.PluginPackages as never, { resolution } as never)
    await packageFiber
    writeEntryRecord({ m4a0: 'context-ready', processRole: 'client', pid: process.pid, phase: 'context-ready' })
    // The official resolution interception is live before this dynamic import;
    // the Client chunk's bare @deepseek-ai imports therefore resolve exactly
    // like a Loader-mounted plugin's would.
    const { startLocalClient } = await import('./client-bootstrap.ts')
    handle = await startLocalClient(context, {}, readProcessStartIdentity())
    writeEntryRecord({ m4a0: 'ready', ...handle.status })
    let stopping = false
    const stop = async (code: number): Promise<void> => {
      if (stopping) return
      stopping = true
      if (handle === undefined) {
        process.exit(code)
        return
      }
      process.exit(await stopLocalClient(handle, code))
    }
    const diag = createEntryDiag('client')
    process.on('SIGTERM', () => {
      runDetached('local client: SIGTERM shutdown', () => stop(0), { diag })
    })
    process.on('SIGINT', () => {
      runDetached('local client: SIGINT shutdown', () => stop(130), { diag })
    })
    attachEntryControl(async request => {
      if (request.op === 'status') {
        writeEntryRecord({
          m4a0: 'status',
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          ...handle!.status,
        })
        return false
      }
      if (request.op === 'shutdown') {
        await stop(0)
        return true
      }
      writeEntryRecord({ m4a0: 'control-error', error: `local client entry: unknown op ${JSON.stringify(request.op)}` })
      return false
    })
  } catch (error) {
    let primary = error instanceof Error ? error : new Error(String(error))
    // The Client root and the official package-resolution plugin are already
    // owned here; dispose them in the exact order the successful path uses.
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch (cleanupError) {
        primary = mergeCause(primary, cleanupError)
      }
    }
    try {
      await context.fiber.dispose()
    } catch (cleanupError) {
      primary = mergeCause(primary, cleanupError)
    }
    writeEntryRecord({
      m4a0: 'failure',
      processRole: 'client',
      phase: 'after-context',
      pid: process.pid,
      error: primary.message,
      ...(primary.stack === undefined ? {} : { stack: primary.stack }),
      ...(primary.cause === undefined ? {} : { cause: primary.cause instanceof Error ? primary.cause.message : String(primary.cause) }),
    })
    writeEntryRecord({ m4a0: 'cleanup', processRole: 'client', phase: 'after-context', pid: process.pid, status: 'completed' })
    process.exitCode = 1
  }
}

/**
 * Dispose the Client-owned root and classify a rejecting disposer as a real
 * cleanup failure. The requested success code becomes 1; an interrupt/signal
 * code keeps its nonzero identity. Never returns the success code after a
 * failed dispose, and a second stop call is prevented by the caller's latch.
 */
export async function stopLocalClient(
  handle: { dispose(): Promise<void> },
  requestedCode: number,
  emit: (record: Record<string, unknown>) => void = writeEntryRecord,
): Promise<number> {
  try {
    await handle.dispose()
    return requestedCode
  } catch (error) {
    emit({
      m4a0: 'cleanup-failure',
      processRole: 'client',
      phase: 'shutdown',
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    return requestedCode === 0 ? 1 : requestedCode
  }
}

/** Read the launcher environment; a missing anchor is a hard startup failure. */
function optionsFromEnvironment(): LocalClientEntryOptions {
  const dshAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  if (dshAnchor === undefined || dshAnchor === '') {
    throw new Error('local client entry: SPLIT_PROCESS_DSH_ANCHOR must name the installed @deepseek-ai/dsh/package.json')
  }
  return { dshAnchor, profile: process.env.SPLIT_PROCESS_PROFILE ?? 'pi-tui' }
}

if (import.meta.main) {
  try {
    await runLocalClientEntry(optionsFromEnvironment())
  } catch (error) {
    writeEntryRecord({
      m4a0: 'failure',
      processRole: 'client',
      phase: 'startup',
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    process.exit(1)
  }
}
