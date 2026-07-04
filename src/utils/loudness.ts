// Loudness normalization — pure gain math (unit-tested; no DOM/Web Audio here).
// A track's/album's measured loudness + settings → the dB gain to apply, with a
// true-peak safety limiter and a sane clamp. Server-computed EBU R128 values
// (integrated LUFS + true peak dBTP) come from GET /api/loudness.

export interface LoudnessData {
  lufs: number;
  truePeakDbfs: number | null;
}

export interface LoudnessSettings {
  enabled: boolean;
  targetLufs: number;
  preampDb: number;
}

// Never boost/cut more than this — guards against wild values on odd masters.
const GAIN_MIN_DB = -15;
const GAIN_MAX_DB = 15;
// Post-gain true peak must stay at/below this to avoid inter-sample clipping.
const TRUE_PEAK_CEILING_DBTP = -1;

/**
 * Gain (dB) to reach the target loudness, or null to apply unity (no change).
 * Returns null when disabled or when loudness hasn't been measured yet.
 * Order matters: apply the target/pre-amp, then REDUCE for the peak ceiling,
 * then clamp. If the peak limit would demand less than GAIN_MIN_DB, the clamp
 * wins and the peak may marginally exceed the ceiling (rare, acceptable).
 */
export function computeLoudnessGainDb(
  data: LoudnessData | null | undefined,
  settings: LoudnessSettings,
): number | null {
  if (!settings.enabled) return null;
  if (!data || !Number.isFinite(data.lufs)) return null;

  let gainDb = settings.targetLufs - data.lufs + (settings.preampDb || 0);

  // Peak limiter — only ever reduces gain so the post-gain true peak <= ceiling.
  const peak = data.truePeakDbfs;
  if (peak != null && Number.isFinite(peak)) {
    const projected = peak + gainDb;
    if (projected > TRUE_PEAK_CEILING_DBTP) gainDb = TRUE_PEAK_CEILING_DBTP - peak;
  }

  return Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, gainDb));
}

/** dB → linear amplitude factor for a Web Audio GainNode. null/NaN → unity. */
export function dbToLinear(db: number | null | undefined): number {
  return db == null || !Number.isFinite(db) ? 1.0 : Math.pow(10, db / 20);
}
