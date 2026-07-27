export type SecretMatch = {
  readonly kind: string
}

type SecretPattern = {
  readonly kind: string
  readonly re: RegExp
}

const PATTERNS: readonly SecretPattern[] = [
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "private-key-pem", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "openai-token", re: /\bsk-(?:(?:proj|live)-)?[A-Za-z0-9_-]{16,}\b/ },
  { kind: "uri-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
  { kind: "assigned-secret", re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?token)\b\s*[:=]\s*['"]?[^\s'";]{8,}/i },
]

const HIGH_ENTROPY_RE = /[A-Za-z0-9+/]{40,}={0,2}/
const HIGH_ENTROPY_MIN_BITS = 4.0

/**
 * Defense-in-depth only: pattern scanning cannot prove that content is secret-free.
 */
export function scanForSecret(content: string): SecretMatch | null {
  for (const p of PATTERNS) {
    if (p.re.test(content)) return { kind: p.kind }
  }
  const hit = content.match(HIGH_ENTROPY_RE)
  if (hit !== null && shannonBitsPerChar(hit[0]) >= HIGH_ENTROPY_MIN_BITS) {
    return { kind: "high-entropy-string" }
  }
  return null
}

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const c of counts.values()) {
    const p = c / s.length
    bits -= p * Math.log2(p)
  }
  return bits
}
