import type { LoudnessData } from './loudness';

// Client-side loudness cache. Each entry holds BOTH scopes so switching
// track/album mode is instant (no refetch). Values from GET /api/loudness.

export interface TrackLoudnessEntry {
  track: LoudnessData | null; // null = server has no measurement yet
  album: LoudnessData | null;
}

const cache = new Map<string, TrackLoudnessEntry>();
const inflight = new Map<string, Promise<void>>();

/** undefined = never fetched; entry (with possibly-null fields) = fetched. */
export function getCachedLoudness(id: string): TrackLoudnessEntry | undefined {
  return cache.get(id);
}

/** Drop a cached entry so the next fetch re-queries (used for the delayed retry
 *  after the server has had time to measure a not-yet-measured track). */
export function invalidateLoudness(id: string): void {
  cache.delete(id);
}

/**
 * Fetch loudness for the given ids, caching results. Only requests ids not
 * already cached or in flight. Failures leave ids uncached so a later call
 * retries. Resolves once the in-flight request for the requested ids settles.
 */
export async function fetchLoudness(ids: string[], authHeaders: Record<string, string>): Promise<void> {
  const missing = ids.filter((id) => id && !cache.has(id) && !inflight.has(id));
  if (missing.length === 0) return;

  const p = fetch(`/api/loudness?ids=${missing.map(encodeURIComponent).join(',')}`, { headers: authHeaders })
    .then((r) => (r.ok ? r.json() : {}))
    .then((data: Record<string, { track: LoudnessData | null; album: LoudnessData | null } | null>) => {
      for (const id of missing) {
        const e = data[id];
        cache.set(id, { track: e?.track ?? null, album: e?.album ?? null });
      }
    })
    .catch(() => { /* leave uncached so a later attempt retries */ })
    .finally(() => missing.forEach((id) => inflight.delete(id)));

  missing.forEach((id) => inflight.set(id, p));
  return p;
}
