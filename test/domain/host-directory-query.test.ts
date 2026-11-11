/**
 * Pure Host-path syntax for the inline Session Workspace directory editor.
 *
 * These cases own the string grammar only: an editor value is split into the
 * Host level to list and the typed prefix for the Host's OWN dialect. They do
 * not prove any filesystem, Host capability or UI behaviour; the chooser and
 * panel suites own those.
 * @module @xmoon76/dsh-pi-tui/host-directory-query.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostDirectoryCandidateValue,
  hostDirectoryQuery,
  hostDirectorySeparator,
} from '../../src/domain/file-completion/host-directory-query.ts'

const POSIX_HOME = '/home/hostuser'
const WINDOWS_HOME = 'C:\\Users\\hostuser'
const UNC_HOME = '\\\\server\\share\\hostuser'

test('blank and whitespace-only values are empty, never a guessed home', () => {
  assert.deepEqual(hostDirectoryQuery('', POSIX_HOME), { kind: 'empty' })
  assert.deepEqual(hostDirectoryQuery('   ', POSIX_HOME), { kind: 'empty' })
  assert.deepEqual(hostDirectoryQuery('\t\n', WINDOWS_HOME), { kind: 'empty' })
})

test('the Host home decides the dialect instead of the Client platform', () => {
  assert.equal(hostDirectorySeparator(POSIX_HOME), '/')
  assert.equal(hostDirectorySeparator('relative-home'), '/')
  assert.equal(hostDirectorySeparator(WINDOWS_HOME), '\\')
  assert.equal(hostDirectorySeparator('C:/Users/hostuser'), '\\')
  assert.equal(hostDirectorySeparator(UNC_HOME), '\\')
})

test('a POSIX root lists itself and a trailing separator lists the typed level', () => {
  assert.deepEqual(hostDirectoryQuery('/', POSIX_HOME), {
    kind: 'absolute',
    directoryToList: '/',
    prefix: '',
    separator: '/',
  })
  assert.deepEqual(hostDirectoryQuery('/srv/work/', POSIX_HOME), {
    kind: 'absolute',
    directoryToList: '/srv/work/',
    prefix: '',
    separator: '/',
  })
})

test('a POSIX child splits into its pure-syntax parent and typed prefix', () => {
  assert.deepEqual(hostDirectoryQuery('/srv/work/pro', POSIX_HOME), {
    kind: 'absolute',
    directoryToList: '/srv/work',
    prefix: 'pro',
    separator: '/',
  })
  // A trailing space is a real name character: the value is never trimmed.
  assert.deepEqual(hostDirectoryQuery('/srv/project ', POSIX_HOME), {
    kind: 'absolute',
    directoryToList: '/srv',
    prefix: 'project ',
    separator: '/',
  })
  assert.deepEqual(hostDirectoryQuery('/数据/项目/子', POSIX_HOME), {
    kind: 'absolute',
    directoryToList: '/数据/项目',
    prefix: '子',
    separator: '/',
  })
})

test('a relative POSIX value is invalid even when a Client cwd could resolve it', () => {
  const query = hostDirectoryQuery('srv/work', POSIX_HOME)
  assert.equal(query.kind, 'invalid')
  assert.match(query.kind === 'invalid' ? query.reason : '', /absolute/u)
  // A Windows-shaped value under a POSIX Host is not an absolute Host path.
  assert.equal(hostDirectoryQuery('C:\\Users\\x', POSIX_HOME).kind, 'invalid')
})

test('a Windows drive path keeps its own separator style and splits at the parent', () => {
  assert.deepEqual(hostDirectoryQuery('C:\\Users\\hostuser', WINDOWS_HOME), {
    kind: 'absolute',
    directoryToList: 'C:\\Users',
    prefix: 'hostuser',
    separator: '\\',
  })
  assert.deepEqual(hostDirectoryQuery('C:/Users/hostuser/pro', WINDOWS_HOME), {
    kind: 'absolute',
    directoryToList: 'C:/Users/hostuser',
    prefix: 'pro',
    separator: '\\',
  })
  assert.deepEqual(hostDirectoryQuery('C:\\', WINDOWS_HOME), {
    kind: 'absolute',
    directoryToList: 'C:\\',
    prefix: '',
    separator: '\\',
  })
  assert.deepEqual(hostDirectoryQuery('C:/', WINDOWS_HOME), {
    kind: 'absolute',
    directoryToList: 'C:/',
    prefix: '',
    separator: '\\',
  })
})

test('drive-relative, root-relative and incomplete Windows values are invalid', () => {
  for (const raw of ['C:foo', 'C:', '\\foo', 'relative', 'C:Users\\x']) {
    assert.equal(hostDirectoryQuery(raw, WINDOWS_HOME).kind, 'invalid', `${raw} must not be a Host absolute path`)
  }
})

test('a complete UNC share root lists itself and only needs one more segment for a prefix', () => {
  assert.deepEqual(hostDirectoryQuery('\\\\server\\share', UNC_HOME), {
    kind: 'absolute',
    directoryToList: '\\\\server\\share',
    prefix: '',
    separator: '\\',
  })
  assert.deepEqual(hostDirectoryQuery('\\\\server\\share\\', UNC_HOME), {
    kind: 'absolute',
    directoryToList: '\\\\server\\share\\',
    prefix: '',
    separator: '\\',
  })
  assert.deepEqual(hostDirectoryQuery('\\\\server\\share\\proj', UNC_HOME), {
    kind: 'absolute',
    directoryToList: '\\\\server\\share\\',
    prefix: 'proj',
    separator: '\\',
  })
})

test('an incomplete UNC value never falls back to a Client root or current drive', () => {
  for (const raw of ['\\\\server', '\\\\path', '\\\\']) {
    assert.equal(hostDirectoryQuery(raw, UNC_HOME).kind, 'invalid', `${raw} must not be a complete UNC path`)
  }
})

test('the accepted candidate value appends the Host separator exactly once', () => {
  assert.equal(hostDirectoryCandidateValue('/srv/work', '/'), '/srv/work/')
  assert.equal(hostDirectoryCandidateValue('/srv/work/', '/'), '/srv/work/')
  assert.equal(hostDirectoryCandidateValue('C:\\Users', '\\'), 'C:\\Users\\')
  assert.equal(hostDirectoryCandidateValue('C:\\Users\\', '\\'), 'C:\\Users\\')
  assert.equal(hostDirectoryCandidateValue('C:/Users', '\\'), 'C:/Users\\')
  assert.equal(hostDirectoryCandidateValue('/srv/project ', '/'), '/srv/project /',
    'a real trailing space is part of the official path and stays before the separator')
})
