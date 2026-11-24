/**
 * Runtime qualification for the pinned official JSONL persistence backend.
 *
 * The Host accepted-input history index may compare a persisted source revision
 * across Host restarts ONLY while the exact official persistence binding, its
 * actual Loader provider entry, its effective root/compression config and the
 * installed official package identity are proven to be the pinned release.
 * Every other runtime is simply unqualified and the history index keeps its
 * ordinary official replay path.
 *
 * Authority is captured at most once per full pass (or one independent point
 * replay) and is a short-lived pass object, never a service or a durable store.
 * It answers one question only: does this actual persistence binding and this
 * actual snapshot metadata allow the pinned durable-revision comparison? It
 * does not decide whether a projection is complete, whether the index is ready
 * or whether Session files may be read.
 *
 * The upstream public revision API remains instance-scoped; this module is the
 * narrow, release-qualified exception the repository accepts for derived
 * metadata.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/history-search-revision-authority
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { stableJson, type HistorySourceProofBasis } from './history-search-index.ts'

/** Cordis `FiberState.ACTIVE` (the enum is a const enum with no runtime value). */
const FIBER_ACTIVE = 2

const APP_PACKAGE = '@deepseek-ai/dsh'
const PROVIDER_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'
const SEAM_PACKAGE = '@deepseek-ai/dsh-session-persistence'
const SESSION_PACKAGE = '@deepseek-ai/dsh-session'
const SESSION_FORMAT_PACKAGE = '@deepseek-ai/dsh-session-format'

/** The only official app versions whose published JSONL package bytes are pinned. */
const SUPPORTED_DSH_VERSIONS = ['0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5'] as const

/**
 * Published package discriminator of the official provider and seam entry
 * files. The entry bytes are identical across the supported pins; the manifest
 * bytes differ per pin and live in the table below. These are bounded
 * identity checks of four installed files, not a cryptographic attestation of
 * a transitive dependency graph.
 */
const PROVIDER_ENTRY_DIGEST = '69efef5f84dddf947032bc1425067878fa610416c8885acde2ded9b01230c9b7'
const SEAM_ENTRY_DIGEST = 'cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb'

const PUBLISHED_PACKAGE_DIGESTS: Readonly<Record<string, {
  readonly providerManifest: string
  readonly seamManifest: string
}>> = {
  '0.2.2-rc.3': {
    providerManifest: '8eaaba7f1f96781d15aca7ea16396a25af0a0ce4c5e4729c51ff28eceebcdbd2',
    seamManifest: '45895439453064c271a816265dc5d81e182a7e0ac5f791b6dc5a4da15acc01a6',
  },
  '0.2.2-rc.4': {
    providerManifest: '86ee0d0a0addc86ae8f0fb56e3adfa2e133b95695381d3f4a9c7272c8f20adad',
    seamManifest: 'd93972a28f148e4fae4916f5830065687df85b05bb3986c3f29148e0a00cca29',
  },
  '0.2.2-rc.5': {
    providerManifest: 'ce8d2e8c745437a06e33ce6b4693013fcf6d05f474c0176c3fff26c8f2ea6c92',
    seamManifest: 'fc71193421409031ff138183a46b8b8bb19ddc82faeb3e4266b3a13aeb0523f4',
  },
}

/** One captured pass-scoped authority; never stored as service state. */
export interface HistoryRevisionAuthority {
  /** The exact raw persistence service instance this authority was proven against. */
  readonly service: object
  /** The official process-local persistence identity of that instance. */
  readonly identity: symbol
  /** The canonical install/config scope digest of this authority. */
  readonly scopeKey: string
  /** The effective normalized absolute persistence root. */
  readonly root: string
  /** The effective physical codec of that root. */
  readonly codec: 'none' | 'zstd'
  /** Lightweight synchronous recheck of the captured runtime binding. */
  isCurrent(): boolean
}

