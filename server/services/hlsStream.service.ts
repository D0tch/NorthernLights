import { spawn, execSync, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeHlsServerLog, writeHlsSessionLog } from './debugLogger.service';

// ─── Types ──────────────────────────────────────────────────────────────

interface HlsSession {
  trackId: string;
  quality: string;
  codec: string;
  outputDir: string;
  playlistPath: string;
  ffmpegProcess: ChildProcess | null;
  createdAt: number;
  lastAccessedAt: number;
  ready: boolean;               // true once playlist contains a segment entry
  readyPromise: Promise<void>;  // resolves when the playlist has a playable segment
  segmentCount: number;
  finished: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────

const HLS_BASE_DIR = path.join(os.tmpdir(), 'nl-hls-streams');
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes of inactivity
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const HLS_SEGMENT_DURATION = 10; // seconds per chunk

// ─── Session Store ──────────────────────────────────────────────────────

const activeSessions = new Map<string, HlsSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function sessionKey(trackId: string, quality: string, codec: string): string {
  return `${trackId}::${quality}::${codec}`;
}

function getSessionKeyParts(key: string): { trackId: string; quality: string; codec: string } | null {
  const parts = key.split('::');
  if (parts.length !== 3) return null;
  return { trackId: parts[0], quality: parts[1], codec: parts[2] };
}

function logHlsSession(trackId: string, quality: string, codec: string, line: string) {
  writeHlsServerLog(`[session ${trackId} ${quality} ${codec}] ${line}`);
  writeHlsSessionLog(trackId, quality, codec, line);
}

function summarizePlaylist(content: string): string {
  return content
    .split(/\r?\n/)
    .slice(0, 16)
    .join('\\n');
}

function countPlaylistSegments(content: string): number {
  return (content.match(/^segment\d+\.ts$/gm) || []).length;
}

function inspectTransportSegment(segmentPath: string): string {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=format_name,duration,size:stream=index,codec_name,codec_type,codec_tag_string,profile,sample_rate,channels -of json "${segmentPath.replace(/"/g, '\\"')}"`,
      { timeout: 5000 }
    ).toString().trim();
    return output || '{"error":"empty ffprobe output"}';
  } catch (err: any) {
    return JSON.stringify({ error: err?.message || String(err) });
  }
}

// ─── Core API ───────────────────────────────────────────────────────────

/**
 * Get or create an HLS session for a given track + quality combination.
 * Returns as soon as the first segment is written — FFmpeg continues in background.
 */
