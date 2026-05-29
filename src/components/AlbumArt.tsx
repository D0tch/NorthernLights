import React, { useState, useEffect, useRef } from 'react';
import { fetchAlbumImage } from '../utils/externalImagery';
import { Disc3 } from 'lucide-react';
import { useInView } from '../hooks/useInView';

interface AlbumArtProps {
  artUrl?: string;
  artist?: string;
  album?: string;
  size?: number;
  className?: string;
}

const AlbumArt: React.FC<AlbumArtProps> = ({ artUrl, artist, album, size = 300, className = '' }) => {
  const [localError, setLocalError] = useState(false);
  const [fetchedArtUrl, setFetchedArtUrl] = useState<string | undefined>();
  const [externalFailed, setExternalFailed] = useState(false);
  const fetchAttempted = useRef(false);
  const [ref, inView] = useInView();

  // Reset all state when artUrl changes so fresh art is attempted
  useEffect(() => {
    setLocalError(false);
    setFetchedArtUrl(undefined);
    setExternalFailed(false);
    fetchAttempted.current = false;
  }, [artUrl]);

  // Fetch external art when local art is missing or errored (once only)
  useEffect(() => {
    if (!inView) return;
    if (fetchAttempted.current) return;
    if ((!artUrl || localError) && album && artist) {
      fetchAttempted.current = true;
      let mounted = true;
      fetchAlbumImage(album, artist)
        .then(url => {
          if (mounted && url) {
            setFetchedArtUrl(url);
          }
        })
        .catch(() => {});
      return () => { mounted = false; };
    }
  }, [inView, artUrl, localError, album, artist]);

  // Determine which URL to show: local first, external fallback
  let activeUrl: string | undefined;
  if (artUrl && !localError) {
    activeUrl = artUrl;
  } else if (fetchedArtUrl && !externalFailed) {
    activeUrl = fetchedArtUrl;
  }

  // For server-served covers (/api/art), request the smallest pre-encoded size
  // that still looks crisp at this display size. This is where the decoded-
  // bitmap memory win lands: a grid of thumbnails decodes 256px covers, not the
  // full-resolution embedded art. External proxied images are left untouched.
  const sizeBucket = size <= 256 ? 256 : size <= 640 ? 640 : 1024;
  const displaySrc = activeUrl && activeUrl.includes('/api/art') && !/[?&]size=/.test(activeUrl)
    ? `${activeUrl}&size=${sizeBucket}`
    : activeUrl;

  const handleError = () => {
    if (activeUrl === artUrl) {
      setLocalError(true);
    } else {
      // External image also failed — give up, show fallback icon
      setExternalFailed(true);
    }
  };

  return (
    <div
      ref={ref}
      className={`relative overflow-hidden bg-[var(--glass-bg)] rounded-sm ${className}`}
    >
      {displaySrc ? (
        <img
          src={displaySrc}
          alt={artist ? `${artist} album artwork` : 'Album artwork'}
          className="w-full h-full object-cover"
          onError={handleError}
          loading="lazy"
        />
      ) : (
        <div className="flex items-center justify-center w-full h-full">
          <Disc3 size={Math.min(size * 0.5, 64)} className="text-[var(--color-text-muted)] opacity-30" />
        </div>
      )}
    </div>
  );
};

export { AlbumArt };
