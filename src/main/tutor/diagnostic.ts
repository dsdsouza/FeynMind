// Choosing the diagnostic's next question. It starts from prerequisites: a concept is asked about
// only once all its prerequisites are known. A correct answer also counts for the concept's
// prerequisites (inferred known); a miss stops that branch, marking every concept that depends on
// it as new without asking (inferred new). Among the concepts that can be asked, the one with
// the most undecided concepts depending on it goes first, since its answer decides the most.

export interface ProbeNode {
  id: number
  /** Prerequisites among the concepts being probed; others are ignored. */
  prerequisites: number[]
}

/** At most this many questions in one diagnostic. */
export const DIAGNOSTIC_MAX_QUESTIONS = 15

export interface ProbeStatus {
  known: Set<number>
  unknown: Set<number>
  /** The next concept to ask about, or null when the diagnostic is over. */
  next: number | null
}

/** All concepts reachable from `start` by following `edges` (not including `start`). */
export function reachable(start: number, edges: Map<number, number[]>): Set<number> {
  const seen = new Set<number>()
  const todo = [...(edges.get(start) ?? [])]
  while (todo.length > 0) {
    const node = todo.pop() as number
    if (seen.has(node)) continue
    seen.add(node)
    todo.push(...(edges.get(node) ?? []))
  }
  return seen
}

export function graphEdges(nodes: ProbeNode[]): { prereqsOf: Map<number, number[]>; dependentsOf: Map<number, number[]> } {
  const ids = new Set(nodes.map((n) => n.id))
  const prereqsOf = new Map<number, number[]>()
  const dependentsOf = new Map<number, number[]>()
  for (const n of nodes) {
    const prereqs = n.prerequisites.filter((p) => ids.has(p) && p !== n.id)
    prereqsOf.set(n.id, prereqs)
    for (const p of prereqs) dependentsOf.set(p, [...(dependentsOf.get(p) ?? []), n.id])
  }
  return { prereqsOf, dependentsOf }
}

/**
 * What the answers so far say, and what to ask next. `nodes` are in syllabus and learning order;
 * `answers` maps each concept asked about to whether the answer was correct.
 */
export function probeStatus(nodes: ProbeNode[], answers: Map<number, boolean>, maxQuestions = DIAGNOSTIC_MAX_QUESTIONS): ProbeStatus {
  const { prereqsOf, dependentsOf } = graphEdges(nodes)
  const known = new Set<number>()
  const unknown = new Set<number>()
  for (const [id, correct] of answers) {
    if (correct) {
      known.add(id)
      for (const p of reachable(id, prereqsOf)) known.add(p)
    }
  }
  for (const [id, correct] of answers) {
    if (correct) continue
    unknown.add(id)
    for (const d of reachable(id, dependentsOf)) if (!known.has(d)) unknown.add(d)
  }
  // A direct answer always wins over an inference.
  for (const [id, correct] of answers) (correct ? unknown : known).delete(id)

  if (answers.size >= maxQuestions) return { known, unknown, next: null }
  const undecided = (id: number): boolean => !known.has(id) && !unknown.has(id)
  let next: number | null = null
  let best = -1
  for (const n of nodes) {
    if (!undecided(n.id) || answers.has(n.id)) continue
    if (!(prereqsOf.get(n.id) ?? []).every((p) => known.has(p))) continue
    const decides = [...reachable(n.id, dependentsOf)].filter(undecided).length
    if (decides > best) {
      best = decides
      next = n.id
    }
  }
  return { known, unknown, next }
}
