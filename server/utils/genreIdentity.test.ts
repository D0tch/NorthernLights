import { isSlashCompoundGenre, normalizeGenreIdentity, scoreGenreSimilarity } from './genreIdentity';

describe('genre identity normalization', () => {
  it.each([
    'Drum and Bass',
    'Drum n Bass',
    'Drum & Bass',
    '  DRUM   &   BASS  ',
  ])('folds connector variant %s to one identity', (value) => {
    expect(normalizeGenreIdentity(value)).toBe('drum and bass');
  });

  it('keeps initialisms intact', () => {
    expect(normalizeGenreIdentity('R&B')).toBe('r&b');
  });

  it('scores normalized connector variants as exact', () => {
    expect(scoreGenreSimilarity('Drum & Bass', 'Drum n Bass')).toMatchObject({
      score: 100,
      normalizedExact: true,
    });
  });

  it('does not over-score a broad single-token overlap', () => {
    expect(scoreGenreSimilarity('Bass', 'Bass Music').score).toBeLessThan(65);
  });

  it('quarantines slash-combined tags', () => {
    expect(isSlashCompoundGenre('Drum & Bass/Downtempo')).toBe(true);
    expect(isSlashCompoundGenre('Drum & Bass')).toBe(false);
  });
});
