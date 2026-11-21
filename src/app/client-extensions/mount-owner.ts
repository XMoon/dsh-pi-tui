/**
 * The ONE Client-local mount owner for external PiTui `./tui` packages.
 *
 * Direct and every split Client construct the SAME owner over their own
 * EXISTING Cordis Context/Loader and the current process's official
 * `PluginPackages` table. The owner never reads the profile, never invents a
 * second package manager or extension service, and never treats the Host
 * Plugin Manager's `enabled` fact as an ACTIVE UI claim:
 *
 * ```text
 * Host PM snapshot -> discoverCurrentClientExtensions (existing pure policy)
 *   -> ConfigPort.extensionConfigs.read(packageName)
 *   -> official Loader.create({ id, name: '<pkg>/tui', config: effective })
 *   -> real Entry/Fiber ACTIVE
 *   -> this Client's piTuiExtensions ledger (Footer/Command contributions)
 * ```
 *
 * Lifecycle rules that are load-bearing here:
 * - the Loader entry id is always `pi-tui-client-` + the validated 32-char
 *   `extensionConfigRowId` hash (`:` is the Loader tree separator and is never
 *   allowed in an id);
 * - `loader.create()` resolving is NOT proof of activation: the real
 *   `Entry.fiber` must exist, settle and be ACTIVE;
 * - `loader.remove()` unregisters synchronously but does not await the old
 *   Fiber's terminal cleanup: the owner captures the fiber first, removes the
 *   entry, then awaits that fiber's disposal before the id may be reused;
 * - a same-PID byte change is NEVER hot-imported: the old Entry stays the
 *   active code and the package becomes `reload-required`;
 * - per-package failures stay Client-local and never block the other package.
 *
 * @module @xmoon76/dsh-pi-tui/app/client-extensions/mount-owner
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { symbols, type Fiber } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ExtensionConfigsConfig } from '../../runtime/config-port.ts'
import type { PluginManagerSnapshot } from '../../runtime/plugin-manager-port.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { clientExtensionEntryId } from '../../domain/extension-config/client-entry.ts'
import { markOwnedClientExtensionEntry, unmarkOwnedClientExtensionEntry } from '../../runtime/plugin-manager-ownership.ts'
import {
  discoverCurrentClientExtensions,
  type CurrentClientExtension,
  type CurrentClientPackageLookup,
} from './discovery.ts'

/** Cordis `FiberState.ACTIVE` (the enum is a const enum with no runtime value). */
const FIBER_ACTIVE = 2

/**
 * Bound on ONE third-party plugin's activation. A missing Cordis dependency
 * can leave a fiber PENDING forever; without a bound one broken plugin would
 * hold the whole serialized reconcile. This is a failure bound, not a
 * success window: an ACTIVE fiber settles immediately.
 */
const ACTIVATION_TIMEOUT_MS = 15_000

/** The PiTui-only runtime state of one package in THIS Client. */
export type ClientExtensionMountPhase =
  | 'active'
  | 'reload-required'
  | 'error'
  | 'unavailable'
  | 'not-opted-in'
  | 'invalid-opt-in'
  | 'unresolved'

/** One package's immutable Client-local observation. */
export interface ClientExtensionObservation {
  readonly packageName: string
  readonly phase: ClientExtensionMountPhase
  /** The live Loader entry id, only while this Client owns one. */
  readonly entryId?: string
  /** The Config revision the running entry was activated with. */
  readonly configRevision?: number
  /** The SHA-256 of the `./tui` bytes this Client actually applied. */
  readonly codeIdentity?: string
  /** Short PiTui-only reason for a non-active phase. */
  readonly reason?: string
}