export async function getOrCreateHlsSession(
  trackId: string,
  trackPath: Buffer,
  quality: string,
  sourceBitrate: number | null,
  sourceFormat: string | null,
  targetCodec: string
): Promise<HlsSession> {
  const key = sessionKey(trackId, quality, targetCodec);

  // Reuse existing session if available
  const existing = activeSessions.get(key);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    if (!existing.ready) {
      await existing.readyPromise;
    }
    return existing;
  }

  // Create output directory — hash the key to guarantee a short, fixed-length name
  const dirHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const outputDir = path.join(HLS_BASE_DIR, dirHash);
  fs.mkdirSync(outputDir, { recursive: true });

  const playlistPath = path.join(outputDir, 'playlist.m3u8');
  // Relative filenames for FFmpeg — absolute paths cause it to embed /tmp/... in the playlist,
  // which the Chromecast interprets as URLs and fetches 404. Use cwd: outputDir instead.
  const playlistFilename = 'playlist.m3u8';
  const segmentFilename = 'segment%03d.ts';

  // Determine encoding strategy
  const inputPath = trackPath.toString('utf8');
  const shouldRemux = getRemuxDecision(quality, sourceBitrate, sourceFormat, targetCodec, inputPath);
  logHlsSession(trackId, quality, targetCodec, `Creating session in ${outputDir}`);
  logHlsSession(trackId, quality, targetCodec, `Input path: ${inputPath}`);
  logHlsSession(trackId, quality, targetCodec, `Remux decision: ${shouldRemux ? 'copy' : 'transcode'}`);

  // Build FFmpeg args
  const ffmpegArgs = buildFfmpegArgs(inputPath, playlistFilename, segmentFilename, quality, shouldRemux, targetCodec);
  logHlsSession(trackId, quality, targetCodec, `FFmpeg args: ${ffmpegArgs.join(' ')}`);

  // Create the readiness promise — resolves when segment000.ts appears
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const session: HlsSession = {
    trackId,
    quality,
    codec: targetCodec,
    outputDir,
    playlistPath,
    ffmpegProcess: null,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ready: false,
    readyPromise,
    segmentCount: 0,
    finished: false,
  };

  activeSessions.set(key, session);

  // Spawn FFmpeg with cwd: outputDir so segment filenames in the playlist are relative
  console.log(`[HLS DEBUG] Spawning FFmpeg: ${ffmpegArgs.join(' ')}`);
  console.log(`[HLS DEBUG] cwd: ${outputDir}`);
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], cwd: outputDir });
  session.ffmpegProcess = ffmpeg;
  logHlsSession(trackId, quality, targetCodec, 'FFmpeg process spawned');

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    // FFmpeg writes ALL output to stderr (config banner, progress, AND errors).
    // Only log lines that look like actual errors, not config/progress noise.
    const msg = data.toString();
    console.log(`[HLS DEBUG] FFmpeg stderr: ${msg.substring(0, 200)}`);
    logHlsSession(trackId, quality, targetCodec, `FFmpeg stderr: ${msg.trim()}`);
    if (/^\[?error|Error while|Invalid|No such file|could not|Cannot/mi.test(msg)) {
      console.error(`[HLS] FFmpeg error for ${trackId}:`, msg.trim());
    }
  });

  ffmpeg.on('exit', (code, signal) => {
    session.ffmpegProcess = null;
    session.finished = true;
    logHlsSession(trackId, quality, targetCodec, `FFmpeg exited with code=${code} signal=${signal}`);
    if (code !== 0 && code !== null && signal !== 'SIGKILL') {
      console.error(`[HLS] FFmpeg exited with code ${code} for track ${trackId}`);
    }
  });

  ffmpeg.on('error', (err) => {
    console.error(`[HLS] FFmpeg spawn error for ${trackId}:`, err);
    logHlsSession(trackId, quality, targetCodec, `FFmpeg spawn error: ${err?.message || String(err)}`);
    session.ffmpegProcess = null;
    // Resolve the promise anyway so callers don't hang
    if (!session.ready) {
      session.ready = true;
      resolveReady!();
    }
  });

  // Resolve as soon as the playlist contains a segment entry — instant-start playback.
  // We check the playlist (not the segment file) because FFmpeg writes the segment
  // first, then updates the playlist. Serving a playlist with no segments causes
  // the CAF Shaka player to close the MediaSource immediately → SourceBuffer error.
  const pollStart = Date.now();
  const POLL_TIMEOUT_MS = 30000; // 30s safety net

  const pollInterval = setInterval(() => {
    try {
      if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf8');
        const segmentCount = countPlaylistSegments(content);
        session.segmentCount = segmentCount;
        console.log(`[HLS DEBUG] Poll: playlist exists, content: ${JSON.stringify(content.substring(0, 200))}`);
        logHlsSession(trackId, quality, targetCodec, `Playlist poll snapshot (${segmentCount} segments): ${summarizePlaylist(content)}`);
        if (segmentCount >= 2 || (segmentCount >= 1 && content.includes('#EXT-X-ENDLIST'))) {
          clearInterval(pollInterval);
          session.ready = true;
          console.log(`[HLS DEBUG] Session ready for track ${trackId}`);
          const firstSegmentPath = path.join(outputDir, 'segment000.ts');
          if (fs.existsSync(firstSegmentPath)) {
            logHlsSession(trackId, quality, targetCodec, `First segment probe: ${inspectTransportSegment(firstSegmentPath)}`);
          } else {
            logHlsSession(trackId, quality, targetCodec, 'First segment probe skipped: segment000.ts missing at ready time');
          }
          resolveReady!();
          return;
        }
      }
    } catch (_) { /* file may be partially written */ }

    if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
      clearInterval(pollInterval);
      console.error(`[HLS] Timeout waiting for first segment of track ${trackId}`);
      logHlsSession(trackId, quality, targetCodec, 'Timed out waiting for playlist to contain first segment');
      session.ready = true;
      resolveReady!();
    }
  }, 50);

  // Also resolve if FFmpeg exits (success or failure) before the poll finds a segment
  ffmpeg.on('exit', () => {
    // Give a brief moment for the final write to flush
    setTimeout(() => {
      if (!session.ready) {
        clearInterval(pollInterval);
        session.ready = true;
        resolveReady!();
      }
    }, 200);
  });

  // Start cleanup timer if not running
  startCleanupTimer();

  // Wait for readiness
  await readyPromise;
  return session;
}

