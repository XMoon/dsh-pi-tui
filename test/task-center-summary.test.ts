import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSpans } from '../src/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'
import type { FooterItemRef } from '../src/footer/types.ts'

const registry = createBuiltinFooterRegistry()
const ref: FooterItemRef = { id: 'tasks' }
const context = { taskBrowserAvailable: true, extensionFooterText: '' }
const plain = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '')
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }
function snapshot(): StatusSnapshot {
  const value = emptyStatusSnapshot() as Mutable<StatusSnapshot>
  value.activity.taskCount = 1
  value.activity.childAgentCount = 2
  value.activity.taskTotalCount = 3
  value.activity.childAgentTotalCount = 7
  value.activity.failedTaskCount = 1
  return value as StatusSnapshot
}

test('Task Center footer shows separate running/total counts and failure attention', () => {
  const item = registry.get('tasks')!
  const segment = item.render(snapshot(), ref, 'preferred', context)
  assert.ok(segment)
  assert.equal(plain(renderSpans(segment.spans)), '[! 1 failed · ● 2/7 agents · 1/3 jobs · ↓ view]')
  const compact = item.render(snapshot(), ref, 'compact', context)
  assert.ok(compact)
  assert.equal(plain(renderSpans(compact.spans)), '[!1·●2/7a·1/3j·↓]')
})