/**
 * The official snapshot metadata a cold source proof can be derived from. Only
 * these classified facts are consumed; this module never reads source files.
 */
export interface HistoryRevisionSnapshotLike {
  readonly formatStatus?: 'current' | 'migration-required'
  readonly location?: { readonly kind: string; readonly path: string }
  readonly revision?: unknown
}

/** The narrow official `profileContext` face this qualification consumes. */
interface ProfileContextLike {
  readonly dir: string
  readonly installAnchor: string
}

/** One resolved official package (the Loader tree's own package lookup). */
interface PluginPackageLike {
  readonly name: string
  readonly version: string | undefined
  readonly dir: string
  readonly manifestPath: string
}

/** The narrow official `pluginPackages` face this qualification consumes. */
interface PluginPackagesLike {
  readonly resolution: unknown
  packageOf(specifier: string, parentURL: string): PluginPackageLike | undefined
}

/** The narrow official Loader face this qualification consumes. */
interface LoaderLike {
  entries(): Iterable<ProviderEntryLike>
}

/** The structural Loader entry fields this qualification consumes. */
interface ProviderEntryLike {
  readonly options: { readonly name: string }
  readonly fiber?: Fiber
  readonly disabled: boolean
  readonly parent: { readonly tree: { readonly ctx: { readonly baseUrl?: string } } }
}

/** One service registration row in the Cordis reflection store. */
interface ImplLike {
  readonly name: string
  readonly value: unknown
  readonly ctx: Context
}

/** A fiber with the Loader entry augmentation applied structurally. */
type FiberWithEntry = Fiber & { readonly entry?: ProviderEntryLike }

/** The effective JSONL provider config the authority is proven against. */
interface JsonlConfigLike {
  readonly root: string
  readonly compression: 'none' | 'zstd'
}

/**
 * The REAL activation fiber of one Loader entry.
 *
 * `Entry.fiber` stores the PromiseLike wrapper returned by
 * `registry.plugin()`; that wrapper inherits from the real fiber
 * (`Object.create(fiber)` in the pinned Cordis release). The provider fiber's
 * own ancestry names the real activation fiber, so the two are compared by
 * object reference and a raw (non-wrapper) assignment is accepted as-is.
 */
function activationFiberOf(providerFiber: FiberWithEntry, entry: ProviderEntryLike): FiberWithEntry | undefined {
  let top: FiberWithEntry | undefined
  let cursor: FiberWithEntry | undefined = providerFiber
  const visited = new Set<Fiber>()
  while (cursor !== undefined && cursor.entry === entry) {
    if (visited.has(cursor)) return undefined
    visited.add(cursor)
    top = cursor
    cursor = cursor.parent?.fiber as FiberWithEntry | undefined
  }
  if (top === undefined) return undefined
  const exposed = entry.fiber as FiberWithEntry | undefined
  if (exposed === undefined) return undefined
  const prototype = Object.getPrototypeOf(exposed) as FiberWithEntry | null
  const real = prototype !== null && prototype !== exposed && (prototype as { readonly uid?: unknown }).uid !== undefined
    ? prototype
    : exposed
  return real === top ? top : undefined
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The raw service instance behind a Cordis traceable proxy. */
function serviceIdentity(value: object): object {
  return (value as { readonly [symbols.original]?: object })[symbols.original] ?? value
}

function isDirectoryStat(value: { isDirectory(): boolean }): boolean {
  return value.isDirectory()
}

function readJsonObject(bytes: Buffer): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/** One ordinary metadata boundary failure: simply "not qualified". */
class QualificationBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QualificationBoundaryError'
  }
}

/**
 * Whether one failure is an ordinary metadata/resolution boundary failure that
 * simply means "not qualified". A programmer error is rethrown instead of being
 * silently converted into an unqualified runtime.
 */
