/**
 * Test-only local npm registry for the S5 real-Host Plugin Manager install
 * evidence (A09 cancel window, A10 blocked-build approval).
 *
 * The fixture packs ONE audit package into a tarball with the developer's own
 * npm, then serves the npm registry metadata route and that exact tarball from
 * a loopback HTTP server. Nothing is published anywhere; no public registry,
 * credential or user store is read.
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

/** Write one package directory and pack it with the local npm. */
export function packFixturePackage(root: string, pkg: FixturePackage): PackedFixturePackage {
  const packageDir = join(root, 'fixture-package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(pkg.manifest, null, 2)}\n`)
  for (const [name, content] of Object.entries(pkg.files ?? {})) {
    const path = join(packageDir, name)
    if (name.includes('/')) mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const outDir = join(root, 'fixture-tarball')
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
  } = {},
): Promise<LocalNpmRegistryControl> {
  const tarball = readFileSync(packed.tarballPath)
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const shasum = createHash('sha1').update(tarball).digest('hex')
  const tarballName = `${packed.name.split('/')[1]}-${packed.version}.tgz`
  const tarballPath = `/${packed.name}/-/${tarballName}`
  const metadataPath = `/${packed.name}`

  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let markRequested!: () => void
  const requested = new Promise<void>(resolve => { markRequested = resolve })
  let requestedOnce = false
  let closed = false

  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (path === metadataPath) {
      const body = JSON.stringify({
        name: packed.name,
        'dist-tags': { latest: packed.version },
        versions: {
          [packed.version]: {
            ...options.manifest,
            name: packed.name,
            version: packed.version,
            dist: {
              tarball: `${registryUrl}${tarballPath}`,
              integrity,
              shasum,
            },
          },
        },
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    if (path === tarballPath) {
      if (!requestedOnce) {
        requestedOnce = true
        markRequested()
      }
      response.on('error', () => {
        // A canceled pnpm child closes its socket; the server owns no retry.
      })
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(tarball.length),
      })
      if (options.slowTarball !== true) {
        response.end(tarball)
        return
      }
      // First bytes flush the headers; the rest waits for the test. A pnpm
      // child terminated by the official cancel closes the socket first.
      response.write(tarball.subarray(0, Math.min(64, tarball.length)))
      void released.then(() => {
        if (closed) return
        finishSlow(response, tarball.subarray(64))
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
