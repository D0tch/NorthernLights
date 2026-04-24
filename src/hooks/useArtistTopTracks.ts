import { useEffect, useState } from 'react';
import { fetchArtistTopTracks, type ArtistTopTrackData } from '../utils/externalImagery';

export const useArtistTopTracks = (
  artistName: string,
  options?: { enabled?: boolean; limit?: number; debounceMs?: number }
) => {
  const enabled = options?.enabled !== false;
  const limit = options?.limit ?? 25;
  const debounceMs = options?.debounceMs ?? 200;
  const [tracks, setTracks] = useState<ArtistTopTrackData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!artistName || !enabled || artistName === 'Unknown Artist') {
      setTracks([]);
      setIsLoading(false);
      return;
    }

    let mounted = true;
    const timer = setTimeout(() => {
      setIsLoading(true);
      fetchArtistTopTracks(artistName, limit)
        .then((result) => {
          if (!mounted) return;
          setTracks(result);
          setError(undefined);
        })
        .catch((err) => {
          if (!mounted) return;
          setError(err?.message || 'Failed to load popular tracks');
          setTracks([]);
        })
        .finally(() => {
          if (mounted) setIsLoading(false);
        });
    }, debounceMs);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [artistName, enabled, limit, debounceMs]);

  return { tracks, isLoading, error };
};