/** The narrow inputs every Direct/Split composition supplies. */
export interface ClientExtensionMountOwnerOptions {
  readonly context: import('@deepseek-ai/cordis').Context
  /** The CURRENT Client process's existing official Loader (never a second). */
  readonly loader: Loader
  /** The CURRENT Client process's official package table. */
  readonly pluginPackages: CurrentClientPackageLookup
  /** The Host-owned per-package Config read (Direct in-process or Remote mirror). */
  readonly config: ExtensionConfigsConfig
  /** A `file:` URL inside this Client's install for package resolution. */
  readonly parentURL: string
  readonly signal?: AbortSignal
  readonly diag?: Diag
}

/** The narrow lifecycle surface every Direct/Split caller uses. */
export interface ClientExtensionMountOwner {
  /** Reconcile the CURRENT Client's entries against ONE committed Host snapshot. */
  reconcile(snapshot: PluginManagerSnapshot): Promise<void>
  /** Unload every owned entry (reverse order, each awaited), idempotent. */
  dispose(): Promise<void>
  /** Read-only ephemeral facts for tests and the future manager projection. */
  observation(): readonly ClientExtensionObservation[]
}

/** One live entry this owner created and still owns. */
interface MountedEntry {
  readonly packageName: string
  readonly entryId: string
  readonly configRevision: number
  readonly configValue: unknown
  readonly codeIdentity: string | undefined
}

/** One bounded activation wait over the REAL fiber lifecycle. */
async function awaitActiveFiber(
  fiber: Fiber,
  signal: AbortSignal | undefined,
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<void> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error(timeout.aborted
        ? `./tui activation did not settle within ${String(timeoutMs)}ms`
        : 'client extension activation was aborted'))
    }
    if (combined.aborted) {
      onAbort()
      return
    }
    combined.addEventListener('abort', onAbort, { once: true })
  })
  await Promise.race([fiber.await(), aborted])
  if (fiber.state !== FIBER_ACTIVE) {
    throw new Error(`./tui fiber is not active after activation (state ${String(fiber.state)})`)
  }
}

/** Whether two detached JSON Config values are equivalent. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Resolve the EXACT module URL the official Loader's ESM import uses. The
 * official Loader exposes its own resolved Node module loader; this is the
 * same resolver/parent URL the real import will use — never a `require`
 * condition, never a second resolver.
 */
