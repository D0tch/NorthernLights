const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;
const SINGLE_LETTER_AMPERSAND_RE = /\b([a-z])\s*&\s*([a-z])\b/g;
const WORD_CONNECTOR_RE = /\b([a-z0-9]{2,})\s+n\s+([a-z0-9]{2,})\b/g;
const NON_WORD_RE = /[^a-z0-9_]+/g;

function normalizeUnicode(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .toLowerCase()
    .trim();
}

/**
 * Stable identity key used only for local genre duplicate review. It treats
 * word-level "and", "n", and "&" connectors as equivalent without turning
 * initialisms such as R&B into "r and b".
 */
export function normalizeGenreIdentity(value: string): string {
  let normalized = normalizeUnicode(value)
    .replace(SINGLE_LETTER_AMPERSAND_RE, '$1_amp_$2')
    .replace(/\s+&\s+/g, ' and ')
    .replace(/\s+\+\s+/g, ' and ');

  // A second pass handles short chains without using fragile look-behind.
  normalized = normalized
    .replace(WORD_CONNECTOR_RE, '$1 and $2')
    .replace(WORD_CONNECTOR_RE, '$1 and $2')
    .replace(NON_WORD_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/_amp_/g, '&');

  return normalized;
}

export function genreTokens(value: string): string[] {
  return normalizeGenreIdentity(value).split(' ').filter(Boolean);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${normalizeGenreIdentity(value)} `;
  const grams = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

export function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 && b.size === 0) return 1;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap++;
  return (2 * overlap) / Math.max(1, a.size + b.size);
}

function tokenJaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 1;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return overlap / Math.max(1, new Set([...a, ...b]).size);
}

function orderedTokenAgreement(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      table[i][j] = left[i - 1] === right[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table[left.length][right.length] / Math.max(1, left.length, right.length);
}

export interface GenreSimilarityEvidence {
  score: number;
  normalizedExact: boolean;
  trigram: number;
  tokenOverlap: number;
  orderedTokens: number;
  reasons: string[];
}

export function scoreGenreSimilarity(left: string, right: string): GenreSimilarityEvidence {
  const leftKey = normalizeGenreIdentity(left);
  const rightKey = normalizeGenreIdentity(right);
  const normalizedExact = leftKey.length > 0 && leftKey === rightKey;
  const trigram = trigramSimilarity(left, right);
  const tokenOverlap = tokenJaccard(genreTokens(left), genreTokens(right));
  const orderedTokens = orderedTokenAgreement(genreTokens(left), genreTokens(right));
  const score = normalizedExact
    ? 100
    : Math.round(Math.min(100, (trigram * 55) + (tokenOverlap * 35) + (orderedTokens * 10)));
  const reasons: string[] = [];
  if (normalizedExact) reasons.push('same normalized wording');
  else {
    if (tokenOverlap >= 0.75) reasons.push('strong word overlap');
    if (trigram >= 0.75) reasons.push('similar spelling');
    if (orderedTokens >= 0.8) reasons.push('same word order');
  }
  return { score, normalizedExact, trigram, tokenOverlap, orderedTokens, reasons };
}

export function isSlashCompoundGenre(value: string): boolean {
  return String(value || '').includes('/');
}
