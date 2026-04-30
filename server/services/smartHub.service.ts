import { initDB, getPlaylistTracks } from '../database';
import OpenAI from 'openai';
import { getLlmConfig, extractJson } from './llm.service';
import { withTransaction } from '../utils/db';

// ============================================================
// Smart Hub: On Repeat, Repeat Rewind, Jump Back In, Artist
// Radio, Daylist. All persist as system playlists with stable
// IDs so they can be played, pinned, and refreshed in place.
// ============================================================

type SmartKind =
  | 'on-repeat'
  | 'repeat-rewind'
  | 'daylist'
  | 'artist-radio'
  | 'seasonal-rewind'
  | 'year-rewind';

// ─── Global content filters ────────────────────────────────
// "Various Artists" is a compilation pseudo-entity, never an artist we'd
// want to feature (radio, jump-back-in tile, top-artist surface). The real
// per-track artists are tagged correctly on VA albums, so individual
// tracks still flow through normally.
const VARIOUS_ARTISTS_NAMES = "'various artists', 'various', 'va', 'compilation', 'compilations'";

function variousArtistsExclusion(artistAlias: string): string {
  return `LOWER(${artistAlias}.name) NOT IN (${VARIOUS_ARTISTS_NAMES})`;
}

// Christmas / holiday content is suppressed from every smart surface
// outside its season (Dec 1 – Jan 5). We match on genre + album, not
// track title — "Holiday" by Madonna is not Christmas music.
function isChristmasSeason(now: Date): boolean {
  const m = now.getMonth();
  const d = now.getDate();
  if (m === 11) return true; // December
  if (m === 0 && d <= 5) return true; // Jan 1–5 (through Epiphany)
  return false;
}

function christmasExclusion(trackAlias: string): string {
  if (isChristmasSeason(new Date())) return '';
  return `
    AND COALESCE(${trackAlias}.genre, '') !~* '(christmas|xmas|holiday|noel)'
    AND COALESCE(${trackAlias}.album, '') !~* '(christmas|xmas|noel)'
  `;
}

const TTL_MS: Record<SmartKind, number> = {
  'on-repeat': 24 * 60 * 60 * 1000,
  'repeat-rewind': 7 * 24 * 60 * 60 * 1000,
  'daylist': 4 * 60 * 60 * 1000,
  'artist-radio': 12 * 60 * 60 * 1000,
  'seasonal-rewind': 7 * 24 * 60 * 60 * 1000,
  'year-rewind': 7 * 24 * 60 * 60 * 1000,
};

function smartPlaylistId(kind: SmartKind, userId: string, suffix?: string): string {
  return suffix ? `smart_${kind}_${userId}_${suffix}` : `smart_${kind}_${userId}`;
}

interface CachedSmart {
  id: string;
  title: string;
  description: string;
  tracks: any[];
  ageMs: number;
  createdAtMs: number;
}

async function loadCachedSmart(id: string): Promise<CachedSmart | null> {
  const db = await initDB();
  const res = await db.query(
    `SELECT id, title, description, created_at FROM playlists WHERE id = $1`,
    [id]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0] as any;
  const tracks = await getPlaylistTracks(id);
  return {
    id,
    title: row.title,
    description: row.description,
    tracks: tracks || [],
    ageMs: Date.now() - new Date(row.created_at).getTime(),
    createdAtMs: new Date(row.created_at).getTime(),
  };
}

async function getCachedSmartPlaylist(id: string, ttlMs: number) {
  const cached = await loadCachedSmart(id);
  if (!cached) return null;
  if (cached.ageMs > ttlMs) return null;
  const { ageMs: _drop, ...rest } = cached;
  return rest;
}

// Stale-while-revalidate: returns the cache regardless of age, plus a flag
// indicating whether a refresh should be triggered.
async function getStaleOrFresh(id: string, ttlMs: number) {
  const cached = await loadCachedSmart(id);
  if (!cached) return { cached: null, stale: true };
  const { ageMs, ...rest } = cached;
  return { cached: rest, stale: ageMs > ttlMs };
}

// Track in-flight refreshes per-user-per-kind to prevent stampedes
const inFlightRefreshes = new Set<string>();
function fireBackgroundRefresh(key: string, work: () => Promise<unknown>) {
  if (inFlightRefreshes.has(key)) return;
  inFlightRefreshes.add(key);
  Promise.resolve()
    .then(work)
    .catch((e) => console.error(`[SmartHub] Background refresh failed for ${key}`, e))
    .finally(() => inFlightRefreshes.delete(key));
}

// Activity gate: never burn LLM tokens or compute on users who aren't
// actively listening. Cheap query (one indexed lookup).
interface UserActivity {
  hasPlayedEver: boolean;
  hasPlayedRecently: boolean; // last 7 days
  hasPlayedToday: boolean;    // last 24h
}

