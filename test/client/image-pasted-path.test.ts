/**
 * The bracketed-paste candidate grammar for an automatically attached image
 * file path. These cases pin the REAL terminal byte shapes (Tern/Hedr send an
 * absolute path plus one trailing ASCII space) and every shape the grammar
 * must refuse so a pasted command, URL or prose fragment never claims an
 * image read.
 * @module @xmoon76/dsh-pi-tui/image-pasted-path.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateImagePathFromPaste } from '../../src/client/media/image/pasted-path.ts'

test('the real Tern paste body yields its absolute path', () => {
  assert.deepEqual(
    candidateImagePathFromPaste('/home/xmoon/.cache/tern/pastes/a07fa8e58c3d1059.png '),
    { path: '/home/xmoon/.cache/tern/pastes/a07fa8e58c3d1059.png' },
  )
})

test('the real Hedr paste body yields its absolute path', () => {
  assert.deepEqual(
    candidateImagePathFromPaste('/home/liujiewei/.local/state/herdr-core/default/files/t3/herdr-paste-1793684406262098400.png '),
    { path: '/home/liujiewei/.local/state/herdr-core/default/files/t3/herdr-paste-1793684406262098400.png' },
  )
})

test('interior spaces and CJK are preserved verbatim (one path, never shell words)', () => {
  assert.deepEqual(
    candidateImagePathFromPaste('/home/用户/图片 dir/截图 2026.png '),
    { path: '/home/用户/图片 dir/截图 2026.png' },
  )
})

test('the extension match is case-insensitive for every accepted raster type', () => {
  for (const extension of ['PNG', 'Jpg', 'jpeg', 'WEBP', 'Gif']) {
    assert.deepEqual(
      candidateImagePathFromPaste(`/tmp/shot.${extension} `),
      { path: `/tmp/shot.${extension}` },
      extension,
    )
  }
})

test('no trailing separator space is not a terminal image paste', () => {
  assert.equal(candidateImagePathFromPaste('/tmp/a.png'), undefined)
})

test('a body ending with two spaces is not the terminal separator shape', () => {
  assert.equal(candidateImagePathFromPaste('/tmp/a.png  '), undefined)
})

test('a newline, CR, NUL, ESC, tab or a C1 control anywhere refuses the candidate', () => {
  for (const body of [
    '/tmp/a.png\n',
    '/tmp/a.png\r',
    '/tmp/a\0.png ',
    '/tmp/a\x1b.png ',
    '/tmp/a\tb.png ',
    // Unicode Cc: DEL and the C1 range (NEL, APC/PM/ST ...) are control
    // characters too, not path text.
    '/tmp/a\x7f.png ',
    '/tmp/a\u0085.png ',
    '/tmp/a\u009f.png ',
  ]) {
    assert.equal(candidateImagePathFromPaste(body), undefined, JSON.stringify(body))
  }
})

test('a paste that also carries prose is not a candidate', () => {
  assert.equal(candidateImagePathFromPaste('see /tmp/a.png '), undefined)
  assert.equal(candidateImagePathFromPaste('/tmp/a.png and b '), undefined)
})

test('a legal single path whose directory ends with a space keeps its interior space', () => {
  // The frozen grammar interprets the body verbatim: `/tmp/foo ` is a legal
  // directory name and `/bar.png` its file — never two shell words.
  assert.deepEqual(candidateImagePathFromPaste('/tmp/foo /bar.png '), { path: '/tmp/foo /bar.png' })
  assert.deepEqual(candidateImagePathFromPaste('/tmp/a b.png '), { path: '/tmp/a b.png' })
})

test('a directory name that itself ends with an image extension is still one path', () => {
  // The same bytes could describe two pasted paths, but the grammar never
  // splits a body into shell words: the complete body is the candidate and
  // the intake's resolve/read is the authority on whether it exists.
  assert.deepEqual(candidateImagePathFromPaste('/tmp/foo.png /bar.png '), { path: '/tmp/foo.png /bar.png' })
  assert.deepEqual(
    candidateImagePathFromPaste('/tmp/a.png /nested/b.webp '),
    { path: '/tmp/a.png /nested/b.webp' },
  )
})

test('URLs, protocol-relative URLs and non-absolute forms are refused', () => {
  for (const body of [
    'https://a/b.png ',
    '//host/b.png ',
    '~/a.png ',
    './a.png ',
    'a.png ',
    'C:\\shots\\a.png ',
    '\\\\server\\share\\a.png ',
  ]) {
    assert.equal(candidateImagePathFromPaste(body), undefined, JSON.stringify(body))
  }
})

test('non-image extensions are refused', () => {
  for (const body of ['/tmp/a.txt ', '/tmp/a.png.txt ', '/tmp/dir.png/file ', '/tmp/.png ']) {
    assert.equal(candidateImagePathFromPaste(body), undefined, JSON.stringify(body))
  }
})

test('an over-long paste is refused before any grammar work', () => {
  const body = `/tmp/${'a'.repeat(1000)}.png `
  assert.equal(candidateImagePathFromPaste(body), undefined)
})

test('an empty body is not a candidate', () => {
  assert.equal(candidateImagePathFromPaste(''), undefined)
  assert.equal(candidateImagePathFromPaste(' '), undefined)
})
