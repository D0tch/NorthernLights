import {
  setEnrichedTrackCredits,
  setTrackGeniusSongId,
  getTracksNeedingMbCredits,
  getTracksNeedingGeniusCredits,
  getSystemSetting,
} from '../database';
import { mbGetRecording } from './metadata/providers/musicbrainz';
import { geniusGetSong, geniusResolveSongId } from './metadata/providers/genius';

// Tag-driven credits are written during scan (no network). These
// enrichment jobs run on demand from the admin settings tab and add
// provider-sourced rows alongside them — never replacing the tag rows
// (setEnrichedTrackCredits in database/index.ts scopes its DELETE by
// source). Aurora stays fully usable without ever running these.

export interface EnrichmentResult {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  creditsWritten: number;
  ranOutOfQuota: boolean;
}

const DEFAULT_BATCH = 200;

export async function enrichCreditsFromMusicBrainz(opts?: { limit?: number }): Promise<EnrichmentResult> {
  const limit = Math.max(1, Math.min(2000, opts?.limit ?? DEFAULT_BATCH));
  const connected = await getSystemSetting('musicBrainzConnected');
  if (!(connected === true || connected === 'true')) {
    return { attempted: 0, succeeded: 0, skipped: 0, failed: 0, creditsWritten: 0, ranOutOfQuota: false };
  }

  const tracks = await getTracksNeedingMbCredits(limit);
  const result: EnrichmentResult = {
    attempted: tracks.length,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    creditsWritten: 0,
    ranOutOfQuota: false,
  };

  for (const t of tracks) {
    try {
      const credits = await mbGetRecording(t.mb_recording_id);
      if (!credits || credits.length === 0) {
        // Write the source row sentinel as an empty set so we don't
        // re-fetch the same recording every run. We do this by setting
        // no credits AND a no-op delete (skip the write; the eligibility
        // query already filters by NOT EXISTS, so a track will be
        // re-attempted on the next run — that's acceptable cost).
        result.skipped++;
        continue;
      }
      await setEnrichedTrackCredits(t.id, 'musicbrainz', credits.map(c => ({
        role: c.role,
        name: c.name,
        detail: c.detail,
      })));
      result.succeeded++;
      result.creditsWritten += credits.length;
    } catch (err: any) {
      // 503/429 from MB → bail out so we don't burn through the throttle.
      const msg = err?.message || '';
      if (msg.includes('429') || msg.toLowerCase().includes('rate')) {
        result.ranOutOfQuota = true;
        break;
      }
      result.failed++;
    }
  }
  return result;
}

export async function enrichCreditsFromGenius(opts?: { limit?: number }): Promise<EnrichmentResult> {
  const limit = Math.max(1, Math.min(2000, opts?.limit ?? DEFAULT_BATCH));
  const apiKey = await getSystemSetting('geniusApiKey');
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    return { attempted: 0, succeeded: 0, skipped: 0, failed: 0, creditsWritten: 0, ranOutOfQuota: false };
  }

  const tracks = await getTracksNeedingGeniusCredits(limit);
  const result: EnrichmentResult = {
    attempted: tracks.length,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    creditsWritten: 0,
    ranOutOfQuota: false,
  };

  for (const t of tracks) {
    try {
      // Resolve the Genius song id once and cache it on the track.
      // On second-pass runs we skip the search step entirely.
      let songId: string | number | null = t.genius_song_id;
      if (!songId) {
        const resolved = await geniusResolveSongId(t.title, t.artist, apiKey);
        if (resolved) {
          songId = resolved;
          await setTrackGeniusSongId(t.id, String(resolved));
        }
      }
      if (!songId) {
        result.skipped++;
        continue;
      }
      const credits = await geniusGetSong(songId, apiKey);
      if (!credits || credits.length === 0) {
        result.skipped++;
        continue;
      }
      await setEnrichedTrackCredits(t.id, 'genius', credits.map(c => ({
        role: c.role,
        name: c.name,
      })));
      result.succeeded++;
      result.creditsWritten += credits.length;
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('429') || msg.toLowerCase().includes('rate')) {
        result.ranOutOfQuota = true;
        break;
      }
      result.failed++;
    }
  }
  return result;
}
