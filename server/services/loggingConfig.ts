// Runtime toggles for noisy streaming logs (HLS pipeline + FFmpeg passthrough).
// Defaults come from env vars (LOG_HLS, LOG_FFMPEG); admin settings override at runtime.

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const envHls = parseBoolEnv(process.env.LOG_HLS);
const envFfmpeg = parseBoolEnv(process.env.LOG_FFMPEG);

export const loggingFlags = {
  hls: envHls,
  ffmpeg: envFfmpeg,
};

export function setHlsLogging(enabled: boolean) {
  loggingFlags.hls = !!enabled;
}

export function setFfmpegLogging(enabled: boolean) {
  loggingFlags.ffmpeg = !!enabled;
}

export function isHlsLoggingEnabled(): boolean {
  return loggingFlags.hls;
}

export function isFfmpegLoggingEnabled(): boolean {
  return loggingFlags.ffmpeg;
}

export function logHls(...args: any[]) {
  if (loggingFlags.hls) console.log(...args);
}

export function logFfmpeg(...args: any[]) {
  if (loggingFlags.ffmpeg) console.error(...args);
}

// Load persisted overrides from the DB. Call after the DB is connected.
// If a setting key is absent (null), keep the env-default already in place.
export async function loadLoggingSettingsFromDB() {
  try {
    const { getSystemSetting } = await import('../database');
    const hls = await getSystemSetting('hlsLoggingEnabled');
    const ffmpeg = await getSystemSetting('ffmpegLoggingEnabled');
    if (typeof hls === 'boolean') loggingFlags.hls = hls;
    if (typeof ffmpeg === 'boolean') loggingFlags.ffmpeg = ffmpeg;
  } catch {
    // ignore — env defaults stand
  }
}
