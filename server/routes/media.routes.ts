import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import * as mm from 'music-metadata';
import { isPathAllowed, pathToBuffer } from '../state';
import { initDB } from '../database';
import {
  getOrCreateHlsSession,
  getSessionInfo,
  touchSession,
  getSessionOutputDir,
  getActiveSessionVariants,
} from '../services/hlsStream.service';
import { writeCastReceiverLog, writeHlsServerLog, writeHlsSessionLog } from '../services/debugLogger.service';

const router = Router();
const HLS_SEGMENT_LINE = /^(segment\d+\.ts)$/gm;
const HLS_MEDIA_PLAYLIST_NAME = 'media.m3u8';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mime type map
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

// CORS helper to handle authenticated requests and custom headers
const setCorsHeaders = (req: any, res: any) => {
  const origin = req.headers.origin;
  // If we have an origin, echo it back instead of using '*' to allow withCredentials/Authorization
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
};

// ─── HLS Streaming ─────────────────────────────────────────────────────

function validateHlsPlaylist(playlist: string): { valid: boolean; error?: string } {
  if (!playlist.startsWith('#EXTM3U')) {
    return { valid: false, error: 'Playlist is missing #EXTM3U header' };
  }

  const lines = playlist.split(/\r?\n/);
  const singleInstanceTags = [
    '#EXT-X-TARGETDURATION:',
    '#EXT-X-MEDIA-SEQUENCE:',
    '#EXT-X-PLAYLIST-TYPE:',
    '#EXT-X-VERSION:',
    '#EXT-X-ENDLIST',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  for (const tag of singleInstanceTags) {
    const count = lines.filter((line) => line === tag || line.startsWith(tag)).length;
    if (count > 1) {
      return { valid: false, error: `Playlist contains duplicate ${tag.replace(/:$/, '')} tags` };
    }
  }

  const targetDurationLine = lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:'));
  if (!targetDurationLine) {
    return { valid: false, error: 'Playlist is missing EXT-X-TARGETDURATION' };
  }

  const targetDuration = parseInt(targetDurationLine.split(':')[1] || '', 10);
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    return { valid: false, error: 'Playlist has invalid EXT-X-TARGETDURATION' };
  }

  for (const line of lines) {
    if (!line.startsWith('#EXTINF:')) continue;
    const durationValue = parseFloat(line.slice('#EXTINF:'.length).split(',')[0] || '');
    if (!Number.isFinite(durationValue)) {
      return { valid: false, error: 'Playlist has invalid EXTINF duration' };
    }
    if (Math.round(durationValue) > targetDuration) {
      return { valid: false, error: 'EXTINF exceeds EXT-X-TARGETDURATION' };
    }
  }

  return { valid: true };
}

function inferCodecString(codec: string): string {
  switch (codec) {
    case 'aac':
    case 'aac_he':
      return 'mp4a.40.2';
    case 'mp3':
      return 'mp4a.69';
    case 'ac3':
      return 'ac-3';
    case 'eac3':
      return 'ec-3';
    default:
      return 'mp4a.40.2';
  }
}

function inferBandwidth(quality: string, codec: string, sourceBitrate?: number | null): number {
  if (quality === 'source') {
    if (codec === 'aac' || codec === 'aac_he') {
      return sourceBitrate && Number.isFinite(sourceBitrate) && sourceBitrate > 0
        ? Math.min(sourceBitrate, 320000)
        : 320000;
    }
    return sourceBitrate && Number.isFinite(sourceBitrate) && sourceBitrate > 0
      ? sourceBitrate
      : 320000;
  }

  const parsed = parseInt(quality, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed * 1000;
  }
  return 192000;
}