async function getUserActivity(userId: string): Promise<UserActivity> {
  const db = await initDB();
  const res = await db.query(
    `SELECT MAX(last_played_at) AS last_play FROM user_playback_stats WHERE user_id = $1`,
    [userId]
  );
  const lastPlay = (res.rows[0] as any)?.last_play;
  if (!lastPlay) return { hasPlayedEver: false, hasPlayedRecently: false, hasPlayedToday: false };
  const ageMs = Date.now() - new Date(lastPlay).getTime();
  return {
    hasPlayedEver: true,
    hasPlayedRecently: ageMs < 7 * 24 * 60 * 60 * 1000,
    hasPlayedToday: ageMs < 24 * 60 * 60 * 1000,
  };
}

async function persistSmart(
  id: string,
  kind: SmartKind,
  title: string,
  description: string,
  userId: string,
  trackIds: string[]
) {
  const uniqueTrackIds = Array.from(new Set(trackIds.filter(Boolean)));

  await withTransaction(async (client) => {
    // Serialize same-playlist smart refreshes. Without this, two concurrent
    // Hub requests can interleave track replacement for the same stable ID.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [id]);

    await client.query(
      `
      INSERT INTO playlists (id, title, description, created_at, is_llm_generated, user_id, is_system, generation_source)
      VALUES ($1, $2, $3, NOW(), FALSE, $4, TRUE, $5)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        created_at = NOW(),
        is_llm_generated = FALSE,
        user_id = EXCLUDED.user_id,
        is_system = TRUE,
        generation_source = EXCLUDED.generation_source
      `,
      [id, title, description, userId, kind]
    );

    await client.query(`DELETE FROM playlist_tracks WHERE playlist_id = $1`, [id]);

    if (uniqueTrackIds.length > 0) {
      await client.query(
        `
        INSERT INTO playlist_tracks (playlist_id, track_id, sort_order, added_at)
        SELECT $1, input.track_id, input.ordinality - 1, NOW()
        FROM unnest($2::text[]) WITH ORDINALITY AS input(track_id, ordinality)
        JOIN tracks t ON t.id = input.track_id
        ORDER BY input.ordinality
        `,
        [id, uniqueTrackIds]
      );
    }
  });

  const tracks = await getPlaylistTracks(id);
  return { id, title, description, tracks };
}

async function computeOnRepeatFresh(userId: string, limit: number) {
  const id = smartPlaylistId('on-repeat', userId);
  const db = await initDB();
  const res = await db.query(
    `
    SELECT t.id, SUM(b.play_count) AS recent_plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= date_trunc('month', NOW() - INTERVAL '30 days')::date
      ${christmasExclusion('t')}
    GROUP BY t.id
    HAVING SUM(b.play_count) >= 3
    ORDER BY recent_plays DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  const trackIds = res.rows.map((r: any) => r.id);
  return persistSmart(id, 'on-repeat', 'On Repeat', 'Songs you love right now.', userId, trackIds);
}

// ─── On Repeat ─────────────────────────────────────────────
// Tracks the user has played most in the last 30 days.
export async function computeOnRepeat(userId: string, limit = 30) {
  const id = smartPlaylistId('on-repeat', userId);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['on-repeat']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeOnRepeatFresh(userId, limit));
    }
    return cached;
  }
  return computeOnRepeatFresh(userId, limit);
}

async function computeRepeatRewindFresh(userId: string, limit: number) {
  const id = smartPlaylistId('repeat-rewind', userId);
  const db = await initDB();
  const res = await db.query(
    `
    WITH rewind_scores AS (
      SELECT
        t.id,
        COALESCE(SUM(CASE WHEN b.year_month BETWEEN
          date_trunc('month', NOW() - INTERVAL '18 months')::date
          AND date_trunc('month', NOW() - INTERVAL '6 months')::date
          THEN b.play_count ELSE 0 END), 0) AS old_plays,
        COALESCE(SUM(CASE WHEN b.year_month >=
          date_trunc('month', NOW() - INTERVAL '3 months')::date
          THEN b.play_count ELSE 0 END), 0) AS recent_plays
      FROM user_track_play_buckets b
      JOIN tracks t ON t.id = b.track_id
      WHERE b.user_id = $1
        ${christmasExclusion('t')}
      GROUP BY t.id
    )
    SELECT id, old_plays, recent_plays
    FROM rewind_scores
    WHERE old_plays >= 4
    ORDER BY (old_plays - 2 * recent_plays) DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  const trackIds = res.rows.map((r: any) => r.id);
  return persistSmart(
    id,
    'repeat-rewind',
    'Repeat Rewind',
    'Your past favorites.',
    userId,
    trackIds
  );
}

// ─── Repeat Rewind ─────────────────────────────────────────
// Tracks heavily played 6–18 months ago, mostly cold now.
export async function computeRepeatRewind(userId: string, limit = 30) {
  const id = smartPlaylistId('repeat-rewind', userId);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['repeat-rewind']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeRepeatRewindFresh(userId, limit));
    }
    return cached;
  }
  return computeRepeatRewindFresh(userId, limit);
}

