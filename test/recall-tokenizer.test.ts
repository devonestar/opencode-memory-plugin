import { describe, expect, test } from "bun:test"
import { tokenizeDocument, tokenizeQuery } from "../src/recall-tokenizer"

describe("recall tokenizer", () => {
  test("normalizes NFKC and lowercase while keeping maximal Latin and number runs", () => {
    // Given compatibility-width mixed-case text with punctuation boundaries
    const text = "Ｆｏｏ42—CAFÉ 007"

    // When the document is tokenized
    const tokens = tokenizeDocument(text)

    // Then compatible Latin and number code points form normalized maximal runs
    expect(tokens).toEqual(["foo42", "café", "007"])
  })

  test("emits each Hangul run with overlapping two and three code-point n-grams", () => {
    // Given one four-code-point Hangul run
    const text = "한글기억"

    // When the document is tokenized
    const tokens = tokenizeDocument(text)

    // Then the run and every ordered overlapping n-gram are retained
    expect(tokens).toEqual(["한글기억", "한글", "글기", "기억", "한글기", "글기억"])
  })

  test("counts repeated document occurrences", () => {
    // Given repeated Latin and Hangul runs
    const text = "Alpha alpha 기억 기억"

    // When the document is tokenized
    const tokens = tokenizeDocument(text)

    // Then repeated occurrences, including run-derived occurrences, remain available to TF
    expect(tokens).toEqual(["alpha", "alpha", "기억", "기억", "기억", "기억"])
  })

  test("deduplicates normalized query tokens in first-occurrence order", () => {
    // Given repeated spellings that normalize to the same tokens
    const query = "ＡLPHA alpha 기억 기억"

    // When the query is tokenized
    const tokens = tokenizeQuery(query)

    // Then each normalized query token occurs once
    expect(tokens).toEqual(["alpha", "기억"])
  })

  test("normalizes compatibility jamo before Hangul n-gram generation", () => {
    // Given compatibility jamo with an NFKC form distinct from the source text
    const text = "ㅎㅏㄴㄱㅡㄹ"

    // When the document is tokenized
    const tokens = tokenizeDocument(text)

    // Then normalization precedes code-point n-gram generation
    expect(tokens).toEqual(["하ᄂ그ᄅ", "하ᄂ", "ᄂ그", "그ᄅ", "하ᄂ그", "ᄂ그ᄅ"])
  })

  test("returns no tokens for empty or punctuation-only text", () => {
    // Given text with no Latin, number, or Hangul runs
    const inputs = ["", "... — !!!"]

    // When each input is tokenized, then it has no searchable tokens
    expect(inputs.map(tokenizeDocument)).toEqual([[], []])
    expect(inputs.map(tokenizeQuery)).toEqual([[], []])
  })
})
