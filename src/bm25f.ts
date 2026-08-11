import type { MemoryType } from "./frontmatter"
import type { MemoryScope } from "./gate"
import { tokenizeDocument, tokenizeQuery } from "./recall-tokenizer"

export type RecallDocument = {
  readonly scope: MemoryScope
  readonly slug: string
  readonly type: MemoryType
  readonly description: string
  readonly body: string
}

export type RankedRecallDocument = RecallDocument & {
  readonly score: number
}

const FIELDS = [
  { name: "slug", weight: 3, b: 0 },
  { name: "description", weight: 2, b: 0.3 },
  { name: "body", weight: 1, b: 0.75 },
] as const
const K1 = 1.2
const PUBLIC_SCORE_SCALE = 1_000_000

type SearchField = (typeof FIELDS)[number]["name"]
type FieldStatistics = {
  readonly length: number
  readonly occurrences: ReadonlyMap<string, number>
}
type TokenizedDocument = {
  readonly source: RecallDocument
  readonly fields: Readonly<Record<SearchField, FieldStatistics>>
}
type ScoredDocument = {
  readonly document: RecallDocument
  readonly rawScore: number
}

function fieldStatistics(text: string): FieldStatistics {
  const tokens = tokenizeDocument(text)
  const occurrences = new Map<string, number>()
  for (const token of tokens) {
    occurrences.set(token, (occurrences.get(token) ?? 0) + 1)
  }
  return { length: tokens.length, occurrences }
}

function averageFieldLength(corpus: readonly TokenizedDocument[], field: SearchField): number {
  return corpus.reduce((total, document) => total + document.fields[field].length, 0) / corpus.length
}

function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  const sharedLength = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const leftCodePoint = leftPoints[index]?.codePointAt(0) ?? -1
    const rightCodePoint = rightPoints[index]?.codePointAt(0) ?? -1
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint
  }
  return leftPoints.length - rightPoints.length
}

function compareScoredDocuments(left: ScoredDocument, right: ScoredDocument): number {
  if (left.rawScore !== right.rawScore) return right.rawScore - left.rawScore
  if (left.document.scope !== right.document.scope) return left.document.scope === "global" ? -1 : 1
  return compareCodePointStrings(left.document.slug, right.document.slug)
}

export function rankBm25f(query: string, documents: readonly RecallDocument[]): readonly RankedRecallDocument[] {
  const terms = tokenizeQuery(query)
  if (terms.length === 0 || documents.length === 0) return []

  const corpus: readonly TokenizedDocument[] = documents.map((source) => ({
    source,
    fields: {
      slug: fieldStatistics(source.slug),
      description: fieldStatistics(source.description),
      body: fieldStatistics(source.body),
    },
  }))
  const averageLengths: Readonly<Record<SearchField, number>> = {
    slug: averageFieldLength(corpus, "slug"),
    description: averageFieldLength(corpus, "description"),
    body: averageFieldLength(corpus, "body"),
  }
  const documentFrequencies = new Map<string, number>()
  for (const term of terms) {
    const frequency = corpus.reduce(
      (total, candidate) =>
        total + (FIELDS.some(({ name }) => candidate.fields[name].occurrences.has(term)) ? 1 : 0),
      0,
    )
    documentFrequencies.set(term, frequency)
  }

  const scored: ScoredDocument[] = []
  for (const document of corpus) {
    let rawScore = 0
    for (const [term, documentFrequency] of documentFrequencies) {
      const idf = Math.log(1 + (corpus.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      let normalizedFieldTf = 0
      for (const { name, weight, b } of FIELDS) {
        const occurrences = document.fields[name].occurrences.get(term) ?? 0
        if (occurrences === 0) continue
        const lengthRatio = document.fields[name].length / averageLengths[name]
        normalizedFieldTf += weight * occurrences / (1 - b + b * lengthRatio)
      }
      rawScore += idf * ((K1 + 1) * normalizedFieldTf) / (K1 + normalizedFieldTf)
    }
    if (rawScore > 0) scored.push({ document: document.source, rawScore })
  }

  return scored.sort(compareScoredDocuments).map(({ document, rawScore }) => ({
    ...document,
    score: Math.round(rawScore * PUBLIC_SCORE_SCALE) / PUBLIC_SCORE_SCALE,
  }))
}
