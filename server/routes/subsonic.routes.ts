import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import * as mm from 'music-metadata';
import { initDB, touchSubsonicApiKey, getActiveSubsonicApiKeyByPrefix, updateSubsonicApiKeyHash, getPlaylists, getPlaylistTracks, getPlaylistMeta, createPlaylist, addTracksToPlaylist, deletePlaylist, recordPlaybackForUser, setTrackLovedForUser, setTrackRatingForUser } from '../database';
import { isPathAllowed, pathToBuffer } from '../state';
import { getOrCreateHlsSession, getSessionInfo, touchSession, getSessionOutputDir } from '../services/hlsStream.service';
import { generateScopedToken, verifyScopedToken } from '../services/scopedToken.service';

const router = Router();
const SUBSONIC_VERSION = '1.16.1';
const SERVER_VERSION = '1.0.0-rc.3';
const DEFAULT_CLIENT = 'Aurora';
const DEFAULT_HLS_QUALITY = '192';
const DEFAULT_HLS_CODEC = 'aac';
const SUBSONIC_KEY_PREFIX_LENGTH = 18;
const SUBSONIC_KEY_USAGE_TOUCH_MS = 5 * 60 * 1000;

type SubsonicContext = {
  userId: string;
  username: string;
  role: string;
  keyId: string;
  keyPrefix: string;
  rawKey?: string;
  authKind: 'apiKey' | 'mediaToken';
};

type SubsonicErrorCode = 41 | 42 | 43 | 44 | 50 | 70;

const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

type RateLimitEntry = { count: number; resetAt: number };
const rateLimitBuckets = new Map<string, RateLimitEntry>();
const keyTouchCache = new Map<string, number>();

const EMPTY_STUB_PAYLOADS: Record<string, Record<string, unknown>> = {
  getpodcasts: { podcasts: { channel: [] } },
  createpodcastchannel: {},
  deletepodcastchannel: {},
  deletepodcastepisode: {},
  downloadpodcastepisode: {},
  refreshpodcasts: {},
  getnewestpodcasts: { newestPodcasts: { episode: [] } },
  getshares: { shares: { share: [] } },
  createshare: {},
  updateshare: {},
  deleteshare: {},
  getinternetradiostations: { internetRadioStations: { internetRadioStation: [] } },
  createinternetradiostation: {},
  updateinternetradiostation: {},
  deleteinternetradiostation: {},
  getchatmessages: { chatMessages: { chatMessage: [] } },
  addchatmessage: {},
  getbookmarks: { bookmarks: { bookmark: [] } },
  createbookmark: {},
  deletebookmark: {},
  getvideoinfo: { videoInfo: { captions: [] } },
  getvideos: { videos: { video: [] } },
  getcaptions: { captions: { caption: [] } },
  getavatar: {},
  jukeboxcontrol: { jukeboxStatus: { currentIndex: -1, playing: false, gain: 1, position: 0 } },
};

