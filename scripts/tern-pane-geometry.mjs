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

/**
 * Every ancestor of `node`, from the ROOT down to its parent.
 *
 * FAIL CLOSED: `chains` is built by {@link index} around ONE snapshot, and a node
 * from a DIFFERENT snapshot is not in it. Returning an empty list there would
 * read as "this node has no clipping ancestor" — every clipped node in a stale
 * snapshot would then look visible and clickable, which is precisely the false
 * pass this oracle exists to prevent. A node the map does not know is a caller
 * bug (mixing two snapshots), so it throws instead.
 */
export const ancestorsOf = (chains, node) => {
  const chain = chains.get(node)
  if (chain === undefined) {
    throw new TypeError('this node is not part of the snapshot these chains index: '
      + 'take the node AND the chains from the SAME snapshot() call')
  }
  return chain.slice(0, -1)
}

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

/**
 * The node's own rect along `axis`, and the part of it that survives every
 * clipping ancestor. Unlike {@link containedXY} this reports the NUMBERS, so a
 * caller can require the whole extent to be visible rather than "contained by
 * some ancestor" — a node can sit inside every recorded ancestor box and still
 * be scrolled or laid out outside the visible pane.
 */
export function visibleBox(chains, node) {
  const box = rect(node)
  const x = surviving(chains, node, 'x')
  const y = surviving(chains, node, 'y')
  return {
    rect: box,
    start: { x: x.start, y: y.start },
    span: { x: x.span, y: y.span },
  }
}

/**
 * Whether the node's ENTIRE rect survives clipping on both axes — i.e. the user
 * can see all of it, not merely part of it. `true` requires a positive size and
 * a surviving span that matches the node's own extent within rounding slack.
 */
export function fullyVisible(chains, node, slack = 0.5) {
  const { rect: box, span } = visibleBox(chains, node)
  const [width, height] = [box[2], box[3]]
  if (!(width > 0) || !(height > 0)) return false
  return span.x >= width - slack && span.y >= height - slack
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