/**
 * Touch a session to keep it alive. Codec is optional — matches by trackId + quality.
 */
export function touchSession(trackId: string, quality: string, codec?: string): void {
  if (codec) {
    const session = activeSessions.get(sessionKey(trackId, quality, codec));
    if (session) {
      session.lastAccessedAt = Date.now();
      return;
    }
  }
}

/**
 * Get the output directory for a session (for serving segments).
 * Codec is optional — matches by trackId + quality.
 */
export function getSessionOutputDir(trackId: string, quality: string, codec?: string): string | null {
  if (codec) {
    const session = activeSessions.get(sessionKey(trackId, quality, codec));
    if (session) return session.outputDir;
  }
  return null;
}

export function getSessionInfo(trackId: string, quality: string, codec: string): Pick<HlsSession, 'playlistPath' | 'quality' | 'codec' | 'segmentCount' | 'finished'> | null {
  const session = activeSessions.get(sessionKey(trackId, quality, codec));
  if (!session) return null;
  return {
    playlistPath: session.playlistPath,
    quality: session.quality,
    codec: session.codec,
    segmentCount: session.segmentCount,
    finished: session.finished,
  };
}

/**
 * Return all active session variants for a trackId.
 */
export function getActiveSessionVariants(trackId: string): Array<{ quality: string; codec: string }> {
  const variants: Array<{ quality: string; codec: string }> = [];
  for (const [key, session] of activeSessions) {
    if (session.trackId !== trackId) continue;
    const parts = getSessionKeyParts(key);
    if (!parts) continue;
    variants.push({ quality: parts.quality, codec: parts.codec });
  }
  return variants;
}

/**
 * Clean up a specific session — kill FFmpeg, remove temp files.
 */
export function cleanupSession(trackId: string, quality: string, codec?: string): void {
  let key: string;
  if (codec) {
    key = sessionKey(trackId, quality, codec);
  } else {
    // Find the first matching session
    for (const [k, session] of activeSessions) {
      if (session.trackId === trackId && session.quality === quality) {
        key = k;
        break;
      }
    }
    if (!key!) return;
  }
  const session = activeSessions.get(key!);
  if (!session) return;
  logHlsSession(session.trackId, session.quality, session.codec, 'Cleaning up session');

  // Kill FFmpeg if still running
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGKILL');
  }

  // Remove temp files
  try {
    fs.rmSync(session.outputDir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }

  activeSessions.delete(key);
}

/**
 * Clean up ALL sessions — called during server shutdown.
 */
