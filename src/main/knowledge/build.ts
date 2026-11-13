import { edgesBreakingCycles } from './graph'
import { comparePairs, groups, resolvePrereq, THRESHOLDS, type MergeItem } from './merge'
import type { BuiltConcept, ConceptRow, KnowledgeRepo, MentionRow } from './repo'
import { normalizeName } from './schemas'
import { MATCH_BATCH, type MatchPair } from './tasks'

// Builds one unit's concept graph from what extraction found in its sections.

export interface BuildDeps {
  repo: KnowledgeRepo
  /** Local embeddings, one vector per text. */
  embed: (texts: string[]) => Promise<Float32Array[]>
  /** Asks the model about unclear pairs (one request per call; cached by content). */
  match: (pairs: MatchPair[]) => Promise<Map<string, boolean>>
  /** The material a section belongs to. */
  materialOf: (sectionId: number) => number
}

export interface BuildResult {
  concepts: number
  links: number
  removedLinks: number
  unresolved: number
  matchCalls: number
}

/** Book order: earlier files first, then earlier pages. */
export function position(materialId: number, page: number): number {
  return materialId * 1_000_000 + page
}

const conceptText = (name: string, definition: string): string => `${name}: ${definition}`

async function askInBatches(deps: BuildDeps, pairs: MatchPair[]): Promise<{ answers: Map<string, boolean>; calls: number }> {
  const answers = new Map<string, boolean>()
  let calls = 0
  for (let i = 0; i < pairs.length; i += MATCH_BATCH) {
    const batch = pairs.slice(i, i + MATCH_BATCH)
    for (const [id, same] of await deps.match(batch)) answers.set(id, same)
    calls++
  }
  return { answers, calls }
}