function isQualificationFailure(error: unknown): boolean {
  if (error instanceof QualificationBoundaryError || error instanceof SyntaxError) return true
  const code = (error as { readonly code?: unknown } | undefined)?.code
  if (typeof code !== 'string') return false
  return code === 'MODULE_NOT_FOUND'
    || code === 'ERR_MODULE_NOT_FOUND'
    || code === 'ENOENT'
    || code === 'EACCES'
    || code === 'EPERM'
    || code === 'ENOTDIR'
    || code === 'ELOOP'
}

/** The canonical absolute path of a resolved file, refusing a directory. */
async function canonicalFile(path: string): Promise<string> {
  const canonical = await realpath(path)
  const metadata = await stat(canonical)
  if (!metadata.isFile()) throw new QualificationBoundaryError('history revision authority: expected a regular file')
  return canonical
}

/** Whether `child` is inside `parent` by whole path segments. */
function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child)
  return relativePath !== '' && !isAbsolute(relativePath) && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
}

/**
 * Capture the pass-scoped revision authority of the official JSONL backend.
 *
 * The passed `persistence` must be the EXACT raw service the consumer Context
 * resolves; every step below is a positive fact. Missing, ambiguous or
 * differently-resolved facts yield `undefined` (normal official replay). An
 * abort propagates and an unexpected programmer error is not swallowed.
 */
export async function captureHistoryRevisionAuthority(
  ctx: Context,
  persistence: object,
  signal: AbortSignal,
): Promise<HistoryRevisionAuthority | undefined> {
  try {
    return await capture(ctx, persistence, signal)
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted()
    if (isQualificationFailure(error)) return undefined
    throw error
  }
}

