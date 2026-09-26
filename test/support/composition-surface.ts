import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The application composition surface.
 *
 * The Pre-M3 TS convergence (plan A5) moves the runner body out of the package
 * entry (`src/index.ts`) into the composition root (`src/app/bootstrap.ts`)
 * while `index.ts` keeps the Cordis contract and the public re-exports. Source
 * locks that pin "where the application is composed" must therefore read BOTH
 * files: reading only `index.ts` would silently stop covering the composition
 * the moment it moves, and reading only `bootstrap.ts` would fail before the
 * move. The pair is deliberately small — it is the composition owner set, not
 * the application owner set (`src/app/direct`, `session`, `submission`,
 * `command`, `surface`), which the composition surface CONSUMES.
 *
 * Use it for ownership locks ("the composition owner constructs/mounts/
 * subscribes X exactly once"). Use the owning module directly for internal
 * contracts.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The composition-surface files, in composition order (entry, then root). */
const COMPOSITION_FILES = ['src/index.ts', 'src/app/bootstrap.ts'] as const

/** Read one composition-surface file. Throws when it is missing. */
export function compositionFile(rel: (typeof COMPOSITION_FILES)[number]): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * The composition-surface contents: `[rel, source]` for every file that exists.
 * `src/index.ts` must exist; `src/app/bootstrap.ts` is absent before A5-1.
 */
export function compositionSources(): Array<{ rel: string; source: string }> {
  const out: Array<{ rel: string; source: string }> = []
  for (const rel of COMPOSITION_FILES) {
    const path = join(ROOT, rel)
    if (!existsSync(path)) continue
    out.push({ rel, source: readFileSync(path, 'utf8') })
  }
  if (out.length === 0 || out[0].rel !== 'src/index.ts') {
    throw new Error('the package entry src/index.ts must exist')
  }
  return out
}

/** The composition-surface contents joined with file banners, for order and count locks. */
export function compositionSource(): string {
  return compositionSources().map(({ rel, source }) => `// >>> ${rel}\n${source}`).join('\n')
}

/** Total occurrences of one literal across the composition surface. */
export function compositionOccurrences(literal: string): number {
  return compositionSources().reduce((total, { source }) => total + source.split(literal).length - 1, 0)
}