export async function buildUnitGraph(deps: BuildDeps, sessionId: number, unitId: number, sectionIds: number[]): Promise<BuildResult> {
  const { repo } = deps
  const mentions = repo.mentions(sectionIds)
  // Concepts that belong only to this unit are rebuilt from scratch; the rest of the session's concepts can absorb new mentions.
  const existing = repo.concepts(sessionId).filter((c) => {
    const units = repo.conceptUnitIds(c.id)
    return units.length > 0 && !(units.length === 1 && units[0] === unitId)
  })

  // 1. Embed every mention ("name: definition", and the name alone for prerequisite matching).
  const mentionVectors = await deps.embed(mentions.map((m) => conceptText(m.name, m.definition)))
  const mentionNameVectors = await deps.embed(mentions.map((m) => m.name))
  const existingVectors = repo.conceptVectors(sessionId, [])
  const existingNameVectors = await deps.embed(existing.map((c) => c.name))

  const fresh: MergeItem[] = mentions.map((m, i) => ({ key: `m${m.id}`, name: m.name, sectionId: m.sectionId, vector: mentionVectors[i] ?? new Float32Array() }))
  const old: MergeItem[] = existing
    .map((c) => ({ key: `c${c.id}`, name: c.name, sectionId: null, vector: existingVectors.get(c.id) ?? new Float32Array() }))
    .filter((item) => item.vector.length > 0)

  // 2. Decide which are the same: clear cases locally, unclear ones by the model.
  const { same, unclear } = comparePairs(fresh, old)
  const describe = new Map<string, { name: string; definition: string }>([
    ...mentions.map((m) => [`m${m.id}`, { name: m.name, definition: m.definition }] as const),
    ...existing.map((c) => [`c${c.id}`, { name: c.name, definition: c.definition }] as const)
  ])
  const conceptPairs: MatchPair[] = unclear.map((p, i) => ({
    id: `P${i + 1}`,
    kind: 'concept',
    a: describe.get(p.a) ?? { name: '?', definition: null },
    b: describe.get(p.b) ?? { name: '?', definition: '' }
  }))
  const first = await askInBatches(deps, conceptPairs)
  const links: [string, string][] = [...same, ...unclear.filter((_, i) => first.answers.get(`P${i + 1}`) === true).map((p) => [p.a, p.b] as [string, string])]

  // 3. Group into concepts. A group holding an existing concept extends it.
  const byKey = new Map(mentions.map((m) => [`m${m.id}`, m]))
  const clusters = groups([...fresh.map((f) => f.key), ...old.map((o) => o.key)], links)
    .map((keys) => ({
      mentions: keys.map((k) => byKey.get(k)).filter((m): m is MentionRow => m !== undefined),
      existing: keys.filter((k) => k.startsWith('c')).map((k) => Number(k.slice(1))).sort((a, b) => a - b)
    }))
    .filter((c) => c.mentions.length > 0)

  const firstPageOf = (m: MentionRow): number => Math.min(...m.pages)
  const built: BuiltConcept[] = clusters.map((cluster) => {
    const sorted = [...cluster.mentions].sort((a, b) => position(deps.materialOf(a.sectionId), firstPageOf(a)) - position(deps.materialOf(b.sectionId), firstPageOf(b)) || a.id - b.id)
    const rep = sorted[0] as MentionRow
    const pages = sorted.flatMap((m) => m.pages.map((p) => ({ materialId: deps.materialOf(m.sectionId), pageIndex: p })))
    const earliest = pages.reduce((a, b) => (position(b.materialId, b.pageIndex) < position(a.materialId, a.pageIndex) ? b : a))
    const repIndex = mentions.indexOf(rep)
    return {
      existingId: cluster.existing[0] ?? null,
      name: rep.name,
      definition: rep.definition,
      firstMaterialId: earliest.materialId,
      firstPage: earliest.pageIndex,
      pages,
      mentionIds: sorted.map((m) => m.id),
      vector: mentionVectors[repIndex] ?? new Float32Array(),
      unresolved: []
    }
  })

  // 4. Resolve prerequisite names to concepts.
  const targets = [
    ...built.map((b, i) => {
      const memberIndexes = b.mentionIds.map((id) => mentions.findIndex((m) => m.id === id))
      return {
        key: `n${i}`,
        names: b.mentionIds.map((id) => byKey.get(`m${id}`)?.name ?? '').filter((n) => n !== ''),
        nameVector: mentionNameVectors[memberIndexes[0] ?? -1] ?? new Float32Array(),
        definition: b.definition
      }
    }),
    ...existing.map((c: ConceptRow, i) => ({ key: `c${c.id}`, names: repo.conceptNames(c.id), nameVector: existingNameVectors[i] ?? new Float32Array(), definition: c.definition }))
  ]
  const prereqNames = [...new Map(mentions.flatMap((m) => m.prerequisites).map((n) => [normalizeName(n), n])).values()]
  const prereqVectors = await deps.embed(prereqNames)
  const resolved = new Map<string, string | null>()
  const prereqPairs: MatchPair[] = []
  const pairTarget = new Map<string, { name: string; key: string }>()
  prereqNames.forEach((name, i) => {
    const result = resolvePrereq(name, prereqVectors[i] ?? new Float32Array(), targets, THRESHOLDS.prereq)
    resolved.set(normalizeName(name), result.match)
    for (const candidate of result.unclear) {
      const target = targets.find((t) => t.key === candidate.key)
      if (!target) continue
      const id = `Q${prereqPairs.length + 1}`
      prereqPairs.push({ id, kind: 'prerequisite', a: { name, definition: null }, b: { name: target.names[0] ?? '', definition: target.definition } })
      pairTarget.set(id, { name, key: candidate.key })
    }
  })
  const second = await askInBatches(deps, prereqPairs)
  for (const [id, same] of second.answers) {
    const pair = pairTarget.get(id)
    // The first confirmed candidate wins (candidates are listed most similar first).
    if (pair && same && !resolved.get(normalizeName(pair.name))) resolved.set(normalizeName(pair.name), pair.key)
  }

  // 5. Links from each concept to its prerequisites.
  const prereqLinks: { concept: number; prereq: { index: number } | { existingId: number } }[] = []
  let unresolvedCount = 0
  built.forEach((b, i) => {
    const seen = new Set<string>()
    for (const id of b.mentionIds) {
      for (const name of byKey.get(`m${id}`)?.prerequisites ?? []) {
        const target = resolved.get(normalizeName(name)) ?? null
        if (target === null) {
          if (!b.unresolved.includes(name)) b.unresolved.push(name)
          unresolvedCount++
          continue
        }
        if (seen.has(target)) continue
        seen.add(target)
        if (target.startsWith('n')) {
          const index = Number(target.slice(1))
          const targetBuilt = built[index]
          // A link to a concept that extends the same existing concept is a self-link.
          if (index !== i && !(targetBuilt?.existingId !== null && targetBuilt?.existingId === b.existingId)) prereqLinks.push({ concept: i, prereq: { index } })
        } else {
          const existingId = Number(target.slice(1))
          if (existingId !== b.existingId) prereqLinks.push({ concept: i, prereq: { existingId } })
        }
      }
    }
  })

  repo.writeUnitGraph(sessionId, unitId, built, prereqLinks)

  // 6. Break loops across the whole session's graph.
  const removed = breakCycles(repo, sessionId)
  return { concepts: built.length, links: prereqLinks.length, removedLinks: removed, unresolved: unresolvedCount, matchCalls: first.calls + second.calls }
}

/** Removes links until the session's graph has no loops, recording why. Returns how many were removed. */
export function breakCycles(repo: KnowledgeRepo, sessionId: number): number {
  const concepts = new Map(repo.concepts(sessionId).map((c) => [c.id, c]))
  const pos = (id: number): number => {
    const c = concepts.get(id)
    return c ? position(c.firstMaterialId, c.firstPage) : 0
  }
  const removed = edgesBreakingCycles(repo.activeEdges(sessionId), pos)
  for (const edge of removed) {
    const concept = concepts.get(edge.concept)?.name ?? '?'
    const prereq = concepts.get(edge.prereq)?.name ?? '?'
    const reason =
      pos(edge.prereq) > pos(edge.concept)
        ? `Removed to break a loop of prerequisites: "${prereq}" first appears after "${concept}" in the book.`
        : `Removed to break a loop of prerequisites between "${concept}" and "${prereq}".`
    repo.setLink(edge.concept, edge.prereq, edge.source, 'removed-cycle', reason)
  }
  return removed.length
}
