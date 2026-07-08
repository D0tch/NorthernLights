import { auroraSeedVariant, wrappedCoverPalette, wrappedCoverLabel } from '../AuroraCover';

describe('wrappedCoverPalette', () => {
  test('season titles map to their seasonal palette', () => {
    expect(wrappedCoverPalette('Spring 2026')).toBe('spring');
    expect(wrappedCoverPalette('Summer 2024')).toBe('summer');
    expect(wrappedCoverPalette('Autumn 2025')).toBe('autumn');
    expect(wrappedCoverPalette('Winter 2025')).toBe('winter');
    expect(wrappedCoverPalette('winter 2025')).toBe('winter'); // case-insensitive
  });

  test('full-year and unknown titles fall back to the year palette', () => {
    expect(wrappedCoverPalette('2025 Wrapped')).toBe('year');
    expect(wrappedCoverPalette('Wrapped')).toBe('year');
    expect(wrappedCoverPalette('')).toBe('year');
    expect(wrappedCoverPalette(null)).toBe('year');
    expect(wrappedCoverPalette('Springtime Mix')).toBe('year'); // not a season title
  });
});

describe('wrappedCoverLabel', () => {
  test('strips the Wrapped suffix from year titles', () => {
    expect(wrappedCoverLabel('2025 Wrapped')).toBe('2025');
  });
  test('season titles pass through', () => {
    expect(wrappedCoverLabel('Spring 2026')).toBe('Spring 2026');
  });
  test('empty/null → empty string', () => {
    expect(wrappedCoverLabel(null)).toBe('');
  });
});

describe('auroraSeedVariant', () => {
  test('deterministic: same seed → same variant', () => {
    expect(auroraSeedVariant('smart_wrapped_u1_2026_spring', 4))
      .toBe(auroraSeedVariant('smart_wrapped_u1_2026_spring', 4));
  });

  test('stays within buckets and spreads across ids', () => {
    const buckets = 4;
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const v = auroraSeedVariant(`playlist-${i}`, buckets);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(buckets);
      seen.add(v);
    }
    // 40 distinct ids should hit more than one bucket (spread, not constant).
    expect(seen.size).toBeGreaterThan(1);
  });

  test('degenerate buckets → 0', () => {
    expect(auroraSeedVariant('x', 0)).toBe(0);
  });
});
