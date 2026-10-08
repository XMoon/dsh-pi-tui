#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/pi-tui-file-reference-built-smoke — qualify the
 * PRIVATE `piTuiFileReferences` Remote endpoint against the BUILT bundle.
 *
 * `pnpm build:bundle` emits the internal app/remote composition into a
 * content-hashed chunk (`dist/runtime-<hash>.mjs`) that is not a public entry.
 * This smoke LOCATES that chunk by its actual export, imports the BUILT
 * code, composes the real Host + Client Remote runtime over the real official
 * Host services and drives the endpoint through the real in-process carrier —
 * it does not grep built JavaScript.
 *
 * Proof:
 *
 * ```text
 * Host explicit piTuiFileReferences/list descriptor is registered
 *   (ctx.typert.local.get('piTuiFileReferences/list') === the built descriptor)
 * Client explicit contribution is mounted (client.remote.piTuiFileReferences.list)
 * one bare call crosses the carrier and reaches the official provider
 * one scoped call crosses the carrier and reaches the Host scanner
 * official [] stays empty (no scanner fallback)
 * home shorthand returns an ABSOLUTE Host path
 * ```
 *
 * It fails when the Host contribution is missing (the call rejects), when the
 * Client contribution is missing (no namespace), on namespace/method drift
 * (the endpoint lookup above), or when source-mode decorator fallback would be
 * required: the built Host service carries NO `@Remote` prototype markers, so
 * only the explicit registration can serve the endpoint.
 *
 * Usage (after `pnpm build:bundle`):
 *   node --import tsx/esm scripts/pi-tui-file-reference-built-smoke.mjs
 *
 * @module pi-tui-file-reference-built-smoke
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const checks = []

function check(name, ok, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) throw new Error(`${name}${detail === '' ? '' : `: ${detail}`}`)
}

/** The standalone temp lifecycle the shared Host fixture needs (no node:test). */
function standaloneLifecycle() {
  const dirs = []
  const disposers = []
  return {
    tempDir(prefix) {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
    defer(cleanup) {
      disposers.push(cleanup)
    },
    async dispose() {
      const failures = []
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try {
          await disposers[index]()
        } catch (error) {
          failures.push(error)
        }
      }
      for (let index = dirs.length - 1; index >= 0; index -= 1) {
        rmSync(dirs[index], { recursive: true, force: true })
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'built smoke teardown failures')
    },
  }
}

/** Locate the BUILT chunk that exports the experimental Remote runtime. */
async function loadBuiltRemoteRuntime() {
  const dist = join(ROOT, 'dist')
  for (const name of readdirSync(dist).sort()) {
    if (!name.endsWith('.mjs')) continue
    const module = await import(pathToFileURL(join(dist, name)).href)
    if (typeof module.createExperimentalRemoteRuntime === 'function') {
      return { chunk: name, createExperimentalRemoteRuntime: module.createExperimentalRemoteRuntime }
    }
  }
  throw new Error('no built dist chunk exports createExperimentalRemoteRuntime — run `pnpm build:bundle` first')
}

const life = standaloneLifecycle()
const { chunk, createExperimentalRemoteRuntime } = await loadBuiltRemoteRuntime()
process.stdout.write(`built chunk: dist/${chunk}\n`)

// The shared REAL Host fixture (the same production-shaped composition the
// suites use), with the REAL `@deepseek-ai/dsh-file-reference-local` provider.
const { createRemoteApplicationHostFixture } = await import('../test/support/remote-application-fixture.ts')
const { SessionId } = await import('@deepseek-ai/dsh-session')

const host = await createRemoteApplicationHostFixture(life, 'hf1-built-preset', { fileReferences: 'local' })
let runtime
try {
  const workspace = life.tempDir('dsh-hf1-built-ws-')
  writeFileSync(join(workspace, 'notes.md'), 'notes')
  mkdirSync(join(workspace, 'dist'))
  writeFileSync(join(workspace, 'dist', 'only-scoped.js'), 'x')
  const sessionId = 'hf1-built-session'
  await host.harness.create(SessionId(sessionId), undefined, { cwd: workspace })

  runtime = await createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })

  // 1. The Host descriptor was registered EXPLICITLY by the built row.
  const descriptor = host.ctx.typert.local.get('piTuiFileReferences/list')
  check('Host descriptor registered through the explicit contribution',
    descriptor !== undefined && descriptor.id === '@xmoon76/dsh-pi-tui#piTuiFileReferences/list',
    JSON.stringify(descriptor?.id))
  check('namespace/method contract matches', descriptor.namespace === 'piTuiFileReferences' && descriptor.method === 'list')

  // 2. The Client contribution is mounted on the built Client runtime.
  const remote = runtime.client.remote.piTuiFileReferences
  check('Client contribution mounted', typeof remote?.list === 'function')
  // The SRC/decorator fallback synthesizes `src-json` codecs; the explicit
  // handwritten contribution is the only source of strict codecs, so this
  // fails if the endpoint were served by source-mode discovery.
  check('explicit strict descriptor (never the src-json decorator fallback)',
    descriptor.parameters.every(parameter => parameter.codec.mode === 'strict')
      && descriptor.result.mode === 'strict')

  // 3. A bare call crosses the carrier and reaches the OFFICIAL provider.
  const bare = await remote.list(sessionId, 'notes')
  check('bare call reaches the official provider',
    bare.ok === true && bare.value.kind === 'ok' && bare.value.items.some(item => item.path === 'notes.md'),
    JSON.stringify(bare))

  // 4. A scoped call crosses the carrier and reaches the Host scanner: the
  //    same name is invisible to the official provider (dist is excluded).
  const bareExcluded = await remote.list(sessionId, 'only-scoped')
  check('official provider excludes dist (the scoped witness is discriminating)',
    bareExcluded.ok === true && bareExcluded.value.kind === 'ok' && bareExcluded.value.items.length === 0,
    JSON.stringify(bareExcluded))
  const scoped = await remote.list(sessionId, 'dist/only')
  check('scoped call reaches the Host scanner',
    scoped.ok === true && scoped.value.kind === 'ok' && scoped.value.items.some(item => item.path === 'dist/only-scoped.js'),
    JSON.stringify(scoped))

  // 5. Official empty stays empty, and home shorthand answers absolute paths.
  const empty = await remote.list(sessionId, 'zzz-definitely-nope')
  check('authoritative official empty stays empty',
    empty.ok === true && empty.value.kind === 'ok' && empty.value.items.length === 0,
    JSON.stringify(empty))
  const home = await remote.list(sessionId, '~/')
  check('home shorthand answers absolute Host paths',
    home.ok === true && home.value.kind === 'ok' && home.value.items.length > 0
      && home.value.items.every(item => isAbsolute(item.path) && !item.path.startsWith('~')),
    JSON.stringify(home))
} finally {
  await runtime?.dispose()
  await host.dispose()
  await life.dispose()
}

process.stdout.write(`${checks.join('\n')}\n`)
process.stdout.write('pi-tui-file-reference-built-smoke: ok\n')
