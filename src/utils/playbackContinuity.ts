import type { TrackInfo } from './fileSystem';

const STORAGE_KEY = 'aurora-playback-continuity-v1';
const RECENT_SNAPSHOT_MS = 10 * 60 * 1000;

export type ContinuityPlaybackState = 'playing' | 'paused' | 'stopped';

export interface PlaybackContinuitySnapshot {
  savedAt: number;
  playlist: Omit<TrackInfo, 'fileHandle'>[];
  currentIndex: number | null;
  currentTime: number;
  duration: number;
  playbackState: ContinuityPlaybackState;
  wasPlaying: boolean;
  repeat: 'none' | 'one' | 'all';
  shuffle: boolean;
  streamingQuality: string;
}

export function sanitizeTrackForContinuity(track: TrackInfo): Omit<TrackInfo, 'fileHandle'> {
  const { fileHandle, ...rest } = track;
  return rest;
}

export function savePlaybackContinuitySnapshot(snapshot: Omit<PlaybackContinuitySnapshot, 'savedAt'>): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...snapshot,
        playlist: snapshot.playlist.map(sanitizeTrackForContinuity),
        savedAt: Date.now(),
      })
    );
  } catch (error) {
    console.warn('[Playback] Failed to persist continuity snapshot:', error);
  }
}

export function readPlaybackContinuitySnapshot(): PlaybackContinuitySnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlaybackContinuitySnapshot;
    if (!Array.isArray(parsed.playlist)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isRecentContinuitySnapshot(snapshot: PlaybackContinuitySnapshot | null): snapshot is PlaybackContinuitySnapshot {
  return !!snapshot && Date.now() - snapshot.savedAt <= RECENT_SNAPSHOT_MS;
}
