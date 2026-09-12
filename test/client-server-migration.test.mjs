import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const MIGRATION_DOC = new URL('../docs/client-server-migration.md', import.meta.url)

test('migration status records verified D1.1 parity and release-family gates', () => {
  const document = readFileSync(MIGRATION_DOC, 'utf8')
  assert.match(document, /M2\s+IN PROGRESS\s+\(D1\.1 DONE:[^\n]*same-Host parity and release-family gates verified/u)
  assert.match(document, /D1\.1 is the first M2 slice\. It is complete for the experimental read surface/u)
  assert.doesNotMatch(document, /D1\.1 IN PROGRESS/u)
  assert.doesNotMatch(document, /D1\.1 is now in progress/iu)
})
