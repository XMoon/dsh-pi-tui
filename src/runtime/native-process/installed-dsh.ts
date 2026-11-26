/**
 * The installed `@deepseek-ai/dsh` anchor and module-closure primitives shared
 * by the platform-native loaders.
 *
 * A real Direct launcher entry (`process.argv[1]`) identifies its own installed
 * DSH package and always wins over an inherited environment anchor: a shell or
 * tool child of a Split Host inherits SPLIT_PROCESS_DSH_ANCHOR, but a Direct
 * `dsh` CLI started from it must use the installation executing that CLI. A
 * caller that already holds the official profile's `installAnchor` may supply
 * it explicitly (the Direct composition does); only a Split Host/Client entry,
 * whose argv[1] is the product's own local-host/local-client script, falls back
 * to the launcher-verified SPLIT_PROCESS_DSH_ANCHOR. No NODE_PATH, profile
 * node_modules or source tree is consulted.
 *
 * Module lookup must prove the resolved dependency belongs to its owner's
 * installation closure: npm keeps sibling dependencies in the owner's nearest
 * `node_modules`; pnpm keeps every package in a shared virtual store (`.mise`
 * in the mise install and `.pnpm` in a project install). Any other ancestor
 * `node_modules` is an accidental hoist and must not supply a dependency.
 *
 * @module runtime/native-process/installed-dsh
 */

import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, sep } from 'node:path'

/** One installed `@deepseek-ai/dsh` manifest, or undefined when the path is
 * unreadable, malformed, or belongs to another package. The name check is
 * load-bearing: `createRequire` would otherwise walk into an unrelated ancestor
 * `node_modules` and silently borrow a dependency that does not belong to the
 * running DSH installation. */
export function installedDshManifest(path: string): string | undefined {
  try {
    const real = realpathSync(path)
    const manifest: unknown = JSON.parse(readFileSync(real, 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
    const record = manifest as Record<string, unknown>
    return record.name === '@deepseek-ai/dsh'
      && typeof record.version === 'string'
      && record.version !== ''
      ? real
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The installed `@deepseek-ai/dsh/package.json` this process runs on.
 * @param explicitAnchor - an already-resolved official profile install anchor;
 *   when provided and valid it outranks the launcher and environment anchors.
 */
export function installedDshAnchor(explicitAnchor?: string): string | undefined {
  if (explicitAnchor !== undefined && explicitAnchor !== '') {
    const provided = installedDshManifest(explicitAnchor)
    if (provided !== undefined) return provided
  }
  const entry = process.argv[1]
  if (entry !== undefined) {
    try {
      let dir = dirname(realpathSync(entry))
      for (let depth = 0; depth < 8; depth += 1) {
        const anchor = installedDshManifest(join(dir, 'package.json'))
        if (anchor !== undefined) return anchor
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      // Unreadable launcher path: try the Split launcher anchor next.
    }
  }
  const provided = process.env.SPLIT_PROCESS_DSH_ANCHOR
  return provided !== undefined && provided !== '' ? installedDshManifest(provided) : undefined
}

/** The nearest `node_modules` directory above a package directory. */
function nearestModuleRoot(packageDir: string): string | undefined {
  for (let dir = packageDir; ; dir = dirname(dir)) {
    if (basename(dir) === 'node_modules') return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Whether `path` is `root` or below it. */
function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

/** Prove a resolved dependency belongs to its owner's installation closure. */
export function assertInstallClosure(ownerDir: string, dependencyDir: string, label: string): void {
  const nearest = nearestModuleRoot(ownerDir)
  if (nearest !== undefined && isInside(dependencyDir, nearest)) return
  for (let dir = ownerDir; ; dir = dirname(dir)) {
    if ((basename(dir) === '.mise' || basename(dir) === '.pnpm') && isInside(dependencyDir, dir)) return
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`installed DSH module: ${label} resolved outside the installed DSH module tree`)
}

/** Read one JSON package manifest as an object, or undefined when unreadable. */
export function readManifestObject(path: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(realpathSync(path), 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
    return manifest as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Require one dependency declaration from an owner manifest. */
export function assertDeclaredDependency(manifest: Record<string, unknown>, name: string, label: string): void {
  const dependencies = manifest.dependencies
  const declared = dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
    ? (dependencies as Record<string, unknown>)[name]
    : undefined
  if (typeof declared !== 'string' || declared === '') {
    throw new Error(`installed DSH module: ${label} does not declare ${name}`)
  }
}

/** Require one peer declaration from an owner manifest. */
export function assertDeclaredPeerDependency(manifest: Record<string, unknown>, name: string, label: string): void {
  const peerDependencies = manifest.peerDependencies
  const declared = peerDependencies !== null && typeof peerDependencies === 'object' && !Array.isArray(peerDependencies)
    ? (peerDependencies as Record<string, unknown>)[name]
    : undefined
  if (typeof declared !== 'string' || declared === '') {
    throw new Error(`installed DSH module: ${label} does not declare ${name} as a peer`)
  }
}

/**
 * Resolve the Koffi entry owned by the running DSH installation:
 * DSH anchor -> `@deepseek-ai/dsh-subprocess-local` manifest -> that package's
 * own `koffi` dependency. The TUI never resolves Koffi from its own package, a
 * profile, or an ambient module path.
 *
 * The owner's declared dependency selects the implementation; this code does
 * not pin or compare a Koffi version, because the running DSH installation owns
 * that choice and an upgrade must not be rejected only for a different version
 * number. The ABI/struct-size checks in the platform bridge decide actual
 * compatibility.
 */
export function resolveDshKoffi(anchor: string): string {
  const manifest = installedDshManifest(anchor)
  if (manifest === undefined) {
    throw new Error('native process identity: the DSH anchor is not an installed @deepseek-ai/dsh manifest')
  }
  const dshDir = dirname(manifest)
  const subprocessManifest = realpathSync(
    createRequire(manifest).resolve('@deepseek-ai/dsh-subprocess-local/package.json'),
  )
  const subprocessDir = dirname(subprocessManifest)
  assertInstallClosure(dshDir, subprocessDir, '@deepseek-ai/dsh-subprocess-local')
  const subprocess = readManifestObject(subprocessManifest)
  if (subprocess?.name !== '@deepseek-ai/dsh-subprocess-local') {
    throw new Error('native process identity: the resolved subprocess manifest is not @deepseek-ai/dsh-subprocess-local')
  }
  assertDeclaredDependency(subprocess, 'koffi', '@deepseek-ai/dsh-subprocess-local')
  const koffiEntry = realpathSync(createRequire(subprocessManifest).resolve('koffi'))
  assertInstallClosure(subprocessDir, dirname(koffiEntry), 'koffi')
  const koffi = readManifestObject(join(dirname(koffiEntry), 'package.json'))
  if (koffi?.name !== 'koffi') {
    throw new Error('native process identity: the resolved koffi is not the koffi package')
  }
  return koffiEntry
}
