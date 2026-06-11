import {
  setEnrichedTrackCredits,
  setTrackGeniusSongId,
  listTracksNeedingMbCredits,
  listTracksNeedingGeniusCredits,
  getSystemSetting,
} from '../database';
import { mbGetRecording } from './metadata/providers/musicbrainz';
import { geniusGetSong, geniusResolveSongId } from './metadata/providers/genius';

// Tag-driven credits are written during scan (no network). These
// enrichment jobs run on demand from the admin settings tab and add
// provider-sourced rows alongside them — never replacing the tag rows
// (setEnrichedTrackCredits in database/index.ts scopes its DELETE by
// source). Aurora stays fully usable without ever running these.

// ─── Credit enrichment — long-running, throttled background jobs ──────────────
// Both providers are rate-limited (MusicBrainz ~1 req/s, Genius a few req/s), so
// enriching a library takes minutes. Rather than block one HTTP request that
// whole time with no feedback, the routes start a background job and the client
// polls get{Mb,Genius}CreditsProgress() to drive a progress bar.

export interface CreditsJobProgress {
  running: boolean;
  total: number;          // tracks needing credits when the run started
  processed: number;      // tracks attempted so far this run
  succeeded: number;      // tracks that got credit rows
  skipped: number;        // tracks the provider had no credits for
  failed: number;
  creditsWritten: number;
  ranOutOfQuota: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

function emptyProgress(): CreditsJobProgress {
  return {
    running: false, total: 0, processed: 0, succeeded: 0, skipped: 0,
    failed: 0, creditsWritten: 0, ranOutOfQuota: false,
    startedAt: null, finishedAt: null,
  };
}

// processOne returns the number of credit rows written, or null when the
// provider had nothing for that track (counted as "skipped"). A rate-limit
// error thrown from the provider stops the run cleanly so we don't burn through
// the throttle — remaining tracks are picked up on the next run since they stay
// in the needing-credits set.
async function runCreditsJob<T>(
  progress: CreditsJobProgress,
  work: T[],
  processOne: (item: T) => Promise<number | null>,
): Promise<void> {
  try {
    for (const item of work) {
      try {
        const written = await processOne(item);
        if (written === null) progress.skipped++;
        else { progress.succeeded++; progress.creditsWritten += written; }
      } catch (err: any) {
        const msg = err?.message || '';
        if (msg.includes('429') || msg.toLowerCase().includes('rate')) {
          progress.ranOutOfQuota = true;
          break;
        }
        progress.failed++;
      }
      progress.processed++;
    }
  } finally {
    progress.running = false;
    progress.finishedAt = Date.now();
  }
}

// ─── MusicBrainz ──────────────────────────────────────────────────────────────

let mbProgress: CreditsJobProgress = emptyProgress();

export function getMbCreditsProgress(): CreditsJobProgress {
  return { ...mbProgress };
}

/**
 * Start the MB credit-enrichment job if one isn't already running. Returns
 * immediately; progress is reported via getMbCreditsProgress(). Idempotent —
 * calling while a run is in flight is a no-op that reports the live state.
 */
export async function startMbCreditsEnrichment(): Promise<{ started: boolean; reason?: 'already_running' | 'not_connected' | 'nothing_to_do'; progress: CreditsJobProgress }> {
  if (mbProgress.running) {
    return { started: false, reason: 'already_running', progress: getMbCreditsProgress() };
  }

  const connected = await getSystemSetting('musicBrainzConnected');
  if (!(connected === true || connected === 'true')) {
    return { started: false, reason: 'not_connected', progress: getMbCreditsProgress() };
  }

  const work = await listTracksNeedingMbCredits();
  if (work.length === 0) {
    mbProgress = { ...emptyProgress(), finishedAt: Date.now() };
    return { started: false, reason: 'nothing_to_do', progress: getMbCreditsProgress() };
  }

  mbProgress = { ...emptyProgress(), running: true, total: work.length, startedAt: Date.now() };
  // Fire and forget — the client polls for progress.
  void runCreditsJob(mbProgress, work, async (t) => {
    const credits = await mbGetRecording(t.mb_recording_id);
    if (!credits || credits.length === 0) return null;
    await setEnrichedTrackCredits(t.id, 'musicbrainz', credits.map(c => ({
      role: c.role,
      name: c.name,
      detail: c.detail,
    })));
    return credits.length;
  });
  return { started: true, progress: getMbCreditsProgress() };
}

// ─── Genius ───────────────────────────────────────────────────────────────────

let geniusProgress: CreditsJobProgress = emptyProgress();

export function getGeniusCreditsProgress(): CreditsJobProgress {
  return { ...geniusProgress };
}

/**
 * Start the Genius credit-enrichment job if one isn't already running. Returns
 * immediately; progress is reported via getGeniusCreditsProgress().
 */
export async function startGeniusCreditsEnrichment(): Promise<{ started: boolean; reason?: 'already_running' | 'not_connected' | 'nothing_to_do'; progress: CreditsJobProgress }> {
  if (geniusProgress.running) {
    return { started: false, reason: 'already_running', progress: getGeniusCreditsProgress() };
  }

  const apiKey = await getSystemSetting('geniusApiKey');
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    return { started: false, reason: 'not_connected', progress: getGeniusCreditsProgress() };
  }

  const work = await listTracksNeedingGeniusCredits();
  if (work.length === 0) {
    geniusProgress = { ...emptyProgress(), finishedAt: Date.now() };
    return { started: false, reason: 'nothing_to_do', progress: getGeniusCreditsProgress() };
  }

  geniusProgress = { ...emptyProgress(), running: true, total: work.length, startedAt: Date.now() };
  void runCreditsJob(geniusProgress, work, async (t) => {
    // Resolve the Genius song id once and cache it on the track so second-pass
    // runs skip the search step entirely.
    let songId: string | number | null = t.genius_song_id;
    if (!songId) {
      const resolved = await geniusResolveSongId(t.title, t.artist, apiKey);
      if (resolved) {
        songId = resolved;
        await setTrackGeniusSongId(t.id, String(resolved));
      }
    }
    if (!songId) return null;
    const credits = await geniusGetSong(songId, apiKey);
    if (!credits || credits.length === 0) return null;
    await setEnrichedTrackCredits(t.id, 'genius', credits.map(c => ({
      role: c.role,
      name: c.name,
    })));
    return credits.length;
  });
  return { started: true, progress: getGeniusCreditsProgress() };
}
