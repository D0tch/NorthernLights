import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store/index';
import type { TrackInfo } from '../utils/fileSystem';

// Resolves the YouTube video id matched to the current track, for the mobile
// now-playing background. The lookup is quota-free (a cached DB read on the
// server). Gated on the user setting, YouTube being enabled, and not casting —
// when those don't hold we never fetch and report no video.
//
// Results are memoised per track id (including "no match", stored as null) so
// reopening the now-playing view or revisiting a track doesn't refetch.

const videoIdCache = new Map<string, string | null>();

export function useTrackMusicVideo(track: TrackInfo | null): { videoId: string | null } {
  const youtubeEnabled = usePlayerStore((s) => s.youtubeEnabled);
  const mobileVideoBackgrounds = usePlayerStore((s) => s.mobileVideoBackgrounds);
  const castConnected = usePlayerStore((s) => s.castConnected);
  const getAuthHeader = usePlayerStore((s) => s.getAuthHeader);

  const trackId = track?.id ?? null;
  const enabled = youtubeEnabled && mobileVideoBackgrounds && !castConnected && !!trackId;

  const [videoId, setVideoId] = useState<string | null>(
    trackId && videoIdCache.has(trackId) ? videoIdCache.get(trackId)! : null,
  );

  useEffect(() => {
    if (!enabled || !trackId) {
      setVideoId(null);
      return;
    }

    if (videoIdCache.has(trackId)) {
      setVideoId(videoIdCache.get(trackId)!);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/providers/external/track-video/${encodeURIComponent(trackId)}`, {
          headers: getAuthHeader(),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`track-video ${res.status}`);
        const data = await res.json();
        const id: string | null = data?.video?.video_id || null;
        videoIdCache.set(trackId, id);
        if (!cancelled) setVideoId(id);
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        // Treat lookup failures as "no video" — the cover background is the fallback.
        if (!cancelled) setVideoId(null);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, trackId, getAuthHeader]);

  return { videoId: enabled ? videoId : null };
}
