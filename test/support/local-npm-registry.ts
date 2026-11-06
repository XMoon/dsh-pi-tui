/**
 * Test-only local npm registry for the S5 real-Host Plugin Manager install
 * evidence (A09 cancel window, A10 blocked-build approval).
 *
 * The fixture packs the audit package (and optionally extra published versions)
 * into tarballs with the developer's own npm, then serves the npm registry
 * metadata route and those exact tarballs from a loopback HTTP server. Nothing
 * is published anywhere; no public registry, credential or user store is read.
 * `additionalVersions` lets the official `listVersions`/`updateBundle` path read
 * a real registry upgrade; the LAST additional version is the slow/cancel target.
 *
 * `slowTarball` withholds the tarball body after the first bytes, so the real
 * pnpm child sits in a network read until the test calls `releaseTarball()`.
 * That is the deterministic cancel window: the official Host `cancelInstall`
 * must terminate the real child and restore the profile files.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the npm registry protocol pnpm reads
 * (packument + tarball + integrity), and a real `pnpm add` run inside the
 * official managed profile.
 * `TEST STAND-INS`: the loopback registry and the tiny fixture package.
 * `DELIBERATELY ABSENT`: npmjs/network credentials, third-party code, and any
 * package script other than the A10 test-owned harmless marker write.
 * @module @xmoon76/dsh-pi-tui/test/support/local-npm-registry
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'

/** One package the fixture writes and packs. `files` are relative to the
 *  package root; `manifest` is written as `package.json`. */
export interface FixturePackage {
  readonly name: string
  readonly version: string
  readonly manifest: Record<string, unknown>
  readonly files?: Readonly<Record<string, string>>
}

export interface PackedFixturePackage {
  readonly name: string
  readonly version: string
  readonly tarballPath: string
  readonly sha256: string
}

/** Write one package directory and pack it with the local npm. A caller that
 *  packs TWO versions passes distinct directories so the second `npm pack`
 *  never overwrites the first version's package/tarball. */