function getParam(req: Request, name: string): string | undefined {
  const source = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
  const value = (source as Record<string, unknown>)[name];
  if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function getParamList(req: Request, name: string): string[] {
  const source = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
  const value = (source as Record<string, unknown>)[name];
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function normalizeMethod(raw: string): string {
  return raw.replace(/\.view$/i, '').toLowerCase();
}

function hashSubsonicApiKey(apiKey: string): string {
  return `sha256:${crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex')}`;
}

async function verifySubsonicApiKey(apiKey: string, storedHash: string): Promise<{ ok: boolean; upgradedHash?: string }> {
  if (storedHash.startsWith('sha256:')) {
    return { ok: hashSubsonicApiKey(apiKey) === storedHash };
  }

  const ok = await bcrypt.compare(apiKey, storedHash);
  return ok ? { ok, upgradedHash: hashSubsonicApiKey(apiKey) } : { ok };
}

async function touchSubsonicKeyDebounced(keyId: string) {
  const now = Date.now();
  const lastTouched = keyTouchCache.get(keyId) || 0;
  if (now - lastTouched < SUBSONIC_KEY_USAGE_TOUCH_MS) return;
  keyTouchCache.set(keyId, now);
  await touchSubsonicApiKey(keyId);
}

function rateLimitKey(req: Request, method: string): string {
  return `${method}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function subsonicRateLimiter(req: Request, res: Response, next: NextFunction) {
  const method = normalizeMethod(String(req.params.method || ''));
  const mediaMethods = new Set(['stream', 'download', 'hlssegment']);
  const limit = mediaMethods.has(method)
    ? { windowMs: 60 * 1000, max: 900 }
    : { windowMs: 5 * 60 * 1000, max: 300 };
  const now = Date.now();

  for (const [key, entry] of rateLimitBuckets) {
    if (entry.resetAt <= now) rateLimitBuckets.delete(key);
  }

  const key = rateLimitKey(req, method);
  const existing = rateLimitBuckets.get(key);
  const nextEntry = existing && existing.resetAt > now
    ? { count: existing.count + 1, resetAt: existing.resetAt }
    : { count: 1, resetAt: now + limit.windowMs };

  rateLimitBuckets.set(key, nextEntry);

  if (nextEntry.count > limit.max) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((nextEntry.resetAt - now) / 1000))));
    return sendError(req, res, 50, 'Too many Subsonic API requests. Try again later.', 429);
  }

  next();
}

export function parseSubsonicAuthParams(params: Record<string, unknown>): { apiKey?: string; error?: { code: SubsonicErrorCode; message: string } } {
  const valueOf = (name: string) => {
    const value = params[name];
    if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
    return value === undefined || value === null ? undefined : String(value);
  };
  const apiKey = valueOf('apiKey') || valueOf('api_key') || valueOf('apikey') || valueOf('key');
  const hasPasswordAuth = Boolean(valueOf('u') || valueOf('username') || valueOf('p') || valueOf('password'));
  const hasTokenAuth = Boolean(valueOf('t') || valueOf('s') || valueOf('token') || valueOf('salt'));

  if (apiKey && (hasPasswordAuth || hasTokenAuth)) {
    return { error: { code: 43, message: 'Conflicting authentication parameters. Use apiKey only.' } };
  }
  if (hasTokenAuth) {
    return { error: { code: 42, message: 'Token/salt authentication is not supported. Use an Aurora Subsonic API key.' } };
  }
  if (hasPasswordAuth) {
    return { error: { code: 41, message: 'Username/password authentication is not supported. Use an Aurora Subsonic API key.' } };
  }
  if (!apiKey) {
    return { error: { code: 43, message: 'Missing Aurora Subsonic API key.' } };
  }
  return { apiKey };
}

async function authenticateSubsonic(req: Request): Promise<{ ctx?: SubsonicContext; error?: { code: SubsonicErrorCode; message: string } }> {
  const params = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
  const parsed = parseSubsonicAuthParams(params as Record<string, unknown>);
  if (parsed.error) return { error: parsed.error };

  const keyPrefix = parsed.apiKey!.slice(0, SUBSONIC_KEY_PREFIX_LENGTH);
  const key = await getActiveSubsonicApiKeyByPrefix(keyPrefix);
  if (!key) {
    return { error: { code: 44, message: 'Invalid or revoked Aurora Subsonic API key.' } };
  }

  const verified = await verifySubsonicApiKey(parsed.apiKey!, key.key_hash);
  if (!verified.ok) {
    return { error: { code: 44, message: 'Invalid or revoked Aurora Subsonic API key.' } };
  }

  if (verified.upgradedHash) {
    await updateSubsonicApiKeyHash(key.id, verified.upgradedHash);
  }
  await touchSubsonicKeyDebounced(key.id);

  return {
    ctx: {
      userId: key.user_id,
      username: key.username,
      role: key.role,
      keyId: key.id,
      keyPrefix: key.key_prefix,
      rawKey: parsed.apiKey!,
      authKind: 'apiKey',
    },
  };
}

async function authenticateHlsSegment(req: Request): Promise<{ ctx?: SubsonicContext; error?: { code: SubsonicErrorCode; message: string } }> {
  const mediaToken = getParam(req, 'mediaToken');
  if (!mediaToken) return authenticateSubsonic(req);

  const payload = await verifyScopedToken(mediaToken, 'media');
  if (!payload) {
    return { error: { code: 44, message: 'Invalid or expired HLS media token.' } };
  }

  return {
    ctx: {
      userId: payload.userId,
      username: payload.username,
      role: payload.role,
      keyId: 'media-token',
      keyPrefix: 'media-token',
      authKind: 'mediaToken',
    },
  };
}

function baseResponse(status: 'ok' | 'failed') {
  return {
    status,
    version: SUBSONIC_VERSION,
    type: 'aurora',
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
  };
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlAttrs(attrs: Record<string, unknown>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
}

function xmlNode(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => xmlNode(name, item)).join('');
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const attrs: Record<string, unknown> = {};
    const children: string[] = [];
    for (const [key, child] of Object.entries(obj)) {
      if (Array.isArray(child) || (child && typeof child === 'object')) {
        children.push(xmlNode(key, child));
      } else {
        attrs[key] = child;
      }
    }
    return `<${name}${xmlAttrs(attrs)}>${children.join('')}</${name}>`;
  }
  return `<${name}>${escapeXml(value)}</${name}>`;
}

export function buildSubsonicXml(payload: Record<string, unknown>): string {
  const response = payload['subsonic-response'] as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  const children: string[] = [];
  for (const [key, value] of Object.entries(response)) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      children.push(xmlNode(key, value));
    } else {
      attrs[key] = value;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi"${xmlAttrs(attrs)}>${children.join('')}</subsonic-response>`;
}

export function subsonicSuccess(payload: Record<string, unknown> = {}) {
  return { 'subsonic-response': { ...baseResponse('ok'), ...payload } };
}

export function subsonicError(code: SubsonicErrorCode, message: string) {
  return { 'subsonic-response': { ...baseResponse('failed'), error: { code, message } } };
}

function sendSubsonic(req: Request, res: Response, payload: Record<string, unknown>) {
  const format = (getParam(req, 'f') || 'xml').toLowerCase();
  if (format === 'json' || format === 'jsonp') {
    if (format === 'jsonp') {
      const callback = getParam(req, 'callback') || 'callback';
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
        res.status(400).type('text/plain').send('Invalid JSONP callback');
        return;
      }
      res.type('application/javascript').send(`${callback}(${JSON.stringify(payload)});`);
      return;
    }
    res.json(payload);
    return;
  }
  res.type('application/xml').send(buildSubsonicXml(payload));
}

function sendError(req: Request, res: Response, code: SubsonicErrorCode, message: string, status = 200) {
  res.status(status);
  sendSubsonic(req, res, subsonicError(code, message));
}

function artistId(id: string) { return id.startsWith('artist:') ? id.slice(7) : id; }
function albumId(id: string) { return id.startsWith('album:') ? id.slice(6) : id; }
function songId(id: string) { return id.startsWith('song:') ? id.slice(5) : id; }
function subsonicArtistId(id: string) { return `artist:${id}`; }
function subsonicAlbumId(id: string) { return `album:${id}`; }
function subsonicSongId(id: string) { return `song:${id}`; }

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date
    ? value
    : typeof value === 'number'
      ? new Date(value)
      : /^\d{10,}$/.test(String(value))
        ? new Date(Number(value))
        : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function suffixFor(track: any): string {
  const ext = track.path ? path.extname(String(track.path)).slice(1).toLowerCase() : '';
  return ext || String(track.format || 'mp3').toLowerCase();
}

export function mapTrackToSubsonic(track: any, userId?: string) {
  const suffix = suffixFor(track);
  const duration = Number.isFinite(Number(track.duration)) ? Math.round(Number(track.duration)) : undefined;
  const bitRate = Number.isFinite(Number(track.bitrate)) ? Math.round(Number(track.bitrate) / 1000) : undefined;
  return {
    id: subsonicSongId(track.id),
    parent: track.album_id ? subsonicAlbumId(track.album_id) : undefined,
    isDir: false,
    title: track.title || path.basename(String(track.path || track.id)),
    album: track.album || undefined,
    artist: track.artist || undefined,
    track: track.track_number || undefined,
    discNumber: track.disc_number || undefined,
    year: track.year || undefined,
    genre: track.genre || undefined,
    coverArt: subsonicSongId(track.id),
    size: track.size || undefined,
    contentType: MIME_TYPES[suffix] || 'audio/mpeg',
    suffix,
    duration,
    bitRate,
    path: undefined,
    isVideo: false,
    created: toIso(track.created_at),
    albumId: track.album_id ? subsonicAlbumId(track.album_id) : undefined,
    artistId: track.artist_id ? subsonicArtistId(track.artist_id) : undefined,
    type: 'music',
    userRating: track.user_rating ?? track.rating ?? undefined,
    starred: track.is_loved ? toIso(track.loved_at) || new Date().toISOString() : undefined,
  };
}

function mapAlbum(row: any, songCount?: number, duration?: number) {
  return {
    id: subsonicAlbumId(row.id),
    name: row.title || 'Unknown Album',
    title: row.title || 'Unknown Album',
    artist: row.artist_name || undefined,
    artistId: row.artist_id ? subsonicArtistId(row.artist_id) : undefined,
    coverArt: subsonicAlbumId(row.id),
    songCount: Number(songCount || row.song_count || 0),
    duration: Number(duration || row.duration || 0),
    created: toIso(row.created_at),
    year: row.release_year || undefined,
    genre: row.genre || undefined,
    isDir: true,
  };
}

export function mapArtist(row: any, albumCount?: number) {
  return {
    id: subsonicArtistId(row.id),
    name: row.name || 'Unknown Artist',
    title: row.name || 'Unknown Artist',
    albumCount: Number(albumCount || row.album_count || 0),
    artistImageUrl: row.image_url || row.artwork_url || undefined,
    starred: undefined,
  };
}

export function buildAlbumListPayload(method: string, albums: any[]) {
  const key = method === 'getalbumlist2' ? 'albumList2' : 'albumList';
  return { [key]: { album: albums.map((row) => mapAlbum(row)) } };
}

export function buildSearchPayload(method: string, payload: Record<string, unknown>) {
  const key = method === 'search3'
    ? 'searchResult3'
    : method === 'search2'
      ? 'searchResult2'
      : 'searchResult';
  return { [key]: payload };
}

async function getTrackRow(id: string, userId: string) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved
    FROM tracks t
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2
    LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2
    WHERE t.id = $1
  `, [songId(id), userId]);
  return res.rows[0] || null;
}

async function resolvePlayableTrack(id: string, userId: string) {
  const track = await getTrackRow(id, userId);
  if (!track?.path) {
    const err = new Error('Track not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const fileBuf = pathToBuffer(track.path);
  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    const err = new Error('Forbidden') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  return { track, fileBuf };
}

async function streamFile(req: Request, res: Response, id: string, userId: string, download = false) {
  const { track, fileBuf } = await resolvePlayableTrack(id, userId);
  if (!fs.existsSync(fileBuf)) return res.status(404).send('File not found');

  const stat = fs.statSync(fileBuf);
  const ext = path.extname(fileBuf.toString('utf8')).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
  const fileName = path.basename(fileBuf.toString('utf8'));
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = Math.max(0, parseInt(parts[0], 10) || 0);
    const end = parts[1] ? Math.min(stat.size - 1, parseInt(parts[1], 10)) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.sendStatus(416);
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(fileBuf, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(fileBuf).pipe(res);
}

function findImageStart(buf: Uint8Array): number {
  const maxScan = Math.min(buf.length - 12, 4096);
  for (let i = 0; i <= maxScan; i++) {
    const b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2], b3 = buf[i + 3];
    if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return i;
    if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return i;
    if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return i;
    if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46 && buf[i + 8] === 0x57 && buf[i + 9] === 0x45 && buf[i + 10] === 0x42 && buf[i + 11] === 0x50) return i;
    if (b0 === 0x42 && b1 === 0x4D) return i;
  }
  return -1;
}

async function sendCoverArt(req: Request, res: Response, id: string, userId: string) {
  let trackId = songId(id);
  const db = await initDB();
  if (id.startsWith('album:')) {
    const albumTrack = await db.query('SELECT id FROM tracks WHERE album_id = $1 AND path IS NOT NULL ORDER BY disc_number NULLS LAST, track_number NULLS LAST, title LIMIT 1', [albumId(id)]);
    trackId = albumTrack.rows[0]?.id || '';
  } else if (id.startsWith('artist:')) {
    const artistTrack = await db.query('SELECT id FROM tracks WHERE artist_id = $1 AND path IS NOT NULL ORDER BY album, disc_number NULLS LAST, track_number NULLS LAST, title LIMIT 1', [artistId(id)]);
    trackId = artistTrack.rows[0]?.id || '';
  }
  const { fileBuf } = await resolvePlayableTrack(trackId, userId);
  if (!fs.existsSync(fileBuf)) return res.status(404).send('Not found');

  const metadata = await mm.parseFile(fileBuf.toString('utf8'));
  const picture = metadata.common.picture?.[0];
  if (!picture) return res.status(404).send('No art found');
  let data: Uint8Array = picture.data;
  const start = findImageStart(data);
  if (start > 0) data = data.subarray(start);
  const format = /^[\x20-\x7E]+$/.test(picture.format) ? picture.format : 'image/jpeg';
  res.setHeader('Content-Type', format);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

async function sendHls(req: Request, res: Response, id: string, ctx: SubsonicContext) {
  const quality = getParam(req, 'maxBitRate') || DEFAULT_HLS_QUALITY;
  const codec = DEFAULT_HLS_CODEC;
  const { track, fileBuf } = await resolvePlayableTrack(id, ctx.userId);
  await getOrCreateHlsSession(songId(id), fileBuf, `${quality}k`, Number(track.bitrate) || null, track.format || null, codec);
  const session = getSessionInfo(songId(id), `${quality}k`, codec);
  if (!session || !fs.existsSync(session.playlistPath)) return res.status(500).send('HLS unavailable');
  touchSession(songId(id), `${quality}k`, codec);
  const mediaToken = await generateScopedToken('media', {
    userId: ctx.userId,
    username: ctx.username,
    role: ctx.role,
  });
  const query = new URLSearchParams({
    id: subsonicSongId(songId(id)),
    mediaToken,
    f: getParam(req, 'f') || 'json',
    maxBitRate: quality,
  });
  const playlist = fs.readFileSync(session.playlistPath, 'utf8').replace(/^(segment\d+\.ts)$/gm, (_match, segment) => {
    query.set('segment', segment);
    return `/rest/hlsSegment.view?${query.toString()}`;
  });
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', session.finished ? 'public, max-age=30' : 'no-cache');
  res.send(playlist);
}

async function sendHlsSegment(req: Request, res: Response, id: string) {
  const segment = getParam(req, 'segment') || '';
  if (!/^segment\d+\.ts$/.test(segment)) return res.status(400).send('Invalid segment');
  const quality = getParam(req, 'maxBitRate') || DEFAULT_HLS_QUALITY;
  const outputDir = getSessionOutputDir(songId(id), `${quality}k`, DEFAULT_HLS_CODEC);
  if (!outputDir) return res.status(404).send('No HLS session');
  const segmentPath = path.join(outputDir, segment);
  if (!fs.existsSync(segmentPath)) return res.status(404).send('Segment not found');
  touchSession(songId(id), `${quality}k`, DEFAULT_HLS_CODEC);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(segmentPath).pipe(res);
}

async function getAlbumSummaries(userId: string, where = '', params: unknown[] = []) {
  const db = await initDB();
  const res = await db.query(`
    SELECT a.*, COUNT(t.id)::int AS song_count, COALESCE(SUM(t.duration), 0)::int AS duration,
           MIN(t.artist_id::text) AS artist_id, MIN(t.genre) AS genre
    FROM albums a
    LEFT JOIN tracks t ON t.album_id = a.id
    ${where}
    GROUP BY a.id
    ORDER BY a.title ASC
  `, params);
  return res.rows.map((row) => mapAlbum(row));
}

async function handleSystem(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  switch (method) {
    case 'ping':
      return sendSubsonic(req, res, subsonicSuccess({}));
    case 'getlicense':
      return sendSubsonic(req, res, subsonicSuccess({ license: { valid: true } }));
    case 'getopensubsonicextensions':
      return sendSubsonic(req, res, subsonicSuccess({
        openSubsonicExtensions: {
          extension: [
            { name: 'apiKeyAuthentication', versions: [1] },
            { name: 'formPost', versions: [1] },
          ],
        },
      }));
    case 'tokeninfo':
      return sendSubsonic(req, res, subsonicSuccess({
        tokenInfo: {
          username: ctx.username,
          keyPrefix: ctx.keyPrefix,
          role: ctx.role,
        },
      }));
    default:
      return false;
  }
}

async function handleBrowsing(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  const db = await initDB();
  switch (method) {
    case 'getmusicfolders':
      return sendSubsonic(req, res, subsonicSuccess({ musicFolders: { musicFolder: [{ id: '1', name: 'Aurora Library' }] } }));
    case 'getindexes': {
      const artists = await db.query(`
        SELECT a.*, COUNT(t.album_id)::int AS album_count
        FROM artists a
        LEFT JOIN (
          SELECT DISTINCT artist_id, album_id
          FROM tracks
          WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
        ) t ON t.artist_id = a.id
        WHERE a.merged_into IS NULL
        GROUP BY a.id
        ORDER BY a.name ASC
      `);
      const grouped = new Map<string, any[]>();
      for (const row of artists.rows) {
        const letter = /^[A-Za-z]$/.test(String(row.name || '').charAt(0)) ? String(row.name).charAt(0).toUpperCase() : '#';
        if (!grouped.has(letter)) grouped.set(letter, []);
        grouped.get(letter)!.push(mapArtist(row, row.album_count));
      }
      return sendSubsonic(req, res, subsonicSuccess({ indexes: { index: Array.from(grouped.entries()).map(([name, artist]) => ({ name, artist })) } }));
    }
    case 'getmusicdirectory': {
      const id = getParam(req, 'id') || 'root';
      if (id === 'root' || id === '1') {
        const artists = await db.query(`
          SELECT a.*, COUNT(t.album_id)::int AS album_count
          FROM artists a
          LEFT JOIN (
            SELECT DISTINCT artist_id, album_id
            FROM tracks
            WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
          ) t ON t.artist_id = a.id
          WHERE a.merged_into IS NULL
          GROUP BY a.id
          ORDER BY a.name ASC
        `);
        return sendSubsonic(req, res, subsonicSuccess({
          directory: {
            id: 'root',
            name: 'Aurora Library',
            child: artists.rows.map((row) => ({
              ...mapArtist(row, row.album_count),
              parent: 'root',
              isDir: true,
            })),
          },
        }));
      }
      if (id.startsWith('artist:')) {
        const artist = await db.query('SELECT * FROM artists WHERE id = $1', [artistId(id)]);
        const albums = await getAlbumSummaries(ctx.userId, 'WHERE t.artist_id = $1', [artistId(id)]);
        return sendSubsonic(req, res, subsonicSuccess({
          directory: {
            id,
            name: artist.rows[0]?.name || 'Artist',
            child: albums.map((album) => ({ ...album, parent: id, isDir: true })),
          },
        }));
      }
      const album = await db.query('SELECT * FROM albums WHERE id = $1', [albumId(id)]);
      const tracks = await db.query('SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2 WHERE t.album_id = $1 ORDER BY t.disc_number NULLS LAST, t.track_number NULLS LAST, t.title', [albumId(id), ctx.userId]);
      return sendSubsonic(req, res, subsonicSuccess({ directory: { id, name: album.rows[0]?.title || 'Album', child: tracks.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getgenres': {
      const genres = await db.query('SELECT COALESCE(NULLIF(TRIM(genre), \'\'), \'Unknown Genre\') AS name, COUNT(*)::int AS song_count FROM tracks GROUP BY 1 ORDER BY 1 ASC');
      return sendSubsonic(req, res, subsonicSuccess({ genres: { genre: genres.rows.map((row) => ({ value: row.name, songCount: row.song_count, albumCount: 0 })) } }));
    }
    case 'getartists': {
      const artists = await db.query(`
        SELECT a.*, COUNT(t.album_id)::int AS album_count
        FROM artists a
        LEFT JOIN (
          SELECT DISTINCT artist_id, album_id
          FROM tracks
          WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
        ) t ON t.artist_id = a.id
        WHERE a.merged_into IS NULL
        GROUP BY a.id
        ORDER BY a.name ASC
      `);
      return sendSubsonic(req, res, subsonicSuccess({ artists: { index: [{ name: 'All', artist: artists.rows.map((row) => mapArtist(row, row.album_count)) }] } }));
    }
    case 'getartist': {
      const id = artistId(getParam(req, 'id') || '');
      const artist = await db.query('SELECT * FROM artists WHERE id = $1', [id]);
      if (!artist.rows[0]) return sendError(req, res, 70, 'Artist not found');
      const albums = await getAlbumSummaries(ctx.userId, 'WHERE t.artist_id = $1', [id]);
      return sendSubsonic(req, res, subsonicSuccess({ artist: { ...mapArtist(artist.rows[0], albums.length), album: albums } }));
    }
    case 'getalbum': {
      const id = albumId(getParam(req, 'id') || '');
      const album = await db.query('SELECT * FROM albums WHERE id = $1', [id]);
      if (!album.rows[0]) return sendError(req, res, 70, 'Album not found');
      const tracks = await db.query('SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2 WHERE t.album_id = $1 ORDER BY t.disc_number NULLS LAST, t.track_number NULLS LAST, t.title', [id, ctx.userId]);
      const summary = mapAlbum(album.rows[0], tracks.rows.length, tracks.rows.reduce((sum, row) => sum + Number(row.duration || 0), 0));
      return sendSubsonic(req, res, subsonicSuccess({ album: { ...summary, song: tracks.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getsong': {
      const track = await getTrackRow(getParam(req, 'id') || '', ctx.userId);
      if (!track) return sendError(req, res, 70, 'Song not found');
      return sendSubsonic(req, res, subsonicSuccess({ song: mapTrackToSubsonic(track, ctx.userId) }));
    }
    default:
      return false;
  }
}

async function handleLists(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  const db = await initDB();
  switch (method) {
    case 'getalbumlist':
    case 'getalbumlist2': {
      const type = (getParam(req, 'type') || 'alphabeticalByName').toLowerCase();
      const size = Math.max(1, Math.min(500, parseInt(getParam(req, 'size') || '10', 10) || 10));
      const genre = getParam(req, 'genre');
      let order = 'a.title ASC';
      if (type === 'newest' || type === 'recent') order = 'a.created_at DESC';
      if (type === 'random') order = 'RANDOM()';
      if (type === 'alphabeticalbyartist') order = 'a.artist_name ASC, a.title ASC';
      const params: unknown[] = [];
      const where = genre ? 'WHERE LOWER(t.genre) = LOWER($1)' : '';
      if (genre) params.push(genre);
      const albums = await db.query(`
        SELECT a.*, COUNT(t.id)::int AS song_count, COALESCE(SUM(t.duration), 0)::int AS duration, MIN(t.artist_id::text) AS artist_id, MIN(t.genre) AS genre
        FROM albums a LEFT JOIN tracks t ON t.album_id = a.id
        ${where}
        GROUP BY a.id
        ORDER BY ${order}
        LIMIT ${size}
      `, params);
      return sendSubsonic(req, res, subsonicSuccess(buildAlbumListPayload(method, albums.rows)));
    }
    case 'getrandomsongs': {
      const size = Math.max(1, Math.min(500, parseInt(getParam(req, 'size') || '10', 10) || 10));
      const countRes = await db.query('SELECT COUNT(*)::int AS count FROM tracks');
      const totalTracks = Number(countRes.rows[0]?.count || 0);
      const randomOffset = totalTracks > size ? Math.floor(Math.random() * Math.max(1, totalTracks - size)) : 0;
      const songs = await db.query('SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $1 ORDER BY t.id OFFSET $2 LIMIT $3', [ctx.userId, randomOffset, size]);
      return sendSubsonic(req, res, subsonicSuccess({ randomSongs: { song: songs.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getsongsbygenre': {
      const genre = getParam(req, 'genre') || '';
      const count = Math.max(1, Math.min(500, parseInt(getParam(req, 'count') || '10', 10) || 10));
      const songs = await db.query('SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $1 WHERE LOWER(t.genre) = LOWER($2) ORDER BY t.title LIMIT $3', [ctx.userId, genre, count]);
      return sendSubsonic(req, res, subsonicSuccess({ songsByGenre: { song: songs.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) } }));
    }
    case 'getstarred':
    case 'getstarred2': {
      const rows = await db.query('SELECT t.*, ult.loved_at, TRUE AS is_loved, ups.rating AS user_rating FROM user_loved_tracks ult JOIN tracks t ON t.id = ult.track_id LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = ult.user_id WHERE ult.user_id = $1 ORDER BY ult.loved_at DESC', [ctx.userId]);
      const payloadName = method === 'getstarred2' ? 'starred2' : 'starred';
      return sendSubsonic(req, res, subsonicSuccess({ [payloadName]: { song: rows.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)), album: [], artist: [] } }));
    }
    case 'search':
    case 'search2':
    case 'search3': {
      const query = (getParam(req, 'query') || getParam(req, 'any') || '').trim();
      const term = `%${query}%`;
      const artistCount = Math.max(0, Math.min(100, parseInt(getParam(req, 'artistCount') || '20', 10) || 20));
      const albumCount = Math.max(0, Math.min(100, parseInt(getParam(req, 'albumCount') || '20', 10) || 20));
      const songCount = Math.max(0, Math.min(200, parseInt(getParam(req, 'songCount') || '50', 10) || 50));
      const [artists, albums, songs] = await Promise.all([
        db.query(`
          SELECT a.*, COUNT(t.album_id)::int AS album_count
          FROM artists a
          LEFT JOIN (
            SELECT DISTINCT artist_id, album_id
            FROM tracks
            WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
          ) t ON t.artist_id = a.id
          WHERE a.name ILIKE $1
          GROUP BY a.id
          ORDER BY a.name
          LIMIT $2
        `, [term, artistCount]),
        db.query('SELECT a.*, COUNT(t.id)::int AS song_count, COALESCE(SUM(t.duration), 0)::int AS duration, MIN(t.artist_id::text) AS artist_id FROM albums a LEFT JOIN tracks t ON t.album_id = a.id WHERE a.title ILIKE $1 OR a.artist_name ILIKE $1 GROUP BY a.id ORDER BY a.title LIMIT $2', [term, albumCount]),
        db.query('SELECT t.*, ups.rating AS user_rating, ult.loved_at, (ult.track_id IS NOT NULL) AS is_loved FROM tracks t LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $2 LEFT JOIN user_loved_tracks ult ON ult.track_id = t.id AND ult.user_id = $2 WHERE t.title ILIKE $1 OR t.artist ILIKE $1 OR t.album ILIKE $1 ORDER BY t.title LIMIT $3', [term, ctx.userId, songCount]),
      ]);
      const payload = { artist: artists.rows.map((row) => mapArtist(row, row.album_count)), album: albums.rows.map((row) => mapAlbum(row)), song: songs.rows.map((row) => mapTrackToSubsonic(row, ctx.userId)) };
      return sendSubsonic(req, res, subsonicSuccess(buildSearchPayload(method, payload)));
    }
    default:
      return false;
  }
}

async function handlePlaylists(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  switch (method) {
    case 'getplaylists': {
      const playlists = await getPlaylists(ctx.userId);
      return sendSubsonic(req, res, subsonicSuccess({ playlists: { playlist: playlists.map((playlist: any) => ({ id: playlist.id, name: playlist.title, comment: playlist.description || undefined, songCount: 0, public: false, owner: ctx.username, created: toIso(playlist.createdAt), changed: toIso(playlist.createdAt), readOnly: !!playlist.isSystem })) } }));
    }
    case 'getplaylist': {
      const id = getParam(req, 'id') || '';
      const playlists = await getPlaylists(ctx.userId);
      const playlist = playlists.find((item: any) => item.id === id);
      if (!playlist) return sendError(req, res, 70, 'Playlist not found');
      const tracks = await getPlaylistTracks(id, ctx.userId);
      return sendSubsonic(req, res, subsonicSuccess({ playlist: { id, name: playlist.title, comment: playlist.description || undefined, owner: ctx.username, public: false, songCount: tracks.length, duration: tracks.reduce((sum: number, track: any) => sum + Number(track.duration || 0), 0), entry: tracks.map((track: any) => mapTrackToSubsonic(track, ctx.userId)), readOnly: !!playlist.isSystem } }));
    }
    case 'createplaylist': {
      const name = (getParam(req, 'name') || getParam(req, 'playlistId') || 'Subsonic Playlist').trim().slice(0, 120);
      const id = `subsonic_${Date.now()}`;
      await createPlaylist(id, name, null, false, ctx.userId);
      const songs = getParamList(req, 'songId').map(songId);
      if (songs.length > 0) await addTracksToPlaylist(id, songs);
      return sendSubsonic(req, res, subsonicSuccess({ playlist: { id, name, songCount: songs.length } }));
    }
    case 'updateplaylist': {
      const id = getParam(req, 'playlistId') || getParam(req, 'id') || '';
      const meta = await getPlaylistMeta(id);
      if (!meta) return sendError(req, res, 70, 'Playlist not found');
      if (meta.isSystem) return sendError(req, res, 50, 'System playlists are read-only');
      if (meta.userId !== ctx.userId && ctx.role !== 'admin') return sendError(req, res, 50, 'Playlist belongs to another user');
      const existing = await getPlaylistTracks(id, ctx.userId);
      const removeIndexes = new Set(getParamList(req, 'songIndexToRemove').map((value) => parseInt(value, 10)).filter(Number.isFinite));
      let nextIds = existing.map((track: any) => track.id).filter((_id: string, index: number) => !removeIndexes.has(index));
      const addIds = getParamList(req, 'songIdToAdd').map(songId);
      nextIds = nextIds.concat(addIds);
      await addTracksToPlaylist(id, nextIds);
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    case 'deleteplaylist': {
      const id = getParam(req, 'id') || '';
      const meta = await getPlaylistMeta(id);
      if (!meta) return sendError(req, res, 70, 'Playlist not found');
      if (meta.isSystem) return sendError(req, res, 50, 'System playlists are read-only');
      if (meta.userId !== ctx.userId && ctx.role !== 'admin') return sendError(req, res, 50, 'Playlist belongs to another user');
      await deletePlaylist(id, ctx.role === 'admin' ? null : ctx.userId);
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    default:
      return false;
  }
}

async function handleAnnotations(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  const id = getParam(req, 'id') || '';
  switch (method) {
    case 'star':
      await setTrackLovedForUser(ctx.userId, songId(id), true);
      return sendSubsonic(req, res, subsonicSuccess({}));
    case 'unstar':
      await setTrackLovedForUser(ctx.userId, songId(id), false);
      return sendSubsonic(req, res, subsonicSuccess({}));
    case 'setrating': {
      const rating = parseInt(getParam(req, 'rating') || '0', 10);
      await setTrackRatingForUser(ctx.userId, songId(id), Number.isFinite(rating) ? rating : 0);
      return sendSubsonic(req, res, subsonicSuccess({}));
    }
    case 'scrobble':
      if (id) await recordPlaybackForUser(ctx.userId, songId(id));
      return sendSubsonic(req, res, subsonicSuccess({}));
    default:
      return false;
  }
}

async function dispatch(req: Request, res: Response, method: string, ctx: SubsonicContext) {
  if (await handleSystem(req, res, method, ctx) !== false) return;
  if (method === 'stream') return streamFile(req, res, getParam(req, 'id') || '', ctx.userId, false);
  if (method === 'download') return streamFile(req, res, getParam(req, 'id') || '', ctx.userId, true);
  if (method === 'getcoverart') return sendCoverArt(req, res, getParam(req, 'id') || '', ctx.userId);
  if (method === 'hls') return sendHls(req, res, getParam(req, 'id') || '', ctx);
  if (method === 'hlssegment') return sendHlsSegment(req, res, getParam(req, 'id') || '');
  if (await handleBrowsing(req, res, method, ctx) !== false) return;
  if (await handleLists(req, res, method, ctx) !== false) return;
  if (await handlePlaylists(req, res, method, ctx) !== false) return;
  if (await handleAnnotations(req, res, method, ctx) !== false) return;
  if (EMPTY_STUB_PAYLOADS[method]) return sendSubsonic(req, res, subsonicSuccess(EMPTY_STUB_PAYLOADS[method]));
  sendError(req, res, 70, `Unsupported OpenSubsonic endpoint: ${method}`);
}

router.all('/:method', subsonicRateLimiter, async (req, res) => {
  const method = normalizeMethod(String(req.params.method));
  try {
    const auth = method === 'hlssegment'
      ? await authenticateHlsSegment(req)
      : await authenticateSubsonic(req);
    if (auth.error || !auth.ctx) return sendError(req, res, auth.error?.code || 44, auth.error?.message || 'Authentication failed');
    await dispatch(req, res, method, auth.ctx);
  } catch (error: any) {
    console.error(`[Subsonic] ${method} error:`, error?.message || error);
    if (res.headersSent) return;
    if (error?.status === 404) return res.status(404).send('Not found');
    if (error?.status === 403) return res.status(403).send('Forbidden');
    sendError(req, res, 70, error?.message || 'Subsonic request failed');
  }
});

export default router;
