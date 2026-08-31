import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function createFixture({ version, englishDate = '2026-08-28', chineseDate = englishDate, guidance = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-release-notes-'))
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

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true })
}

test('release-notes accepts stable v tags and next-v prerelease tags', () => {
  const stable = createFixture({ version: '1.2.3' })
  try {
    const result = run(stable, 'v1.2.3')
    assert.equal(result.status, 0, result.stderr)
    const body = readFileSync(stable.output, 'utf8')
    assert.match(body, /^## 中文/m)
    assert.match(body, /^## English/m)
  } finally {
    cleanup(stable)
  }

  const next = createFixture({ version: '1.2.3-alpha.1' })
  try {
    const result = run(next, 'next-v1.2.3-alpha.1')
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(next.output, 'utf8'), /English migration note\./)
  } finally {
    cleanup(next)
  }
})

test('current 0.4 prerelease guidance remains under Unreleased', () => {
  const changelogs = [
    readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'),
    readFileSync(join(repo, 'CHANGELOG.en.md'), 'utf8'),
  ]
  const unreleased = changelog => {
    const start = changelog.indexOf('## [Unreleased]')
    const nextHeading = changelog.indexOf('\n## [', start + 1)
    return changelog.slice(start, nextHeading === -1 ? changelog.length : nextHeading)
  }
  const body = changelogs.map(unreleased).join('\n')
  assert.doesNotMatch(changelogs[0], /^## \[0\.4\.0-alpha\.1\]/mu)
  assert.doesNotMatch(changelogs[1], /^## \[0\.4\.0-alpha\.1\]/mu)
  for (const command of [
    '@deepseek-ai/dsh@0.1.2-alpha.2',
    '@xmoon76/dsh-pi-tui@next',
    '@xmoon76/dsh-pi-tui@0.3',
  ]) {
    assert.ok(body.includes(command), `Unreleased guidance is missing ${command}`)
  }

  const output = join(tmpdir(), `dsh-pi-tui-release-notes-${process.pid}.md`)
  try {
    const result = spawnSync(
      process.execPath,
      [join(repo, 'scripts/release-notes.mjs'), 'next-v0.4.0-alpha.1', output],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Version 0\.4\.0-alpha\.1 not found/u)
  } finally {
    rmSync(output, { force: true })
  }
})

test('0.4 release guidance follows the stable or next tag channel', () => {
  const prereleaseGuidance = '\n- @deepseek-ai/dsh@0.1.2-alpha.2\n- @xmoon76/dsh-pi-tui@next\n- @xmoon76/dsh-pi-tui@0.3'
  const stableWithPrereleaseGuidance = createFixture({ version: '0.4.0', guidance: prereleaseGuidance })
  try {
    const result = run(stableWithPrereleaseGuidance, 'v0.4.0')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /@deepseek-ai\/dsh@0\.1\.2/u)
  } finally {
    cleanup(stableWithPrereleaseGuidance)
  }

  const stableGuidance = '\n- @deepseek-ai/dsh@0.1.2\n- @xmoon76/dsh-pi-tui@latest\n- @xmoon76/dsh-pi-tui@0.3'
  const stable = createFixture({ version: '0.4.0', guidance: stableGuidance })
  try {
    const result = run(stable, 'v0.4.0')
    assert.equal(result.status, 0, result.stderr)
  } finally {
    cleanup(stable)
  }
})

test('release-notes guidance matching rejects near-miss package versions', () => {
  const fixture = createFixture({
    version: '0.4.0-alpha.1',
    guidance: '\n- @deepseek-ai/dsh@0x1.2-alpha.1\n- @xmoon76/dsh-pi-tui@next\n- @xmoon76/dsh-pi-tui@0.3',
  })
  try {
    const result = run(fixture, 'next-v0.4.0-alpha.1')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must document @deepseek-ai\/dsh@0\.1\.2-alpha\.2/u)
  } finally {
    cleanup(fixture)
  }
})

test('release-notes rejects bilingual heading/date mismatch', () => {
  const fixture = createFixture({ version: '1.2.3', chineseDate: '2026-08-28', englishDate: '2026-08-29' })
  try {
    const result = run(fixture, 'v1.2.3')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Changelog headings do not match/)
  } finally {
    cleanup(fixture)
  }
})

test('release-notes rejects malformed or channel-inconsistent tags', () => {
  const fixture = createFixture({ version: '1.2.3' })
  try {
    for (const input of ['next-v1.2.3', 'v1.2.3-alpha.1', 'release-v1.2.3']) {
      const result = run(fixture, input)
      assert.notEqual(result.status, 0, `${input} unexpectedly passed`)
    }
  } finally {
    cleanup(fixture)
  }
})
