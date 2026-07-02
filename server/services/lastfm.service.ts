import { createHash } from 'crypto';
import { getUserSetting, setUserSetting, getSystemSetting } from '../database';

const LFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';

export interface LfmTrack {
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  duration?: number;
  trackNumber?: number;
  timestamp?: number;
  mbid?: string;
  chosenByUser?: boolean;
}

/**
 * Get user's Last.fm credentials. API key + shared secret are system-level,
 * session key is per-user.
 */
async function getUserLfmCreds(userId: string): Promise<{ apiKey: string; sharedSecret: string; sessionKey: string }> {
  const apiKey = (await getSystemSetting('lastFmApiKey')) || '';
  const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';
  const sessionKey = (await getUserSetting(userId, 'lastFmSessionKey')) || '';
  return { apiKey, sharedSecret, sessionKey };
}

/**
 * Build Last.fm API signature (MD5 of sorted key-value pairs + shared secret).
 * Excludes 'format' and 'callback' params from signature.
 */
export function buildSignature(params: Record<string, string>, secret: string): string {
  // Last.fm verifies the signature by sorting param names in code-point (byte)
  // order, NOT locale order. localeCompare diverges for prefix pairs once an
  // array index bracket sits between the shared prefix and the differing char —
  // e.g. it orders "album[0]" before "albumArtist[0]", but Last.fm expects
  // "albumArtist[0]" first ('A'=65 < '['=91). A wrong order yields a wrong
  // api_sig and Last.fm rejects the call with error 13 (invalid signature),
  // which silently breaks batch scrobbles for any track carrying both an album
  // and an albumArtist (same for track[]/trackNumber[]).
  const filtered = Object.entries(params)
    .filter(([key]) => key !== 'format' && key !== 'callback')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  let sigString = '';
  for (const [key, value] of filtered) {
    sigString += key + value;
  }
  sigString += secret;

  return createHash('md5').update(sigString, 'utf8').digest('hex');
}

/**
 * Make an authenticated Last.fm API call (POST with signature) for a specific user.
 */
