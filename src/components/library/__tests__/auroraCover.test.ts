import {
  auroraSeedVariant,
  wrappedCoverPalette,
  wrappedCoverLabel,
  systemGenreCoverLabel,
  systemDecadeCoverLabel,
} from '../AuroraCover';

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

describe('systemGenreCoverLabel', () => {
  test('new favourites titles → genre', () => {
    expect(systemGenreCoverLabel('Your Trance favourites')).toBe('Trance');
    expect(systemGenreCoverLabel('Your Hip-Hop favourites')).toBe('Hip-Hop');
  });
  test('new rediscover titles → genre', () => {
    expect(systemGenreCoverLabel('Rediscover Trance')).toBe('Trance');
  });
  test('legacy titles (until playlists regenerate) → genre', () => {
    expect(systemGenreCoverLabel('Trance Heavy Rotation')).toBe('Trance');
    expect(systemGenreCoverLabel('Trance Rediscovery')).toBe('Trance');
  });
});

describe('systemDecadeCoverLabel', () => {
  test('new full-decade titles → full numeral', () => {
    expect(systemDecadeCoverLabel("The 2010's")).toBe('2010');
    expect(systemDecadeCoverLabel("Trance from the 1990's")).toBe('1990');
  });
  test('legacy short-decade titles expand to the full decade', () => {
    expect(systemDecadeCoverLabel("90's Mix")).toBe('1990');
    expect(systemDecadeCoverLabel("90's Pop")).toBe('1990');
    expect(systemDecadeCoverLabel("00's Mix")).toBe('2000');
    expect(systemDecadeCoverLabel("10's Mix")).toBe('2010');
  });
  test('unparseable falls back to a trimmed title', () => {
    expect(systemDecadeCoverLabel('Oldies Mix')).toBe('Oldies');
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
