jest.mock('../database', () => ({
  initDB: jest.fn(),
  invalidateGenreEntityCache: jest.fn(),
  setSystemSetting: jest.fn(),
}));

jest.mock('./genreMatrix.service', () => ({
  genreMatrixService: { reloadMappings: jest.fn() },
}));

import { initDB, invalidateGenreEntityCache, setSystemSetting } from '../database';
import { genreMatrixService } from './genreMatrix.service';
import { groupGenres } from './genreCanonicalization.service';

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';
const ALIAS_ID = '22222222-2222-4222-8222-222222222222';

function reviewRows(paths: [string | null, string | null] = ['Electronic.Drum and Bass', 'Electronic.Drum and Bass']) {
  return [
    {
      id: CANONICAL_ID,
      name: 'Drum & Bass',
      normalized_key: 'drum and bass',
      track_count: 20,
      album_count: 3,
      taxonomy_path: paths[0],
      exact_mb_path: paths[0],
    },
    {
      id: ALIAS_ID,
      name: 'Drum n Bass',
      normalized_key: 'drum and bass',
      track_count: 8,
      album_count: 2,
      taxonomy_path: paths[1],
      exact_mb_path: paths[1],
    },
  ];
}

function makeDb(rows = reviewRows()) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM genres g') && sql.includes('COUNT(DISTINCT tg.track_id)')) {
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: jest.fn() };
  const db = { connect: jest.fn(async () => client) };
  (initDB as jest.Mock).mockResolvedValue(db);
  return { db, client, query };
}

describe('genre grouping transaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (setSystemSetting as jest.Mock).mockResolvedValue(undefined);
    (genreMatrixService.reloadMappings as jest.Mock).mockResolvedValue(undefined);
  });

  it('redirects aliases, repoints primary and secondary memberships, and invalidates consumers', async () => {
    const { query, client } = makeDb();

    await groupGenres({
      canonicalGenreId: CANONICAL_ID,
      aliasGenreIds: [ALIAS_ID],
      candidateKey: 'genre-normalized:drum and bass',
      signature: 'signature',
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('BEGIN');
    expect(statements.some(sql => sql.includes('UPDATE genres SET merged_into'))).toBe(true);
    expect(statements.some(sql => sql.includes('UPDATE tracks SET genre_id'))).toBe(true);
    expect(statements.some(sql => sql.includes('INSERT INTO track_genres'))).toBe(true);
    expect(statements.some(sql => sql.includes('DELETE FROM track_genres'))).toBe(true);
    expect(statements.some(sql => sql.includes('INSERT INTO genre_duplicate_reviews'))).toBe(true);
    expect(statements).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(invalidateGenreEntityCache).toHaveBeenCalled();
    expect(setSystemSetting).toHaveBeenCalledWith('systemPlaylistConfigUpdatedAt', expect.any(Number));
    expect(genreMatrixService.reloadMappings).toHaveBeenCalled();
  });

  it('rolls back taxonomy-root conflicts until explicitly acknowledged', async () => {
    const { query } = makeDb(reviewRows(['Electronic.Drum and Bass', 'Jazz.Drum and Bass']));

    await expect(groupGenres({
      canonicalGenreId: CANONICAL_ID,
      aliasGenreIds: [ALIAS_ID],
    })).rejects.toMatchObject({ code: 'GENRE_TAXONOMY_CONFLICT' });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('ROLLBACK');
    expect(statements.some(sql => sql.includes('UPDATE genres SET merged_into'))).toBe(false);
    expect(invalidateGenreEntityCache).not.toHaveBeenCalled();
  });

  it('promotes the strongest available path when the selected canonical genre is unmapped', async () => {
    const { query } = makeDb(reviewRows([null, 'Electronic.Drum and Bass']));

    await groupGenres({ canonicalGenreId: CANONICAL_ID, aliasGenreIds: [ALIAS_ID] });

    const pathWrite = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO subgenre_mappings'));
    expect(pathWrite?.[1]).toEqual(['drum  bass', 'Electronic.Drum and Bass']);
  });
});
