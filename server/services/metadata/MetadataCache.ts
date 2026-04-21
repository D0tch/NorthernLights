import { queryWithRetry } from '../../utils/db';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

export class MetadataCache {
  
  static isCacheFresh(lastUpdated: number): boolean {
    if (!lastUpdated) return false;
    return (Date.now() - lastUpdated * 1000) < CACHE_TTL_MS;
  }

  static async getCachedArtist(name: string): Promise<any | null> {
    const res = await queryWithRetry('SELECT * FROM artists WHERE name = $1', [name]);
    return res.rows[0] || null;
  }

  static async upsertArtistCache(name: string, imageUrl: string | null, bio: string | null, mbid: string | null): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await queryWithRetry(
      `INSERT INTO artists (id, name, image_url, bio, mbid, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, artists.image_url),
         bio = COALESCE($3, artists.bio),
         mbid = COALESCE($4, artists.mbid),
         last_updated = $5`,
      [name, imageUrl, bio, mbid, now]
    );
  }

  static async getCachedAlbum(title: string, artistName: string): Promise<any | null> {
    const res = await queryWithRetry('SELECT * FROM albums WHERE title = $1 AND artist_name = $2', [title, artistName]);
    return res.rows[0] || null;
  }

  static async upsertAlbumCache(title: string, artistName: string, imageUrl: string | null, mbid: string | null): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await queryWithRetry(
      `INSERT INTO albums (id, title, artist_name, image_url, mbid, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       ON CONFLICT (title, artist_name) DO UPDATE SET
         image_url = COALESCE($3, albums.image_url),
         mbid = COALESCE($4, albums.mbid),
         last_updated = $5`,
      [title, artistName, imageUrl, mbid, now]
    );
  }

  static async getCachedGenre(name: string): Promise<any | null> {
    const res = await queryWithRetry('SELECT * FROM genres WHERE name = $1', [name]);
    return res.rows[0] || null;
  }

  static async upsertGenreCache(name: string, imageUrl: string | null, description: string | null): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await queryWithRetry(
      `INSERT INTO genres (id, name, image_url, description, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, genres.image_url),
         description = COALESCE($3, genres.description),
         last_updated = $4`,
      [name, imageUrl, description, now]
    );
  }

  static async clearAllCaches(): Promise<void> {
    await queryWithRetry('UPDATE artists SET last_updated = 0 WHERE last_updated > 0');
    await queryWithRetry('UPDATE albums SET last_updated = 0 WHERE last_updated > 0');
    await queryWithRetry('UPDATE genres SET last_updated = 0 WHERE last_updated > 0');
  }
}
