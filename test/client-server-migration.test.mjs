import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const MIGRATION_DOC = new URL('../docs/client-server-migration.md', import.meta.url)
const CI_WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url)

test('migration status records the completed D1 read parity gates', () => {
  const document = readFileSync(MIGRATION_DOC, 'utf8')
  assert.match(document, /M2\s+IN PROGRESS\s+\(D1 COMPLETE:[^\n]*D1\.3[^\n]*writes remain unimplemented/u)
  assert.match(document, /D1\.1 is the first M2 slice\. It is complete for the experimental read surface/u)
  assert.match(document, /D1\.2 is complete for the experimental live-session authority read shadow/u)
  assert.match(document, /## D1\.3 status — Task and presentation read parity/u)
  assert.match(document, /session\.createdAt.*session\.live.*session\.measureContext.*subagent\.descendantTree/us)
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

test('Source Mode parity smokes build the vendored pi-tui dist first', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  const build = workflow.indexOf('- name: Build vendored pi-tui before Source Mode smokes')
  const firstSmoke = workflow.indexOf('- name: Remote Session read fixture smoke')
  assert.ok(build >= 0, 'Source checks must build the private pi-tui export before importing projections')
  assert.ok(firstSmoke > build, 'the vendored pi-tui build must precede every Remote smoke')
  assert.match(
    workflow,
    /^      - name: Pi component compatibility contract\n        run: pnpm gate:pi-surface-compat$/mu,
    'the compatibility contract must remain a top-level Source checks step',
  )
})

test('D1.3 task, presentation, and closure smokes are Source Mode gates', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  for (const [name, command] of [
    ['Remote task read parity smoke', 'smoke:remote-task-read-parity'],
    ['Remote presentation/history parity smoke', 'smoke:remote-presentation-parity'],
    ['D1 closure gate', 'smoke:remote-d1-closure'],
  ]) {
    assert.match(
      workflow,
      new RegExp(`- name: ${name}\\n\\s+if: env\\.DSH_MODE == 'source'\\n\\s+run: pnpm ${command}`),
    )
  }
})