// ─── Jump Back In ──────────────────────────────────────────
// Mixed-type tile feed: recently played items (albums, playlists,
// artists). Returns descriptors, not a playlist — the UI renders
// each tile and handles its own play action.
export interface JumpTile {
  type: 'album' | 'playlist' | 'artist';
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  lastPlayedAt: number;
}

export async function computeJumpBackIn(userId: string, limit = 12): Promise<JumpTile[]> {
  const db = await initDB();

  // Recently played tracks → group to album, taking most recent play per album
  const albumRes = await db.query(
    `
    SELECT
      t.album_id::text AS album_id,
      MAX(ups.last_played_at) AS last_played_at,
      MAX(t.album) AS album,
      MAX(COALESCE(t.album_artist, t.artist)) AS artist
    FROM user_playback_stats ups
    JOIN tracks t ON t.id = ups.track_id
    WHERE ups.user_id = $1
      AND ups.last_played_at IS NOT NULL
      AND ups.last_played_at > NOW() - INTERVAL '90 days'
      AND t.album_id IS NOT NULL
      AND t.album IS NOT NULL AND t.album <> ''
      ${christmasExclusion('t')}
    GROUP BY t.album_id
    ORDER BY last_played_at DESC
    LIMIT $2
    `,
    [userId, limit * 2]
  );

  // Recently played playlists (track-level approximation: any playlist that
  // contains recently played tracks)
  const playlistRes = await db.query(
    `
    SELECT p.id, p.title, MAX(ups.last_played_at) AS last_played_at
    FROM user_playback_stats ups
    JOIN playlist_tracks pt ON pt.track_id = ups.track_id
    JOIN playlists p ON p.id = pt.playlist_id
    WHERE ups.user_id = $1
      AND ups.last_played_at > NOW() - INTERVAL '60 days'
      AND (p.user_id = $1 OR p.is_system = TRUE)
      AND COALESCE(p.generation_source, '') NOT IN ('artist-radio')
    GROUP BY p.id, p.title
    ORDER BY last_played_at DESC
    LIMIT $2
    `,
    [userId, Math.ceil(limit / 2)]
  );

  // Recently played artists (top played in last 60 days)
  const artistRes = await db.query(
    `
    SELECT a.id::text AS id, a.name, a.image_url, MAX(ups.last_played_at) AS last_played_at
    FROM user_playback_stats ups
    JOIN tracks t ON t.id = ups.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE ups.user_id = $1
      AND ups.last_played_at > NOW() - INTERVAL '60 days'
      AND ${variousArtistsExclusion('a')}
    GROUP BY a.id, a.name, a.image_url
    ORDER BY last_played_at DESC
    LIMIT $2
    `,
    [userId, Math.ceil(limit / 3)]
  );

  const tiles: JumpTile[] = [];

  for (const r of albumRes.rows as any[]) {
    tiles.push({
      type: 'album',
      id: r.album_id,
      title: r.album,
      subtitle: r.artist,
      imageUrl: null,
      lastPlayedAt: new Date(r.last_played_at).getTime(),
    });
  }
  for (const r of playlistRes.rows as any[]) {
    tiles.push({
      type: 'playlist',
      id: r.id,
      title: r.title,
      subtitle: 'Playlist',
      imageUrl: null,
      lastPlayedAt: new Date(r.last_played_at).getTime(),
    });
  }
  for (const r of artistRes.rows as any[]) {
    tiles.push({
      type: 'artist',
      id: r.id,
      title: r.name,
      subtitle: 'Artist',
      imageUrl: r.image_url,
      lastPlayedAt: new Date(r.last_played_at).getTime(),
    });
  }

  tiles.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
  return tiles.slice(0, limit);
}

// ─── Artist Radio Candidates ───────────────────────────────
// Top recent artists ranked by play volume in last 60 days.
export interface ArtistRadioCandidate {
  artistId: string;
  artistName: string;
  imageUrl: string | null;
  recentPlays: number;
  withArtists: string[];
}