function buildMasterPlaylist(trackId: string, quality: string, codec: string, token?: string, sourceBitrate?: number | null): string {
  const params = new URLSearchParams({
    quality,
    codec,
  });
  if (token) params.set('token', token);

  const codecString = inferCodecString(codec);
  const averageBandwidth = inferBandwidth(quality, codec, sourceBitrate);
  const bandwidth = Math.round(averageBandwidth * 1.15);

  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${averageBandwidth},CODECS="${codecString}"`,
    `${HLS_MEDIA_PLAYLIST_NAME}?${params.toString()}`,
    '',
  ].join('\n');
}

function rewriteMediaPlaylistSegments(playlist: string, quality: string, codec: string, token?: string): string {
  const segmentSuffix = `?quality=${encodeURIComponent(quality)}&codec=${encodeURIComponent(codec)}`
    + (token ? `&token=${encodeURIComponent(token)}` : '');

  return playlist.replace(
    HLS_SEGMENT_LINE,
    `$1${segmentSuffix}`
  );
}

async function resolveTrackForHls(trackId: string): Promise<{
  fileBuf: Buffer;
  bitrate: number | null;
  sourceFormat: string | null;
}> {
  let fileBuf: Buffer;
  let bitrate: number | null = null;
  let sourceFormat: string | null = null;

  if (UUID_REGEX.test(trackId)) {
    const db = await initDB();
    const result = await db.query('SELECT path, bitrate, format FROM tracks WHERE id = $1', [trackId]);
    if (result.rows.length === 0) {
      const err = new Error('Track not found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    fileBuf = pathToBuffer(result.rows[0].path);
    bitrate = result.rows[0].bitrate;
    sourceFormat = result.rows[0].format;
  } else {
    const dbPath = Buffer.from(decodeURIComponent(trackId), 'base64').toString();
    fileBuf = pathToBuffer(dbPath);

    try {
      const db = await initDB();
      const result = await db.query('SELECT bitrate, format FROM tracks WHERE path = $1', [dbPath]);
      if (result.rows.length > 0) {
        bitrate = result.rows[0].bitrate;
        sourceFormat = result.rows[0].format;
      }
    } catch { /* non-critical */ }
  }

  return { fileBuf, bitrate, sourceFormat };
}

function normalizeTargetCodec(codec: string, quality: string): string {
  if ((codec === 'ac3' || codec === 'eac3') && quality !== 'source' && parseInt(quality, 10) < 256) {
    console.log(`[HLS] Overriding ${codec} → AAC (${quality} too low for AC-3)`);
    return 'aac';
  }
  return codec;
}

async function ensureHlsSessionForRequest(trackId: string, quality: string, targetCodec: string) {
  const { fileBuf, bitrate, sourceFormat } = await resolveTrackForHls(trackId);
  const codec = normalizeTargetCodec(targetCodec, quality);
  await getOrCreateHlsSession(trackId, fileBuf, quality, bitrate, sourceFormat, codec);
  return {
    codec,
    sessionInfo: getSessionInfo(trackId, quality, codec),
  };
}

function sanitizeCastLogValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/([?&]token=)[^&\s]+/g, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[redacted]"')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt-redacted]')
    .slice(0, 2000);
}

router.post('/cast/log', (req, res) => {
  const source = sanitizeCastLogValue(typeof req.body?.source === 'string' ? req.body.source : 'receiver');
  const level = sanitizeCastLogValue(typeof req.body?.level === 'string' ? req.body.level : 'info');
  const message = sanitizeCastLogValue(typeof req.body?.message === 'string' ? req.body.message : '');
  const detail = sanitizeCastLogValue(typeof req.body?.detail === 'string' ? req.body.detail : '');
  const session = sanitizeCastLogValue(typeof req.body?.session === 'string' ? req.body.session : '');

  writeCastReceiverLog(`[${level}] [${source}]${session ? ` [${session}]` : ''} ${message}${detail ? ` :: ${detail}` : ''}`);
  res.sendStatus(204);
});

// Serve HLS playlist for a track
router.all('/stream/:trackId/playlist.m3u8', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { trackId } = req.params;
  const quality = (req.query.quality as string) || '128k';
  let targetCodec = (req.query.codec as string) || 'aac'; // safe universal default

  try {
    const token = req.query.token as string | undefined;
    const { bitrate } = await resolveTrackForHls(trackId);
    const output = buildMasterPlaylist(trackId, quality, targetCodec, token, bitrate);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    writeHlsServerLog(`[playlist ${trackId} ${quality} ${targetCodec}] Served master playlist`);
    writeHlsSessionLog(trackId, quality, targetCodec, `Served master playlist: ${output.split(/\r?\n/).join('\\n')}`);
    res.send(output);
  } catch (err: any) {
    console.error('[HLS] Playlist error:', err?.message || err);
    writeHlsServerLog(`[playlist ${trackId} ${quality} ${targetCodec}] Error: ${err?.message || String(err)}`);
    if (!res.headersSent) {
      if (err?.code === 'ENOENT' || err?.message?.includes('ENOENT')) {
        res.status(501).send('FFmpeg not installed — HLS streaming unavailable');
      } else {
        res.status(500).send('HLS streaming error');
      }
    }
  }
});

router.all('/stream/:trackId/media.m3u8', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { trackId } = req.params;
  const quality = (req.query.quality as string) || '128k';
  let targetCodec = (req.query.codec as string) || 'aac';

  try {
    const ensured = await ensureHlsSessionForRequest(trackId, quality, targetCodec);
    targetCodec = ensured.codec;
    const sessionInfo = ensured.sessionInfo;

    if (!sessionInfo || !fs.existsSync(sessionInfo.playlistPath)) {
      writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Session ready but playlist path missing`);
      return res.status(500).send('HLS media playlist generation failed');
    }

    const token = req.query.token as string | undefined;
    const playlist = fs.readFileSync(sessionInfo.playlistPath, 'utf8');
    const output = rewriteMediaPlaylistSegments(playlist, sessionInfo.quality, sessionInfo.codec, token);

    const validation = validateHlsPlaylist(output);
    if (!validation.valid) {
      console.error('[HLS] Invalid playlist generated:', validation.error);
      writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Invalid playlist: ${validation.error}`);
      writeHlsSessionLog(trackId, quality, targetCodec, `Invalid media playlist: ${validation.error}`);
      return res.status(500).send(`Invalid HLS playlist: ${validation.error}`);
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', sessionInfo.finished ? 'public, max-age=30' : 'no-cache');
    writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Served media playlist with ${sessionInfo.segmentCount} segments; finished=${sessionInfo.finished}`);
    writeHlsSessionLog(trackId, quality, targetCodec, `Served media playlist snapshot: ${output.split(/\r?\n/).slice(0, 20).join('\\n')}`);
    res.send(output);
  } catch (err: any) {
    console.error('[HLS] Media playlist error:', err?.message || err);
    writeHlsServerLog(`[media-playlist ${trackId} ${quality} ${targetCodec}] Error: ${err?.message || String(err)}`);
    if (!res.headersSent) {
      if (err?.code === 'ENOENT' || err?.message?.includes('ENOENT')) {
        res.status(501).send('FFmpeg not installed — HLS streaming unavailable');
      } else if (err?.status === 404) {
        res.status(404).send('Track not found');
      } else {
        res.status(500).send('HLS streaming error');
      }
    }
  }
});