export async function lfmFetch(
  userId: string,
  method: string,
  params: Record<string, string>,
  overrides?: { apiKey?: string; sharedSecret?: string; sessionKey?: string }
): Promise<any> {
  const creds = await getUserLfmCreds(userId);
  const apiKey = overrides?.apiKey || creds.apiKey;
  const sharedSecret = overrides?.sharedSecret || creds.sharedSecret;
  const sessionKey = overrides?.sessionKey || creds.sessionKey;

  const allParams: Record<string, string> = {
    method,
    api_key: apiKey,
    format: 'json',
    ...params,
  };

  if (sessionKey) {
    allParams.sk = sessionKey;
  }

  // Build signature (sk is included in allParams if present)
  allParams.api_sig = buildSignature(allParams, sharedSecret);

  const body = new URLSearchParams(allParams);

  const res = await fetch(LFM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AuroraMediaServer/1.0'
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  const raw = await res.text();
  let json: any;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Last.fm HTTP ${res.status}: non-JSON response ${raw.slice(0, 120)}`);
  }

  if (json.error) {
    throw new Error(`Last.fm error ${json.error}: ${json.message}`);
  }

  if (!res.ok) {
    throw new Error(`Last.fm HTTP ${res.status}: ${json.message || raw.slice(0, 120) || 'request failed'}`);
  }

  return json;
}

/**
 * Scrobble tracks to Last.fm for a user (batch up to 50 per request).
 */
export async function scrobbleTracks(userId: string, tracks: LfmTrack[]): Promise<any> {
  if (tracks.length === 0) return { scrobbles: [] };

  const results: any[] = [];

  // Batch in groups of 50
  for (let i = 0; i < tracks.length; i += 50) {
    const batch = tracks.slice(i, i + 50);
    const params: Record<string, string> = {};

    batch.forEach((t, idx) => {
      params[`artist[${idx}]`] = t.artist;
      params[`track[${idx}]`] = t.track;
      params[`timestamp[${idx}]`] = String(t.timestamp || Math.floor(Date.now() / 1000));
      if (t.album) params[`album[${idx}]`] = t.album;
      if (t.albumArtist) params[`albumArtist[${idx}]`] = t.albumArtist;
      if (t.duration) params[`duration[${idx}]`] = String(t.duration);
      if (t.trackNumber) params[`trackNumber[${idx}]`] = String(t.trackNumber);
      if (t.mbid) params[`mbid[${idx}]`] = t.mbid;
      params[`chosenByUser[${idx}]`] = t.chosenByUser !== false ? '1' : '0';
    });

    const result = await lfmFetch(userId, 'track.scrobble', params);
    results.push(result);
  }

  return results.length === 1 ? results[0] : results;
}

/**
 * Update Now Playing on Last.fm for a user.
 */
export async function updateNowPlaying(userId: string, track: LfmTrack): Promise<any> {
  const params: Record<string, string> = {
    artist: track.artist,
    track: track.track,
  };
  if (track.album) params.album = track.album;
  if (track.albumArtist) params.albumArtist = track.albumArtist;
  if (track.duration) params.duration = String(track.duration);
  if (track.trackNumber) params.trackNumber = String(track.trackNumber);
  if (track.mbid) params.mbid = track.mbid;

  return lfmFetch(userId, 'track.updateNowPlaying', params);
}

/**
 * Love a track on Last.fm for a user.
 */
export async function loveTrack(userId: string, artist: string, track: string): Promise<any> {
  return lfmFetch(userId, 'track.love', { artist, track });
}

/**
 * Unlove a track on Last.fm for a user.
 */
export async function unloveTrack(userId: string, artist: string, track: string): Promise<any> {
  return lfmFetch(userId, 'track.unlove', { artist, track });
}

// A single external play, provider-agnostic. mbid, when present, is the
// MusicBrainz *recording* id — the strongest key for matching to a local track.
export interface ExternalListen {
  artist: string;
  track: string;
  mbid?: string;
}

const LFM_HISTORY_PAGE_SIZE = 200; // Last.fm max per page
const LFM_HISTORY_MAX_PAGES = 10;  // cap: ≤2000 scrobbles per period fetch

/**
 * Fetch a user's scrobbles in [fromTs, toTs] (UNIX seconds) as flat listen rows.
 * Uses user.getRecentTracks — a public read (api_key + username, no signature).
 * Resilient by contract: returns [] when Last.fm isn't connected, and returns
 * whatever was gathered so far on any error/timeout. Callers (e.g. Wrapped
 * enrichment) must always be able to proceed without external history.
 */
export async function getScrobblesInRange(userId: string, fromTs: number, toTs: number): Promise<ExternalListen[]> {
  const apiKey = (await getSystemSetting('lastFmApiKey')) || '';
  const username = (await getUserSetting(userId, 'lastFmUsername')) || '';
  if (!apiKey || !username) return [];

  const out: ExternalListen[] = [];
  const deadline = Date.now() + 30000; // overall budget; page cap is the primary bound
  try {
    for (let page = 1; page <= LFM_HISTORY_MAX_PAGES; page++) {
      if (Date.now() > deadline) break;
      const url = `${LFM_API_URL}?method=user.getrecenttracks`
        + `&user=${encodeURIComponent(username)}&api_key=${encodeURIComponent(apiKey)}`
        + `&format=json&limit=${LFM_HISTORY_PAGE_SIZE}&page=${page}&from=${fromTs}&to=${toTs}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'AuroraMediaServer/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) break;
      const json: any = await res.json();
      const raw = json?.recenttracks?.track;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const t of list) {
        // The currently-playing track has no timestamp and isn't a real scrobble.
        if (t?.['@attr']?.nowplaying === 'true') continue;
        const artist = t?.artist?.['#text'] || t?.artist?.name || '';
        const track = t?.name || '';
        if (!artist || !track) continue;
        out.push({ artist, track, mbid: String(t?.mbid || '').trim() || undefined });
      }
      const totalPages = Number(json?.recenttracks?.['@attr']?.totalPages || 1);
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
    }
  } catch (e) {
    console.error('[LastFm] getScrobblesInRange failed', (e as Error).message);
  }
  return out;
}
