/**
 * Test-owned temporary-directory lifecycle: every fixture root created
 * through here is disposed by the TestContext that created it, so a test
 * file never leaks `dsh-*` directories into the system temp root even when
 * run standalone. Teardown runs in two phases: ALL resource disposers
 * registered via `defer()` execute first (reverse registration order),
 * and only then are the temp directories removed (reverse creation
 * order) — on Windows a directory held open cannot be removed, so the
 * disposers-before-removal ordering is part of the contract regardless of
 * the order in which `tempDir` and `defer` were called.
 *
 * Set `DSH_TEST_KEEP_TMP=1` to keep (and print) the fixture roots for
 * debugging; deletion is the default and must stay the default.
 * @module @xmoon76/dsh-pi-tui/test/support/temp-lifecycle
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

/** A teardown action; may be async and may return anything. */
export type Cleanup = () => unknown

/** Per-test lifecycle: temp directories plus deferred resource disposers, all owned by one test. */
export interface TestLifecycle {
  /** Create a test-owned temp directory under `os.tmpdir()`; removed (recursively, forced) at teardown. */
  tempDir(prefix: string): string
  /** Register a resource disposer; disposers run in reverse registration order, always BEFORE any temp-dir removal. */
  defer(cleanup: Cleanup): void
}

/** `DSH_TEST_KEEP_TMP` is evaluated at teardown time so callers can toggle it around a subtest. */
function keepTmp(): boolean {
  return process.env.DSH_TEST_KEEP_TMP === '1'
}

function assertSafePrefix(prefix: string): void {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError(`tempDir prefix must be a non-empty string, got ${JSON.stringify(prefix)}`)
  }
  if (prefix === '.' || prefix === '..' || prefix.includes('/') || prefix.includes('\\') || prefix.includes('\0')) {
    throw new TypeError(`tempDir prefix must be a plain basename prefix without path components, got ${JSON.stringify(prefix)}`)
  }
}

/**
 * Bind a disposer stack to one test: when the test finishes — whether it
 * passed, failed an assertion, or threw — every `defer` runs in reverse
 * registration order, then every `tempDir` root is removed in reverse
 * creation order. Cleanup failures are never swallowed: the first error
 * (aggregated when several) propagates through `t.after` so the suite/gate
 * sees the leak instead of silently keeping the directory.
 */
export function testLifecycle(t: TestContext): TestLifecycle {
  const disposers: Cleanup[] = []
  const tempDirs: string[] = []
  t.after(async () => {
    const failures: unknown[] = []
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        await disposers[i]()
      } catch (error) {
        failures.push(error)
      }
    }
    for (let i = tempDirs.length - 1; i >= 0; i--) {
      try {
        const dir = tempDirs[i]
        if (keepTmp()) {
          process.stderr.write(`[temp-lifecycle] keeping ${dir} (DSH_TEST_KEEP_TMP=1)\n`)
          continue
        }
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'test lifecycle cleanup failed')
  })
  return {
    tempDir(prefix) {
      assertSafePrefix(prefix)
      const dir = mkdtempSync(join(tmpdir(), prefix))
      tempDirs.push(dir)
      return dir
    },
    defer(cleanup) {
      disposers.push(cleanup)
    },
  }
}