async function capture(
  ctx: Context,
  persistence: object,
  signal: AbortSignal,
): Promise<HistoryRevisionAuthority | undefined> {
  signal.throwIfAborted()
  if (process.platform !== 'linux' && process.platform !== 'darwin') return undefined
  if (Number.parseInt(process.versions.node, 10) !== 24) return undefined
  const identity = (persistence as { readonly identity?: unknown }).identity
  if (typeof identity !== 'symbol') return undefined
  const rawPersistence = serviceIdentity(persistence)

  // 1. The consumer Context must resolve the SAME raw service, and the store
  // must hold exactly ONE registration of that service, whose value is that
  // same raw object.
  const resolved = ctx.reflect.get('sessionPersistence') as object | undefined
  if (resolved === undefined || serviceIdentity(resolved) !== rawPersistence) return undefined
  signal.throwIfAborted()
  const store = ctx.reflect.store as Record<symbol, ImplLike | undefined>
  const registrations: Array<{ readonly key: symbol; readonly impl: ImplLike }> = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    if (impl?.name !== 'sessionPersistence') continue
    registrations.push({ key, impl })
  }
  if (registrations.length !== 1) return undefined
  const registration = registrations[0]!
  if (registration.impl.value !== rawPersistence) return undefined
  const providerFiber = registration.impl.ctx.fiber as FiberWithEntry
  if (providerFiber.state !== FIBER_ACTIVE) return undefined

  // 2. Walk to the nearest real Loader entry and prove it is the ACTIVE,
  // enabled official JSONL provider whose activation fiber is in the provider
  // fiber's own ancestry (by object identity, never by uid/name guessing).
  let cursor: FiberWithEntry | undefined = providerFiber
  let entry: ProviderEntryLike | undefined
  const seenFibers = new Set<Fiber>()
  while (cursor !== undefined && entry === undefined) {
    // The root fiber's parent context resolves to itself; stop on a real cycle.
    if (seenFibers.has(cursor)) break
    seenFibers.add(cursor)
    entry = cursor.entry
    cursor = cursor.parent?.fiber as FiberWithEntry | undefined
  }
  if (entry === undefined || entry.options.name !== PROVIDER_PACKAGE) return undefined
  const loader = ctx.reflect.get('loader') as LoaderLike | undefined
  if (loader === undefined) return undefined
  const liveEntries = [...loader.entries()]
  if (!liveEntries.includes(entry)) return undefined
  const activationFiber = activationFiberOf(providerFiber, entry)
  if (activationFiber === undefined || activationFiber.state !== FIBER_ACTIVE) return undefined
  if (entry.disabled) return undefined

  // 3. The ACTUAL effective config of that activation fiber: a non-empty
  // absolute root and the official codec. The real root must resolve to an
  // existing directory; nothing here creates or reads a Session file.
  const effectiveConfig = activationFiber.effectiveConfig
  if (effectiveConfig === null || typeof effectiveConfig !== 'object') return undefined
  const configRoot = (effectiveConfig as { readonly root?: unknown }).root
  const compression = (effectiveConfig as { readonly compression?: unknown }).compression
  if (typeof configRoot !== 'string' || configRoot === '' || !isAbsolute(configRoot)) return undefined
  if (compression !== 'none' && compression !== 'zstd') return undefined
  signal.throwIfAborted()
  const normalizedRoot = resolve(configRoot)
  const canonicalRoot = await realpath(normalizedRoot)
  signal.throwIfAborted()
  if (!isDirectoryStat(await stat(canonicalRoot))) return undefined
  signal.throwIfAborted()

  // 4. The app anchor must be the pinned official `@deepseek-ai/dsh` release
  // and the profile directory is the canonical one the index uses.
  const resolvedProfileContext = ctx.reflect.get('profileContext') as ProfileContextLike | undefined
  if (resolvedProfileContext === undefined
    || typeof resolvedProfileContext.dir !== 'string'
    || typeof resolvedProfileContext.installAnchor !== 'string') {
    return undefined
  }
  const profileContext = serviceIdentity(resolvedProfileContext) as unknown as ProfileContextLike
  const realProfileDir = await realpath(profileContext.dir)
  signal.throwIfAborted()
  const canonicalAnchorPath = await canonicalFile(profileContext.installAnchor)
  signal.throwIfAborted()
  const appManifestBytes = await readFile(canonicalAnchorPath)
  signal.throwIfAborted()
  const appManifest = readJsonObject(appManifestBytes)
  if (appManifest?.name !== APP_PACKAGE) return undefined
  const appVersion = appManifest.version
  if (typeof appVersion !== 'string' || !SUPPORTED_DSH_VERSIONS.includes(appVersion as typeof SUPPORTED_DSH_VERSIONS[number])) {
    return undefined
  }
  const digests = PUBLISHED_PACKAGE_DIGESTS[appVersion]
  if (digests === undefined) return undefined

  // 5. The Loader's OWN package resolution must identify the actual provider
  // entry's package, and the provider manifest must be the exact same release.
  const pluginPackages = ctx.get('pluginPackages') as PluginPackagesLike | undefined
  if (pluginPackages === undefined) return undefined
  const pluginPackagesRaw = serviceIdentity(pluginPackages) as PluginPackagesLike
  const resolution = pluginPackagesRaw.resolution
  const baseUrl = entry.parent?.tree?.ctx?.baseUrl
  if (typeof baseUrl !== 'string') return undefined
  const providerPackage = pluginPackagesRaw.packageOf(entry.options.name, baseUrl)
  if (providerPackage === undefined || providerPackage.name !== PROVIDER_PACKAGE) return undefined
  signal.throwIfAborted()
  const canonicalProviderManifestPath = await canonicalFile(providerPackage.manifestPath)
  signal.throwIfAborted()
  const providerManifestBytes = await readFile(canonicalProviderManifestPath)
  signal.throwIfAborted()
  const providerManifest = readJsonObject(providerManifestBytes)
  const providerVersion = providerManifest?.version
  if (providerManifest?.name !== PROVIDER_PACKAGE || providerVersion !== appVersion) return undefined
  const canonicalProviderDir = await realpath(providerPackage.dir)
  signal.throwIfAborted()
  if (dirname(canonicalProviderManifestPath) !== canonicalProviderDir) return undefined

  const providerRequire = createRequire(canonicalProviderManifestPath)
  const canonicalProviderEntry = await canonicalFile(providerRequire.resolve(PROVIDER_PACKAGE))
  signal.throwIfAborted()
  if (!isInside(canonicalProviderDir, canonicalProviderEntry)) return undefined
  const providerEntryDigest = sha256(await readFile(canonicalProviderEntry))
  signal.throwIfAborted()
  const providerManifestDigest = sha256(providerManifestBytes)
  if (providerManifestDigest !== digests.providerManifest) return undefined
  if (providerEntryDigest !== PROVIDER_ENTRY_DIGEST) return undefined

  // 6. The persistence seam must resolve from BOTH the provider and the app
  // anchor at the same official release, and its four bounded published bytes
  // must match the pin.
  const providerSeamManifestPath = await canonicalFile(providerRequire.resolve(`${SEAM_PACKAGE}/package.json`))
  signal.throwIfAborted()
  const anchorRequire = createRequire(canonicalAnchorPath)
  const anchorSeamManifestPath = await canonicalFile(anchorRequire.resolve(`${SEAM_PACKAGE}/package.json`))
  signal.throwIfAborted()
  const providerSeamManifestBytes = await readFile(providerSeamManifestPath)
  signal.throwIfAborted()
  const anchorSeamManifestBytes = await readFile(anchorSeamManifestPath)
  signal.throwIfAborted()
  const providerSeamManifest = readJsonObject(providerSeamManifestBytes)
  const anchorSeamManifest = readJsonObject(anchorSeamManifestBytes)
  if (providerSeamManifest?.name !== SEAM_PACKAGE || providerSeamManifest.version !== appVersion) return undefined
  if (anchorSeamManifest?.name !== SEAM_PACKAGE || anchorSeamManifest.version !== appVersion) return undefined
  const seamManifestDigest = sha256(providerSeamManifestBytes)
  if (seamManifestDigest !== digests.seamManifest) return undefined
  if (sha256(anchorSeamManifestBytes) !== digests.seamManifest) return undefined
  const canonicalSeamDir = await realpath(dirname(providerSeamManifestPath))
  signal.throwIfAborted()
  const canonicalSeamEntry = await canonicalFile(providerRequire.resolve(SEAM_PACKAGE))
  signal.throwIfAborted()
  if (!isInside(canonicalSeamDir, canonicalSeamEntry)) return undefined
  if (sha256(await readFile(canonicalSeamEntry)) !== SEAM_ENTRY_DIGEST) return undefined
  signal.throwIfAborted()

  // 7. The projection's actual dependency boundary: the provider resolves the
  // official Session/format packages at the same pin (no mixed generation).
  const sessionManifestPath = await canonicalFile(providerRequire.resolve(`${SESSION_PACKAGE}/package.json`))
  signal.throwIfAborted()
  const sessionFormatManifestPath = await canonicalFile(providerRequire.resolve(`${SESSION_FORMAT_PACKAGE}/package.json`))
  signal.throwIfAborted()
  for (const [name, manifestPath] of [
    [SESSION_PACKAGE, sessionManifestPath],
    [SESSION_FORMAT_PACKAGE, sessionFormatManifestPath],
  ] as const) {
    const manifest = readJsonObject(await readFile(manifestPath))
    signal.throwIfAborted()
    if (manifest?.name !== name || manifest.version !== appVersion) return undefined
  }

  // 8. The scope digest binds every captured fact that can change projection
  // semantics. Identical content under a different install path or Node
  // version conservatively misses and rebuilds once.
  const scopeKey = sha256(Buffer.from(stableJson([
    'pitui-history-pinned-revision',
    1,
    realProfileDir,
    normalizedRoot,
    canonicalRoot,
    compression,
    APP_PACKAGE,
    appVersion,
    canonicalAnchorPath,
    providerManifest.name,
    providerVersion,
    canonicalProviderManifestPath,
    providerManifestDigest,
    providerEntryDigest,
    providerSeamManifest.name,
    providerSeamManifest.version,
    providerSeamManifestPath,
    anchorSeamManifestPath,
    seamManifestDigest,
    SEAM_ENTRY_DIGEST,
    sessionManifestPath,
    sessionFormatManifestPath,
    process.platform,
    process.arch,
    process.versions.node,
  ]), 'utf8'))

  // 9. Final synchronous recheck after every async boundary: the captured
  // runtime facts must still be the live ones before this pass may use them.
  const isCurrent = (): boolean => {
    if (ctx.reflect.get('sessionPersistence') !== undefined) {
      const current = ctx.reflect.get('sessionPersistence') as object
      if (serviceIdentity(current) !== rawPersistence) return false
      if ((current as { readonly identity?: unknown }).identity !== identity) return false
    } else {
      return false
    }
    if (ctx.reflect.store[registration.key] !== registration.impl) return false
    if (registration.impl.value !== rawPersistence) return false
    if (providerFiber.state !== FIBER_ACTIVE) return false
    if (providerFiber.entry !== entry) return false
    if (activationFiberOf(providerFiber, entry) !== activationFiber) return false
    if (activationFiber.state !== FIBER_ACTIVE) return false
    if (entry.disabled) return false
    const currentConfig = activationFiber.effectiveConfig as Partial<JsonlConfigLike> | undefined
    if (currentConfig === null || typeof currentConfig !== 'object') return false
    if (currentConfig.root !== configRoot || currentConfig.compression !== compression) return false
    const currentProfileContext = ctx.reflect.get('profileContext') as ProfileContextLike | undefined
    if (currentProfileContext === undefined) return false
    if (serviceIdentity(currentProfileContext) !== profileContext) return false
    if (currentProfileContext.dir !== profileContext.dir) return false
    if (currentProfileContext.installAnchor !== profileContext.installAnchor) return false
    const currentPackages = ctx.get('pluginPackages') as object | undefined
    if (currentPackages === undefined || serviceIdentity(currentPackages) !== pluginPackagesRaw) return false
    if (pluginPackagesRaw.resolution !== resolution) return false
    return true
  }
  if (!isCurrent()) return undefined
  signal.throwIfAborted()
  return {
    service: rawPersistence,
    identity,
    scopeKey,
    root: normalizedRoot,
    codec: compression,
    isCurrent,
  }
}

