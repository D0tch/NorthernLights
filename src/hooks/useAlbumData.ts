import { useState, useEffect } from 'react';
import { fetchAlbumData } from '../utils/externalImagery';

interface AlbumDataState {
  description: string | undefined;
  tags: string[] | undefined;
  listeners: string | undefined;
  playcount: string | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export const useAlbumData = (
  albumName: string,
  artistName: string,
  mbAlbumId?: string | null,
  options?: { enabled?: boolean }
): AlbumDataState => {
  const enabled = options?.enabled !== false;
  const [description, setDescription] = useState<string | undefined>();
  const [tags, setTags] = useState<string[] | undefined>();
  const [listeners, setListeners] = useState<string | undefined>();
  const [playcount, setPlaycount] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!albumName || !artistName || !enabled) {
      setIsLoading(false);
      return;
    }

    let mounted = true;
    setDescription(undefined);
    setTags(undefined);
    setListeners(undefined);
    setPlaycount(undefined);
    setError(undefined);
    setIsLoading(true);

    fetchAlbumData(albumName, artistName, mbAlbumId)
      .then(data => {
        if (mounted) {
          setDescription(data.description);
          setTags(data.tags);
          setListeners(data.listeners);
          setPlaycount(data.playcount);
        }
      })
      .catch(err => {
        if (mounted) setError(err?.message || 'Failed to load album data');
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    return () => { mounted = false; };
  }, [albumName, artistName, mbAlbumId, enabled]);

  return { description, tags, listeners, playcount, isLoading, error };
};