router.all('/stream/:trackId/prewarm', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.method !== 'POST' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'POST, HEAD, OPTIONS');
    return res.status(405).send('Method not allowed');
  }

  const { trackId } = req.params;
  const quality = (req.query.quality as string) || '128k';
  let targetCodec = (req.query.codec as string) || 'aac';

  try {
    const ensured = await ensureHlsSessionForRequest(trackId, quality, targetCodec);
    targetCodec = ensured.codec;
    const sessionInfo = ensured.sessionInfo;

    if (!sessionInfo || !fs.existsSync(sessionInfo.playlistPath)) {
      writeHlsServerLog(`[prewarm ${trackId} ${quality} ${targetCodec}] Session ready but playlist path missing`);
      return res.status(500).json({ ok: false, error: 'HLS prewarm failed' });
    }

    touchSession(trackId, quality, targetCodec);
    writeHlsServerLog(`[prewarm ${trackId} ${quality} ${targetCodec}] Ready with ${sessionInfo.segmentCount} segments; finished=${sessionInfo.finished}`);
    writeHlsSessionLog(trackId, quality, targetCodec, `Prewarm ready: segments=${sessionInfo.segmentCount}; finished=${sessionInfo.finished}`);

    if (req.method === 'HEAD') {
      return res.sendStatus(204);
    }

    res.json({
      ok: true,
      trackId,
      quality,
      codec: targetCodec,
      segmentCount: sessionInfo.segmentCount,
      finished: sessionInfo.finished,
    });
  } catch (err: any) {
    console.error('[HLS] Prewarm error:', err?.message || err);
    writeHlsServerLog(`[prewarm ${trackId} ${quality} ${targetCodec}] Error: ${err?.message || String(err)}`);
    if (err?.code === 'ENOENT' || err?.message?.includes('ENOENT')) {
      return res.status(501).json({ ok: false, error: 'FFmpeg not installed — HLS streaming unavailable' });
    }
    if (err?.status === 404) {
      return res.status(404).json({ ok: false, error: 'Track not found' });
    }
    res.status(500).json({ ok: false, error: 'HLS prewarm error' });
  }
});