export function packFixturePackage(
  root: string,
  pkg: FixturePackage,
  options: { readonly directory?: string; readonly tarballDirectory?: string } = {},
): PackedFixturePackage {
  const packageDir = join(root, options.directory ?? 'fixture-package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(pkg.manifest, null, 2)}\n`)
  for (const [name, content] of Object.entries(pkg.files ?? {})) {
    const path = join(packageDir, name)
    if (name.includes('/')) mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const outDir = join(root, options.tarballDirectory ?? 'fixture-tarball')
  mkdirSync(outDir, { recursive: true })
  // `npm pack` prints the created file name; no registry/network access and no
  // lifecycle scripts run for this fixture package.
  const output = execFileSync(
    process.env.DSH_TEST_NPM_COMMAND ?? 'npm',
    ['pack', '--silent', '--pack-destination', outDir],
    { cwd: packageDir, encoding: 'utf8' },
  ).trim().split('\n').at(-1)?.trim()
  if (output === undefined || output === '') throw new Error('npm pack produced no tarball name')
  const tarballPath = join(outDir, output)
  const tarball = readFileSync(tarballPath)
  return {
    name: pkg.name,
    version: pkg.version,
    tarballPath,
    sha256: createHash('sha256').update(tarball).digest('hex'),
  }
}

/** One additional published version served beside the primary package. */
export interface AdditionalRegistryVersion {
  readonly packed: PackedFixturePackage
  /** The exact manifest merged into this version's packument entry. */
  readonly manifest?: Record<string, unknown>
  readonly publishedAt?: string
  readonly deprecated?: string
  /** Dist-tags pointing at this version (the last additional version is `latest`). */
  readonly tags?: readonly string[]
}

export interface LocalNpmRegistryControl {
  /** `http://127.0.0.1:<port>` — pass as the install registry. */
  readonly url: string
  /** The tarball's SHA-256 (the same value the fixture packed). */
  readonly tarballSha256: string
  /** Resolves when pnpm requested the tarball; the slow mode then holds it. */
  waitForTarballRequest(timeoutMs?: number): Promise<void>
  /** Let a held tarball finish. Safe when the request never arrived. */
  releaseTarball(): void
  /** Release + stop the server. */
  close(): Promise<void>
}

/**
 * Start a loopback registry for one packed package.
 *
 * `slowTarball` withholds the body until `releaseTarball()`. A real pnpm that
 * was already terminated by `cancelInstall()` simply observes a closed socket.
 */
export async function startLocalNpmRegistry(
  packed: PackedFixturePackage,
  options: {
    readonly slowTarball?: boolean
    /** The exact package manifest the fixture packed. It is merged into the
     *  packument's version entry so `pnpm view` (the official inspect path)
     *  sees `dsh.bundle` instead of a bundle-less package. */
    readonly manifest?: Record<string, unknown>
    /** Published versions newer than the primary package. The Host's
     *  `listVersions` can therefore read a real registry upgrade. */
    readonly additionalVersions?: readonly AdditionalRegistryVersion[]
  } = {},
): Promise<LocalNpmRegistryControl> {
  interface ServedVersion {
    readonly packed: PackedFixturePackage
    readonly manifest: Record<string, unknown> | undefined
    readonly publishedAt: string
    readonly deprecated?: string
    readonly tags: readonly string[]
    readonly tarball: Buffer
    readonly integrity: string
    readonly shasum: string
    readonly tarballPath: string
  }
  const served: ServedVersion[] = []
  const versions = [packed, ...(options.additionalVersions ?? []).map(version => version.packed)]
  const tarballPaths = new Map<string, string>()
  for (const entry of versions) {
    const tarball = readFileSync(entry.tarballPath)
    // A scoped name keeps its last segment; an unscoped name is its own filename.
    const baseName = entry.name.startsWith('@') ? entry.name.split('/')[1]! : entry.name
    const tarballName = `${baseName}-${entry.version}.tgz`
    const tarballPath = `/${entry.name}/-/${tarballName}`
    tarballPaths.set(`${entry.name}@${entry.version}`, tarballPath)
    const additional = (options.additionalVersions ?? []).find(candidate => candidate.packed.version === entry.version)
    served.push({
      packed: entry,
      manifest: entry === packed ? options.manifest : additional?.manifest,
      publishedAt: additional?.publishedAt ?? new Date(0).toISOString(),
      ...(additional?.deprecated === undefined ? {} : { deprecated: additional.deprecated }),
      tags: entry === packed ? [] : additional?.tags ?? [],
      tarball,
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      shasum: createHash('sha1').update(tarball).digest('hex'),
      tarballPath,
    })
  }
  const tarballByPath = new Map(served.map(version => [version.tarballPath, version]))
  // The LAST additional version is the release the slow mode withholds (the
  // update target); a single-version fixture keeps the primary behavior.
  const slowVersion = (options.additionalVersions ?? []).at(-1)?.packed.version ?? packed.version
  const slowTarballPath = tarballPaths.get(`${packed.name}@${slowVersion}`)!
  const metadataPath = `/${packed.name}`

  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let markRequested!: () => void
  const requested = new Promise<void>(resolve => { markRequested = resolve })
  let requestedOnce = false
  let closed = false

  const distTags: Record<string, string> = { latest: served.at(-1)!.packed.version }
  for (const version of served) {
    for (const tag of version.tags) distTags[tag] = version.packed.version
  }
  const time: Record<string, string> = {
    created: served[0]!.publishedAt,
    modified: served.at(-1)!.publishedAt,
  }
  for (const version of served) time[version.packed.version] = version.publishedAt

  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (path === metadataPath) {
      const body = JSON.stringify({
        name: packed.name,
        'dist-tags': distTags,
        time,
        versions: Object.fromEntries(served.map((version) => [version.packed.version, {
          ...version.manifest,
          name: packed.name,
          version: version.packed.version,
          ...(version.deprecated === undefined ? {} : { deprecated: version.deprecated }),
          dist: {
            tarball: `${registryUrl}${version.tarballPath}`,
            integrity: version.integrity,
            shasum: version.shasum,
          },
        }])),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    const servedVersion = tarballByPath.get(path)
    if (servedVersion !== undefined) {
      const slow = options.slowTarball === true && path === slowTarballPath
      if (slow && !requestedOnce) {
        requestedOnce = true
        markRequested()
      }
      response.on('error', () => {
        // A canceled pnpm child closes its socket; the server owns no retry.
      })
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(servedVersion.tarball.length),
      })
      if (!slow) {
        response.end(servedVersion.tarball)
        return
      }
      // First bytes flush the headers; the rest waits for the test. A pnpm
      // child terminated by the official cancel closes the socket first.
      response.write(servedVersion.tarball.subarray(0, Math.min(64, servedVersion.tarball.length)))
      void released.then(() => {
        if (closed) return
        finishSlow(response, servedVersion.tarball.subarray(64))
      })
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  let registryUrl = ''
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the local registry did not bind a TCP address'))
        return
      }
      registryUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })

  return {
    url: registryUrl,
    tarballSha256: packed.sha256,
    waitForTarballRequest: async (timeoutMs = 30_000) => {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        requested,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('pnpm never requested the slow fixture tarball')), timeoutMs)
          timer.unref?.()
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
    },
    releaseTarball: () => { release() },
    close: async () => {
      closed = true
      release()
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    },
  }
}

function finishSlow(response: ServerResponse, rest: Buffer): void {
  if (response.destroyed || response.writableEnded) return
  response.end(rest)
}
