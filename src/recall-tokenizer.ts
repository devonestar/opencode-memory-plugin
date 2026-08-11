const TOKEN_RUN_PATTERN = /[\p{Script=Latin}\p{Number}]+|\p{Script=Hangul}+/gu
const HANGUL_RUN_PATTERN = /^\p{Script=Hangul}+$/u
const HANGUL_NGRAM_SIZES = [2, 3] as const

export function tokenizeDocument(text: string): readonly string[] {
  const tokens: string[] = []
  const normalized = text.normalize("NFKC").toLowerCase()
  for (const match of normalized.matchAll(TOKEN_RUN_PATTERN)) {
    const run = match[0]
    tokens.push(run)
    if (!HANGUL_RUN_PATTERN.test(run)) continue
    const codePoints = Array.from(run)
    for (const size of HANGUL_NGRAM_SIZES) {
      for (let start = 0; start + size <= codePoints.length; start += 1) {
        tokens.push(codePoints.slice(start, start + size).join(""))
      }
    }
  }
  return tokens
}

export function tokenizeQuery(text: string): readonly string[] {
  return [...new Set(tokenizeDocument(text))]
}