// Serve individual HLS segments (.ts files)
router.all('/stream/:trackId/:segment', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { trackId, segment } = req.params;
  const quality = (req.query.quality as string) || '128k';
  const codec = (req.query.codec as string) || 'aac';

  console.log(`[HLS DEBUG] Segment request: trackId=${trackId} segment=${segment} quality=${quality} codec=${codec}`);
  writeHlsSessionLog(trackId, quality, codec, `Segment request for ${segment}`);

  // Only serve .ts segment files
  if (!segment.endsWith('.ts')) {
    return res.status(400).send('Invalid segment request');
  }

  const outputDir = getSessionOutputDir(trackId, quality, codec);

  if (!outputDir) {
    console.log(`[HLS DEBUG] No exact session for trackId=${trackId}; active variants=${JSON.stringify(getActiveSessionVariants(trackId))}`);
    writeHlsSessionLog(trackId, quality, codec, `Missing exact session for ${segment}; active variants=${JSON.stringify(getActiveSessionVariants(trackId))}`);
    return res.status(404).send('No active HLS session for this track');
  }

  const segmentPath = path.join(outputDir, segment);
  if (!fs.existsSync(segmentPath)) {
    console.log(`[HLS DEBUG] Segment not found: ${segmentPath}`);
    writeHlsSessionLog(trackId, quality, codec, `Segment missing on disk: ${segmentPath}`);
    return res.status(404).send('Segment not found');
  }

  console.log(`[HLS DEBUG] Serving segment: ${segmentPath}`);
  const stat = fs.statSync(segmentPath);
  writeHlsSessionLog(trackId, quality, codec, `Serving ${segment} (${stat.size} bytes) from ${segmentPath}`);

  // Touch the session to keep it alive
  touchSession(trackId, quality, codec);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Chunks never change
  fs.createReadStream(segmentPath).pipe(res);
});

// ─── Legacy Streaming ──────────────────────────────────────────────────

// Stream audio (supports Range requests)
router.all('/stream', async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;

  if (!b64Path && !rawPath) {
    return res.status(400).send('Missing path parameter');
  }

  // pathB64 is the DB base64 path, URL-encoded by the frontend.
  // decodeURIComponent undoes the URL-encoding; the result is the raw DB base64 string.
  const dbPathStr = b64Path ? decodeURIComponent(b64Path) : rawPath;

  const fileBuf = pathToBuffer(dbPathStr);

  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('File not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  const stat = fs.statSync(fileBuf);
  const fileSize = stat.size;
  const ext = path.extname(fileBuf.toString('utf8')).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'audio/mpeg';

  if (mimeType === 'audio/x-ms-wma') {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'none');

    const ffmpeg = spawn('ffmpeg', [
      '-i', fileBuf.toString('utf8'),
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-id3v2_version', '3',
      '-fflags', '+genpts',
      '-f', 'mp3',
      '-'
    ]);

    ffmpeg.stderr.on('data', (data) => {
      console.error('[FFmpeg]', data.toString());
    });

    ffmpeg.stdout.pipe(res);

    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(501).send('FFmpeg not installed — WMA playback unavailable');
        } else {
          res.status(500).send('Transcoding error');
        }
      }
    });

    ffmpeg.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`FFmpeg process exited with code ${code} and signal ${signal}`);
      }
    });

    return;
  }

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(fileBuf, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
    };
    res.writeHead(200, head);
    fs.createReadStream(fileBuf).pipe(res);
  }
});

// Get album art by track path
router.get('/art', async (req, res) => {
  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;

  if (!b64Path && !rawPath) return res.status(404).send('Not found');

  const dbPathStr = b64Path ? decodeURIComponent(b64Path) : rawPath;

  const fileBuf = pathToBuffer(dbPathStr);
  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('Not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  try {
    const utf8Path = fileBuf.toString('utf8');
    const metadata = await mm.parseFile(utf8Path);
    const picture = metadata.common.picture?.[0];

    if (picture) {
      // Sanitize Content-Type: WMA files can embed malformed format strings
      // containing non-ASCII/control characters that crash Node's setHeader.
      const validMime = /^[\x20-\x7E]+$/.test(picture.format) ? picture.format : 'image/jpeg';
      res.setHeader('Content-Type', validMime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(picture.data);
    } else {
      res.status(404).send('No art found');
    }
  } catch (err: any) {
    console.error('[Art] Error reading embedded art:', err?.message || err);
    res.status(500).send('Error reading metadata');
  }
});

export default router;
