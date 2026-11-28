/**
 * Public headless entry contract for NAF-1.
 *
 * The package subpath is the compatibility surface: a consumer must be able to
 * import the typed factory from `@xmoon76/dsh-pi-tui/native-client` without
 * reaching the TUI, a second Store closure or a Host-owned service object.
 * This test pins the subpath and the factory shape; runtime business evidence
 * belongs to the integration candidate, not to this static guard.
 * @module @xmoon76/dsh-pi-tui/native-client-public-contract.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { NativeAttachOptions, NativeClient } from '../../src/app/remote-process/native-client.ts'
import { attachNativeClient } from '../../src/app/remote-process/native-client.ts'

const packageRoot = join(import.meta.dirname, '..', '..')

type AssertAssignable<A, B> = A extends B ? true : never
const _attachOptionsShape: AssertAssignable<NativeAttachOptions, {
  readonly dshAnchor: string
  readonly profile: string
  readonly packageRoot: string
  readonly expectedInstanceId?: string
  readonly signal?: AbortSignal
}> = true
const _clientShape: AssertAssignable<NativeClient, { close(): Promise<void> }> = true

test('package.json publishes one typed native-client subpath', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: string; default?: string } | string>
  }
  const entry = manifest.exports?.['./native-client']
  assert.ok(entry !== undefined && typeof entry !== 'string', 'the public subpath must exist')
  assert.equal(entry.types, './dist/native-client.d.mts')
  assert.equal(entry.default, './dist/native-client.mjs')
})

test('the headless entry exports the attach factory as a function', () => {
  assert.equal(typeof attachNativeClient, 'function')
  assert.ok(_attachOptionsShape)
  assert.ok(_clientShape)
})
