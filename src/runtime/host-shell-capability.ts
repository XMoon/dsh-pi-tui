/**
 * The Windows Host's official PowerShell capability: the live installed
 * `@deepseek-ai/dsh-pwsh-local` public module constants plus the ONE live
 * `ctx.shell.pwshPath` getter read per attempt.
 *
 * Nothing here is a second executor, resolver or configuration authority. The
 * module is located through the running official DSH installation only: the
 * real DSH anchor (an explicit profile install anchor, the Direct launcher, or
 * the launcher-verified Split anchor) resolves the official
 * `@deepseek-ai/dsh-pwsh-sandbox` manifest, which declares `dsh-pwsh-local` as
 * a peer; the public ESM entry is resolved from that sandbox manifest's own
 * module context and proved inside the same installed closure. The immutable
 * module (its public constants) is cached by install identity; the service and
 * its `pwshPath` value are never cached.
 *
 * POSIX hosts never load this module: the shared execution core keeps the
 * existing Bash dialect.
 * @module @xmoon76/dsh-pi-tui/runtime/host-shell-capability
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostShellLocal } from './host-user-shell-execution.ts'
import {
  assertDeclaredDependency,
  assertDeclaredPeerDependency,
  assertInstallClosure,
  installedDshAnchor,
  readManifestObject,
} from './native-process/installed-dsh.ts'

/** The live official service face the execution core needs. */
export interface HostShellServiceLike {
  /** The live official executable getter; read once per attempt. */
  readonly pwshPath: string
}

/** The immutable public constants of the installed official pwsh-local module. */
interface PwshHostShellModule {
  readonly encodingPreamble: string
  readonly envOverrides: Readonly<Record<string, string>>
}

const loadedModules = new Map<string, Promise<PwshHostShellModule>>()

/**
 * Resolve the installed official pwsh-local public module once per install
 * identity. A failed load is not cached: a later attempt after the installation
 * is repaired must be able to load it.
 * @param explicitAnchor - the official profile install anchor when the caller
 *   already holds one (Direct/Split-Host composition); otherwise the
 *   launcher/environment anchor is resolved.
 */
async function resolvePwshHostShellModule(explicitAnchor?: string): Promise<PwshHostShellModule> {
  const anchor = installedDshAnchor(explicitAnchor)
  if (anchor === undefined) {
    throw new Error('the installed @deepseek-ai/dsh anchor is unavailable')
  }
  // The install IDENTITY includes the installed DSH version: an in-place
  // reinstall at the same path must not reuse an older module's constants.
  const anchorVersion = readManifestObject(anchor)?.version
  const identity = `${anchor}\u0000${typeof anchorVersion === 'string' ? anchorVersion : ''}`
  const cached = loadedModules.get(identity)
  if (cached !== undefined) return cached
  const loading = loadPwshHostShellModule(anchor)
  loadedModules.set(identity, loading)
  try {
    return await loading
  } catch (error) {
    loadedModules.delete(identity)
    throw error
  }
}

async function loadPwshHostShellModule(anchor: string): Promise<PwshHostShellModule> {
  const anchorManifest = readManifestObject(anchor)
  if (anchorManifest?.name !== '@deepseek-ai/dsh') {
    throw new Error('the DSH anchor is not an installed @deepseek-ai/dsh manifest')
  }
  assertDeclaredDependency(anchorManifest, '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh')
  assertDeclaredDependency(anchorManifest, '@deepseek-ai/dsh-pwsh-local', '@deepseek-ai/dsh')

  const anchorRequire = createRequire(anchor)
  const sandboxManifestPath = realpathSync(anchorRequire.resolve('@deepseek-ai/dsh-pwsh-sandbox/package.json'))
  const sandboxManifest = readManifestObject(sandboxManifestPath)
  if (sandboxManifest?.name !== '@deepseek-ai/dsh-pwsh-sandbox') {
    throw new Error('the resolved sandbox manifest is not @deepseek-ai/dsh-pwsh-sandbox')
  }
  assertDeclaredPeerDependency(sandboxManifest, '@deepseek-ai/dsh-pwsh-local', '@deepseek-ai/dsh-pwsh-sandbox')

  const sandboxRequire = createRequire(sandboxManifestPath)
  const localEntry = realpathSync(sandboxRequire.resolve('@deepseek-ai/dsh-pwsh-local'))
  assertInstallClosure(dirname(anchor), dirname(localEntry), '@deepseek-ai/dsh-pwsh-local')

  const imported = await import(pathToFileURL(localEntry).href) as {
    readonly ENCODING_PREAMBLE?: unknown
    readonly ENV_OVERRIDES?: unknown
  }
  if (typeof imported.ENCODING_PREAMBLE !== 'string' || imported.ENCODING_PREAMBLE === '') {
    throw new Error('the installed pwsh-local module does not export ENCODING_PREAMBLE')
  }
  const overrides = imported.ENV_OVERRIDES
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('the installed pwsh-local module does not export ENV_OVERRIDES')
  }
  const envOverrides: Record<string, string> = {}
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value !== 'string') {
      throw new Error(`the installed pwsh-local ENV_OVERRIDES entry ${name} is not a string`)
    }
    envOverrides[name] = value
  }
  return { encodingPreamble: imported.ENCODING_PREAMBLE, envOverrides }
}

/**
 * Build the Host-local shell inputs for ONE attempt. POSIX keeps the existing
 * Bash dialect without touching the Windows module. On Windows the live
 * official service must be mounted and expose its executable getter; the
 * executable is read exactly once for this attempt, then the immutable module
 * constants are loaded. A missing capability is an explicit undefined, never a
 * fallback to a bare `pwsh`, `cmd` or another executor.
 */
export async function hostShellLocalForAttempt(options: {
  readonly platform: NodeJS.Platform
  readonly shell: HostShellServiceLike | undefined
  readonly anchor: string | undefined
}): Promise<HostShellLocal | undefined> {
  if (options.platform !== 'win32') return { dialect: 'bash' }
  const shell = options.shell
  if (shell === undefined || typeof shell.pwshPath !== 'string' || shell.pwshPath === '') return undefined
  const executable = shell.pwshPath
  const capability = await resolvePwshHostShellModule(options.anchor)
  return {
    dialect: 'pwsh',
    executable,
    encodingPreamble: capability.encodingPreamble,
    envOverrides: capability.envOverrides,
  }
}
