import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleWidth } from '@xmoon76/pi-tui'
import { compileView } from '../src/extension/internal/component-compiler.ts'

test('CompiledFrame abdicates below three cells and caches by effective outer width', () => {
  const frame = compileView({
    kind: 'frame',
    width: 99,
    child: { kind: 'text', spans: [{ text: '界', tone: 'accent' }] },
  })
  for (const width of [1, 2]) {
    const rows = frame.component.render(width)
    assert.equal(rows.length, 0)
    assert.ok(rows.every(row => visibleWidth(row) <= width))
  }
  const minimum = frame.component.render(3)
  assert.ok(minimum.length > 0)
  assert.ok(minimum.every(row => visibleWidth(row) <= 3))
  const wider = frame.component.render(4)
  assert.ok(wider.length > 0)
  assert.ok(wider.every(row => visibleWidth(row) <= 4))
})
