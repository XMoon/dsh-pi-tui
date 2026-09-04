import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { testLifecycle } from './support/temp-lifecycle.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function createFixture(life, { version, englishDate = '2026-08-28', chineseDate = englishDate, guidance = '' }) {
  const root = life.tempDir('dsh-pi-tui-release-notes-')
  const output = join(root, 'release-notes.md')
  const packageJson = join(root, 'package.json')
  const chinese = join(root, 'CHANGELOG.md')
  const english = join(root, 'CHANGELOG.en.md')

  cpSync(join(repo, 'scripts/release-context.mjs'), join(root, 'release-context.mjs'))
  cpSync(join(repo, 'scripts/release-notes.mjs'), join(root, 'release-notes.mjs'))
  writeFileSync(packageJson, `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version }, null, 2)}\n`)
  writeFileSync(chinese, `# 更新日志\n\n## [Unreleased]\n\n## [${version}] - ${chineseDate}\n\n### 变更\n\n- 中文迁移说明。${guidance}\n`)
  writeFileSync(english, `# Changelog\n\n## [Unreleased]\n\n## [${version}] - ${englishDate}\n\n### Changes\n\n- English migration note.${guidance}\n`)
  return { root, output, packageJson, chinese, english }
}

function run(fixture, input) {
  return spawnSync(
    process.execPath,
    [join(fixture.root, 'release-notes.mjs'), input, fixture.output],
    { cwd: fixture.root, encoding: 'utf8' },
  )
}

test('release-notes accepts stable v tags and next-v prerelease tags', (t) => {
  const life = testLifecycle(t)
  const stable = createFixture(life, { version: '1.2.3' })
  const result = run(stable, 'v1.2.3')
  assert.equal(result.status, 0, result.stderr)
  const body = readFileSync(stable.output, 'utf8')
  assert.match(body, /^## 中文/m)
  assert.match(body, /^## English/m)

  const next = createFixture(life, { version: '1.2.3-alpha.1' })
  const nextResult = run(next, 'next-v1.2.3-alpha.1')
  assert.equal(nextResult.status, 0, nextResult.stderr)
  assert.match(readFileSync(next.output, 'utf8'), /English migration note\./)
})

test('current 0.4.1 release body carries the DSH/TUI install pairing', () => {
  // The PUBLISHED stable 0.4.1 line documents its rc.1 target while the
  // peer floor stays rc.1; the release body must carry the copy-paste
  // install commands. (This test validates the live repository state, so it
  // follows the current package.json version — the historical prerelease
  // pairings are pinned by the fixture-based tests below.)
  const output = join(tmpdir(), `dsh-pi-tui-release-notes-${process.pid}.md`)
  try {
    const result = spawnSync(
      process.execPath,
      [join(repo, 'scripts/release-notes.mjs'), 'v0.4.1', output],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const body = readFileSync(output, 'utf8')
    for (const command of [
      '@deepseek-ai/dsh@0.1.2-rc.1',
      '@xmoon76/dsh-pi-tui@0.4.1',
      '@xmoon76/dsh-pi-tui@0.3',
    ]) {
      assert.ok(body.includes(command), `release body is missing ${command}`)
    }
    assert.doesNotMatch(body, /@xmoon76\/dsh-pi-tui@(latest|next)/u)
  } finally {
    rmSync(output, { force: true })
  }
})

test('0.4 release guidance pins the exact release TUI version', (t) => {
  const life = testLifecycle(t)
  // A fixture on the alpha.4 floor (any 0.4 prerelease after 0.4.0-alpha.1)
  // must document the latest validated alpha.5 pin and the exact prerelease
  // package version. The stable 0.4.0 cutover must pin its own package version
  // and must not retain prerelease-only guidance.
  const prereleaseGuidance = '\n- @deepseek-ai/dsh@0.1.2-alpha.5\n- @xmoon76/dsh-pi-tui@0.4.0-alpha.2\n- @xmoon76/dsh-pi-tui@0.3'
  const futurePrerelease = createFixture(life, { version: '0.4.0-alpha.2', guidance: prereleaseGuidance })
  try {
    const accepted = run(futurePrerelease, 'next-v0.4.0-alpha.2')
    assert.equal(accepted.status, 0, accepted.stderr)
    const stableWithPrereleaseGuidance = createFixture(life, { version: '0.4.0', guidance: prereleaseGuidance })
    try {
      const result = run(stableWithPrereleaseGuidance, 'v0.4.0')
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /@deepseek-ai\/dsh@0\.1\.2-rc\.1/u)
    } finally {
      // testLifecycle cleans the fixture roots.
    }
  } finally {
    // testLifecycle cleans the fixture roots.
  }

  const stableGuidance = '\n- @deepseek-ai/dsh@0.1.2-rc.1\n- @xmoon76/dsh-pi-tui@0.4.0\n- @xmoon76/dsh-pi-tui@0.3'
  const stable = createFixture(life, { version: '0.4.0', guidance: stableGuidance })
  const stableResult = run(stable, 'v0.4.0')
  assert.equal(stableResult.status, 0, stableResult.stderr)
})

test('0.4.1 stable guidance pins the published rc.1 DSH family', (t) => {
  const life = testLifecycle(t)
  const guidance = '\n- @deepseek-ai/dsh@0.1.2-rc.1\n- @xmoon76/dsh-pi-tui@0.4.1\n- @xmoon76/dsh-pi-tui@0.3'
  const stable = createFixture(life, { version: '0.4.1', guidance })
  const result = run(stable, 'v0.4.1')
  assert.equal(result.status, 0, result.stderr)
})

test('release-notes guidance matching rejects near-miss package versions', (t) => {
  const life = testLifecycle(t)
  const fixture = createFixture(life, {
    version: '0.4.0-alpha.1',
    guidance: '\n- @deepseek-ai/dsh@0.1.2-alpha.3\n- @xmoon76/dsh-pi-tui@next\n- @xmoon76/dsh-pi-tui@0.3',
  })
  const result = run(fixture, 'next-v0.4.0-alpha.1')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must document @xmoon76\/dsh-pi-tui@0\.4\.0-alpha\.1/u)
})

test('release-notes rejects bilingual heading/date mismatch', (t) => {
  const life = testLifecycle(t)
  const fixture = createFixture(life, { version: '1.2.3', chineseDate: '2026-08-28', englishDate: '2026-08-29' })
  const result = run(fixture, 'v1.2.3')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Changelog headings do not match/)
})

test('release-notes rejects malformed or channel-inconsistent tags', (t) => {
  const life = testLifecycle(t)
  const fixture = createFixture(life, { version: '1.2.3' })
  for (const input of ['next-v1.2.3', 'v1.2.3-alpha.1', 'release-v1.2.3']) {
    const result = run(fixture, input)
    assert.notEqual(result.status, 0, `${input} unexpectedly passed`)
  }
})
