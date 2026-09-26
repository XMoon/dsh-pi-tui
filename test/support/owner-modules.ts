import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The A5b owner surface: the composition surface (plan A5 §22) PLUS the
 * application owner modules the A5b slices extract bootstrap responsibilities
 * into (`app/surface`, `app/command`, `app/submission`, `app/session`,
 * `app/direct`).
 *
 * A5b locks care about two different facts and must not conflate them:
 *
 * - **single ownership** — a tracker/controller/state machine is constructed
 *   exactly once across the whole owner surface, wherever its owner lives;
 * - **ownership LOCATION** — the construction lives in the module that owns the
 *   behaviour, not in `src/app/bootstrap.ts` (which stays composition-only).
 *
 * The list is deliberately EXPLICIT rather than a `src/app/**` glob (A5b plan
 * §8.3): a source lock must follow the authority to a named owner, and a glob
 * would let an old string search pass by scanning the whole tree.
 *
 * The list grows as slices land. Entries that do not exist yet are not listed,
 * so `ownerSources()` never silently covers a missing module: every listed
 * module is REQUIRED to exist.
 */

export type OwnerRole = 'composition' | 'owner'

export interface OwnerModule {
  readonly rel: string
  readonly role: OwnerRole
}

/** The explicit A5b owner-module set, in composition order. */
export const OWNER_MODULES: readonly OwnerModule[] = [
  { rel: 'src/index.ts', role: 'composition' },
  { rel: 'src/app/bootstrap.ts', role: 'composition' },
  // A5b-1: viewer + live-session presentation.
  { rel: 'src/app/surface/session-presentation.ts', role: 'owner' },
  { rel: 'src/app/surface/viewer-runtime.ts', role: 'owner' },
  // A5b-2: status/settings/history/client state.
  { rel: 'src/app/surface/status-runtime.ts', role: 'owner' },
  { rel: 'src/app/surface/input-history.ts', role: 'owner' },
  { rel: 'src/app/surface/settings-runtime.ts', role: 'owner' },
  // A5b-3: command authority/registration/catalog.
  // A5b-4: submission/input + local shell.
  // A5b-5: TuiApp application events.
] as const

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function read(rel: string): string {
  const path = join(ROOT, rel)
  if (!existsSync(path)) throw new Error(`the A5b owner surface requires ${rel}`)
  return readFileSync(path, 'utf8')
}

/** The owner-surface contents with each module's role, in composition order. */
export function ownerSources(): Array<OwnerModule & { source: string }> {
  return OWNER_MODULES.map((m) => ({ ...m, source: read(m.rel) }))
}

/** The owner-surface contents joined with file banners. */
export function ownerSource(): string {
  return ownerSources().map(({ rel, source }) => `// >>> ${rel}\n${source}`).join('\n')
}

/** Total occurrences of one literal across the owner surface. */
export function ownerOccurrences(literal: string): number {
  return ownerSources().reduce((total, { source }) => total + source.split(literal).length - 1, 0)
}

/** The source of one owner-surface module. Throws when it is not listed. */
export function ownerFile(rel: string): string {
  const entry = ownerSources().find((m) => m.rel === rel)
  if (!entry) throw new Error(`${rel} is not part of the A5b owner surface`)
  return entry.source
}
