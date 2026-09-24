/**
 * Retired message-source vocabulary must not be MANUFACTURED by an active
 * harness. Native V4 source admission rejects the retired catch-all
 * `plugin` kind, so a current smoke that fixtures one proves parity against
 * data the real runtime never produces. Typed tests are caught by
 * typecheck; this scan covers the JS harnesses (scripts/*.mjs) that no
 * compiler sees. Historical/negative-test usage in test fixtures remains
 * legitimate — this file only scans active scripts.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const RETIRED_SOURCE_KIND = /source:\s*\{[^}]*kind:\s*['"]plugin['"]/u
const offenders = []
test('no active script manufactures the retired plugin message-source kind', () => {
  for (const name of readdirSync(SCRIPTS_DIR)) {
    if (!name.endsWith('.mjs')) continue
    const source = readFileSync(join(SCRIPTS_DIR, name), 'utf8')
    if (RETIRED_SOURCE_KIND.test(source)) offenders.push(name)
  }
  assert.deepEqual(offenders, [],
    'active harnesses must fixture current-official (or unknown-producer) source kinds')
})