export function cleanupAllSessions(): void {
  for (const [key, session] of activeSessions) {
    if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
      session.ffmpegProcess.kill('SIGKILL');
    }
    try {
      fs.rmSync(session.outputDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  }
  activeSessions.clear();

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  // Try to remove the base dir itself
  try {
    fs.rmSync(HLS_BASE_DIR, { recursive: true, force: true });
  } catch (e) {
    // Ignore
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────

// Formats that are definitively NOT valid in MPEG-TS containers (HLS spec)
const NOT_TS_COMPATIBLE = new Set([
  'flac', 'ogg', 'vorbis', 'opus', 'wav', 'wave', 'wma',
]);

/**
 * Use ffprobe to detect the actual audio codec of a file.
 * Returns codec name (e.g., 'aac', 'alac', 'mp3', 'flac') or null on failure.
 */
function detectActualCodec(filePath: string): string | null {
  try {
    const output = execSync(
      `ffprobe -v quiet -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "${filePath.replace(/"/g, '\\"')}"`,
      { timeout: 5000 }
    ).toString().trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether to remux (copy codec) or transcode.
 * Considers: user quality preference, source format, and target codec.
 */
function getRemuxDecision(
  quality: string,
  sourceBitrate: number | null,
  sourceFormat: string | null,
  targetCodec: string,
  inputPath: string
): boolean {
  const fmt = (sourceFormat || '').toLowerCase();

  // Known incompatible formats — always transcode regardless of quality
  if (NOT_TS_COMPATIBLE.has(fmt)) return false;

  // MPEG-4 container: could be AAC or ALAC — must detect actual codec
  if (fmt === 'mpeg-4' || fmt === 'm4a' || fmt === 'mp4') {
    const actualCodec = detectActualCodec(inputPath);
    if (actualCodec === 'alac') return false; // ALAC can't go in MPEG-TS
    // For AAC in M4A, fall through to the normal bitrate check below
  }

  // Quality = 'source': remux if the codec is TS-compatible
  if (quality === 'source') {
    return true; // FLAC/OGG/ALAC already filtered out above
  }

  if (!sourceBitrate) return false;

  const requestedBitrateNum = parseInt(quality) * 1000;
  if (isNaN(requestedBitrateNum)) return false;

  // Remux if: source codec matches target AND bitrate is sufficient
  // This means the source is already in the right format — no transcoding needed
  const codecMap: Record<string, string[]> = {
    mp3: ['mp3', 'mpeg'],
    aac: ['aac', 'm4a', 'mp4', 'mpeg-4', 'mp4/m4a'],
    ac3: ['ac3'],
    eac3: ['eac3'],
  };
  const matchingFormats = codecMap[targetCodec] || [];
  if (matchingFormats.includes(fmt) && requestedBitrateNum >= sourceBitrate) {
    return true;
  }

  return false; // transcode
}

function buildFfmpegArgs(
  inputPath: string,
  playlistPath: string,
  segmentPattern: string,
  quality: string,
  shouldRemux: boolean,
  codec: string
): string[] {
  const args = [
    '-i', inputPath,
    '-vn',                          // Strip any video/cover art streams
    '-map', '0:a:0',               // Take first audio stream only
  ];

  if (shouldRemux) {
    args.push('-c:a', 'copy');      // Zero CPU — container change only
  } else {
    switch (codec) {
      case 'mp3':
        args.push('-c:a', 'libmp3lame', '-b:a', quality);
        break;
      case 'ac3':
        args.push('-c:a', 'ac3', '-b:a', quality);
        break;
      case 'eac3':
        args.push('-c:a', 'eac3', '-b:a', quality);
        break;
      default: // 'aac', 'aac_he', any unknown → AAC (universal)
        args.push('-c:a', 'aac', '-b:a', quality, '-profile:a', 'aac_low');
        break;
    }
  }

  args.push(
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',          // VOD mode — keep all segments in playlist
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segmentPattern,
    '-hls_flags', 'independent_segments',
    '-f', 'hls',
    playlistPath,
  );

  return args;
}

function startCleanupTimer(): void {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of activeSessions) {
      if (now - session.lastAccessedAt > SESSION_TTL_MS) {
        console.log(`[HLS] Reaping expired session: ${key}`);
        logHlsSession(session.trackId, session.quality, session.codec, 'Reaping expired session due to TTL');
        cleanupSession(session.trackId, session.quality);
      }
    }

    // If no sessions remain, stop the timer
    if (activeSessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
}
