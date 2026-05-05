import { useMemo } from 'react';
import { usePlayerStore } from '../store';
import type { TrackInfo } from '../utils/fileSystem';

export type NowPlayingState = 'playing' | 'paused' | 'stopped';

export function useCurrentTrack(): TrackInfo | null {
  return usePlayerStore((s) =>
    s.currentIndex !== null ? s.playlist[s.currentIndex] ?? null : null,
  );
}

export function useNowPlayingState(): NowPlayingState {
  return usePlayerStore((s) => s.playbackState);
}

export function useIsCurrentTrack(trackId: string | undefined): boolean {
  return usePlayerStore((s) => {
    if (!trackId || s.currentIndex === null) return false;
    return s.playlist[s.currentIndex]?.id === trackId;
  });
}

interface CollectionMatch {
  albumId?: string;
  artistId?: string;
}

export function useIsCurrentCollection(match: CollectionMatch): boolean {
  return usePlayerStore((s) => {
    const track = s.currentIndex !== null ? s.playlist[s.currentIndex] : null;
    if (!track) return false;
    if (match.albumId && track.albumId === match.albumId) return true;
    if (match.artistId && track.artistId === match.artistId) return true;
    return false;
  });
}

export interface ResumeContext {
  track: TrackInfo;
  index: number;
  totalTracks: number;
  remaining: number;
}

/**
 * V1: returns a resume context whenever a queue exists.
 * Freshness gate (<7d) and last-opened-album fallback are tracked in TASKS.md
 * tech-debt and will land in a follow-up.
 */
export function useResumeContext(): ResumeContext | null {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);

  return useMemo(() => {
    if (currentIndex === null || playlist.length === 0) return null;
    const track = playlist[currentIndex];
    if (!track) return null;
    return {
      track,
      index: currentIndex,
      totalTracks: playlist.length,
      remaining: Math.max(0, playlist.length - currentIndex - 1),
    };
  }, [playlist, currentIndex]);
}
