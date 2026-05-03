import { useMemo } from 'react';
import { usePlayerStore } from '../store/index';
import { normalizeArtistIdentityKey } from '../utils/artistUtils';

/**
 * Memoized Set of canonical-identity keys for every artist row in the store.
 * Pass into `parseArtistsForDisplay` to enable artist-aware ` & ` splitting
 * (so `Tony Bennett & Lady Gaga` becomes two chips, while `Nik & Jay` stays
 * whole because the joined name is itself a known artist).
 */
export function useKnownArtistKeys(): Set<string> {
  const artists = usePlayerStore(state => state.artists);
  return useMemo(() => {
    const set = new Set<string>();
    for (const a of artists) {
      const key = normalizeArtistIdentityKey(a.name);
      if (key) set.add(key);
    }
    return set;
  }, [artists]);
}
