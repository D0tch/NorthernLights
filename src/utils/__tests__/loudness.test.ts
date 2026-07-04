import { computeLoudnessGainDb, dbToLinear, type LoudnessSettings } from '../loudness';

const S = (over: Partial<LoudnessSettings> = {}): LoudnessSettings => ({
  enabled: true,
  targetLufs: -18,
  preampDb: 0,
  ...over,
});

describe('computeLoudnessGainDb', () => {
  test('disabled → null (unity)', () => {
    expect(computeLoudnessGainDb({ lufs: -10, truePeakDbfs: -3 }, S({ enabled: false }))).toBeNull();
  });

  test('missing data → null', () => {
    expect(computeLoudnessGainDb(null, S())).toBeNull();
    expect(computeLoudnessGainDb(undefined, S())).toBeNull();
  });

  test('non-finite lufs → null', () => {
    expect(computeLoudnessGainDb({ lufs: NaN, truePeakDbfs: -3 }, S())).toBeNull();
  });

  test('basic: target − lufs (+preamp)', () => {
    // loud -8, target -18 → -10 dB; peak -3 + (-10) = -13 ≤ -1, no limiting
    expect(computeLoudnessGainDb({ lufs: -8, truePeakDbfs: -3 }, S())).toBeCloseTo(-10, 5);
  });

  test('preamp is added', () => {
    expect(computeLoudnessGainDb({ lufs: -18, truePeakDbfs: -6 }, S({ preampDb: 3 }))).toBeCloseTo(3, 5);
  });

  test('peak limiter reduces a boost that would clip', () => {
    // quiet -30 → +12; peak -2, so max allowed gain = ceiling(-1) − (-2) = +1
    expect(computeLoudnessGainDb({ lufs: -30, truePeakDbfs: -2 }, S())).toBeCloseTo(1, 5);
  });

  test('peak limiter never touches attenuation', () => {
    // loud -6 → -12; peak +1 + (-12) = -11 ≤ -1, unchanged even with a hot peak
    expect(computeLoudnessGainDb({ lufs: -6, truePeakDbfs: 1 }, S())).toBeCloseTo(-12, 5);
  });

  test('null peak → no peak limiting', () => {
    expect(computeLoudnessGainDb({ lufs: -30, truePeakDbfs: null }, S())).toBeCloseTo(12, 5);
  });

  test('clamps to +15 max', () => {
    expect(computeLoudnessGainDb({ lufs: -40, truePeakDbfs: null }, S())).toBe(15);
  });

  test('clamps to −15 min', () => {
    expect(computeLoudnessGainDb({ lufs: 2, truePeakDbfs: null }, S())).toBe(-15);
  });
});

describe('dbToLinear', () => {
  test('null → 1 (unity)', () => expect(dbToLinear(null)).toBe(1));
  test('0 dB → 1', () => expect(dbToLinear(0)).toBeCloseTo(1, 6));
  test('−6 dB ≈ 0.501', () => expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3));
  test('+6 dB ≈ 1.995', () => expect(dbToLinear(6)).toBeCloseTo(1.9953, 3));
  test('NaN → 1', () => expect(dbToLinear(NaN)).toBe(1));
});
