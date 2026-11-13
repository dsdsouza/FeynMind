// Prerequisite graph algorithms. An edge { concept, prereq } means "concept needs prereq first".
// Positions order concepts as the book does (where each first appears); lower comes first.

export interface PrereqEdge {
  concept: number
  prereq: number
  /** Links the user made are kept in preference to extracted ones when a loop must be broken. */
  source: 'extracted' | 'user'
}

/** Groups of concepts that all depend on each other (Tarjan's algorithm). Single nodes without a self-loop are left out. */
export function cycles(nodes: Iterable<number>, edges: PrereqEdge[]): number[][] {
  const next = new Map<number, number[]>()
  for (const e of edges) next.set(e.concept, [...(next.get(e.concept) ?? []), e.prereq])
  let counter = 0
  const index = new Map<number, number>()
  const low = new Map<number, number>()
  const stack: number[] = []
  const onStack = new Set<number>()
  const groups: number[][] = []

  // Iterative depth-first search, so a long chain of prerequisites cannot overflow the call stack.
  for (const root of nodes) {
    if (index.has(root)) continue
    const work: { node: number; child: number }[] = [{ node: root, child: 0 }]
    index.set(root, counter)
    low.set(root, counter++)
    stack.push(root)
    onStack.add(root)
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: number; child: number }
      const children = next.get(frame.node) ?? []
      if (frame.child < children.length) {
        const child = children[frame.child++] as number
        if (!index.has(child)) {
          index.set(child, counter)
          low.set(child, counter++)
          stack.push(child)
          onStack.add(child)
          work.push({ node: child, child: 0 })
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(child) ?? 0))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0))
      if (low.get(frame.node) === index.get(frame.node)) {
        const group: number[] = []
        for (;;) {
          const member = stack.pop() as number
          onStack.delete(member)
          group.push(member)
          if (member === frame.node) break
        }
        if (group.length > 1) groups.push(group.sort((a, b) => a - b))
      }
    }
  }
  return groups
}

/**
 * Edges to remove so that no loops remain. In each loop the link removed is the one pointing
 * furthest forward in the book (the prerequisite first appears latest after the concept that
 * needs it), since a book usually teaches prerequisites first. Extracted links go before links
 * the user made.
 */
export function edgesBreakingCycles(edges: PrereqEdge[], position: (concept: number) => number): PrereqEdge[] {
  let active = [...edges]
  const removed: PrereqEdge[] = []
  const nodes = new Set(edges.flatMap((e) => [e.concept, e.prereq]))
  for (;;) {
    const loops = cycles(nodes, active)
    if (loops.length === 0) return removed
    for (const loop of loops) {
      const members = new Set(loop)
      const inLoop = active.filter((e) => members.has(e.concept) && members.has(e.prereq))
      const worst = inLoop.sort(
        (a, b) =>
          Number(a.source === 'user') - Number(b.source === 'user') ||
          position(b.prereq) - position(b.concept) - (position(a.prereq) - position(a.concept)) ||
          b.concept - a.concept ||
          b.prereq - a.prereq
      )[0]
      if (!worst) continue
      removed.push(worst)
      active = active.filter((e) => e !== worst)
    }
  }
}

/** Whether adding "concept needs prereq" would make a loop: true if prereq already needs concept, directly or not. */
export function wouldMakeCycle(edges: PrereqEdge[], concept: number, prereq: number): boolean {
  if (concept === prereq) return true
  const next = new Map<number, number[]>()
  for (const e of edges) next.set(e.concept, [...(next.get(e.concept) ?? []), e.prereq])
  const seen = new Set<number>()
  const todo = [prereq]
  while (todo.length > 0) {
    const node = todo.pop() as number
    if (node === concept) return true
    if (seen.has(node)) continue
    seen.add(node)
    todo.push(...(next.get(node) ?? []))
  }
  return false
}

/**
 * Learning order: every concept after its prerequisites (among `nodes`), and otherwise in book
 * order. Edges to concepts outside `nodes` are ignored. The graph must have no loops.
 */
export function learningOrder(nodes: number[], edges: PrereqEdge[], position: (concept: number) => number): number[] {
  const inSet = new Set(nodes)
  const waitingFor = new Map<number, number>(nodes.map((n) => [n, 0]))
  const dependents = new Map<number, number[]>()
  for (const e of edges) {
    if (!inSet.has(e.concept) || !inSet.has(e.prereq)) continue
    waitingFor.set(e.concept, (waitingFor.get(e.concept) ?? 0) + 1)
    dependents.set(e.prereq, [...(dependents.get(e.prereq) ?? []), e.concept])
  }
  const order: number[] = []
  const ready = nodes.filter((n) => waitingFor.get(n) === 0)
  const byPosition = (a: number, b: number): number => position(a) - position(b) || a - b
  while (ready.length > 0) {
    ready.sort(byPosition)
    const node = ready.shift() as number
    order.push(node)
    for (const d of dependents.get(node) ?? []) {
      const left = (waitingFor.get(d) ?? 0) - 1
      waitingFor.set(d, left)
      if (left === 0) ready.push(d)
    }
  }
  if (order.length !== nodes.length) throw new Error('The prerequisite graph has a loop; it should have been broken first.')
  return order
}