// For a candidate seed artist, peek at the 3 closest neighbour artists by
// 1280D embedding similarity. Mirrors what generateArtistRadioFresh would
// surface, so the subtitle previews who'll actually play. Empty array if
// the seed has no embeddings.
async function previewWithArtists(userId: string, artistId: string): Promise<string[]> {
  const db = await initDB();
  const res = await db.query(
    `
    WITH seed AS (
      SELECT tf.embedding_vector AS vec
      FROM tracks t
      JOIN track_features tf ON tf.track_id = t.id
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE t.artist_id = $2
        AND tf.embedding_vector IS NOT NULL
      ORDER BY COALESCE(ups.play_count, 0) DESC, t.id ASC
      LIMIT 1
    ),
    neighbors AS (
      SELECT t.artist_id, tf.embedding_vector <=> (SELECT vec FROM seed) AS distance
      FROM tracks t
      JOIN track_features tf ON tf.track_id = t.id
      WHERE tf.embedding_vector IS NOT NULL
        AND t.artist_id IS NOT NULL
        AND t.artist_id <> $2
      ORDER BY distance ASC
      LIMIT 50
    )
    SELECT a.name, MIN(n.distance) AS d
    FROM neighbors n
    JOIN artists a ON a.id = n.artist_id
    WHERE ${variousArtistsExclusion('a')}
    GROUP BY a.name
    ORDER BY d ASC
    LIMIT 3
    `,
    [userId, artistId]
  );
  return res.rows.map((r: any) => r.name as string);
}

export async function computeArtistRadioCandidates(
  userId: string,
  limit = 6
): Promise<ArtistRadioCandidate[]> {
  const db = await initDB();
  const res = await db.query(
    `
    SELECT
      a.id::text AS artist_id,
      a.name AS artist_name,
      a.image_url,
      SUM(b.play_count) AS recent_plays,
      0.7 * SUM(CASE WHEN b.year_month >=
        date_trunc('month', NOW() - INTERVAL '60 days')::date
        THEN b.play_count ELSE 0 END)
      + 0.3 * SUM(CASE WHEN b.year_month BETWEEN
        date_trunc('month', NOW() - INTERVAL '180 days')::date
        AND date_trunc('month', NOW() - INTERVAL '60 days')::date
        THEN b.play_count ELSE 0 END) AS score
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE b.user_id = $1
      AND b.year_month >= date_trunc('month', NOW() - INTERVAL '180 days')::date
      AND ${variousArtistsExclusion('a')}
    GROUP BY a.id, a.name, a.image_url
    HAVING SUM(b.play_count) >= 10
    ORDER BY score DESC
    LIMIT $2
    `,
    [userId, limit]
  );

  const candidates: ArtistRadioCandidate[] = await Promise.all(
    res.rows.map(async (r: any) => ({
      artistId: r.artist_id,
      artistName: r.artist_name,
      imageUrl: r.image_url,
      recentPlays: Number(r.recent_plays),
      withArtists: await previewWithArtists(userId, r.artist_id).catch(() => []),
    }))
  );
  return candidates;
}

// ─── Artist Radio (generated on demand) ────────────────────
// Builds a 30-track radio seeded by the artist's most-played track,
// using 1280D Discogs-EffNet embedding similarity.
async function generateArtistRadioFresh(userId: string, artistId: string, limit: number) {
  const id = smartPlaylistId('artist-radio', userId, artistId);
  const db = await initDB();

  const artistRes = await db.query(
    `SELECT name FROM artists WHERE id = $1`,
    [artistId]
  );
  if (artistRes.rowCount === 0) {
    throw new Error(`Artist not found: ${artistId}`);
  }
  const artistName = (artistRes.rows[0] as any).name;

  // Refuse to build a radio for the "Various Artists" pseudo-entity — by
  // definition it has no coherent acoustic signature.
  if (VARIOUS_ARTISTS_NAMES.includes(`'${artistName.toLowerCase()}'`)) {
    throw new Error('Cannot generate radio for compilation pseudo-artist');
  }

  // Seed: artist's track with the highest user play count that has an embedding
  const seedRes = await db.query(
    `
    SELECT t.id, tf.embedding_vector
    FROM tracks t
    JOIN track_features tf ON tf.track_id = t.id
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
    WHERE t.artist_id = $2
      AND tf.embedding_vector IS NOT NULL
      ${christmasExclusion('t')}
    ORDER BY COALESCE(ups.play_count, 0) DESC, t.id ASC
    LIMIT 1
    `,
    [userId, artistId]
  );

  let seedTrackIds: string[] = [];
  let seedVectorStr: string | null = null;

  if (seedRes.rowCount && seedRes.rowCount > 0) {
    const seedRow = seedRes.rows[0] as any;
    seedTrackIds.push(seedRow.id);
    seedVectorStr = seedRow.embedding_vector;
  }

  // Fallback when no embedding exists for this artist: just return their tracks
  if (!seedVectorStr) {
    const fallbackRes = await db.query(
      `
      SELECT t.id
      FROM tracks t
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE t.artist_id = $2
      ${christmasExclusion('t')}
      ORDER BY COALESCE(ups.play_count, 0) DESC, t.id ASC
      LIMIT $3
      `,
      [userId, artistId, limit]
    );
    const trackIds = fallbackRes.rows.map((r: any) => r.id);
    return persistSmart(
      id,
      'artist-radio',
      `${artistName} Radio`,
      `A mix inspired by ${artistName}.`,
      userId,
      trackIds
    );
  }

  // K-NN by embedding, dedupe artists (max 2 per artist, except seed)
  const neighborsRes = await db.query(
    `
    SELECT t.id, t.artist_id::text AS artist_id,
      tf.embedding_vector <=> $1::vector AS distance
    FROM tracks t
    JOIN track_features tf ON tf.track_id = t.id
    WHERE tf.embedding_vector IS NOT NULL
    ${christmasExclusion('t')}
    ORDER BY distance ASC
    LIMIT $2
    `,
    [seedVectorStr, limit * 4]
  );

  const perArtist = new Map<string, number>();
  const radioTrackIds: string[] = [];
  // Always include the seed first
  radioTrackIds.push(...seedTrackIds);
  perArtist.set(artistId, 1);

  for (const row of neighborsRes.rows as any[]) {
    if (radioTrackIds.length >= limit) break;
    if (radioTrackIds.includes(row.id)) continue;
    const cap = row.artist_id === artistId ? 5 : 2;
    const cur = perArtist.get(row.artist_id) || 0;
    if (cur >= cap) continue;
    radioTrackIds.push(row.id);
    perArtist.set(row.artist_id, cur + 1);
  }

  return persistSmart(
    id,
    'artist-radio',
    `${artistName} Radio`,
    `A mix inspired by ${artistName}.`,
    userId,
    radioTrackIds
  );
}

