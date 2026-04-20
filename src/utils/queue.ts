import type { TrackInfo } from './fileSystem';

export function createQueueEntryId(): string {
  return `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneTrackForQueue(track: TrackInfo): TrackInfo {
  return {
    ...track,
    queueEntryId: createQueueEntryId(),
  };
}

export function ensureQueueEntryIds(tracks: TrackInfo[]): { tracks: TrackInfo[]; changed: boolean } {
  let changed = false;
  const normalized = tracks.map((track) => {
    if (track.queueEntryId) return track;
    changed = true;
    return {
      ...track,
      queueEntryId: createQueueEntryId(),
    };
  });
  return { tracks: normalized, changed };
}
