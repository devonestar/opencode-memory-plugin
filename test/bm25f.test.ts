import { describe, expect, spyOn, test } from "bun:test"
import { rankBm25f, type RecallDocument } from "../src/bm25f"
import * as recallTokenizer from "../src/recall-tokenizer"

function document(input: Partial<RecallDocument> & Pick<RecallDocument, "slug">): RecallDocument {
  return {
    scope: input.scope ?? "project",
    slug: input.slug,
    type: input.type ?? "project",
    description: input.description ?? "unused",
    body: input.body ?? "unused",
  }
}

describe("BM25F recall ranking", () => {
  test("matches an independent hand-calculated body score and drops zero scores", () => {
    // Given N=2, df=1, unit average body length, and one body occurrence
    const documents = [document({ slug: "match", body: "alpha" }), document({ slug: "miss", body: "beta" })]

    // When BM25F ranks the corpus
    const ranked = rankBm25f("alpha", documents)

    // Then IDF=ln(2), normalized TF=1, saturation=1, rounded publicly to six decimals
    expect(ranked.map(({ slug, score }) => ({ slug, score }))).toEqual([{ slug: "match", score: 0.693147 }])
  })

  test("applies slug, description, and body field weights before saturation", () => {
    // Given one occurrence in each isolated unit-length field and one non-match
    const documents = [
      document({ slug: "alpha", description: "other", body: "other" }),
      document({ slug: "description", description: "alpha", body: "other" }),
      document({ slug: "body", description: "other", body: "alpha" }),
      document({ slug: "miss", description: "other", body: "other" }),
    ]

    // When a shared query term is ranked
    const ranked = rankBm25f("alpha", documents)

    // Then weights 3, 2, and 1 produce independently calculated saturated scores
    expect(ranked.map(({ slug, score }) => ({ slug, score }))).toEqual([
      { slug: "alpha", score: 0.560489 },
      { slug: "description", score: 0.490428 },
      { slug: "body", score: 0.356675 },
    ])
  })

  test("uses b=0.75 body length normalization with hand-calculated scores", () => {
    // Given two matching bodies of lengths one and four, so average length is 2.5
    const documents = [
      document({ slug: "short", body: "alpha" }),
      document({ slug: "long", body: "alpha beta gamma delta" }),
    ]

    // When the corpus is ranked
    const ranked = rankBm25f("alpha", documents)

    // Then standard BM25F normalization and k1=1.2 yield these independent values
    expect(ranked.map(({ slug, score }) => ({ slug, score }))).toEqual([
      { slug: "short", score: 0.241631 },
      { slug: "long", score: 0.14639 },
    ])
  })

  test("finds Korean relevance through overlapping Hangul n-grams", () => {
    // Given a relevant longer Hangul run and an unrelated document
    const documents = [
      document({ slug: "relevant", body: "장기기억 관리" }),
      document({ slug: "irrelevant", body: "임시상태 관리" }),
    ]

    // When a shorter Korean query is ranked
    const ranked = rankBm25f("기억", documents)

    // Then the matching two-code-point n-gram retrieves only the relevant document
    expect(ranked.map(({ slug }) => slug)).toEqual(["relevant"])
  })

  test("deduplicates repeated query terms", () => {
    // Given one fixed corpus
    const documents = [document({ slug: "alpha-note", body: "alpha alpha" }), document({ slug: "miss", body: "beta" })]

    // When equivalent single and repeated-term queries are ranked
    const single = rankBm25f("alpha", documents)
    const repeated = rankBm25f("alpha alpha ＡLPHA", documents)

    // Then query repetition cannot multiply a document score
    expect(repeated).toEqual(single)
  })

  test("is independent of input corpus order", () => {
    // Given the same corpus in opposite orders
    const documents = [
      document({ slug: "strong", description: "alpha" }),
      document({ slug: "weak", body: "alpha" }),
      document({ slug: "miss", body: "beta" }),
    ]

    // When both corpora are ranked
    const forward = rankBm25f("alpha", documents)
    const reversed = rankBm25f("alpha", [...documents].reverse())

    // Then ranking and public scores are identical
    expect(reversed).toEqual(forward)
  })

  test("breaks raw-score ties by global scope then code-point slug order", () => {
    // Given equal-scoring documents in mixed scope and slug order
    const documents = [
      document({ scope: "project", slug: "delta", body: "alpha" }),
      document({ scope: "global", slug: "zeta", body: "alpha" }),
      document({ scope: "project", slug: "𐀀", body: "alpha" }),
      document({ scope: "project", slug: "beta", body: "alpha" }),
      document({ scope: "project", slug: "\uE000", body: "alpha" }),
    ]

    // When they are ranked
    const ranked = rankBm25f("alpha", documents)

    // Then scope precedence wins before ascending slug code points
    expect(ranked.map(({ scope, slug }) => `${scope}:${slug}`)).toEqual([
      "global:zeta",
      "project:beta",
      "project:delta",
      "project:\uE000",
      "project:𐀀",
    ])
  })

  test("returns no results for empty and punctuation-only queries", () => {
    // Given a searchable corpus
    const documents = [document({ slug: "alpha", body: "alpha" })]

    // When queries contain no searchable token, then ranking is empty
    expect(rankBm25f("", documents)).toEqual([])
    expect(rankBm25f("... — !!!", documents)).toEqual([])
  })

  test("tokenizes fields once and bounds document-frequency membership checks", () => {
    // Given instrumented token arrays for three documents and two unique query terms
    const originalTokenizeDocument = recallTokenizer.tokenizeDocument
    let membershipChecks = 0
    const tokenizeDocument = spyOn(recallTokenizer, "tokenizeDocument").mockImplementation((text) => {
      const tokens = [...originalTokenizeDocument(text)]
      const includes = tokens.includes.bind(tokens)
      tokens.includes = (term, fromIndex) => {
        membershipChecks += 1
        return includes(term, fromIndex)
      }
      return tokens
    })

    try {
      const documents = [
        document({ slug: "doc-one", description: "context-one", body: "alpha" }),
        document({ slug: "doc-two", description: "context-two", body: "omega" }),
        document({ slug: "doc-three", description: "context-three", body: "neither" }),
      ]

      // When BM25F ranks the corpus
      rankBm25f("alpha omega", documents)

      // Then one query plus three fields per document are tokenized, without a scoring-document multiplier on DF work
      expect(tokenizeDocument).toHaveBeenCalledTimes(1 + documents.length * 3)
      expect(membershipChecks).toBeLessThanOrEqual(2 * documents.length * 3)
    } finally {
      tokenizeDocument.mockRestore()
    }
  })
})
