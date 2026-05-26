// Extracts a recognizable "edition" suffix from an album title so that
// "Abbey Road (2011 Remaster)" can be grouped with "Abbey Road" under
// the same release group. The normalized title is the user's title
// with the matched trailing parenthetical / bracketed suffix removed;
// editionLabel is a short human label for the AlbumCard badge.
//
// We only strip the LAST parenthetical/bracketed group, so a title like
// "Symphony No. 9 (Choral) (2011 Remaster)" keeps the work-identifying
// "(Choral)" and only loses the edition marker.

type EditionRule = { pattern: RegExp; label: (m: RegExpMatchArray) => string };

// Patterns are matched case-insensitively against the inner text of the
// trailing (...) or [...] group. Order matters only for "remaster" vs
// "remastered" — the more specific year-form is checked first.
const EDITION_RULES: EditionRule[] = [
  { pattern: /^(?:\d{4})\s*remaster(?:ed)?$/i, label: (m) => m[0].toLowerCase() },
  { pattern: /^remaster(?:ed)?\s*(?:\d{4})?$/i, label: () => 'remaster' },
  { pattern: /^super\s*deluxe(?:\s*edition)?$/i, label: () => 'super deluxe' },
  { pattern: /^deluxe(?:\s*edition)?$/i, label: () => 'deluxe' },
  { pattern: /^(\d+(?:st|nd|rd|th))\s*anniversary(?:\s*edition)?$/i, label: (m) => `${m[1].toLowerCase()} anniversary` },
  { pattern: /^anniversary(?:\s*edition)?$/i, label: () => 'anniversary' },
  { pattern: /^expanded(?:\s*edition)?$/i, label: () => 'expanded' },
  { pattern: /^special\s*edition$/i, label: () => 'special edition' },
  { pattern: /^collector'?s\s*edition$/i, label: () => "collector's edition" },
  { pattern: /^bonus\s*track(?:s)?(?:\s*version)?$/i, label: () => 'bonus tracks' },
  { pattern: /^re[-\s]?issue$/i, label: () => 'reissue' },
  { pattern: /^digipak$/i, label: () => 'digipak' },
  { pattern: /^mono$/i, label: () => 'mono' },
  { pattern: /^stereo$/i, label: () => 'stereo' },
  { pattern: /^explicit$/i, label: () => 'explicit' },
  { pattern: /^clean$/i, label: () => 'clean' },
  { pattern: /^live(?:\s+at\s+.+)?$/i, label: () => 'live' },
];

const TRAILING_GROUP_RE = /\s*[\(\[]([^\(\)\[\]]+)[\)\]]\s*$/;

export interface EditionParseResult {
  normalizedTitle: string;
  editionLabel: string | null;
}

export function extractEditionSuffix(title: string): EditionParseResult {
  const original = (title || '').trim();
  if (!original) return { normalizedTitle: '', editionLabel: null };

  const match = original.match(TRAILING_GROUP_RE);
  if (!match) return { normalizedTitle: original, editionLabel: null };

  const inner = match[1].trim();
  for (const rule of EDITION_RULES) {
    const m = inner.match(rule.pattern);
    if (m) {
      const normalized = original.slice(0, match.index).trim();
      return {
        normalizedTitle: normalized || original,
        editionLabel: rule.label(m),
      };
    }
  }

  return { normalizedTitle: original, editionLabel: null };
}
