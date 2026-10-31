/**
 * TSP-7 PR-D: the TSP renderer module graph carries NO command executor.
 *
 * The whole-footer command surface and the custom command items are
 * EXPLICIT_UNAVAILABLE in TSP; the structural guarantee behind that claim is
 * that the TSP renderer modules never import the PiTui footer executors (the
 * command runner, the dynamic item runtime or the ANSI composer). This is
 * the static half of the zero-execution witness; the runtime half (no
 * command output, no command string, no trust read on a hostile project
 * config) lives in test/app/tern-tsp-footer-config-direct.test.ts.
 * @module @xmoon76/dsh-pi-tui/tsp-no-command-executor.test
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const tspDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tui', 'tsp')

/** The PiTui footer executor modules a TSP module must never import. */
const FORBIDDEN_MODULES = [
  'command-runner',
  'dynamic-item-runtime',
  'runtime',
  'composer',
] as const

/** Any import statement naming one of the forbidden footer modules. */
const forbiddenImport = (source: string): string | undefined => {
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
    const specifier = match[1] ?? ''
    for (const module of FORBIDDEN_MODULES) {
      if (specifier === `../footer/${module}.ts` || specifier === `../../tui/footer/${module}.ts`) {
        return specifier
      }
    }
  }
  return undefined
}

const files = readdirSync(tspDir).filter(name => name.endsWith('.ts'))
assert.ok(files.length > 0, 'the TSP renderer directory was found')

test('no TSP renderer module imports the PiTui footer executors', () => {
  for (const name of files) {
    const specifier = forbiddenImport(readFileSync(join(tspDir, name), 'utf8'))
    assert.equal(specifier, undefined,
      `${name} imports ${specifier} — TSP renders unavailable markers, never executes a footer command`)
  }
})

test('the forbidden-import detector actually detects (self-check)', () => {
  // A no-op detector would make the gate above false assurance: prove the
  // matcher fires on each forbidden specifier shape.
  for (const module of FORBIDDEN_MODULES) {
    assert.equal(forbiddenImport(`import { x } from '../footer/${module}.ts'`), `../footer/${module}.ts`)
    assert.equal(forbiddenImport(`import { x } from '../../tui/footer/${module}.ts'`), `../../tui/footer/${module}.ts`)
  }
  assert.equal(forbiddenImport("import { x } from '../footer/builtin-items.ts'"), undefined,
    'the read-only builtin definitions stay importable')
})
