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
