import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A4 surface-ownership locks (plan §18/§20).
 *
 * These are SOURCE locks: the ownership claim is "the runner owns no surface
 * construction / no surface lifetime, and the surface owner reads no Host
 * business service and no Direct wiring". Behaviour is covered by the runner
 * integration suites; these locks pin the dependency direction so a later edit
 * cannot silently move construction or Host coupling back.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const indexSource = read('src/index.ts')

/** Every TypeScript source under `src/app/surface`. */
function surfaceSources(): Array<{ rel: string; source: string }> {
  const out: Array<{ rel: string; source: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      out.push({ rel: relative(ROOT, path), source: readFileSync(path, 'utf8') })
    }
  }
  walk(join(ROOT, 'src', 'app', 'surface'))
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

test('A4: the runner owns no surface construction or mount', () => {
  // The mounted TuiApp, the status store and the opening journal are constructed
  // by the surface owner — never in the runner.
  assert.doesNotMatch(indexSource, /\bstartProcessTui\(/u,
    'the runner must not mount the process TUI directly (SurfaceRuntime.start owns the mount)')
  assert.doesNotMatch(indexSource, /new StatusStore\(/u,
    'the runner must not construct the status store (the surface owner owns the instance)')
  assert.doesNotMatch(indexSource, /new ImageLoader\(/u,
    'the runner must not construct the image loader (the surface owner builds the option wiring)')
  assert.match(indexSource, /createSurfaceRuntime<SessionEvent>\(/u,
    'the runner must create the surface owner')
  assert.match(indexSource, /surface\.start\(\{/u,
    'the runner must mount through the surface owner')
  // A4-5 surface-owned constructions (plan §14/§20).
  assert.doesNotMatch(indexSource, /new SurfaceHost\(/u,
    'the runner must not construct the extension surface host')
  assert.doesNotMatch(indexSource, /new PluginManagerController\(/u,
    'the runner must not construct the Plugin Manager controller')
  assert.doesNotMatch(indexSource, /new PluginManagerPanel\(/u,
    'the runner must not construct a Plugin Manager panel')
  assert.doesNotMatch(indexSource, /new PluginManagerHostRegistry\(/u,
    'the runner must not construct the Plugin Manager host registry')
  assert.match(indexSource, /surface\.attachPluginManager\(\{ port: backend\.pluginManager, diag \}\)/u,
    'the runner must attach the Plugin Manager owner through the surface')
})

test('A4: the mounted TuiApp has exactly one lifetime owner', () => {
  // The runner borrows the mounted reference; only the surface owner releases it.
  assert.match(indexSource, /app = surface\.app/u, 'the runner borrows the mounted app from the surface owner')
  assert.doesNotMatch(indexSource, /app\?\.dispose\(\)/u, 'the runner must not dispose the mounted app')
  assert.doesNotMatch(indexSource, /app\.dispose\(\)/u, 'the runner must not dispose the mounted app')
})

test('A4: app/surface reads no Host business service and no Direct wiring', () => {
  const sources = surfaceSources()
  assert.ok(sources.length > 0, 'src/app/surface must exist')
  for (const { rel, source } of sources) {
    assert.doesNotMatch(source, /ctx\s*\.\s*get\(/u,
      `${rel}: the surface owner must consume injected capabilities, never a Host service lookup`)
    assert.doesNotMatch(source, /from '[^']*(?:\/|^)(?:app\/direct|runtime\/direct)\//u,
      `${rel}: the surface owner must not import Direct wiring`)
    assert.doesNotMatch(source, /new Direct[A-Za-z0-9_]*\(/u,
      `${rel}: the surface owner must not construct a Direct semantic adapter`)
  }
})

test('A4: the opening journal instance is surface-owned', () => {
  // The concrete state lives in the surface module; the runner only reads the
  // surface owner's instance (A4-1 module, A4-2 instance).
  assert.match(indexSource, /surface\.openingJournal\./u,
    'the runner must drive the opening journal through the surface owner')
  assert.doesNotMatch(indexSource, /createOpeningJournal</u,
    'the runner must not create the opening journal instance')
  const journal = read('src/app/surface/opening-journal.ts')
  assert.match(journal, /export function createOpeningJournal</u, 'the surface module owns the journal implementation')
})
