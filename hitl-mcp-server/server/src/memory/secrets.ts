/**
 * Shapes of credentials that must never leave the machine. High precision over
 * recall: a false hit keeps a memory local, a miss is still encrypted in transit.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['API key', /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Azure storage key', /AccountKey=[A-Za-z0-9+/=]{40,}/],
  ['Azure DevOps PAT', /\b[a-z2-7]{52}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['assigned secret', /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9_\-+/.]{16,}/i],
];

/** The kind of secret `text` appears to hold, or null when it looks clean. */
export function findSecret(text: string): string | null {
  for (const [kind, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}
