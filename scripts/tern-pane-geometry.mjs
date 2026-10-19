/**
 * The geometry oracle behind the real-pane Tern driver.
 *
 * A node's own rect is NOT a visibility proof. The client clips at an overflow
 * edge, so a line whose bottom falls past its region's edge is still present in
 * the tree and unreadable on screen — the tree reports what the presenter asked
 * for, these predicates report what the client shows. They are pure (no socket,
 * no Tern binary) so the traps stay covered in the headless suite; the driver
 * and the pointer it issues are the only impure parts.
 */

/** `[x, y, width, height]`; a node the tree omits as zeroed-out has no rect. */
export const rect = (node) => node.rect ?? [0, 0, 0, 0]

/** Walk a root list into every node, plus each node's own ancestor chain. */
export function index(roots) {
  const nodes = []
  const chains = new Map()
  const walk = (list, path) => {
    for (const node of list) {
      const next = [...path, node]
      nodes.push(node)
      chains.set(node, next)
      if (node.children) walk(node.children, next)
    }
  }
  walk(roots, [])
  return { nodes, chains }
}

export const ancestorsOf = (chains, node) => (chains.get(node) ?? []).slice(0, -1)

const edge = (box, axis) => (axis === 'x' ? box[0] : box[1])
const extent = (box, axis) => (axis === 'x' ? box[2] : box[3])

/**
 * The slice of `node` that survives every clipping ancestor on `axis`. A
 * zero-sized ancestor cannot clip: the client gives it no box to clip at.
 */
function surviving(chains, node, axis) {
  const box = rect(node)
  const low = edge(box, axis)
  let start = low
  let end = low + extent(box, axis)
  for (const ancestor of ancestorsOf(chains, node)) {
    const ar = rect(ancestor)
    if (extent(ar, axis) === 0) continue
    start = Math.max(start, edge(ar, axis))
    end = Math.min(end, edge(ar, axis) + extent(ar, axis))
  }
  return { start, span: Math.max(0, end - start) }
}

/** The surviving span on `axis` (`'x'` unless asked otherwise). */
export const visibleSpan = (chains, node, axis = 'x') => surviving(chains, node, axis).span

/** Every clipping ancestor on `axis` contains this node (0.5px rounding slack). */
const within = (chains, node, axis) => {
  const box = rect(node)
  const low = edge(box, axis)
  const high = low + extent(box, axis)
  return ancestorsOf(chains, node).every((ancestor) => {
    const ar = rect(ancestor)
    if (extent(ar, axis) === 0) return true
    const aLow = edge(ar, axis)
    return low >= aLow - 0.5 && high <= aLow + extent(ar, axis) + 0.5
  })
}

/** Fully inside every clipping ancestor on the horizontal axis only. */
export const containedX = (chains, node) => within(chains, node, 'x')

/**
 * Fully inside every clipping ancestor on BOTH axes. A line that fits the
 * horizontal clip but whose bottom falls past its region is not readable, so
 * the block/line assertions use this one.
 */
export const containedXY = (chains, node) => within(chains, node, 'x') && within(chains, node, 'y')

/**
 * The centre of the fragment the client actually shows, or `undefined` when
 * less than `minSpan` pixels of it survive on EITHER axis. Both axes matter:
 * a node's own centre can fall outside the part that is on screen — into a
 * region clipped away above or below it — so a click aimed there lands on
 * whatever covers it (or on nothing) while a "reachable" claim passes.
 */
export function visiblePoint(chains, node, minSpan = 4) {
  const x = surviving(chains, node, 'x')
  const y = surviving(chains, node, 'y')
  if (x.span < minSpan || y.span < minSpan) return undefined
  return { x: x.start + x.span / 2, y: y.start + y.span / 2 }
}