/**
 * Derive the exact persistable source basis of ONE selected official snapshot.
 *
 * This is pure metadata classification: it never stats, opens, reads or
 * resolves the source path. A missing or differently-classified fact — a live
 * record is vetoed by the Host, not here — yields `undefined`.
 */
export function sourceProofBasis(
  authority: HistoryRevisionAuthority,
  snapshot: HistoryRevisionSnapshotLike,
): HistorySourceProofBasis | undefined {
  if (!authority.isCurrent()) return undefined
  if (snapshot.formatStatus !== 'current') return undefined
  const location = snapshot.location
  if (location === undefined || location.kind !== 'jsonl') return undefined
  const revision = snapshot.revision
  if (typeof revision !== 'string' || revision === '') return undefined
  if (typeof location.path !== 'string' || !isAbsolute(location.path)) return undefined
  const normalizedPath = resolve(location.path)
  const relativePath = relative(authority.root, normalizedPath)
  if (relativePath === '' || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return undefined
  }
  const suffix = authority.codec === 'zstd' ? '.jsonl.zstd' : '.jsonl'
  if (!normalizedPath.endsWith(suffix)) return undefined
  return {
    scopeKey: authority.scopeKey,
    sourcePath: normalizedPath,
    sourceRevision: revision,
  }
}