export async function generateArtistRadio(userId: string, artistId: string, limit = 30) {
  const id = smartPlaylistId('artist-radio', userId, artistId);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['artist-radio']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => generateArtistRadioFresh(userId, artistId, limit));
    }
    return cached;
  }
  return generateArtistRadioFresh(userId, artistId, limit);
}

// ─── Daylist ────────────────────────────────────────────────
// Time-of-day + weekday-aware LLM-curated playlist with a quirky
// title (e.g. "indie folk petrichor tuesday afternoon").
function describeTimeOfDay(hour: number): string {
  if (hour < 5) return 'late night';
  if (hour < 8) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'evening';
  if (hour < 23) return 'night';
  return 'late night';
}

interface DaylistConcept {
  title: string;
  description: string;
  target_genres: string[];
}

async function generateDaylistConcept(
  weekday: string,
  timeOfDay: string,
  recentGenres: string[]
): Promise<DaylistConcept | null> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return null;

  const openai = new OpenAI({ baseURL: baseUrl, apiKey });
  const recentGenresStr = recentGenres.length > 0 ? recentGenres.join(', ') : 'eclectic';

  const prompt = `You are curating a personalised daily mix for a music app, inspired by Spotify's "daylist".
Today is ${weekday} ${timeOfDay}. The listener's recent genres include: ${recentGenresStr}.

Create a single playlist concept with:
- a quirky, all-lowercase title combining 2-4 mood/genre/atmosphere words ending with the weekday and time-of-day, e.g. "indie folk petrichor tuesday afternoon", "warm cinematic ambient sunday morning", "punky neon disco friday night"
- a one-sentence description
- 3-5 target genres pulled from the listener's recent genre list when possible, otherwise loosely related

Output ONLY valid JSON, no prose:
{
  "title": "indie folk petrichor tuesday afternoon",
  "description": "Soft strings and rain-soaked guitar for an unhurried Tuesday.",
  "target_genres": ["indie folk", "ambient folk", "chamber pop"]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.choices[0].message.content;
    if (!content) return null;
    const parsed = extractJson(content);
    if (!parsed || !parsed.title || !Array.isArray(parsed.target_genres)) return null;
    return {
      title: String(parsed.title).toLowerCase(),
      description: String(parsed.description || ''),
      target_genres: parsed.target_genres.map((g: any) => String(g).toLowerCase()),
    };
  } catch (err) {
    console.error('[Daylist] LLM error', err);
    return null;
  }
}

// The title prompt asks for "<weekday> <time-of-day>" flavour, but freshness
// uses created_at instead of title text so LLM formatting cannot cause loops.
function daylistBucketSuffix(now: Date): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const timeOfDay = describeTimeOfDay(now.getHours());
  return `${weekday} ${timeOfDay}`;
}

function getDaylistBucketStartMs(now: Date): number {
  const hour = now.getHours();
  const startHour =
    hour < 5 ? 0 :
    hour < 8 ? 5 :
    hour < 12 ? 8 :
    hour < 14 ? 12 :
    hour < 17 ? 14 :
    hour < 20 ? 17 :
    hour < 23 ? 20 :
    23;
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  return start.getTime();
}

function isDaylistFromCurrentBucket(cached: Pick<CachedSmart, 'createdAtMs'> | null, now = new Date()): boolean {
  return !!cached && cached.createdAtMs >= getDaylistBucketStartMs(now);
}

async function computeDaylistFresh(userId: string, limit: number) {
  const id = smartPlaylistId('daylist', userId);
  const db = await initDB();
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const timeOfDay = describeTimeOfDay(now.getHours());

  // Recent listening signature: top genres by play count over last 7 days
  const genresRes = await db.query(
    `
    SELECT t.genre, SUM(b.play_count) AS plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= date_trunc('month', NOW() - INTERVAL '7 days')::date
      AND t.genre IS NOT NULL AND t.genre <> ''
    GROUP BY t.genre
    ORDER BY plays DESC
    LIMIT 8
    `,
    [userId]
  );
  const recentGenres = genresRes.rows.map((r: any) => String(r.genre).toLowerCase());

  const concept = await generateDaylistConcept(weekday, timeOfDay, recentGenres);
  const fallbackTitle = `${recentGenres.slice(0, 2).join(' ') || 'eclectic'} ${weekday} ${timeOfDay}`;
  const title = concept?.title || fallbackTitle;
  const description =
    concept?.description ||
    `A fresh mix for your ${weekday} ${timeOfDay}.`;
  const targetGenres = concept?.target_genres?.length ? concept.target_genres : recentGenres.slice(0, 4);

  // Pick tracks matching target genres, preferring the user's library tracks
  // they haven't played to death today
  let tracksRes;
  if (targetGenres.length > 0) {
    const placeholders = targetGenres.map((_, i) => `$${i + 2}`).join(',');
    tracksRes = await db.query(
      `
      SELECT t.id
      FROM tracks t
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE (LOWER(COALESCE(t.genre, '')) IN (${placeholders})
        OR LOWER(COALESCE(t.genres, '')) ~ ANY(ARRAY[${targetGenres.map((_, i) => `$${i + 2}`).join(',')}]))
        ${christmasExclusion('t')}
      ORDER BY RANDOM()
      LIMIT $${targetGenres.length + 2}
      `,
      [userId, ...targetGenres, limit]
    );
  } else {
    tracksRes = await db.query(
      `SELECT t.id FROM tracks t WHERE TRUE ${christmasExclusion('t')} ORDER BY RANDOM() LIMIT $1`,
      [limit]
    );
  }

  let trackIds = tracksRes.rows.map((r: any) => r.id);
  if (trackIds.length === 0) {
    const fallbackRes = await db.query(
      `
      SELECT t.id
      FROM tracks t
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE TRUE
        ${christmasExclusion('t')}
      ORDER BY
        COALESCE(ups.last_played_at, NOW() - INTERVAL '10 years') DESC,
        RANDOM()
      LIMIT $2
      `,
      [userId, limit]
    );
    trackIds = fallbackRes.rows.map((r: any) => r.id);
  }
  return persistSmart(id, 'daylist', title, description, userId, trackIds);
}

export async function computeDaylist(userId: string, limit = 30) {
  const id = smartPlaylistId('daylist', userId);
  const activity = await getUserActivity(userId);

  // Never call the LLM for a user with no listening history.
  if (!activity.hasPlayedEver) return null;

  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['daylist']);
  if (cached) {
    // Bucket-aware: if the cached playlist was created before the current
    // time-of-day bucket, force a refresh even if within TTL — but only for
    // users who have actually engaged in the last 24h.
    const bucketChanged = !isDaylistFromCurrentBucket(cached);
    if ((stale || bucketChanged) && activity.hasPlayedToday) {
      fireBackgroundRefresh(id, () => computeDaylistFresh(userId, limit));
    }
    return cached;
  }

  // First-ever generation: only proceed if user has played recently, otherwise
  // the daylist would be a random mix and the LLM call is wasted.
  if (!activity.hasPlayedRecently) return null;
  return computeDaylistFresh(userId, limit);
}

// ─── Time capsules: Seasonal Rewind + Year Rewind ─────────
// Surface only when the calendar puts us in a meaningful window:
// - Seasonal rewinds run during the matching 3-month season,
//   pulling tracks from the same season last year.
// - Year rewinds run Dec 1 – Jan 31, pulling the closing year.
// Both require ≥10 distinct tracks in the source window or they
// don't render — a sad capsule is worse than no capsule.

interface SeasonalWindow {
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  label: string;
  emoji: string;
  rangeStart: string; // 'YYYY-MM-01'
  rangeEnd: string;   // last month of season, 'YYYY-MM-01'
}

function getActiveSeasonalWindow(now: Date): SeasonalWindow | null {
  const m = now.getMonth(); // 0-indexed
  const y = now.getFullYear();
  const fmt = (yy: number, mm: number) =>
    `${yy}-${String(mm).padStart(2, '0')}-01`;

  if (m >= 2 && m <= 4) {
    return { season: 'spring', label: 'Spring Rewind', emoji: '🌸', rangeStart: fmt(y - 1, 3), rangeEnd: fmt(y - 1, 5) };
  }
  if (m >= 5 && m <= 7) {
    return { season: 'summer', label: 'Summer Rewind', emoji: '☀️', rangeStart: fmt(y - 1, 6), rangeEnd: fmt(y - 1, 8) };
  }
  if (m >= 8 && m <= 10) {
    return { season: 'autumn', label: 'Autumn Rewind', emoji: '🍂', rangeStart: fmt(y - 1, 9), rangeEnd: fmt(y - 1, 11) };
  }
  // Winter (Dec / Jan / Feb): previous full winter spans Dec → Feb across year boundary.
  if (m === 11) {
    // Dec(y): previous winter = Dec(y-1), Jan(y), Feb(y)
    return { season: 'winter', label: 'Winter Rewind', emoji: '❄️', rangeStart: fmt(y - 1, 12), rangeEnd: fmt(y, 2) };
  }
  // Jan(y) or Feb(y): previous winter = Dec(y-2), Jan(y-1), Feb(y-1)
  return { season: 'winter', label: 'Winter Rewind', emoji: '❄️', rangeStart: fmt(y - 2, 12), rangeEnd: fmt(y - 1, 2) };
}

function getActiveYearRewind(now: Date): { year: number; label: string } | null {
  const m = now.getMonth();
  const y = now.getFullYear();
  if (m === 11) return { year: y, label: `Your ${y}` };
  if (m === 0) return { year: y - 1, label: `Your ${y - 1}` };
  return null;
}

const MIN_CAPSULE_TRACKS = 10;

async function computeSeasonalRewindFresh(userId: string, limit: number) {
  const win = getActiveSeasonalWindow(new Date());
  if (!win) return null;
  const id = smartPlaylistId('seasonal-rewind', userId, win.season);
  const db = await initDB();
  const res = await db.query(
    `
    SELECT t.id, SUM(b.play_count) AS plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= $2::date
      AND b.year_month <= $3::date
      ${christmasExclusion('t')}
    GROUP BY t.id
    HAVING SUM(b.play_count) >= 2
    ORDER BY plays DESC
    LIMIT $4
    `,
    [userId, win.rangeStart, win.rangeEnd, limit]
  );
  if (res.rowCount! < MIN_CAPSULE_TRACKS) return null;
  const trackIds = res.rows.map((r: any) => r.id);
  const yearLabel = new Date(win.rangeStart).getFullYear();
  return persistSmart(
    id,
    'seasonal-rewind',
    `${win.emoji} ${win.label}`,
    `${trackIds.length} tracks that defined your ${win.season} of ${yearLabel}.`,
    userId,
    trackIds
  );
}

export async function computeSeasonalRewind(userId: string, limit = 30) {
  const win = getActiveSeasonalWindow(new Date());
  if (!win) return null;
  const id = smartPlaylistId('seasonal-rewind', userId, win.season);
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['seasonal-rewind']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeSeasonalRewindFresh(userId, limit));
    }
    return cached;
  }
  return computeSeasonalRewindFresh(userId, limit);
}

async function computeYearRewindFresh(userId: string, limit: number) {
  const yr = getActiveYearRewind(new Date());
  if (!yr) return null;
  const id = smartPlaylistId('year-rewind', userId, String(yr.year));
  const db = await initDB();
  const res = await db.query(
    `
    SELECT t.id, SUM(b.play_count) AS plays
    FROM user_track_play_buckets b
    JOIN tracks t ON t.id = b.track_id
    WHERE b.user_id = $1
      AND b.year_month >= make_date($2::int, 1, 1)
      AND b.year_month < make_date(($2::int + 1), 1, 1)
      ${christmasExclusion('t')}
    GROUP BY t.id
    HAVING SUM(b.play_count) >= 2
    ORDER BY plays DESC
    LIMIT $3
    `,
    [userId, yr.year, limit]
  );
  if (res.rowCount! < MIN_CAPSULE_TRACKS) return null;
  const trackIds = res.rows.map((r: any) => r.id);
  return persistSmart(
    id,
    'year-rewind',
    `🎉 ${yr.label}`,
    `${trackIds.length} tracks that defined your ${yr.year}.`,
    userId,
    trackIds
  );
}

export async function computeYearRewind(userId: string, limit = 50) {
  const yr = getActiveYearRewind(new Date());
  if (!yr) return null;
  const id = smartPlaylistId('year-rewind', userId, String(yr.year));
  const { cached, stale } = await getStaleOrFresh(id, TTL_MS['year-rewind']);
  if (cached) {
    if (stale) {
      fireBackgroundRefresh(id, () => computeYearRewindFresh(userId, limit));
    }
    return cached;
  }
  return computeYearRewindFresh(userId, limit);
}

// ─── Pre-warm queue ────────────────────────────────────────
// Called from the main Hub view. Skipped entirely for inactive users
// to avoid spending CPU/LLM tokens on lurkers.
export function queueSmartHubRefreshForUser(userId: string) {
  void (async () => {
    try {
      const activity = await getUserActivity(userId);
      // Lurker — return whatever's cached without recomputing anything.
      if (!activity.hasPlayedRecently) return;

      const onRepeatId = smartPlaylistId('on-repeat', userId);
      const repeatRewindId = smartPlaylistId('repeat-rewind', userId);
      const daylistId = smartPlaylistId('daylist', userId);

      const [onRepeatCache, repeatRewindCache, daylistCache] = await Promise.all([
        loadCachedSmart(onRepeatId),
        loadCachedSmart(repeatRewindId),
        loadCachedSmart(daylistId),
      ]);

      if (!onRepeatCache || onRepeatCache.ageMs > TTL_MS['on-repeat']) {
        fireBackgroundRefresh(onRepeatId, () => computeOnRepeatFresh(userId, 30));
      }
      if (!repeatRewindCache || repeatRewindCache.ageMs > TTL_MS['repeat-rewind']) {
        fireBackgroundRefresh(repeatRewindId, () => computeRepeatRewindFresh(userId, 30));
      }
      // Daylist refresh only fires if the user has actually engaged today.
      if (activity.hasPlayedToday) {
        const daylistBucketChanged = daylistCache && !isDaylistFromCurrentBucket(daylistCache);
        if (
          !daylistCache ||
          daylistCache.ageMs > TTL_MS['daylist'] ||
          daylistBucketChanged
        ) {
          fireBackgroundRefresh(daylistId, () => computeDaylistFresh(userId, 30));
        }
      }

      // Capsules pre-warm only when the calendar puts us in their window.
      const seasonal = getActiveSeasonalWindow(new Date());
      if (seasonal) {
        const seasonalId = smartPlaylistId('seasonal-rewind', userId, seasonal.season);
        const cache = await loadCachedSmart(seasonalId);
        if (!cache || cache.ageMs > TTL_MS['seasonal-rewind']) {
          fireBackgroundRefresh(seasonalId, () => computeSeasonalRewindFresh(userId, 30));
        }
      }
      const yr = getActiveYearRewind(new Date());
      if (yr) {
        const yearId = smartPlaylistId('year-rewind', userId, String(yr.year));
        const cache = await loadCachedSmart(yearId);
        if (!cache || cache.ageMs > TTL_MS['year-rewind']) {
          fireBackgroundRefresh(yearId, () => computeYearRewindFresh(userId, 50));
        }
      }
    } catch (e) {
      console.error('[SmartHub] Pre-warm failed', e);
    }
  })();
}

// ─── Bundle endpoint helper ────────────────────────────────
export async function computeSmartHubBundle(userId: string) {
  // Hard short-circuit for users with zero listening history. Saves 5+ SQL
  // queries per Hub view and prevents any chance of an LLM call.
  const activity = await getUserActivity(userId);
  if (!activity.hasPlayedEver) {
    return {
      jumpBackIn: [],
      onRepeat: null,
      repeatRewind: null,
      daylist: null,
      artistRadios: [],
      seasonalRewind: null,
      yearRewind: null,
    };
  }

  const [
    jumpBackIn,
    onRepeat,
    repeatRewind,
    daylist,
    artistRadios,
    seasonalRewind,
    yearRewind,
  ] = await Promise.all([
    computeJumpBackIn(userId).catch((e) => {
      console.error('[SmartHub] jumpBackIn failed', e);
      return [];
    }),
    computeOnRepeat(userId).catch((e) => {
      console.error('[SmartHub] onRepeat failed', e);
      return null;
    }),
    computeRepeatRewind(userId).catch((e) => {
      console.error('[SmartHub] repeatRewind failed', e);
      return null;
    }),
    computeDaylist(userId).catch((e) => {
      console.error('[SmartHub] daylist failed', e);
      return null;
    }),
    computeArtistRadioCandidates(userId).catch((e) => {
      console.error('[SmartHub] artistRadios failed', e);
      return [];
    }),
    computeSeasonalRewind(userId).catch((e) => {
      console.error('[SmartHub] seasonalRewind failed', e);
      return null;
    }),
    computeYearRewind(userId).catch((e) => {
      console.error('[SmartHub] yearRewind failed', e);
      return null;
    }),
  ]);

  return {
    jumpBackIn,
    onRepeat,
    repeatRewind,
    daylist,
    artistRadios,
    seasonalRewind,
    yearRewind,
  };
}
