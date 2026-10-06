import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRODUCTION_SOURCE_EXTENSIONS } from './owner-modules.ts'

/**
 * The application composition surface (A5, extended by TS2).
 *
 * The Pre-M3 TS convergence (plan A5) moved the runner body out of the package
 * entry (`src/index.ts`) into the composition root (`src/app/bootstrap.ts`)
 * while `index.ts` keeps the Cordis contract and the public re-exports. TS2
 * then split the composition root into a facade plus cohesive wiring-only
 * helpers under `src/app/bootstrap/**`. Source locks that pin "where the
 * application is composed" must therefore read the WHOLE composition zone:
 * reading only `index.ts` would silently stop covering the composition the
 * moment it moves, and reading only the facade would fail as soon as a
 * responsibility lands in a helper.
 *
 * The surface is deliberately NOT a `src/app/**` glob: it is the composition
 * zone (entry + facade + bootstrap helpers), which the application owners
 * (`app/direct`, `session`, `submission`, `command`, `surface`,
 * `plugin-manager`) are CONSUMED from, never part of.
 *
 * Use it for ownership locks ("the composition owner constructs/mounts/
 * subscribes X exactly once"). Use the owning module directly for internal
 * contracts.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The composition-zone files that are not bootstrap helpers, in composition order. */
const COMPOSITION_ROOTS = ['src/index.ts', 'src/app/bootstrap.ts'] as const

/** The bootstrap composition-helper directory. */
const BOOTSTRAP_ZONE = 'src/app/bootstrap'

/**
 * The composition-surface files, in composition order: the package entry
 * first, the facade second, then every bootstrap helper sorted
 * deterministically. The helper list is read from disk, so a newly extracted
 * helper joins the surface automatically — it cannot escape the ownership
 * locks by not being listed.
 */
export function compositionFiles(): string[] {
  const helpers = readdirSync(join(ROOT, BOOTSTRAP_ZONE), { withFileTypes: true })
    .filter(entry => entry.isFile() && PRODUCTION_SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension)))
    .map(entry => `${BOOTSTRAP_ZONE}/${entry.name}`)
    .sort()
  return [...COMPOSITION_ROOTS, ...helpers]
}

/** Read one composition-surface file. Throws when it is not part of the surface. */
export function compositionFile(rel: string): string {
  if (!compositionFiles().includes(rel)) throw new Error(`${rel} is not part of the composition surface`)
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * The composition-surface contents: `[rel, source]` for every file, in
 * composition order. Every file is REQUIRED (A5a review P2): an ownership lock
 * must fail — not silently shrink its scope — if the composition root
 * disappears or is renamed.
 */
export function compositionSources(): Array<{ rel: string; source: string }> {
  return compositionFiles().map((rel) => {
    const path = join(ROOT, rel)
    if (!existsSync(path)) throw new Error(`the composition surface requires ${rel}`)
    return { rel, source: readFileSync(path, 'utf8') }
  })
}

/** The composition-surface contents joined with file banners, for order and count locks. */
export function compositionSource(): string {
  return compositionSources().map(({ rel, source }) => `// >>> ${rel}\n${source}`).join('\n')
}

/** Total occurrences of one literal across the composition surface. */
export function compositionOccurrences(literal: string): number {
  return compositionSources().reduce((total, { source }) => total + source.split(literal).length - 1, 0)
}
