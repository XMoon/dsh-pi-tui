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
 * The span on `axis` that the clip ancestors still let through. A zero-sized
 * ancestor cannot clip: the client gives it no box to clip at.
 */
export function visibleSpan(chains, node, axis = 'x') {
  const box = rect(node)
  let low = edge(box, axis)
  let high = low + extent(box, axis)
  for (const ancestor of ancestorsOf(chains, node)) {
    const ar = rect(ancestor)
    if (extent(ar, axis) === 0) continue
    low = Math.max(low, edge(ar, axis))
    high = Math.min(high, edge(ar, axis) + extent(ar, axis))
  }
  return Math.max(0, high - low)
}

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
 * The midpoint of the fragment the client actually shows, or `undefined` when
 * less than `minSpan` pixels of it survive: clicking a node's own centre would
 * click whatever sits on top of the clipped part, which is how a "reachable"
 * claim passes while the user cannot reach it.
 */
export function visiblePoint(chains, node, minSpan = 4) {
  const box = rect(node)
  const width = visibleSpan(chains, node, 'x')
  if (width < minSpan) return undefined
  let left = box[0]
  for (const ancestor of ancestorsOf(chains, node)) {
    const ar = rect(ancestor)
    if (extent(ar, 'x') === 0) continue
    left = Math.max(left, ar[0])
  }
  return { x: left + width / 2, y: box[1] + box[3] / 2 }
}