function resolveImportedModuleUrl(loader: Loader, specifier: string, parentURL: string): string | undefined {
  const internal = loader.internal
  if (internal === undefined) return undefined
  try {
    const result = internal.version === 'v2'
      ? internal.resolveSync(parentURL, { specifier })
      : internal.resolveSync(specifier, parentURL, {})
    const url = (result as { readonly url?: unknown }).url
    if (typeof url !== 'string' || !url.startsWith('file:')) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Hash the exact bytes of the module the Loader will import. */
function readCodeIdentity(loader: Loader, specifier: string, parentURL: string): string | undefined {
  const url = resolveImportedModuleUrl(loader, specifier, parentURL)
  if (url === undefined) return undefined
  try {
    return createHash('sha256').update(readFileSync(new URL(url))).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * Process-lifetime identity memory per Loader: Node's ESM cache is
 * process-scoped, so a same-PID surface revision must inherit the identity
 * the previous revision actually imported. A fresh owner must never mistake a
 * cached v1 module for a newly written v2 file.
 */
const PROCESS_KNOWN_CODE_IDENTITIES = new WeakMap<object, Map<string, string | undefined>>()

function processKnownCodeIdentities(loader: Loader): Map<string, string | undefined> {
  const key = (loader as unknown as Record<symbol, object | undefined>)[symbols.original] ?? loader
  let known = PROCESS_KNOWN_CODE_IDENTITIES.get(key)
  if (known === undefined) {
    known = new Map()
    PROCESS_KNOWN_CODE_IDENTITIES.set(key, known)
  }
  return known
}

/** Create the ONE Client-local mount owner. */
export function createClientExtensionMountOwner(
  options: ClientExtensionMountOwnerOptions,
): ClientExtensionMountOwner {
  const { loader, pluginPackages, config, parentURL } = options
  const mounted = new Map<string, MountedEntry>()
  /**
   * The code identity this Client has ALREADY imported for a package, even
   * after a disable unloads its entry. Node's ESM cache never forgets a URL,
   * so a later re-enable must not claim newer file bytes it cannot load.
   */
  const knownCodeIdentity = processKnownCodeIdentities(loader)
  const observations = new Map<string, ClientExtensionObservation>()
  let reconcileTail: Promise<void> = Promise.resolve()
  let disposed = false
  /** Reconcile epoch: a superseded reconcile may never publish. */
  let reconciliation = 0

  const warn = (message: string, fields?: Record<string, unknown>): void => {
    options.diag?.warn(message, fields)
  }

  const isCurrent = (epoch: number): boolean => !disposed && epoch === reconciliation && options.signal?.aborted !== true

  const setObservation = (observation: ClientExtensionObservation): void => {
    observations.set(observation.packageName, Object.freeze(observation))
  }

  /** Capture the live fiber and remove the entry, then await terminal cleanup. */
  const unloadEntry = async (entry: MountedEntry): Promise<void> => {
    let fiber: Fiber | undefined
    try {
      fiber = loader.resolve(entry.entryId).fiber
    } catch {
      // The entry is already gone (external teardown): nothing left to await.
      fiber = undefined
    }
    loader.remove(entry.entryId)
    unmarkOwnedClientExtensionEntry(loader, entry.entryId)
    if (fiber !== undefined) {
      await fiber.dispose()
      await fiber.await()
    }
    if (Object.hasOwn(loader.store, entry.entryId)) {
      throw new Error(`client extension: entry "${entry.entryId}" survived its removal`)
    }
  }

  /** Remove a not-yet-published entry created by the current reconcile. */
  const discardCreatedEntry = async (entryId: string): Promise<void> => {
    let fiber: Fiber | undefined
    try {
      fiber = loader.resolve(entryId).fiber
    } catch {
      return
    }
    try {
      loader.remove(entryId)
      unmarkOwnedClientExtensionEntry(loader, entryId)
    } catch {
      // A concurrently removed entry is already the desired terminal state.
    }
    if (fiber !== undefined) {
      // Cordis' disposer may return `undefined` when no cleanup was
      // registered; normalize before attaching the error handler.
      await Promise.resolve(fiber.dispose()).catch(() => undefined)
    }
  }

  /** Resolve the real entry/fiber pair after `loader.create` resolved. */
  const requireActiveFiber = async (entryId: string, epoch: number): Promise<Fiber> => {
    const entry = loader.resolve(entryId)
    const fiber = entry.fiber
    if (fiber === undefined) {
      throw new Error(`./tui entry "${entryId}" produced no live Fiber`)
    }
    await awaitActiveFiber(fiber, options.signal)
    if (!isCurrent(epoch)) throw new Error('client extension activation was superseded')
    return fiber
  }

  const reconcileNow = async (snapshot: PluginManagerSnapshot): Promise<void> => {
    const epoch = ++reconciliation
    const outcomes = discoverCurrentClientExtensions(snapshot, pluginPackages, parentURL)
    const candidates = new Map<string, Extract<CurrentClientExtension, { kind: 'candidate' }>>()
    for (const outcome of outcomes) {
      if (outcome.kind !== 'candidate') continue
      clientExtensionEntryId(outcome.configRowId)
      candidates.set(outcome.packageName, outcome)
    }

    // 1. Any package that is no longer an eligible candidate loses its entry.
    for (const [packageName, entry] of [...mounted]) {
      if (candidates.has(packageName)) continue
      try {
        await unloadEntry(entry)
        mounted.delete(packageName)
        observations.delete(packageName)
      } catch (error) {
        setObservation({ packageName, phase: 'error', entryId: entry.entryId, reason: 'cleanup failed' })
        warn('client extension: cleanup failed while unloading an ineligible package', {
          packageName,
          entryId: entry.entryId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (!isCurrent(epoch)) return
    }

    // 2. Drop observations for packages that are no longer part of the
    // current enabled outcome set (a never-mounted package that was disabled
    // must not leave a stale non-active observation behind).
    const current = new Set(outcomes.map(outcome =>
      outcome.kind === 'unresolved' ? outcome.bundleName : outcome.packageName))
    for (const packageName of [...observations.keys()]) {
      if (!current.has(packageName) && !mounted.has(packageName)) observations.delete(packageName)
    }

    // 3. Record the PiTui-only outcome of every enabled non-candidate.
    for (const outcome of outcomes) {
      if (outcome.kind === 'candidate') continue
      const packageName = outcome.kind === 'unresolved' ? outcome.bundleName : outcome.packageName
      setObservation({
        packageName,
        phase: outcome.kind,
        ...(outcome.kind === 'not-opted-in' ? {} : { reason: outcome.reason }),
      })
    }
    if (candidates.size === 0) return

    // 4. One Settings refresh per reconcile, then one read per candidate.
    try {
      await config.refresh()
    } catch (error) {
      warn('client extension: per-package Config refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (!isCurrent(epoch)) return

    for (const candidate of outcomes) {
      if (candidate.kind !== 'candidate') continue
      if (!isCurrent(epoch)) return
      const { packageName, tuiSpecifier, configRowId } = candidate
      const read = config.read(packageName)
      if (read.kind !== 'ready') {
        // A previously ACTIVE entry must not keep rendering/running while the
        // Host says its Config is no longer readable. Revoke the contributions
        // through the official Loader first; only then report unavailable.
        const previous = mounted.get(packageName)
        if (previous !== undefined) {
          try {
            await unloadEntry(previous)
            mounted.delete(packageName)
          } catch (error) {
            setObservation({ packageName, phase: 'error', entryId: previous.entryId, reason: 'cleanup failed after Config became unavailable' })
            warn('client extension: cleanup failed after Config became unavailable', {
              packageName,
              entryId: previous.entryId,
              error: error instanceof Error ? error.message : String(error),
            })
            continue
          }
        }
        setObservation({ packageName, phase: 'unavailable', reason: read.reason })
        continue
      }
      const identity = readCodeIdentity(loader, tuiSpecifier, parentURL)
      const previous = mounted.get(packageName)
      if (previous !== undefined) {
        // A changed file cannot be reloaded in the same PID: Node's ESM cache
        // still serves the old module. Keep the verified old entry and expose
        // the actionable state instead of faking a new version.
        if (identity === undefined) {
          // A non-file or conditional-export package cannot be byte-verified.
          // Never guess "same": the old entry stays live and the user gets the
          // conservative restart signal instead of a false ACTIVE claim.
          setObservation({
            packageName,
            phase: 'reload-required',
            entryId: previous.entryId,
            ...(knownCodeIdentity.get(packageName) === undefined ? {} : { codeIdentity: knownCodeIdentity.get(packageName) }),
            reason: 'the installed ./tui bytes cannot be verified; restart this Client to reload them',
          })
          continue
        }
        const appliedIdentity = knownCodeIdentity.get(packageName)
        if (appliedIdentity !== identity) {
          setObservation({
            packageName,
            phase: 'reload-required',
            entryId: previous.entryId,
            ...(appliedIdentity === undefined ? {} : { codeIdentity: appliedIdentity }),
            reason: 'the installed ./tui bytes differ from the running entry; restart this Client to load them',
          })
          continue
        }
        if (!sameJsonValue(previous.configValue, read.effective) || previous.configRevision !== read.revision) {
          try {
            await loader.update(previous.entryId, { config: read.effective })
            await requireActiveFiber(previous.entryId, epoch)
          } catch (error) {
            await unloadEntry(previous).catch(() => undefined)
            mounted.delete(packageName)
            setObservation({ packageName, phase: 'error', entryId: previous.entryId, reason: 'config update failed' })
            warn('client extension: config update failed', {
              packageName,
              entryId: previous.entryId,
              error: error instanceof Error ? error.message : String(error),
            })
            continue
          }
          mounted.set(packageName, {
            ...previous,
            configRevision: read.revision,
            configValue: read.effective,
          })
        }
        const applied = mounted.get(packageName)!
        setObservation({
          packageName,
          phase: 'active',
          entryId: applied.entryId,
          configRevision: applied.configRevision,
          ...(applied.codeIdentity === undefined ? {} : { codeIdentity: applied.codeIdentity }),
        })
        continue
      }

      // A package disabled earlier in this SAME process still has its old
      // module in Node's cache. Re-enabling with changed bytes must not claim
      // the new file as ACTIVE.
      if (knownCodeIdentity.has(packageName)) {
        const knownIdentity = knownCodeIdentity.get(packageName)
        if (knownIdentity === undefined || identity === undefined || knownIdentity !== identity) {
          setObservation({
            packageName,
            phase: 'reload-required',
            ...(knownIdentity === undefined ? {} : { codeIdentity: knownIdentity }),
            reason: 'the installed ./tui bytes differ from (or cannot be verified against) the code this Client already loaded; restart this Client',
          })
          continue
        }
      }

      const entryId = clientExtensionEntryId(configRowId)
      if (Object.hasOwn(loader.store, entryId)) {
        setObservation({
          packageName,
          phase: 'error',
          entryId,
          reason: `the Client entry id "${entryId}" is already owned by another Loader entry`,
        })
        continue
      }

      try {
        await (loader.create as (entry: {
          readonly id: string
          readonly name: string
          readonly config?: unknown
        }) => Promise<string>)({
          id: entryId,
          name: tuiSpecifier,
          config: read.effective,
        })
        markOwnedClientExtensionEntry(loader, entryId)
        if (!isCurrent(epoch)) {
          await discardCreatedEntry(entryId)
          return
        }
        await requireActiveFiber(entryId, epoch)
        // The Settings generation must still be the one this import started
        // from. A changed generation means the admitted Config is stale: the
        // entry is destroyed before it can publish as ACTIVE.
        const verified = config.read(packageName)
        if (verified.kind !== 'ready' || !Object.is(verified.generation, read.generation)) {
          await discardCreatedEntry(entryId)
          setObservation({
            packageName,
            phase: 'unavailable',
            reason: 'the Host Config generation changed while the Client entry was activating; refresh and retry',
          })
          continue
        }
        knownCodeIdentity.set(packageName, identity)
        mounted.set(packageName, {
          packageName,
          entryId,
          configRevision: verified.revision,
          configValue: verified.effective,
          codeIdentity: identity,
        })
        setObservation({
          packageName,
          phase: 'active',
          entryId,
          configRevision: verified.revision,
          ...(identity === undefined ? {} : { codeIdentity: identity }),
        })
      } catch (error) {
        await discardCreatedEntry(entryId)
        setObservation({
          packageName,
          phase: 'error',
          entryId,
          reason: 'the ./tui module could not be activated',
        })
        warn('client extension: ./tui activation failed', {
          packageName,
          entryId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return {
    reconcile(snapshot: PluginManagerSnapshot): Promise<void> {
      if (disposed) return Promise.reject(new Error('client extension mount owner is disposed'))
      const run = reconcileTail.then(() => reconcileNow(snapshot))
      reconcileTail = run.then(() => undefined, () => undefined)
      return run
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      reconciliation += 1
      await reconcileTail.catch(() => undefined)
      const errors: unknown[] = []
      for (const [packageName, entry] of [...mounted].reverse()) {
        try {
          await unloadEntry(entry)
          mounted.delete(packageName)
          observations.delete(packageName)
        } catch (error) {
          errors.push(error)
          setObservation({ packageName, phase: 'error', entryId: entry.entryId, reason: 'cleanup failed' })
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'client extension mount owner disposal failed')
    },
    observation(): readonly ClientExtensionObservation[] {
      return Object.freeze([...observations.values()])
    },
  }
}
