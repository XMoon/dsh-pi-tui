import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const MIGRATION_DOC = new URL('../docs/client-server-migration.md', import.meta.url)
const CI_WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url)

test('migration status records verified D1.1 and D1.2 parity gates', () => {
  const document = readFileSync(MIGRATION_DOC, 'utf8')
  assert.match(document, /M2\s+IN PROGRESS\s+\(D1\.1 DONE:[^\n]*D1\.2 DONE:[^\n]*writes remain unimplemented/u)
  assert.match(document, /D1\.1 is the first M2 slice\. It is complete for the experimental read surface/u)
  assert.match(document, /D1\.2 is complete for the experimental live-session authority read shadow/u)
  assert.doesNotMatch(document, /D1\.1 IN PROGRESS/u)
  assert.doesNotMatch(document, /D1\.1 is now in progress/iu)
})

test('D1.2 authority smoke is restricted to the Source Mode lane', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  assert.match(
    workflow,
    /- name: Remote command\/skill authority parity smoke\n\s+if: env\.DSH_MODE == 'source'\n\s+run: pnpm smoke:remote-surface-authority-parity/u,
  )
})
