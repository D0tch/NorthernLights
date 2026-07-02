import { getUserSetting } from '../database';

const LB_API_URL = 'https://api.listenbrainz.org/1';

export interface LbTrack {
  artist: string;
  track: string;
  album?: string;
  duration?: number;
  trackNumber?: number;
  timestamp?: number;
  mbid?: string;
}

async function getUserToken(userId: string): Promise<string> {
  return (await getUserSetting(userId, 'listenBrainzUserToken')) || '';
}

export async function validateToken(token: string): Promise<{ valid: boolean; username?: string; message?: string }> {
  const res = await fetch(`${LB_API_URL}/validate-token`, {
    headers: { 'Authorization': `Token ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    return { valid: false, message: `ListenBrainz returned ${res.status}` };
  }
  const data = await res.json();
  return { valid: !!data.valid, username: data.user_name, message: data.message };
}

function toPayload(t: LbTrack, includeListenedAt: boolean) {
  const additional_info: Record<string, any> = {};
  if (t.duration) additional_info.duration_ms = t.duration * 1000;
  if (t.trackNumber) additional_info.tracknumber = t.trackNumber;
  if (t.mbid) additional_info.recording_mbid = t.mbid;
  additional_info.submission_client = 'NorthernLights';

  const track_metadata: Record<string, any> = {
    artist_name: t.artist,
    track_name: t.track,
  };
  if (t.album) track_metadata.release_name = t.album;
  if (Object.keys(additional_info).length > 0) track_metadata.additional_info = additional_info;

  const payload: Record<string, any> = { track_metadata };
  if (includeListenedAt) {
    payload.listened_at = t.timestamp || Math.floor(Date.now() / 1000);
  }
  return payload;
}

async function submit(userId: string, body: Record<string, any>): Promise<any> {
  const token = await getUserToken(userId);
  if (!token) throw new Error('ListenBrainz not connected');

  const res = await fetch(`${LB_API_URL}/submit-listens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(json?.error || `ListenBrainz returned ${res.status}`);
  }
  return json;
}

export async function scrobbleTracks(userId: string, tracks: LbTrack[]): Promise<any> {
  if (tracks.length === 0) return { accepted: 0 };

  const listenType = tracks.length === 1 ? 'single' : 'import';
  const results: any[] = [];

  // LB recommends batches under 1MB; chunk at 100 to be safe.
  for (let i = 0; i < tracks.length; i += 100) {
    const batch = tracks.slice(i, i + 100);
    const body = {
      listen_type: listenType,
      payload: batch.map(t => toPayload(t, true)),
    };
    const result = await submit(userId, body);
    results.push(result);
  }

  return results.length === 1 ? results[0] : results;
}

export async function updateNowPlaying(userId: string, track: LbTrack): Promise<any> {
  const body = {
    listen_type: 'playing_now',
    payload: [toPayload(track, false)],
  };
  return submit(userId, body);
}

const LB_HISTORY_PAGE_SIZE = 200; // well under LB's max of 1000
const LB_HISTORY_MAX_PAGES = 10;  // cap: ≤2000 listens per period fetch

/**
 * Fetch a user's listens in (fromTs, toTs] (UNIX seconds) as flat listen rows,
 * mirroring lastfm.getScrobblesInRange's contract. LB returns listens newest
 * first, so we walk max_ts backwards page by page. Resilient — returns [] when
 * not connected and whatever was gathered on error/timeout. Recording MBIDs
 * come from LB's mapping when available (strongest key for local matching).
 */
export async function getListensInRange(userId: string, fromTs: number, toTs: number): Promise<Array<{ artist: string; track: string; mbid?: string }>> {
  const username = (await getUserSetting(userId, 'listenBrainzUsername')) || '';
  if (!username) return [];
  const token = await getUserToken(userId); // optional for public reads, but avoids stricter rate limits

  const out: Array<{ artist: string; track: string; mbid?: string }> = [];
  const deadline = Date.now() + 30000; // overall budget; page cap is the primary bound
  let maxTs = toTs;
  try {
    for (let page = 0; page < LB_HISTORY_MAX_PAGES; page++) {
      if (Date.now() > deadline) break;
      const url = `${LB_API_URL}/user/${encodeURIComponent(username)}/listens`
        + `?min_ts=${Math.max(0, fromTs - 1)}&max_ts=${maxTs}&count=${LB_HISTORY_PAGE_SIZE}`;
      const res = await fetch(url, {
        headers: token ? { 'Authorization': `Token ${token}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) break;
      const json: any = await res.json();
      const listens = json?.payload?.listens;
      if (!Array.isArray(listens) || listens.length === 0) break;
      let oldest = maxTs;
      for (const l of listens) {
        const md = l?.track_metadata || {};
        const artist = md?.artist_name || '';
        const track = md?.track_name || '';
        const mbid = String(md?.mbid_mapping?.recording_mbid || md?.additional_info?.recording_mbid || '').trim() || undefined;
        if (artist && track) out.push({ artist, track, mbid });
        const at = Number(l?.listened_at || 0);
        if (at && at < oldest) oldest = at;
      }
      if (listens.length < LB_HISTORY_PAGE_SIZE) break;
      maxTs = oldest - 1; // next page: strictly older than the oldest seen
      if (maxTs <= fromTs) break;
    }
  } catch (e) {
    console.error('[ListenBrainz] getListensInRange failed', (e as Error).message);
  }
  return out;
}
