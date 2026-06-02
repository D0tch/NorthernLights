import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';

let pool: Pool | null = null;
let initPromise: Promise<Pool> | null = null;

// Reference-counted leak detection control - allows nested long-running operations
let leakDetectionDisabledCount = 0;

export function disableLeakDetection() {
  leakDetectionDisabledCount++;
}

export function enableLeakDetection() {
  leakDetectionDisabledCount = Math.max(0, leakDetectionDisabledCount - 1);
}

export function isLeakDetectionActive(): boolean {
  return leakDetectionDisabledCount === 0;
}

export async function initDB(): Promise<Pool> {
  if (pool) return pool;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    let client;
    try {
      const instance = new Pool({
        user: process.env.DB_USER || 'musicuser',
        password: process.env.DB_PASSWORD || 'musicpass',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'musicdb',
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000,
        keepAlive: true,
      });

      instance.on('connect', () => {
        console.log('[DB] New client connected to database pool');
      });

      instance.on('error', (err) => {
        console.error('[DB] Unexpected error on idle client:', err);
      });

      instance.on('remove', (client) => {
        if (client && (client as any)._leakTimeout) {
          clearTimeout((client as any)._leakTimeout);
          delete (client as any)._leakTimeout;
        }
        console.log('[DB] Client removed from database pool');
      });

      instance.on('acquire', (client) => {
        if (!client) return;
        
        // Skip leak detection during long-running operations (e.g., MBDB import)
        if (!isLeakDetectionActive()) return;
        
        const stack = new Error().stack;
        (client as any)._leakTimeout = setTimeout(() => {
          console.warn('[DB] CONNECTION LEAK DETECTED: Client held for > 2 minutes.');
          if (stack) console.warn('[DB] Leak origin stack trace:', stack);
        }, 2 * 60 * 1000);
      });

      instance.on('release', (err, client) => {
        if (client && (client as any)._leakTimeout) {
          clearTimeout((client as any)._leakTimeout);
          delete (client as any)._leakTimeout;
        }
      });

      // Slow-query observability: time every pool.query() and warn when it
      // exceeds DB_SLOW_QUERY_MS (default 500ms). Callback-style calls are passed
      // through untouched. This is the only production visibility into queries
      // that degrade as the library grows toward 100k+ tracks.
      const slowQueryMs = parseInt(process.env.DB_SLOW_QUERY_MS || '500', 10);
      const originalQuery = instance.query.bind(instance);
      (instance as any).query = (...args: any[]) => {
        if (typeof args[args.length - 1] === 'function') {
          return (originalQuery as any)(...args);
        }
        const start = process.hrtime.bigint();
        const result = (originalQuery as any)(...args);
        if (result && typeof result.then === 'function') {
          result.then(
            () => {
              const ms = Number(process.hrtime.bigint() - start) / 1e6;
              if (ms >= slowQueryMs) {
                const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
                console.warn(`[DB] slow query ${ms.toFixed(0)}ms: ${String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
              }
            },
            () => { /* errors surface to the caller */ },
          );
        }
        return result;
      };

      // Test connection and initialize schema
      client = await instance.connect();

      await client.query(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          title TEXT,
          artist TEXT,
          album_artist TEXT,
          artists TEXT,
          album TEXT,
          genre TEXT,
          duration REAL,
          track_number INTEGER,
          year INTEGER,
          release_type TEXT,
          is_compilation BOOLEAN,
          path TEXT UNIQUE,
          play_count INTEGER DEFAULT 0,
          last_played_at TIMESTAMPTZ,
          rating INTEGER DEFAULT 0,
          bitrate INTEGER,
          format TEXT
        );

        DO $$ 
        BEGIN 
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS play_count INTEGER DEFAULT 0;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS last_played_at TIMESTAMPTZ;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
        EXCEPTION 
          WHEN OTHERS THEN null; 
        END $$;

        DO $$ 
        BEGIN 
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS bitrate INTEGER;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS format TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS genres TEXT;
        EXCEPTION 
          WHEN OTHERS THEN null; 
        END $$;

        DO $$ 
        BEGIN 
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS isrc TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_recording_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_track_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_album_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_artist_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_album_artist_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_release_group_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_work_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS genius_song_id TEXT;
        EXCEPTION
          WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS tracks_genius_song_id_idx ON tracks(genius_song_id);
        CREATE INDEX IF NOT EXISTS tracks_mb_recording_id_idx ON tracks(mb_recording_id);

        DO $$
        BEGIN
          -- art_hash: NULL = needs processing; '' = processed, no embedded art;
          -- otherwise the content hash of the encoded cover (see services/artCache.ts).
          -- file_mtime: epoch ms of the source file, for change detection on re-scan.
          -- file_size: bytes of the source file, surfaced as Subsonic Child.size.
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS art_hash TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS file_mtime BIGINT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS file_size BIGINT;
        EXCEPTION
          WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS tracks_art_hash_idx ON tracks(art_hash);

        CREATE TABLE IF NOT EXISTS track_features (
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE PRIMARY KEY,
          bpm NUMERIC,
          acoustic_vector VECTOR(7)
        );

        -- Migration: Add 8D acoustic_vector column (VECTOR(8))
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS acoustic_vector_8d VECTOR(8);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Create HNSW index for 8D vectors
        DO $$
        BEGIN
          CREATE INDEX IF NOT EXISTS track_features_vector_8d_idx 
          ON track_features USING hnsw (acoustic_vector_8d vector_l2_ops);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Migration: Add is_simulated flag for tracks analyzed without real ffmpeg audio
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Migration: Add 8D acoustic vector (named column for 10D expansion)
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS acoustic_vector VECTOR(10);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Migration: Add/resize Discogs-EffNet embedding column to 1280D
        -- EffNet produces 1280D embeddings (bs64 refers to batch size, not dims)
        DO $$
        BEGIN
          -- If the column exists as VECTOR(128) (wrong size), drop and recreate it
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'track_features'
              AND column_name = 'embedding_vector'
          ) THEN
            DECLARE
              col_dims INTEGER;
            BEGIN
              SELECT atttypmod INTO col_dims
              FROM pg_attribute a
              JOIN pg_class c ON a.attrelid = c.oid
              WHERE c.relname = 'track_features' AND a.attname = 'embedding_vector';
              IF col_dims != 1280 THEN
                DROP INDEX IF EXISTS track_features_embedding_idx;
                ALTER TABLE track_features DROP COLUMN embedding_vector;
                ALTER TABLE track_features ADD COLUMN embedding_vector VECTOR(1280);
              END IF;
            END;
          ELSE
            ALTER TABLE track_features ADD COLUMN embedding_vector VECTOR(1280);
          END IF;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- HNSW index for 10D acoustic vectors (L2 distance)
        DO $$
        BEGIN
          CREATE INDEX IF NOT EXISTS track_features_acoustic_idx 
          ON track_features USING hnsw (acoustic_vector vector_l2_ops);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- HNSW index for 1280D EffNet embeddings (Cosine distance)
        DO $$
        BEGIN
          CREATE INDEX IF NOT EXISTS track_features_embedding_idx 
          ON track_features USING hnsw (embedding_vector vector_cosine_ops);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        CREATE TABLE IF NOT EXISTS directories (
          id TEXT PRIMARY KEY,
          path TEXT UNIQUE
        );

        CREATE TABLE IF NOT EXISTS genre_matrix_cache (
          id TEXT PRIMARY KEY,
          matrix TEXT
        );

        CREATE TABLE IF NOT EXISTS system_settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        -- Ensure index exists for fast vector search
        CREATE INDEX IF NOT EXISTS track_features_vector_idx ON track_features USING hnsw (acoustic_vector vector_l2_ops);

        -- Add MFCC timbre vector column (nullable — backfilled by background migrator)
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS mfcc_vector VECTOR(13);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- HNSW index for 13D timbre similarity search
        CREATE INDEX IF NOT EXISTS track_features_mfcc_idx ON track_features USING hnsw (mfcc_vector vector_l2_ops);

        CREATE TABLE IF NOT EXISTS playlists (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          is_llm_generated BOOLEAN NOT NULL DEFAULT FALSE
        );

        DO $$ 
        BEGIN 
          ALTER TABLE playlists ALTER COLUMN created_at TYPE TIMESTAMPTZ; 
        EXCEPTION 
          WHEN OTHERS THEN null; 
        END $$;

        DO $$
        BEGIN
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS generation_source TEXT;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        CREATE TABLE IF NOT EXISTS playlist_tracks (
          playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL,
          added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (playlist_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS playlist_tracks_track_id_idx ON playlist_tracks(track_id);

        DO $$
        BEGIN
          ALTER TABLE playlist_tracks ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        EXCEPTION
          WHEN OTHERS THEN null;
        END $$;

        CREATE TABLE IF NOT EXISTS subgenre_mappings (
          sub_genre TEXT PRIMARY KEY,
          path TEXT NOT NULL
        );

        DROP TABLE IF EXISTS macro_matrix_cache CASCADE;

        CREATE TABLE IF NOT EXISTS genre (
          id INTEGER PRIMARY KEY,
          gid UUID NOT NULL,
          name TEXT NOT NULL,
          comment TEXT,
          edits_pending INTEGER,
          last_updated TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS genre_alias (
          id INTEGER PRIMARY KEY,
          genre INTEGER REFERENCES genre(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          locale TEXT,
          edits_pending INTEGER,
          last_updated TIMESTAMP WITH TIME ZONE,
          type INTEGER,
          sort_name TEXT,
          begin_date_year INTEGER,
          begin_date_month INTEGER,
          begin_date_day INTEGER,
          end_date_year INTEGER,
          end_date_month INTEGER,
          end_date_day INTEGER,
          primary_for_locale BOOLEAN,
          ended BOOLEAN
        );
        CREATE INDEX IF NOT EXISTS genre_alias_genre_idx ON genre_alias (genre);
        CREATE INDEX IF NOT EXISTS genre_alias_name_lower_idx ON genre_alias (LOWER(name));
        CREATE INDEX IF NOT EXISTS genre_alias_name_trgm_idx ON genre_alias USING gin (LOWER(name) gin_trgm_ops);

        CREATE TABLE IF NOT EXISTS l_genre_genre (
          id INTEGER PRIMARY KEY,
          link INTEGER NOT NULL,
          entity0 INTEGER NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
          entity1 INTEGER NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
          edits_pending INTEGER,
          last_updated TIMESTAMP WITH TIME ZONE,
          link_order INTEGER,
          entity0_credit TEXT,
          entity1_credit TEXT
        );

        -- Indexes for l_genre_genre to speed up materialized view refresh
        CREATE INDEX IF NOT EXISTS l_genre_genre_entity0_idx ON l_genre_genre (entity0);
        CREATE INDEX IF NOT EXISTS l_genre_genre_entity1_idx ON l_genre_genre (entity1);
        CREATE INDEX IF NOT EXISTS l_genre_genre_link_idx ON l_genre_genre (link);
        CREATE INDEX IF NOT EXISTS l_genre_genre_link_subgenre_idx ON l_genre_genre (entity0, entity1) WHERE link = 944810;

        -- Note: We can only create the materialized view after l_genre_genre and genre are created.
        -- We will recreate it inside a DO block to catch if tables are empty.
        -- Auto-migrate the materialized view if the old schema exists
        DO $$ 
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_class c 
                JOIN pg_namespace n ON n.oid = c.relnamespace 
                WHERE c.relname = 'genre_tree_paths' AND c.relkind = 'm'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_attribute a 
                JOIN pg_class c ON a.attrelid = c.oid 
                WHERE c.relname = 'genre_tree_paths' AND a.attname = 'genre_name'
            ) THEN
                DROP MATERIALIZED VIEW genre_tree_paths CASCADE;
            END IF;
        END $$;

        DO $$ 
        BEGIN 
            CREATE MATERIALIZED VIEW IF NOT EXISTS genre_tree_paths AS
            WITH RECURSIVE genre_tree AS (
                -- Base cases: top-level genres (genres that have no parents)
                -- In the MBDB link data, entity0 is the broader genre and entity1 is the specific subgenre
                SELECT 
                    g.id AS genre_id, 
                    g.name::TEXT AS genre_name,
                    g.name::TEXT AS path,
                    1 AS level,
                    ARRAY[g.id] AS visited
                FROM genre g
                WHERE EXISTS (SELECT 1 FROM l_genre_genre lgg WHERE lgg.link = 944810 AND lgg.entity0 = g.id)
                AND NOT EXISTS (SELECT 1 FROM l_genre_genre lgg WHERE lgg.link = 944810 AND lgg.entity1 = g.id)
                
                UNION ALL
                
                -- Recursive step: traverse entity0 (broad) → entity1 (specific)
                SELECT 
                    child.entity1, -- The specific subgenre
                    g.name::TEXT AS genre_name,
                    (parent.path || '.' || g.name)::TEXT,
                    parent.level + 1,
                    parent.visited || child.entity1
                FROM l_genre_genre child
                JOIN genre_tree parent ON child.entity0 = parent.genre_id
                JOIN genre g ON child.entity1 = g.id
                WHERE child.link = 944810
                AND child.entity1 != ALL(parent.visited)  -- cycle protection
                AND parent.level < 20                     -- max depth guard
            )
            SELECT genre_id, genre_name, path, level FROM genre_tree;
        EXCEPTION 
            WHEN OTHERS THEN 
                RAISE NOTICE 'Materialized view creation failed (tables might be empty): %', SQLERRM;
        END $$;

        -- Enhance lookups on the materialized view
        CREATE INDEX IF NOT EXISTS genre_tree_paths_name_idx ON genre_tree_paths (LOWER(genre_name));
        CREATE INDEX IF NOT EXISTS genre_tree_paths_name_trgm_idx ON genre_tree_paths USING gin (LOWER(genre_name) gin_trgm_ops);
        DO $$ 
        BEGIN 
            CREATE UNIQUE INDEX IF NOT EXISTS genre_tree_paths_genre_path_idx ON genre_tree_paths (genre_id, path);
        EXCEPTION WHEN OTHERS THEN null; 
        END $$;

        -- Entity tables for UUID-based navigation
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";

        CREATE TABLE IF NOT EXISTS artists (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS albums (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          artist_name TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(title, artist_name)
        );

        CREATE TABLE IF NOT EXISTS genres (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Add FK columns to tracks (nullable, backfilled by migration)
        DO $$
        BEGIN
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS artist_id UUID REFERENCES artists(id);
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS album_id UUID REFERENCES albums(id);
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS genre_id UUID REFERENCES genres(id);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Indexes for FK lookups
        CREATE INDEX IF NOT EXISTS tracks_artist_id_idx ON tracks(artist_id);
        CREATE INDEX IF NOT EXISTS tracks_album_id_idx ON tracks(album_id);
        CREATE INDEX IF NOT EXISTS tracks_genre_id_idx ON tracks(genre_id);

        -- External metadata cache columns
        DO $$
        BEGIN
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS artwork_url TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS bio TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS mbid TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS normalized_key TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS last_updated BIGINT DEFAULT 0;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS mbid TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS last_updated BIGINT DEFAULT 0;
          ALTER TABLE genres ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE genres ADD COLUMN IF NOT EXISTS description TEXT;
          ALTER TABLE genres ADD COLUMN IF NOT EXISTS last_updated BIGINT DEFAULT 0;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS artists_normalized_key_idx ON artists(normalized_key);
        CREATE INDEX IF NOT EXISTS artists_mbid_idx ON artists(mbid);

        -- Persistent merge redirect. Set by mergeArtistRows on the duplicate
        -- row; getOrCreateArtist follows it so refreshes can't recreate the
        -- merged-away credit string as a fresh row.
        DO $$
        BEGIN
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES artists(id) ON DELETE SET NULL;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS artists_merged_into_idx ON artists(merged_into);

        -- Extended artist metadata cache (MusicBrainz fields + Last.fm stats)
        DO $$
        BEGIN
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS disambiguation TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS area TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS artist_type TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS lifespan_begin TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS lifespan_end TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS links TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS genres TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS community_tags TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS listeners TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS members TEXT;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- File-embedded URL tags per track
        DO $$
        BEGIN
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS raw_urls TEXT;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Disc number for multi-disc albums
        DO $$
        BEGIN
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS disc_number INTEGER;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Extended album metadata cache (Last.fm wiki + stats)
        DO $$
        BEGIN
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS description TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS tags TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS listeners TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS playcount TEXT;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Release-group / edition model. release_group_id is Aurora's own
        -- UUID so manual-merge works for albums without MusicBrainz tags.
        -- mb_release_group_id mirrors the MBID when present; the heuristic
        -- and MBID grouping both write the same release_group_id so the
        -- API can answer "what editions exist?" with a single lookup.
        DO $$
        BEGIN
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS release_group_id UUID;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS mb_release_group_id TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS edition_label TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS normalized_title TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS release_year INTEGER;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS manual_group_override BOOLEAN DEFAULT FALSE;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS is_compilation BOOLEAN DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS albums_release_group_id_idx ON albums(release_group_id);
        CREATE INDEX IF NOT EXISTS albums_mb_release_group_id_idx ON albums(mb_release_group_id);
        CREATE INDEX IF NOT EXISTS albums_normalized_title_idx ON albums(normalized_title);

        -- Pseudo-entity flag for "Various Artists" and similar. Derived
        -- at upsert time as: all of this artist's tracks live on albums
        -- whose is_compilation = TRUE. Replaces the deprecated name-list
        -- filter that previously hard-coded ('various artists','va',...).
        DO $$
        BEGIN
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS is_va_pseudo BOOLEAN DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS artists_is_va_pseudo_idx ON artists(is_va_pseudo);

        -- Multi-valued artist credits per track. The existing tracks.artist_id
        -- + tracks.artists JSON keep their meaning ("the primary credit" and
        -- "all credited names as one display string"). This join table layers
        -- role-specific credits on top: composer, conductor, performer (with
        -- instrument), lyricist, producer, remixer, engineer, etc.
        --
        -- source = 'tag' for credits parsed from on-disk metadata (the only
        -- path in v1). A future MusicBrainz enrichment can append rows with
        -- source = 'musicbrainz' without colliding, and the rescan-delete
        -- below is scoped to source = 'tag' so MB rows survive rescans.
        --
        -- detail is the empty string by default (not NULL) so it can be part
        -- of the primary key without needing COALESCE() — Postgres requires
        -- PK columns to be NOT NULL.
        CREATE TABLE IF NOT EXISTS track_artist_credits (
          track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'tag',
          detail TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (track_id, artist_id, role, detail)
        );
        CREATE INDEX IF NOT EXISTS track_artist_credits_artist_role_idx
          ON track_artist_credits(artist_id, role);
        CREATE INDEX IF NOT EXISTS track_artist_credits_track_idx
          ON track_artist_credits(track_id);

        -- ==========================================
        -- MULTI-USER TABLES
        -- ==========================================

        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS invites (
          token TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(32), 'hex'),
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          max_uses INTEGER DEFAULT 1,
          uses INTEGER DEFAULT 0,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS artist_duplicate_reviews (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          candidate_key TEXT NOT NULL,
          signature TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('dismissed', 'merged')),
          canonical_artist_id UUID REFERENCES artists(id) ON DELETE SET NULL,
          artist_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(candidate_key, signature)
        );
        CREATE INDEX IF NOT EXISTS artist_duplicate_reviews_key_idx ON artist_duplicate_reviews(candidate_key, signature);

        CREATE TABLE IF NOT EXISTS user_playback_stats (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
          play_count INTEGER NOT NULL DEFAULT 0,
          rating INTEGER NOT NULL DEFAULT 0,
          last_played_at TIMESTAMPTZ,
          PRIMARY KEY (user_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS ups_user_id_idx ON user_playback_stats(user_id);
        CREATE INDEX IF NOT EXISTS ups_track_id_idx ON user_playback_stats(track_id);

        CREATE TABLE IF NOT EXISTS user_track_play_buckets (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
          year_month DATE NOT NULL,
          play_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, track_id, year_month)
        );
        CREATE INDEX IF NOT EXISTS utpb_user_month_idx ON user_track_play_buckets(user_id, year_month);
        CREATE INDEX IF NOT EXISTS utpb_user_track_idx ON user_track_play_buckets(user_id, track_id);

        CREATE TABLE IF NOT EXISTS user_loved_tracks (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
          loved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS ult_user_id_idx ON user_loved_tracks(user_id);
        CREATE INDEX IF NOT EXISTS ult_track_id_idx ON user_loved_tracks(track_id);

        CREATE TABLE IF NOT EXISTS user_settings (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );

        CREATE TABLE IF NOT EXISTS subsonic_api_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS subsonic_api_keys_user_id_idx ON subsonic_api_keys(user_id);
        CREATE INDEX IF NOT EXISTS subsonic_api_keys_active_idx ON subsonic_api_keys(user_id, revoked_at);
        CREATE UNIQUE INDEX IF NOT EXISTS subsonic_api_keys_prefix_idx ON subsonic_api_keys(key_prefix);
        CREATE INDEX IF NOT EXISTS tracks_title_trgm_idx ON tracks USING gin (title gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS tracks_artist_trgm_idx ON tracks USING gin (artist gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS tracks_album_trgm_idx ON tracks USING gin (album gin_trgm_ops);

        -- Add user_id to playlists (nullable for backward compat)
        DO $$
        BEGIN
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS playlists_user_id_idx ON playlists(user_id);

        -- Add pinned column to playlists
        DO $$
        BEGIN
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Add is_system column to playlists (system-owned, read-only to users)
        DO $$
        BEGIN
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Shareable playlist links: an opaque token + a public flag enabling an
        -- unauthenticated, read-only snapshot of the playlist.
        DO $$
        BEGIN
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS share_token TEXT;
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE UNIQUE INDEX IF NOT EXISTS playlists_share_token_idx ON playlists(share_token) WHERE share_token IS NOT NULL;

        -- ==========================================
        -- JAMBASE / CONCERTS
        -- ==========================================

        DO $$
        BEGIN
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS jambase_id TEXT;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS artists_jambase_id_idx ON artists(jambase_id);

        CREATE TABLE IF NOT EXISTS user_artist_subscriptions (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, artist_id)
        );
        CREATE INDEX IF NOT EXISTS uas_user_id_idx ON user_artist_subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS uas_artist_id_idx ON user_artist_subscriptions(artist_id);

        -- 'explicit' = user manually subscribed; 'auto' = added by auto-add.
        -- Distinguishing the two lets us avoid evicting explicit picks during
        -- auto-refresh and lets the UI show an "auto" badge.
        DO $$
        BEGIN
          ALTER TABLE user_artist_subscriptions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'explicit';
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- When a user removes an auto-added artist, record it here so the
        -- next auto-add run doesn't immediately re-add the same artist.
        CREATE TABLE IF NOT EXISTS user_dismissed_auto_artists (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
          dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, artist_id)
        );
        CREATE INDEX IF NOT EXISTS udaa_user_id_idx ON user_dismissed_auto_artists(user_id);

        CREATE TABLE IF NOT EXISTS concert_events (
          jambase_event_id TEXT PRIMARY KEY,
          artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
          event_date DATE NOT NULL,
          event_datetime TIMESTAMPTZ,
          venue_name TEXT,
          venue_city TEXT,
          venue_region TEXT,
          venue_country TEXT,
          venue_lat DOUBLE PRECISION,
          venue_lng DOUBLE PRECISION,
          ticket_url TEXT,
          price_min NUMERIC,
          price_max NUMERIC,
          price_currency TEXT,
          status TEXT,
          raw_json JSONB,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS concert_events_artist_id_idx ON concert_events(artist_id);
        CREATE INDEX IF NOT EXISTS concert_events_event_date_idx ON concert_events(event_date);
        CREATE INDEX IF NOT EXISTS concert_events_artist_date_idx ON concert_events(artist_id, event_date);

        -- Per-artist fetch marker so we know "we checked, nothing here" vs "never checked".
        -- Without this, an artist with zero upcoming shows would be re-fetched on every visit.
        CREATE TABLE IF NOT EXISTS artist_concerts_cache (
          artist_id UUID PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
          jambase_id TEXT,
          events_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Monthly API counter. One row per calendar month (e.g. '2026-04').
        -- Lazy reset: first call of a new month inserts a fresh row.
        CREATE TABLE IF NOT EXISTS concerts_api_usage (
          year_month TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0,
          last_call_at TIMESTAMPTZ
        );

        -- ==========================================
        -- GIN TRIGRAM INDEXES FOR FILTER ILIKE QUERIES
        -- pg_trgm extension is already enabled above.
        -- These allow index-backed wildcard text search
        -- instead of sequential scans on large tables.
        -- ==========================================
        CREATE INDEX IF NOT EXISTS artists_name_trgm_idx ON artists USING gin (name gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS artists_genres_trgm_idx ON artists USING gin (genres gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS artists_community_tags_trgm_idx ON artists USING gin (community_tags gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS artists_area_trgm_idx ON artists USING gin (area gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS albums_title_trgm_idx ON albums USING gin (title gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS albums_artist_name_trgm_idx ON albums USING gin (artist_name gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS albums_tags_trgm_idx ON albums USING gin (tags gin_trgm_ops);
      `);

      // One-time backfill of user_track_play_buckets from user_playback_stats.
      // Lossy: attributes all historical plays to the month of last_played_at.
      // Skipped after first run (the table will already contain rows).
      const bucketProbe = await client.query('SELECT 1 FROM user_track_play_buckets LIMIT 1');
      if (bucketProbe.rowCount === 0) {
        const upsProbe = await client.query(
          `SELECT 1 FROM user_playback_stats WHERE last_played_at IS NOT NULL AND play_count > 0 LIMIT 1`
        );
        if ((upsProbe.rowCount ?? 0) > 0) {
          const result = await client.query(`
            INSERT INTO user_track_play_buckets (user_id, track_id, year_month, play_count)
            SELECT user_id, track_id, date_trunc('month', last_played_at)::date, play_count
            FROM user_playback_stats
            WHERE last_played_at IS NOT NULL AND play_count > 0
            ON CONFLICT (user_id, track_id, year_month) DO NOTHING
          `);
          console.log(`[DB] Backfilled ${result.rowCount} rows into user_track_play_buckets from user_playback_stats`);
        }
      }

      client.release();
      pool = instance;
      return pool;
    } catch (e) {
      if (client) {
        try { client.release(); } catch {}
      }
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

export async function getDatabaseStats() {
  try {
    const p = await initDB();
    const queries = {
      tables: "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
      indexes: "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'",
      tracks: "SELECT count(*) FROM tracks",
      artists: "SELECT count(*) FROM artists WHERE merged_into IS NULL",
      albums: "SELECT count(*) FROM albums",
      genres: "SELECT count(*) FROM genres",
      playlists: "SELECT count(*) FROM playlists"
    };

    const results: any = {};
    for (const [key, query] of Object.entries(queries)) {
      try {
        const res = await p.query(query);
        results[key] = parseInt(res.rows[0].count || '0', 10);
      } catch (e) {
        results[key] = 0;
      }
    }
    return results;
  } catch (e) {
    console.error('[DB] Failed to get stats:', e);
    return null;
  }
}

export async function closeDB() {
  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
  }
}

export async function getPoolStats() {
  if (!pool) return null;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

// Ensure the local dev server gracefully cleans up the database lock on restarts or exits.
let isShuttingDown = false;
async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[PGlite] Received ${signal}, shutting down...`);
  await closeDB();
  if (signal === 'SIGUSR2') {
    process.kill(process.pid, 'SIGUSR2');
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.once('SIGUSR2', () => handleShutdown('SIGUSR2'));

function parseStringArrayField(value: any): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value !== 'string' || value.trim().length === 0) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }
    if (typeof parsed === 'string' && parsed.trim().length > 0) {
      return [parsed];
    }
  } catch {
    return [value];
  }

  return [];
}

function parseObjectArrayField<T extends object>(value: any): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.trim().length === 0) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTrackRow(row: any) {
  return {
    ...row,
    albumArtist: row.album_artist,
    trackNumber: row.track_number,
    discNumber: row.disc_number ?? null,
    releaseType: row.release_type,
    isCompilation: !!row.is_compilation,
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at ? new Date(row.last_played_at).getTime() : 0,
    bitrate: row.bitrate,
    format: row.format,
    fileSize: row.file_size != null ? Number(row.file_size) : undefined,
    artistId: row.artist_id,
    albumId: row.album_id,
    genreId: row.genre_id,
    mbRecordingId: row.mb_recording_id,
    mbTrackId: row.mb_track_id,
    mbAlbumId: row.mb_album_id,
    mbArtistId: row.mb_artist_id,
    mbAlbumArtistId: row.mb_album_artist_id,
    mbReleaseGroupId: row.mb_release_group_id,
    mbWorkId: row.mb_work_id,
    artists: parseStringArrayField(row.artists),
    genres: parseStringArrayField(row.genres),
    rawUrls: parseObjectArrayField<{ url: string; type: string }>(row.raw_urls),
    playlistAddedAt: row.playlist_added_at ? new Date(row.playlist_added_at).getTime() : undefined,
    isLoved: row.is_loved === true,
    artHash: row.art_hash ?? undefined,
  };
}

export async function getAllTracks(userId: string | null = null) {
  const db = await initDB();
  // LEFT JOIN instead of a correlated EXISTS subquery: the EXISTS re-ran once per
  // track row (full-library hot path), whereas the join resolves loved-state in a
  // single pass using ult_user_id_idx / ult_track_id_idx. Matters at 100k tracks.
  const res = userId
    ? await db.query(`
        SELECT t.*, (ult.track_id IS NOT NULL) AS is_loved
        FROM tracks t
        LEFT JOIN user_loved_tracks ult
          ON ult.track_id = t.id AND ult.user_id = $1
      `, [userId])
    : await db.query('SELECT t.*, FALSE AS is_loved FROM tracks t');
  return res.rows.map(mapTrackRow);
}

export async function getTrackById(trackId: string) {
  const db = await initDB();
  const res = await db.query('SELECT t.*, FALSE AS is_loved FROM tracks t WHERE t.id = $1', [trackId]);
  return res.rows[0] ? mapTrackRow(res.rows[0]) : null;
}

// Returns all known track paths as a Set for O(1) existence checks during scanning.
export async function getExistingPaths(): Promise<Set<string>> {
  const db = await initDB();
  const res = await db.query('SELECT path FROM tracks');
  return new Set(res.rows.map((r: any) => r.path));
}

// Path (base64) → { mtime, artHash } for incremental change detection during a
// scan. mtime is epoch ms (null for rows predating the file_mtime column).
export async function getPathsWithMeta(): Promise<Map<string, { mtime: number | null; artHash: string | null }>> {
  const db = await initDB();
  const res = await db.query('SELECT path, file_mtime, art_hash FROM tracks');
  const map = new Map<string, { mtime: number | null; artHash: string | null }>();
  for (const r of res.rows) {
    if (!r.path) continue;
    map.set(r.path, {
      mtime: r.file_mtime != null ? Number(r.file_mtime) : null,
      artHash: r.art_hash ?? null,
    });
  }
  return map;
}

// Whether any track still references an art hash — drives orphan cleanup.
export async function countTracksByArtHash(hash: string): Promise<number> {
  const db = await initDB();
  const res = await db.query('SELECT 1 FROM tracks WHERE art_hash = $1 LIMIT 1', [hash]);
  return res.rows.length;
}

// art_hash for a single track path (base64), or null if unknown / unprocessed.
export async function getArtHashForPath(b64Path: string): Promise<string | null> {
  const db = await initDB();
  const res = await db.query('SELECT art_hash FROM tracks WHERE path = $1 LIMIT 1', [b64Path]);
  if (res.rows.length === 0) return null;
  return res.rows[0].art_hash ?? null;
}

// Returns a Buffer array of decoded UTF-8 paths matching a specific directory prefix.
//
// Filters at the BYTE level inside Postgres (decode the base64 path to bytea and
// compare the directory prefix + a '/' boundary byte) instead of shipping every
// row to Node and base64-decoding each in a JS loop. Byte-level (not convert_from
// /UTF8) keeps it resilient: it never throws on a path that isn't valid UTF-8.
// Returns only matching rows — the seq scan is unindexed but vastly cheaper than
// transferring the whole tracks table at 100k+.
export async function getPathsForDirectory(dirPath: string): Promise<Buffer[]> {
  const db = await initDB();
  const dirBuf = Buffer.from(dirPath, 'utf8');
  const res = await db.query(
    `SELECT path FROM (
       SELECT path, decode(path, 'base64') AS p FROM tracks WHERE path IS NOT NULL
     ) s
     WHERE substring(s.p FROM 1 FOR octet_length($1::bytea)) = $1::bytea
       AND (octet_length(s.p) = octet_length($1::bytea)
            OR get_byte(s.p, octet_length($1::bytea)) = 47)`, // 47 = '/'
    [dirBuf]
  );
  return res.rows.map((r: any) => Buffer.from(r.path, 'base64'));
}

export async function addTrack(track: any) {
  const db = await initDB();
  const id = Buffer.from(track.path).toString('base64');
  
  // Sanitize strings to remove null bytes which crash Postgres
  const sanitizeArray = (arr: any) => Array.isArray(arr) ? arr.map(sanitizeString) : arr;

  await db.query(`
    INSERT INTO tracks (id, title, artist, album_artist, artists, album, genre, duration, track_number, disc_number, year, release_type, is_compilation, path, bitrate, format, artist_id, album_id, genre_id, genres, isrc, mb_recording_id, mb_track_id, mb_album_id, mb_artist_id, mb_album_artist_id, mb_release_group_id, mb_work_id, raw_urls, art_hash, file_mtime, file_size)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      artist = EXCLUDED.artist,
      album_artist = EXCLUDED.album_artist,
      artists = EXCLUDED.artists,
      album = EXCLUDED.album,
      genre = EXCLUDED.genre,
      duration = EXCLUDED.duration,
      track_number = EXCLUDED.track_number,
      disc_number = EXCLUDED.disc_number,
      year = EXCLUDED.year,
      release_type = EXCLUDED.release_type,
      is_compilation = EXCLUDED.is_compilation,
      path = EXCLUDED.path,
      bitrate = EXCLUDED.bitrate,
      format = EXCLUDED.format,
      artist_id = EXCLUDED.artist_id,
      album_id = EXCLUDED.album_id,
      genre_id = EXCLUDED.genre_id,
      genres = EXCLUDED.genres,
      isrc = EXCLUDED.isrc,
      mb_recording_id = EXCLUDED.mb_recording_id,
      mb_track_id = EXCLUDED.mb_track_id,
      mb_album_id = EXCLUDED.mb_album_id,
      mb_artist_id = EXCLUDED.mb_artist_id,
      mb_album_artist_id = EXCLUDED.mb_album_artist_id,
      mb_release_group_id = EXCLUDED.mb_release_group_id,
      mb_work_id = EXCLUDED.mb_work_id,
      raw_urls = EXCLUDED.raw_urls,
      -- COALESCE so a metadata-parse-failure re-insert (which passes no art
      -- fields) never wipes an already-encoded cover.
      art_hash = COALESCE(EXCLUDED.art_hash, tracks.art_hash),
      file_mtime = COALESCE(EXCLUDED.file_mtime, tracks.file_mtime),
      file_size = COALESCE(EXCLUDED.file_size, tracks.file_size)
    WHERE
      tracks.title IS DISTINCT FROM EXCLUDED.title OR
      tracks.artist IS DISTINCT FROM EXCLUDED.artist OR
      tracks.album_artist IS DISTINCT FROM EXCLUDED.album_artist OR
      tracks.artists IS DISTINCT FROM EXCLUDED.artists OR
      tracks.album IS DISTINCT FROM EXCLUDED.album OR
      tracks.genre IS DISTINCT FROM EXCLUDED.genre OR
      tracks.duration IS DISTINCT FROM EXCLUDED.duration OR
      tracks.track_number IS DISTINCT FROM EXCLUDED.track_number OR
      tracks.disc_number IS DISTINCT FROM EXCLUDED.disc_number OR
      tracks.year IS DISTINCT FROM EXCLUDED.year OR
      tracks.release_type IS DISTINCT FROM EXCLUDED.release_type OR
      tracks.is_compilation IS DISTINCT FROM EXCLUDED.is_compilation OR
      tracks.path IS DISTINCT FROM EXCLUDED.path OR
      tracks.bitrate IS DISTINCT FROM EXCLUDED.bitrate OR
      tracks.format IS DISTINCT FROM EXCLUDED.format OR
      tracks.artist_id IS DISTINCT FROM EXCLUDED.artist_id OR
      tracks.album_id IS DISTINCT FROM EXCLUDED.album_id OR
      tracks.genre_id IS DISTINCT FROM EXCLUDED.genre_id OR
      tracks.genres IS DISTINCT FROM EXCLUDED.genres OR
      tracks.isrc IS DISTINCT FROM EXCLUDED.isrc OR
      tracks.mb_recording_id IS DISTINCT FROM EXCLUDED.mb_recording_id OR
      tracks.mb_track_id IS DISTINCT FROM EXCLUDED.mb_track_id OR
      tracks.mb_album_id IS DISTINCT FROM EXCLUDED.mb_album_id OR
      tracks.mb_artist_id IS DISTINCT FROM EXCLUDED.mb_artist_id OR
      tracks.mb_album_artist_id IS DISTINCT FROM EXCLUDED.mb_album_artist_id OR
      tracks.mb_release_group_id IS DISTINCT FROM EXCLUDED.mb_release_group_id OR
      tracks.mb_work_id IS DISTINCT FROM EXCLUDED.mb_work_id OR
      tracks.raw_urls IS DISTINCT FROM EXCLUDED.raw_urls OR
      -- Trigger the upsert when only the artwork or the file mtime changed, so
      -- a re-tag (identical text metadata, new cover) still records the update.
      (EXCLUDED.art_hash IS NOT NULL AND tracks.art_hash IS DISTINCT FROM EXCLUDED.art_hash) OR
      (EXCLUDED.file_mtime IS NOT NULL AND tracks.file_mtime IS DISTINCT FROM EXCLUDED.file_mtime) OR
      (EXCLUDED.file_size IS NOT NULL AND tracks.file_size IS DISTINCT FROM EXCLUDED.file_size)
  `, [
    id,
    sanitizeString(track.title) || path.basename(track.path),
    sanitizeString(track.artist) || null,
    sanitizeString(track.albumArtist) || null,
    track.artists ? JSON.stringify(sanitizeArray(track.artists)) : null,
    sanitizeString(track.album) || null,
    sanitizeString(track.genre) || null,
    track.duration || 0,
    track.trackNumber || null,
    track.discNumber || null,
    track.year || null,
    track.releaseType || null,
    !!track.isCompilation,
    track.path,
    track.bitrate || null,
    track.format || null,
    track.artistId || null,
    track.albumId || null,
    track.genreId || null,
    track.genres ? JSON.stringify(sanitizeArray(track.genres)) : null,
    track.isrc || null,
    track.mbRecordingId || null,
    track.mbTrackId || null,
    track.mbAlbumId || null,
    track.mbArtistId || null,
    track.mbAlbumArtistId || null,
    track.mbReleaseGroupId || null,
    track.mbWorkId || null,
    track.rawUrls ? JSON.stringify(track.rawUrls) : null,
    track.artHash ?? null,
    track.fileMtime ?? null,
    track.fileSize ?? null,
  ]);

  if (track.audioFeatures) {
    const vector8dStr = `[${track.audioFeatures.acoustic_vector.join(',')}]`;
    await db.query(`
      INSERT INTO track_features (track_id, bpm, acoustic_vector_8d)
      VALUES ($1, $2, $3)
      ON CONFLICT (track_id) DO UPDATE SET
        bpm = EXCLUDED.bpm,
        acoustic_vector_8d = EXCLUDED.acoustic_vector_8d
      WHERE track_features.bpm IS DISTINCT FROM EXCLUDED.bpm OR track_features.acoustic_vector_8d IS DISTINCT FROM EXCLUDED.acoustic_vector_8d
    `, [id, track.audioFeatures.bpm, vector8dStr]);
  }
}

export async function clearTracks() {
  const db = await initDB();
  await db.query('DELETE FROM tracks');
}

// One-time backfill of file_size for rows scanned before the column existed.
// Cheap: it only stats files (no metadata parse) for rows missing a size and
// updates them. Once every on-disk track has a size this is a no-op query, so
// it is safe to call at the end of every scan.
export async function backfillTrackFileSizes(): Promise<number> {
  const db = await initDB();
  const res = await db.query('SELECT id, path FROM tracks WHERE file_size IS NULL AND path IS NOT NULL');
  if (res.rows.length === 0) return 0;
  let updated = 0;
  const CONCURRENCY = 16;
  for (let i = 0; i < res.rows.length; i += CONCURRENCY) {
    const batch = res.rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (row: any) => {
      try {
        const realPath = Buffer.from(row.path, 'base64'); // raw filesystem-path bytes
        const stat = await fs.promises.stat(realPath);
        await db.query('UPDATE tracks SET file_size = $2 WHERE id = $1', [row.id, stat.size]);
        updated++;
      } catch {
        // File missing/unreadable — leave NULL; nothing to surface.
      }
    }));
  }
  return updated;
}

export async function addTrackFeatures(trackId: string, audioFeatures: { bpm: number; acoustic_vector: number[]; embedding_vector?: number[]; is_simulated?: boolean }) {
  const db = await initDB();
  const vector8dStr = `[${audioFeatures.acoustic_vector.slice(0, 8).join(',')}]`;
  const simulated = audioFeatures.is_simulated ?? false;
  const embStr = audioFeatures.embedding_vector && audioFeatures.embedding_vector.length > 0
    ? `[${audioFeatures.embedding_vector.join(',')}]`
    : null;

  await db.query(`
    INSERT INTO track_features (track_id, bpm, acoustic_vector_8d, embedding_vector, is_simulated)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (track_id) DO UPDATE SET
      bpm = EXCLUDED.bpm,
      acoustic_vector_8d = EXCLUDED.acoustic_vector_8d,
      embedding_vector = EXCLUDED.embedding_vector,
      is_simulated = EXCLUDED.is_simulated
  `, [trackId, audioFeatures.bpm, vector8dStr, embStr, simulated]);
}

export async function getTracksWithoutFeatures(): Promise<{ id: string; filePath: Buffer; title: string; artist: string | null }[]> {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.id, t.path, t.title, t.artist
    FROM tracks t
    LEFT JOIN track_features tf ON t.id = tf.track_id
    WHERE tf.track_id IS NULL
    ORDER BY t.title
  `);
  return res.rows.map((r: any) => ({
    id: r.id,
    filePath: Buffer.from(r.path, 'base64'),
    title: r.title,
    artist: r.artist || null,
  }));
}

export async function getTracksWithSimulatedFeatures(): Promise<{ id: string; filePath: Buffer; title: string; artist: string | null }[]> {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.id, t.path, t.title, t.artist
    FROM tracks t
    JOIN track_features tf ON t.id = tf.track_id
    WHERE tf.is_simulated = TRUE
    ORDER BY t.title
  `);
  return res.rows.map((r: any) => ({
    id: r.id,
    filePath: Buffer.from(r.path, 'base64'),
    title: r.title,
    artist: r.artist || null,
  }));
}

export async function getSimulatedFeatureTracks(limit = 50): Promise<Array<{
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  filename: string;
  filePath: string;
  bpm: number | null;
}>> {
  const db = await initDB();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const res = await db.query(`
    SELECT t.id, t.title, t.artist, t.album, t.path, tf.bpm
    FROM tracks t
    JOIN track_features tf ON t.id = tf.track_id
    WHERE tf.is_simulated = TRUE
    ORDER BY t.artist NULLS LAST, t.title NULLS LAST
    LIMIT $1
  `, [safeLimit]);

  return res.rows.map((r: any) => {
    const decodedPath = Buffer.from(r.path, 'base64').toString('utf8');
    return {
      id: r.id,
      title: r.title,
      artist: r.artist || null,
      album: r.album || null,
      filename: path.basename(decodedPath),
      filePath: decodedPath,
      bpm: r.bpm === null || r.bpm === undefined ? null : Number(r.bpm),
    };
  });
}

export async function getTrackCountWithFeatures(): Promise<{ withFeatures: number; total: number }> {
  const db = await initDB();
  const res = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(tf.track_id) as with_features
    FROM tracks t
    LEFT JOIN track_features tf ON t.id = tf.track_id
  `);
  const row = res.rows[0];
  return { withFeatures: parseInt(row.with_features), total: parseInt(row.total) };
}

export async function addDirectory(dirPath: string) {
  const db = await initDB();
  const id = Buffer.from(dirPath).toString('base64');
  await db.query('INSERT INTO directories (id, path) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, dirPath]);
  return { id, path: dirPath };
}

export async function getDirectories() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM directories');
  return res.rows.map((d: any) => d.path);
}

export async function removeDirectory(dirPath: string) {
  const db = await initDB();
  const id = Buffer.from(dirPath, 'utf8').toString('base64');  // Fixed: explicit 'utf8' encoding
  await db.query('DELETE FROM directories WHERE id = $1', [id]);
}

export async function removeTracksByDirectory(dirPath: string) {
  const db = await initDB();

  // Match the directory at the byte level inside Postgres (paths are stored as
  // base64 of the raw UTF-8 bytes) and delete in a single statement, instead of
  // SELECT-ing every track, decoding each in a JS loop, then chunked-deleting.
  // See getPathsForDirectory for the matching rationale.
  const dirBuf = Buffer.from(dirPath, 'utf8');
  await db.query(
    `DELETE FROM tracks WHERE id IN (
       SELECT id FROM (
         SELECT id, decode(path, 'base64') AS p FROM tracks WHERE path IS NOT NULL
       ) s
       WHERE substring(s.p FROM 1 FOR octet_length($1::bytea)) = $1::bytea
         AND (octet_length(s.p) = octet_length($1::bytea)
              OR get_byte(s.p, octet_length($1::bytea)) = 47)
     )`, // 47 = '/'
    [dirBuf]
  );
}

// Delete a specific set of tracks by their IDs.
export async function deleteTracksByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await initDB();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
    await db.query(`DELETE FROM tracks WHERE id IN (${placeholders})`, chunk);
  }
}

// Delete tracks by their stored base64 path values. Sync-walk diffs disk paths
// against tracks.path, while tracks.id may differ on existing libraries.
export async function deleteTracksByPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const db = await initDB();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
    await db.query(`DELETE FROM tracks WHERE path IN (${placeholders})`, chunk);
  }
}

/**
 * Safety-net: removes tracks whose decoded file path no longer belongs to any
 * registered directory in the directories table.
 *
 * This catches the edge case where removeTracksByDirectory() found 0 matches
 * due to a subtle path encoding mismatch, leaving stale tracks in the DB even
 * after a directory was correctly de-registered.
 */
export async function purgeOrphanedTracks(): Promise<number> {
  const db = await initDB();

  const [tracksRes, dirsRes] = await Promise.all([
    db.query('SELECT id, path FROM tracks'),
    db.query('SELECT path FROM directories'),
  ]);

  const dirs: Buffer[] = dirsRes.rows.map((r: any) => Buffer.from(r.path as string, 'utf8'));

  const staleIds: string[] = [];
  for (const row of tracksRes.rows) {
    const fileBuf = Buffer.from(row.path as string, 'base64');
    const belongs = dirs.some(dirBuf => {
      const prefixMatches =
        fileBuf.length >= dirBuf.length &&
        fileBuf.slice(0, dirBuf.length).equals(dirBuf);
      const atBoundary =
        fileBuf.length === dirBuf.length ||
        fileBuf[dirBuf.length] === 0x2f; // '/'
      return prefixMatches && atBoundary;
    });
    if (!belongs) staleIds.push(row.id as string);
  }

  if (staleIds.length > 0) {
    console.log(`[DB] purgeOrphanedTracks: removing ${staleIds.length} tracks with no registered directory`);
    for (let i = 0; i < staleIds.length; i += 100) {
      const chunk = staleIds.slice(i, i + 100);
      const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
      await db.query(`DELETE FROM tracks WHERE id IN (${placeholders})`, chunk);
    }
  }

  return staleIds.length;
}

/**
 * Remove albums, artists, and genres that have zero tracks still referencing them.
 * Call this after any bulk track deletion (folder removal, sync-walk pruning) to prevent
 * ghost entries appearing in the library UI.
 */
export async function purgeOrphanedEntities(): Promise<{ albums: number; artists: number; genres: number }> {
  const db = await initDB();

  const [albumRes, artistRes, genreRes] = await Promise.all([
    db.query(`
      DELETE FROM albums
      WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)
      RETURNING id
    `),
    db.query(`
      WITH credited_artist_names AS (
        SELECT DISTINCT lower(btrim(credited_artist.name)) AS name
        FROM tracks t
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN t.artists IS NOT NULL AND btrim(t.artists) LIKE '[%' THEN t.artists::jsonb
            ELSE '[]'::jsonb
          END
        ) AS credited_artist(name)
      )
      DELETE FROM artists a
      WHERE a.merged_into IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM tracks t
        WHERE t.artist_id = a.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM credited_artist_names credited
        WHERE credited.name = lower(btrim(a.name))
      )
      AND NOT EXISTS (
        -- Keep artists referenced only via track_artist_credits (producers,
        -- composers, featured credits whose name isn't in any track.artists JSON).
        -- Without this guard the ON DELETE CASCADE on track_artist_credits.artist_id
        -- silently destroys credit-only artists on every rescan. Index-backed via
        -- track_artist_credits_artist_role_idx.
        SELECT 1
        FROM track_artist_credits tac
        WHERE tac.artist_id = a.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM artists redirect
        WHERE redirect.merged_into = a.id
      )
      RETURNING id
    `),
    db.query(`
      DELETE FROM genres
      WHERE id NOT IN (SELECT DISTINCT genre_id FROM tracks WHERE genre_id IS NOT NULL)
      RETURNING id
    `),
  ]);

  // Clear in-memory caches so subsequent getOrCreate* calls re-fetch from DB
  clearEntityCaches();

  return {
    albums: albumRes.rowCount ?? 0,
    artists: artistRes.rowCount ?? 0,
    genres: genreRes.rowCount ?? 0,
  };
}

export async function recordPlayback(trackId: string) {
  const db = await initDB();
  // Increment playCount, update lastPlayedAt, and passively give a small rating bump
  await db.query(`
    UPDATE tracks 
    SET play_count = play_count + 1,
        last_played_at = NOW(),
        rating = LEAST(rating + 1, 5)
    WHERE id = $1
  `, [trackId]);
}

export async function recordSkip(trackId: string) {
  const db = await initDB();
  // Penalize rating slightly for skips
  await db.query(`
    UPDATE tracks 
    SET rating = GREATEST(rating - 1, 0)
    WHERE id = $1
  `, [trackId]);
}

// ==========================================
// ENTITY HELPERS (Artists, Albums, Genres)
// ==========================================

// Constants for missing metadata
const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_ALBUM = 'Unknown Album';
const UNKNOWN_GENRE = 'Unknown Genre';
const FEATURE_ARTIST_BACKFILL_SETTING = 'artistCreditFeatureBackfillV1';
const ARTIST_CANONICALIZATION_SETTING = 'artistCanonicalizationV1';
const COMPOUND_CREDIT_SPLIT_SETTING = 'artistCompoundCreditSplitV1';
const ALBUM_ARTIST_NAME_SYNC_SETTING = 'albumArtistNameSyncV1';

function cleanArtistNamePart(value: string): string {
  return value
    .trim()
    .replace(/^[([{]+/, '')
    .replace(/[)\]}]+$/, '')
    .trim();
}

function uniqueArtistNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawName of names) {
    const name = cleanArtistNamePart(rawName);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(name);
  }

  return result;
}

export function normalizeArtistIdentityKey(name: string | null | undefined): string {
  return (name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function scoreArtistDisplayName(name: string): number {
  let score = 0;
  if (/[^\x00-\x7F]/.test(name)) score += 4;
  if (/[’'`´.-]/.test(name)) score += 2;
  if (/[a-z]/.test(name)) score += 1;
  if (name === name.toUpperCase() && /[A-Z]/.test(name) && name.length <= 4) score -= 2;
  return score;
}

// Splits a list-style credit like "Alok, Martin Jensen & Jason Derulo" into
// individual names. The comma is the trigger: presence of a comma means the
// string is a list, so we split on commas and on a final " & " (Oxford-and).
// Without a comma we keep the part intact so true group names like
// "Nick & Jay" / "Hall & Oates" / "Mr. & Mrs. Smith" are preserved. We avoid
// splitting on the word "and" — too many band names contain it.
function explodeListCredit(part: string): string[] {
  if (!part.includes(',')) return [part];
  const commaParts = part
    .split(/\s*,\s*/)
    .map(cleanArtistNamePart)
    .filter(Boolean);
  if (commaParts.length === 0) return [];
  const last = commaParts[commaParts.length - 1];
  const ampSplit = last
    .split(/\s+&\s+/)
    .map(cleanArtistNamePart)
    .filter(Boolean);
  if (ampSplit.length > 1) {
    return [...commaParts.slice(0, -1), ...ampSplit];
  }
  return commaParts;
}

// Utility for splitting credit strings into individual artist names. Splits on
// `feat.`/`ft.`/`featuring` markers and on comma-list patterns ("A, B & C").
// Deliberately does NOT split on a bare "&" or "and" — names like
// "Nick & Jay" or "Florence and the Machine" are a single artist.
export function splitArtistNames(artistStr: string | null | undefined): string[] {
  if (!artistStr) return [];
  const featuredParts = artistStr
    .split(/\s*(?:[\(\[\{]\s*)?\b(?:feat\.?|ft\.?|featuring)\b\.?\s+(?!$)/i)
    .map(cleanArtistNamePart)
    .filter(Boolean);
  const exploded = featuredParts.flatMap(explodeListCredit);
  return uniqueArtistNames(exploded);
}

export function normalizeArtistNames(
  rawArtistsField: string[] | string | null | undefined,
  fallbackArtist?: string | null
): string[] {
  const rawNames = Array.isArray(rawArtistsField)
    ? rawArtistsField
    : rawArtistsField
      ? [rawArtistsField]
      : fallbackArtist
        ? [fallbackArtist]
        : [];

  return uniqueArtistNames(rawNames.flatMap(name => splitArtistNames(name)));
}

export function getPrimaryArtistName(
  albumArtist: string | null | undefined,
  trackArtist: string | null | undefined,
  artistNames: string[]
): string | null {
  const albumArtistNames = normalizeArtistNames(albumArtist, null);
  if (albumArtistNames.length > 0) return albumArtistNames[0];
  if (artistNames.length > 0) return artistNames[0];
  return trackArtist?.trim() || null;
}

// Utility for splitting multiple genres (e.g., "Folk, Country, Rock")
export function splitGenreNames(genreStr: string | null | undefined): string[] {
  if (!genreStr) return [];
  // Only split on comma or semicolon. Do NOT split on slash or ampersand
  // as this breaks genres like 'Pop/Rock', 'Dance/Electronic', and 'R&B'.
  const parts = genreStr.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [];
}

// In-memory caches to reduce DB round-trips during scanning
const artistCache = new Map<string, string>();   // name/normalized-key/mbid -> UUID
const albumCache = new Map<string, string>();     // "title::::artist" -> UUID
const genreCache = new Map<string, string>();     // name -> UUID

function clearEntityCaches() {
  artistCache.clear();
  albumCache.clear();
  genreCache.clear();
}

// Sanitize strings to remove null bytes which crash Postgres
const sanitizeString = (str: any) => typeof str === 'string' ? str.replace(/\x00/g, '') : str;

async function resolveMergedArtist(db: Pool, id: string): Promise<string> {
  let currentId = id;
  for (let i = 0; i < 8; i++) {
    const row = await db.query('SELECT merged_into FROM artists WHERE id = $1', [currentId]);
    const next = row.rows[0]?.merged_into;
    if (!next || next === currentId) return currentId;
    currentId = next;
  }
  return currentId;
}

export async function getOrCreateArtist(name?: string | null, mbid?: string | null): Promise<string> {
  const safeName = sanitizeString(name)?.trim() || UNKNOWN_ARTIST;
  const lowerName = safeName.toLowerCase();
  const normalizedKey = normalizeArtistIdentityKey(safeName);
  const safeMbid = sanitizeString(mbid)?.trim() || null;
  const cacheKey = safeMbid ? `mbid:${safeMbid}` : `key:${normalizedKey || lowerName}`;

  const cached = artistCache.get(cacheKey) || artistCache.get(lowerName);
  if (cached) return cached;

  const db = await initDB();

  if (safeMbid) {
    const byMbid = await db.query('SELECT id FROM artists WHERE mbid = $1 LIMIT 1', [safeMbid]);
    if (byMbid.rows.length > 0) {
      const id = await resolveMergedArtist(db, byMbid.rows[0].id);
      await db.query(
        'UPDATE artists SET normalized_key = COALESCE(normalized_key, $2) WHERE id = $1',
        [id, normalizedKey || null]
      );
      artistCache.set(cacheKey, id);
      artistCache.set(lowerName, id);
      return id;
    }
  }

  const existing = await db.query(
    `SELECT id
     FROM artists
     WHERE LOWER(name) = $1
        OR (
          normalized_key IS NOT NULL
          AND normalized_key = $2
          AND (mbid IS NULL OR $3::text IS NULL OR mbid = $3)
        )
     ORDER BY
       CASE WHEN mbid IS NOT NULL THEN 0 ELSE 1 END,
       created_at ASC
     LIMIT 1`,
    [lowerName, normalizedKey || null, safeMbid]
  );
  if (existing.rows.length > 0) {
    const id = await resolveMergedArtist(db, existing.rows[0].id);
    await db.query(
      'UPDATE artists SET normalized_key = COALESCE(normalized_key, $2), mbid = COALESCE(mbid, $3) WHERE id = $1',
      [id, normalizedKey || null, safeMbid]
    );
    artistCache.set(cacheKey, id);
    artistCache.set(lowerName, id);
    return id;
  }

  const res = await db.query(
    `INSERT INTO artists (name, normalized_key, mbid)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET
       normalized_key = COALESCE(artists.normalized_key, EXCLUDED.normalized_key),
       mbid = COALESCE(artists.mbid, EXCLUDED.mbid)
     RETURNING id`,
    [safeName, normalizedKey || null, safeMbid]
  );
  const id = await resolveMergedArtist(db, (res.rows[0] as any).id as string);
  artistCache.set(cacheKey, id);
  artistCache.set(lowerName, id);
  return id;
}

export interface AlbumUpsertOpts {
  mbReleaseGroupId?: string | null;
  year?: number | null;
  releaseType?: string | null;
  isCompilation?: boolean | null;
}

// Decides whether a track signals a compilation. Primary source is the
// MusicBrainz RELEASETYPE / MUSICBRAINZ_ALBUMTYPE tag containing
// "compilation" as a secondary release-group type — that's what Picard
// writes today. The legacy iTunes TCMP/cpil/COMPILATION=1 flag is a
// fallback because it's frequently mis-set on box sets that aren't
// actually compilations.
function inferCompilationFromTrack(
  releaseType?: string | null,
  isCompilationFlag?: boolean | null,
): boolean {
  const rt = (releaseType || '').toLowerCase();
  if (rt.includes('compilation')) return true;
  return !!isCompilationFlag;
}

export async function getOrCreateAlbum(
  title?: string | null,
  artistName?: string | null,
  opts: AlbumUpsertOpts = {},
): Promise<string> {
  const safeTitle = sanitizeString(title)?.trim() || UNKNOWN_ALBUM;
  const safeArtist = sanitizeString(artistName)?.trim() || UNKNOWN_ARTIST;
  const lowerTitle = safeTitle.toLowerCase();
  const lowerArtist = safeArtist.toLowerCase();
  const key = `${lowerTitle}::::${lowerArtist}`;

  const db = await initDB();

  const cached = albumCache.get(key);
  if (cached) {
    await updateAlbumFlags(cached, opts);
    return cached;
  }

  const existing = await db.query('SELECT id FROM albums WHERE LOWER(title) = $1 AND LOWER(artist_name) = $2', [lowerTitle, lowerArtist]);
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id as string;
    albumCache.set(key, id);
    await updateAlbumFlags(id, opts);
    return id;
  }

  const { extractEditionSuffix } = await import('../utils/editionSuffix');
  const { normalizedTitle, editionLabel } = extractEditionSuffix(safeTitle);
  const lowerNormalized = (normalizedTitle || safeTitle).toLowerCase();

  // Resolve release_group_id: MBID first, then normalized-title heuristic,
  // then mint a fresh UUID. We never auto-regroup albums whose owner
  // already chose to merge or split them manually.
  let releaseGroupId: string | null = null;
  const mbReleaseGroupId = opts.mbReleaseGroupId || null;

  if (mbReleaseGroupId) {
    const mbidHit = await db.query(
      `SELECT release_group_id FROM albums WHERE mb_release_group_id = $1 AND release_group_id IS NOT NULL LIMIT 1`,
      [mbReleaseGroupId]
    );
    if (mbidHit.rows.length > 0) {
      releaseGroupId = mbidHit.rows[0].release_group_id;
    }
  }

  if (!releaseGroupId) {
    const heuristicHit = await db.query(
      `SELECT release_group_id FROM albums
       WHERE LOWER(normalized_title) = $1
         AND LOWER(artist_name) = $2
         AND release_group_id IS NOT NULL
         AND manual_group_override = FALSE
       LIMIT 1`,
      [lowerNormalized, lowerArtist]
    );
    if (heuristicHit.rows.length > 0) {
      releaseGroupId = heuristicHit.rows[0].release_group_id;
    }
  }

  const isCompilation = inferCompilationFromTrack(opts.releaseType, opts.isCompilation);

  const res = await db.query(
    `INSERT INTO albums (
       title, artist_name, normalized_title, edition_label,
       mb_release_group_id, release_group_id, release_year, is_compilation
     )
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::uuid, gen_random_uuid()), $7, $8)
     ON CONFLICT (title, artist_name) DO UPDATE SET
       normalized_title = COALESCE(albums.normalized_title, EXCLUDED.normalized_title),
       edition_label = COALESCE(albums.edition_label, EXCLUDED.edition_label),
       mb_release_group_id = COALESCE(albums.mb_release_group_id, EXCLUDED.mb_release_group_id),
       release_group_id = COALESCE(albums.release_group_id, EXCLUDED.release_group_id),
       release_year = COALESCE(albums.release_year, EXCLUDED.release_year),
       is_compilation = albums.is_compilation OR EXCLUDED.is_compilation
     RETURNING id`,
    [
      safeTitle,
      safeArtist,
      normalizedTitle || safeTitle,
      editionLabel,
      mbReleaseGroupId,
      releaseGroupId,
      opts.year || null,
      isCompilation,
    ]
  );
  const id = (res.rows[0] as any).id as string;
  albumCache.set(key, id);
  return id;
}

// Idempotent OR-merge of per-track signals onto an existing album row.
// Called on every getOrCreateAlbum hit (including cache hits) so that
// each subsequent track in the same album can promote the album-level
// is_compilation, mb_release_group_id, and release_year fields.
export async function updateAlbumFlags(albumId: string, opts: AlbumUpsertOpts): Promise<void> {
  if (!opts) return;
  const isCompilation = inferCompilationFromTrack(opts.releaseType, opts.isCompilation);
  const mbRgid = opts.mbReleaseGroupId || null;
  const year = opts.year || null;
  if (!isCompilation && !mbRgid && !year) return;

  const db = await initDB();
  await db.query(
    `UPDATE albums SET
       is_compilation = is_compilation OR $2,
       mb_release_group_id = COALESCE(mb_release_group_id, $3),
       release_year = LEAST(COALESCE(release_year, $4), COALESCE($4, release_year))
     WHERE id = $1`,
    [albumId, isCompilation, mbRgid, year]
  );

  // If we just learned an MBID and the album has no group yet (or shares
  // its group with no one else), try to merge into an existing group.
  if (mbRgid) {
    await db.query(
      `UPDATE albums dst SET release_group_id = src.release_group_id
       FROM (
         SELECT release_group_id FROM albums
         WHERE mb_release_group_id = $2 AND release_group_id IS NOT NULL
           AND id <> $1
         LIMIT 1
       ) src
       WHERE dst.id = $1
         AND dst.manual_group_override = FALSE
         AND dst.release_group_id IS DISTINCT FROM src.release_group_id`,
      [albumId, mbRgid]
    );
  }
}

// Recomputes artists.is_va_pseudo: TRUE when EVERY track for this artist
// lives on a compilation album. Used to suppress "Various Artists" and
// similar pseudo-entities from artist-facing surfaces without resorting
// to the legacy name-list match.
export async function recomputeIsVaPseudo(artistId?: string | null): Promise<void> {
  const db = await initDB();
  if (artistId) {
    await db.query(
      `UPDATE artists a SET is_va_pseudo = (
         SELECT COUNT(*) > 0 AND BOOL_AND(COALESCE(al.is_compilation, FALSE))
         FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
         WHERE t.artist_id = a.id
       )
       WHERE a.id = $1`,
      [artistId]
    );
  } else {
    await db.query(
      `UPDATE artists a SET is_va_pseudo = sub.flag
       FROM (
         SELECT t.artist_id AS id,
                COUNT(*) > 0 AND BOOL_AND(COALESCE(al.is_compilation, FALSE)) AS flag
         FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
         WHERE t.artist_id IS NOT NULL
         GROUP BY t.artist_id
       ) sub
       WHERE a.id = sub.id`
    );
  }
}

export async function getOrCreateGenre(name?: string | null): Promise<string> {
  const safeName = sanitizeString(name)?.trim() || UNKNOWN_GENRE;
  const lowerName = safeName.toLowerCase();

  const cached = genreCache.get(lowerName);
  if (cached) return cached;

  const db = await initDB();
  
  const existing = await db.query('SELECT id FROM genres WHERE LOWER(name) = $1', [lowerName]);
  if (existing.rows.length > 0) {
    genreCache.set(lowerName, existing.rows[0].id);
    return existing.rows[0].id;
  }

  const res = await db.query(
    `INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [safeName]
  );
  const id = (res.rows[0] as any).id as string;
  genreCache.set(lowerName, id);
  return id;
}

export async function getArtistById(id: string) {
  const db = await initDB();
  const canonicalId = await resolveMergedArtist(db, id);
  const res = await db.query('SELECT * FROM artists WHERE id = $1', [canonicalId]);
  return res.rows[0] || null;
}

export async function getAlbumById(id: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM albums WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// All editions in the same release-group, ordered by canonical-first
// (most tracks → earliest release_year → earliest created_at).
export async function getReleaseGroupEditions(releaseGroupId: string) {
  const db = await initDB();
  const res = await db.query(
    `SELECT al.*, COUNT(t.id)::int AS track_count
     FROM albums al
     LEFT JOIN tracks t ON t.album_id = al.id
     WHERE al.release_group_id = $1
     GROUP BY al.id
     ORDER BY track_count DESC,
              COALESCE(al.release_year, 9999) ASC,
              al.created_at ASC`,
    [releaseGroupId]
  );
  return res.rows;
}

// Manual merge: move `sourceAlbumId` into the release group of
// `targetAlbumId`. Sets manual_group_override on the source so future
// rescans can't pull it back into a heuristic group.
export async function mergeAlbumIntoGroup(sourceAlbumId: string, targetAlbumId: string) {
  if (sourceAlbumId === targetAlbumId) return;
  const db = await initDB();
  const target = await db.query('SELECT release_group_id FROM albums WHERE id = $1', [targetAlbumId]);
  if (target.rows.length === 0) throw new Error('Target album not found');
  const rgid = target.rows[0].release_group_id;
  if (!rgid) throw new Error('Target album has no release group');
  await db.query(
    `UPDATE albums SET release_group_id = $2, manual_group_override = TRUE WHERE id = $1`,
    [sourceAlbumId, rgid]
  );
  await db.query(`UPDATE albums SET manual_group_override = TRUE WHERE id = $1`, [targetAlbumId]);
}

// Manual split: give this album a fresh release group of its own, and
// pin the override so heuristics won't re-merge it on the next scan.
export async function unmergeAlbumFromGroup(albumId: string) {
  const db = await initDB();
  await db.query(
    `UPDATE albums SET release_group_id = gen_random_uuid(), manual_group_override = TRUE WHERE id = $1`,
    [albumId]
  );
}

// ==========================================
// MULTI-VALUED ARTIST CREDITS (composer, conductor, performer, …)
// ==========================================

export interface ScannedCredit {
  role: string;
  name: string;
  detail?: string;
}

// Writes the tag-derived credits for a single track. The DELETE is
// scoped to source='tag' so MusicBrainz-sourced rows (future opt-in
// enrichment) survive rescans. Idempotent: calling this twice with the
// same input leaves the same set of rows.
export async function setTrackCredits(trackId: string, credits: ScannedCredit[]): Promise<void> {
  if (!trackId) return;
  const db = await initDB();
  await db.query(
    `DELETE FROM track_artist_credits WHERE track_id = $1 AND source = 'tag'`,
    [trackId]
  );
  if (!Array.isArray(credits) || credits.length === 0) return;

  // Group by (role) so per-role positions are zero-based and meaningful
  // for ordering "Composer 1 / Composer 2".
  const positionByRole = new Map<string, number>();
  for (const c of credits) {
    const role = (c.role || '').trim().toLowerCase();
    const name = (c.name || '').trim();
    if (!role || !name) continue;
    const detail = (c.detail || '').trim();
    let artistId: string | null;
    try {
      artistId = await getOrCreateArtist(name, null);
    } catch {
      continue;
    }
    if (!artistId) continue;
    const position = positionByRole.get(role) ?? 0;
    positionByRole.set(role, position + 1);
    await db.query(
      `INSERT INTO track_artist_credits
         (track_id, artist_id, role, position, source, detail)
       VALUES ($1, $2, $3, $4, 'tag', $5)
       ON CONFLICT (track_id, artist_id, role, detail) DO UPDATE SET position = EXCLUDED.position`,
      [trackId, artistId, role, position, detail]
    );
  }
}

// Writes credits from an external provider for a single track. The DELETE
// is scoped to (track_id, source) so each provider owns its own slice
// independently and re-running an enrichment overwrites only that
// provider's rows. Tag-derived credits (source = 'tag') are never
// touched by this path.
export async function setEnrichedTrackCredits(
  trackId: string,
  source: string,
  credits: ScannedCredit[],
): Promise<void> {
  if (!trackId || !source || source === 'tag') return;
  const db = await initDB();
  await db.query(
    `DELETE FROM track_artist_credits WHERE track_id = $1 AND source = $2`,
    [trackId, source]
  );
  if (!Array.isArray(credits) || credits.length === 0) return;

  const positionByRole = new Map<string, number>();
  for (const c of credits) {
    const role = (c.role || '').trim().toLowerCase();
    const name = (c.name || '').trim();
    if (!role || !name) continue;
    const detail = (c.detail || '').trim();
    let artistId: string | null;
    try {
      artistId = await getOrCreateArtist(name, null);
    } catch {
      continue;
    }
    if (!artistId) continue;
    const position = positionByRole.get(role) ?? 0;
    positionByRole.set(role, position + 1);
    await db.query(
      `INSERT INTO track_artist_credits
         (track_id, artist_id, role, position, source, detail)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (track_id, artist_id, role, detail) DO UPDATE SET position = EXCLUDED.position, source = EXCLUDED.source`,
      [trackId, artistId, role, position, source, detail]
    );
  }
}

export async function setTrackGeniusSongId(trackId: string, geniusSongId: string | null): Promise<void> {
  const db = await initDB();
  await db.query(`UPDATE tracks SET genius_song_id = $2 WHERE id = $1`, [trackId, geniusSongId]);
}

// Counts of credit rows by source so the settings UI can show "73 rows
// from tags, 18 from MusicBrainz, 5 from Genius" — a passive progress
// indicator since the import job is admin-triggered, not scheduled.
export async function getCreditsStatus(): Promise<{ total: number; bySource: Record<string, number>; tracksWithCredits: number; eligibleMusicbrainz: number; eligibleGenius: number; alreadyMusicbrainz: number; alreadyGenius: number }> {
  const db = await initDB();
  const [byRole, eligibleMb, eligibleGenius, distinctTracks, alreadyMb, alreadyGenius] = await Promise.all([
    db.query(`SELECT source, COUNT(*)::int AS c FROM track_artist_credits GROUP BY source`),
    db.query(`SELECT COUNT(*)::int AS c FROM tracks WHERE mb_recording_id IS NOT NULL`),
    db.query(`SELECT COUNT(*)::int AS c FROM tracks WHERE COALESCE(title, '') <> '' AND COALESCE(artist, album_artist, '') <> ''`),
    db.query(`SELECT COUNT(DISTINCT track_id)::int AS c FROM track_artist_credits`),
    db.query(`SELECT COUNT(DISTINCT track_id)::int AS c FROM track_artist_credits WHERE source = 'musicbrainz'`),
    db.query(`SELECT COUNT(DISTINCT track_id)::int AS c FROM track_artist_credits WHERE source = 'genius'`),
  ]);
  const bySource: Record<string, number> = {};
  let total = 0;
  for (const row of byRole.rows as any[]) {
    bySource[row.source] = row.c;
    total += row.c;
  }
  return {
    total,
    bySource,
    tracksWithCredits: distinctTracks.rows[0]?.c || 0,
    eligibleMusicbrainz: eligibleMb.rows[0]?.c || 0,
    eligibleGenius: eligibleGenius.rows[0]?.c || 0,
    alreadyMusicbrainz: alreadyMb.rows[0]?.c || 0,
    alreadyGenius: alreadyGenius.rows[0]?.c || 0,
  };
}

// Returns up to `limit` tracks that have an mb_recording_id but no
// credits from MusicBrainz yet. Powers the MB enrichment job.
export async function getTracksNeedingMbCredits(limit: number): Promise<Array<{ id: string; mb_recording_id: string; title: string; artist: string }>> {
  const db = await initDB();
  const res = await db.query(
    `SELECT t.id, t.mb_recording_id, t.title, COALESCE(t.artist, t.album_artist) AS artist
     FROM tracks t
     WHERE t.mb_recording_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM track_artist_credits tac
         WHERE tac.track_id = t.id AND tac.source = 'musicbrainz'
       )
     LIMIT $1`,
    [Math.max(1, Math.min(5000, limit))]
  );
  return res.rows as any[];
}

// Returns up to `limit` tracks that don't yet have Genius credits.
// Prefers tracks with a cached genius_song_id so they skip the search
// round-trip; falls back to (title, artist) for new tracks.
export async function getTracksNeedingGeniusCredits(limit: number): Promise<Array<{ id: string; title: string; artist: string; genius_song_id: string | null }>> {
  const db = await initDB();
  const res = await db.query(
    `SELECT t.id, t.title, COALESCE(t.artist, t.album_artist) AS artist, t.genius_song_id
     FROM tracks t
     WHERE COALESCE(t.title, '') <> ''
       AND COALESCE(t.artist, t.album_artist, '') <> ''
       AND NOT EXISTS (
         SELECT 1 FROM track_artist_credits tac
         WHERE tac.track_id = t.id AND tac.source = 'genius'
       )
     ORDER BY (t.genius_song_id IS NOT NULL) DESC
     LIMIT $1`,
    [Math.max(1, Math.min(5000, limit))]
  );
  return res.rows as any[];
}

// Aggregated role list for an artist: roles ordered by frequency, plus
// total credit count. Used by the Artist detail page to drive the role
// filter chip row and the "roles in your library" header line.
export async function getArtistRolesInLibrary(artistId: string): Promise<{ role: string; credits: number }[]> {
  const db = await initDB();
  const res = await db.query(
    `SELECT role, COUNT(*)::int AS credits
     FROM track_artist_credits
     WHERE artist_id = $1
     GROUP BY role
     ORDER BY credits DESC, role ASC`,
    [artistId]
  );
  return res.rows as { role: string; credits: number }[];
}

// For an artist + role, returns the albums where they hold that credit.
// Powers the role-filtered album view on the Artist detail page.
export async function getArtistAlbumsByRole(artistId: string, role: string): Promise<any[]> {
  const db = await initDB();
  const res = await db.query(
    `SELECT al.*, COUNT(DISTINCT t.id)::int AS credited_track_count
     FROM track_artist_credits tac
     JOIN tracks t ON t.id = tac.track_id
     JOIN albums al ON al.id = t.album_id
     WHERE tac.artist_id = $1 AND tac.role = $2
     GROUP BY al.id
     ORDER BY COALESCE(al.release_year, 9999) DESC, al.title ASC`,
    [artistId, role]
  );
  return res.rows;
}

// All albums an artist is credited on, for EVERY role, in one query. Replaces a
// per-role N+1 (getArtistRolesInLibrary + a getArtistAlbumsByRole call per role).
// Each row carries its `role`; the caller groups into a role→albums map.
export async function getArtistAlbumsAllRoles(artistId: string): Promise<any[]> {
  const db = await initDB();
  const res = await db.query(
    `SELECT tac.role, al.*, COUNT(DISTINCT t.id)::int AS credited_track_count
     FROM track_artist_credits tac
     JOIN tracks t ON t.id = tac.track_id
     JOIN albums al ON al.id = t.album_id
     WHERE tac.artist_id = $1
     GROUP BY tac.role, al.id
     ORDER BY tac.role, COALESCE(al.release_year, 9999) DESC, al.title ASC`,
    [artistId]
  );
  return res.rows;
}

// All credits for every track on an album, keyed by track_id. Returned
// as a flat list (the route handler shapes it into a map). Includes the
// artist's display name so the UI doesn't need a second round-trip.
export async function getAlbumCredits(albumId: string): Promise<any[]> {
  const db = await initDB();
  const res = await db.query(
    `SELECT tac.track_id, tac.artist_id, tac.role, tac.position, tac.detail, tac.source,
            a.name AS artist_name
     FROM track_artist_credits tac
     JOIN tracks t ON t.id = tac.track_id
     JOIN artists a ON a.id = tac.artist_id
     WHERE t.album_id = $1
     ORDER BY tac.track_id, tac.role, tac.position`,
    [albumId]
  );
  return res.rows;
}

// Credits for a single track. Used by the track context menu's
// "view credits" sub-panel.
export async function getTrackCredits(trackId: string): Promise<any[]> {
  const db = await initDB();
  const res = await db.query(
    `SELECT tac.artist_id, tac.role, tac.position, tac.detail, tac.source,
            a.name AS artist_name
     FROM track_artist_credits tac
     JOIN artists a ON a.id = tac.artist_id
     WHERE tac.track_id = $1
     ORDER BY tac.role, tac.position`,
    [trackId]
  );
  return res.rows;
}

export async function getGenreById(id: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM genres WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function getAllArtists() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM artists WHERE merged_into IS NULL ORDER BY name ASC');
  return res.rows;
}

export async function getAllAlbums() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM albums ORDER BY title ASC');
  return res.rows;
}

export async function getAllGenres() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM genres ORDER BY name ASC');
  return res.rows;
}

export async function getTracksByArtist(artistId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM tracks WHERE artist_id = $1', [artistId]);
  return res.rows.map(mapTrackRow);
}

export async function getSimilarArtistsByAudioProfile(artistId: string, limit: number = 8) {
  const db = await initDB();
  const safeLimit = Math.max(1, Math.min(24, Math.floor(limit)));
  const res = await db.query(`
    WITH target AS (
      SELECT
        AVG(tf.acoustic_vector_8d) AS musicnn_profile,
        AVG(tf.embedding_vector) AS effnet_profile,
        COUNT(tf.acoustic_vector_8d) AS analyzed_tracks
      FROM tracks t
      JOIN track_features tf ON tf.track_id = t.id
      WHERE t.artist_id = $1
        AND tf.acoustic_vector_8d IS NOT NULL
        AND LOWER(TRIM(COALESCE(t.album_artist, t.artist, ''))) NOT IN ('unknown artist', '???')
    ),
    candidates AS (
      SELECT
        a.id,
        a.name,
        a.image_url,
        COUNT(DISTINCT t.id)::int AS track_count,
        COUNT(DISTINCT t.album_id)::int AS album_count,
        COUNT(tf.acoustic_vector_8d)::int AS analyzed_tracks,
        AVG(tf.acoustic_vector_8d) AS musicnn_profile,
        AVG(tf.embedding_vector) AS effnet_profile
      FROM artists a
      JOIN tracks t ON t.artist_id = a.id
      JOIN track_features tf ON tf.track_id = t.id
      WHERE a.id <> $1
        AND tf.acoustic_vector_8d IS NOT NULL
        AND COALESCE(a.is_va_pseudo, FALSE) = FALSE
        AND LOWER(TRIM(a.name)) NOT IN ('unknown artist', '???')
      GROUP BY a.id, a.name, a.image_url
      HAVING COUNT(tf.acoustic_vector_8d) >= 2
    ),
    scored AS (
      SELECT
        c.*,
        CASE
          WHEN target.effnet_profile IS NOT NULL AND c.effnet_profile IS NOT NULL
            THEN ((c.musicnn_profile <-> target.musicnn_profile) * 0.35) + ((c.effnet_profile <=> target.effnet_profile) * 0.65)
          ELSE c.musicnn_profile <-> target.musicnn_profile
        END AS distance
      FROM candidates c
      CROSS JOIN target
      WHERE target.analyzed_tracks > 0
    )
    SELECT
      id,
      name,
      image_url,
      track_count,
      album_count,
      analyzed_tracks,
      distance,
      GREATEST(0, LEAST(100, ROUND(100 / (1 + distance * 18))))::int AS match_score
    FROM scored
    ORDER BY distance ASC, track_count DESC, name ASC
    LIMIT $2
  `, [artistId, safeLimit]);

  return res.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    imageUrl: row.image_url || undefined,
    trackCount: row.track_count || 0,
    albumCount: row.album_count || 0,
    analyzedTracks: row.analyzed_tracks || 0,
    distance: typeof row.distance === 'number' ? row.distance : Number(row.distance),
    matchScore: row.match_score || 0,
  }));
}

export async function getTracksByAlbum(albumId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM tracks WHERE album_id = $1 ORDER BY track_number ASC NULLS LAST', [albumId]);
  return res.rows.map(mapTrackRow);
}

export async function getTracksByGenre(genreId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM tracks WHERE genre_id = $1', [genreId]);
  return res.rows.map(mapTrackRow);
}

type ArtistCanonicalRow = {
  id: string;
  name: string;
  mbid: string | null;
  normalized_key: string | null;
  created_at: Date | string;
  track_count: number;
};

function chooseCanonicalArtist(rows: ArtistCanonicalRow[]): ArtistCanonicalRow {
  return [...rows].sort((a, b) => {
    const trackDelta = Number(b.track_count || 0) - Number(a.track_count || 0);
    if (trackDelta !== 0) return trackDelta;

    const scoreDelta = scoreArtistDisplayName(b.name) - scoreArtistDisplayName(a.name);
    if (scoreDelta !== 0) return scoreDelta;

    const mbidDelta = Number(Boolean(b.mbid)) - Number(Boolean(a.mbid));
    if (mbidDelta !== 0) return mbidDelta;

    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  })[0];
}

async function mergeArtistRows(db: Pool, canonical: ArtistCanonicalRow, duplicate: ArtistCanonicalRow) {
  if (canonical.id === duplicate.id) return;

  // Only inherit duplicate metadata when the two rows share a canonical
  // identity ("Tiësto" / "Tiesto"). For amp-compound merges like
  // "Sia & At home with the kids" -> "Sia", the duplicate's MBID/image/etc.
  // belong to the credit string, not to the canonical artist, so dropping
  // them is the safer default.
  const sameCanonicalIdentity = Boolean(canonical.normalized_key)
    && canonical.normalized_key === duplicate.normalized_key;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (sameCanonicalIdentity) {
      await client.query(`
        UPDATE artists canonical
        SET
          image_url = COALESCE(canonical.image_url, duplicate.image_url),
          artwork_url = COALESCE(canonical.artwork_url, duplicate.artwork_url),
          bio = COALESCE(canonical.bio, duplicate.bio),
          mbid = COALESCE(canonical.mbid, duplicate.mbid),
          normalized_key = COALESCE(canonical.normalized_key, duplicate.normalized_key),
          disambiguation = COALESCE(canonical.disambiguation, duplicate.disambiguation),
          area = COALESCE(canonical.area, duplicate.area),
          artist_type = COALESCE(canonical.artist_type, duplicate.artist_type),
          lifespan_begin = COALESCE(canonical.lifespan_begin, duplicate.lifespan_begin),
          lifespan_end = COALESCE(canonical.lifespan_end, duplicate.lifespan_end),
          links = COALESCE(canonical.links, duplicate.links),
          genres = COALESCE(canonical.genres, duplicate.genres),
          community_tags = COALESCE(canonical.community_tags, duplicate.community_tags),
          listeners = COALESCE(canonical.listeners, duplicate.listeners),
          members = COALESCE(canonical.members, duplicate.members),
          jambase_id = COALESCE(canonical.jambase_id, duplicate.jambase_id)
        FROM artists duplicate
        WHERE canonical.id = $1 AND duplicate.id = $2
      `, [canonical.id, duplicate.id]);
    }

    await client.query('UPDATE tracks SET artist_id = $1 WHERE artist_id = $2', [canonical.id, duplicate.id]);
    await client.query('UPDATE concert_events SET artist_id = $1 WHERE artist_id = $2', [canonical.id, duplicate.id]);

    // For amp-compound merges, the duplicate's name may also be stored as the
    // owner string on `albums.artist_name`. The display layer falls back to a
    // clean split when both halves are still known artists ("Tony Bennett &
    // Lady Gaga" -> two chips), so only rewrite the album owner when the
    // duplicate's halves don't both resolve to known artist rows. This keeps
    // collaboration headers intact while cleaning up junk credits like
    // "Sia & At home with the kids" once the second half is gone.
    if (!sameCanonicalIdentity) {
      const halves = (duplicate.name || '').split(/\s+[&+]\s+/).map(s => s.trim()).filter(Boolean);
      let cleanSplit = halves.length >= 2;
      if (cleanSplit) {
        for (const h of halves) {
          const key = normalizeArtistIdentityKey(h);
          if (!key) { cleanSplit = false; break; }
          if (key === duplicate.normalized_key) { cleanSplit = false; break; }
          const exists = await client.query('SELECT 1 FROM artists WHERE normalized_key = $1 AND id <> $2 LIMIT 1', [key, duplicate.id]);
          if (exists.rows.length === 0) { cleanSplit = false; break; }
        }
      }
      if (!cleanSplit) {
        // Can't blindly UPDATE artist_name — albums has UNIQUE(title,
        // artist_name), so if an album with the same title already exists
        // under the canonical name we'd hit
        // albums_title_artist_name_key. For each conflicting album, fold
        // its tracks into the survivor and drop the duplicate row.
        const dupAlbums = await client.query(
          'SELECT id, title FROM albums WHERE LOWER(artist_name) = LOWER($1)',
          [duplicate.name]
        );
        for (const album of dupAlbums.rows) {
          const survivor = await client.query(
            'SELECT id FROM albums WHERE LOWER(title) = LOWER($1) AND LOWER(artist_name) = LOWER($2) AND id <> $3 LIMIT 1',
            [album.title, canonical.name, album.id]
          );
          if (survivor.rows.length > 0) {
            await client.query('UPDATE tracks SET album_id = $1 WHERE album_id = $2', [survivor.rows[0].id, album.id]);
            await client.query('DELETE FROM albums WHERE id = $1', [album.id]);
          } else {
            await client.query('UPDATE albums SET artist_name = $1 WHERE id = $2', [canonical.name, album.id]);
          }
        }
      }
    }

    await client.query(`
      INSERT INTO user_artist_subscriptions (user_id, artist_id, created_at, source)
      SELECT user_id, $1, created_at, source
      FROM user_artist_subscriptions
      WHERE artist_id = $2
      ON CONFLICT (user_id, artist_id) DO UPDATE SET
        created_at = LEAST(user_artist_subscriptions.created_at, EXCLUDED.created_at),
        source = CASE
          WHEN user_artist_subscriptions.source = 'explicit' OR EXCLUDED.source = 'explicit' THEN 'explicit'
          ELSE user_artist_subscriptions.source
        END
    `, [canonical.id, duplicate.id]);
    await client.query('DELETE FROM user_artist_subscriptions WHERE artist_id = $1', [duplicate.id]);

    await client.query(`
      INSERT INTO user_dismissed_auto_artists (user_id, artist_id, dismissed_at)
      SELECT user_id, $1, dismissed_at
      FROM user_dismissed_auto_artists
      WHERE artist_id = $2
      ON CONFLICT (user_id, artist_id) DO UPDATE SET
        dismissed_at = GREATEST(user_dismissed_auto_artists.dismissed_at, EXCLUDED.dismissed_at)
    `, [canonical.id, duplicate.id]);
    await client.query('DELETE FROM user_dismissed_auto_artists WHERE artist_id = $1', [duplicate.id]);

    await client.query(`
      INSERT INTO artist_concerts_cache (artist_id, jambase_id, events_count, last_error, fetched_at)
      SELECT $1, jambase_id, events_count, last_error, fetched_at
      FROM artist_concerts_cache
      WHERE artist_id = $2
      ON CONFLICT (artist_id) DO UPDATE SET
        jambase_id = COALESCE(artist_concerts_cache.jambase_id, EXCLUDED.jambase_id),
        events_count = GREATEST(artist_concerts_cache.events_count, EXCLUDED.events_count),
        last_error = COALESCE(artist_concerts_cache.last_error, EXCLUDED.last_error),
        fetched_at = GREATEST(artist_concerts_cache.fetched_at, EXCLUDED.fetched_at)
    `, [canonical.id, duplicate.id]);
    await client.query('DELETE FROM artist_concerts_cache WHERE artist_id = $1', [duplicate.id]);

    // Preserve the duplicate row as a merge redirect so refresh-metadata can't
    // recreate the same credit string as a fresh row (which would re-surface
    // it as a duplicate candidate). Re-target any existing redirects that
    // pointed at this duplicate so chains stay flat.
    await client.query('UPDATE artists SET merged_into = $1 WHERE merged_into = $2', [canonical.id, duplicate.id]);
    await client.query('UPDATE artists SET merged_into = $1 WHERE id = $2', [canonical.id, duplicate.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function canonicalizeArtistEntities(db: Pool) {
  const canonicalizationDone = await getSystemSetting(ARTIST_CANONICALIZATION_SETTING) === true;
  const artistsRes = await db.query(`
    SELECT a.*, COUNT(t.id)::int AS track_count
    FROM artists a
    LEFT JOIN tracks t ON t.artist_id = a.id
    GROUP BY a.id
    ORDER BY a.created_at ASC
  `);

  const rows = artistsRes.rows.map((row: any) => ({
    ...row,
    normalized_key: row.normalized_key || normalizeArtistIdentityKey(row.name) || null,
    track_count: Number(row.track_count || 0),
  })) as ArtistCanonicalRow[];

  for (const row of rows) {
    if (row.normalized_key !== (artistsRes.rows.find((raw: any) => raw.id === row.id)?.normalized_key || null)) {
      await db.query('UPDATE artists SET normalized_key = $1 WHERE id = $2', [row.normalized_key, row.id]);
    }
  }

  if (canonicalizationDone) return;

  const byMbid = new Map<string, ArtistCanonicalRow[]>();
  const byKey = new Map<string, ArtistCanonicalRow[]>();
  for (const row of rows) {
    if (row.mbid) {
      const key = row.mbid.toLowerCase();
      byMbid.set(key, [...(byMbid.get(key) || []), row]);
    }
    if (row.normalized_key && row.normalized_key.length >= 3) {
      byKey.set(row.normalized_key, [...(byKey.get(row.normalized_key) || []), row]);
    }
  }

  const mergedIds = new Set<string>();
  let mergeCount = 0;
  const mergeGroup = async (group: ArtistCanonicalRow[]) => {
    const active = group.filter(row => !mergedIds.has(row.id));
    if (active.length < 2) return;
    const canonical = chooseCanonicalArtist(active);
    for (const duplicate of active) {
      if (duplicate.id === canonical.id) continue;
      await mergeArtistRows(db, canonical, duplicate);
      mergedIds.add(duplicate.id);
      mergeCount++;
    }
  };

  for (const group of byMbid.values()) {
    if (group.length > 1) await mergeGroup(group);
  }

  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const mbids = new Set(group.map(row => row.mbid).filter(Boolean));
    if (mbids.size > 1) continue;
    await mergeGroup(group);
  }

  clearEntityCaches();
  await setSystemSetting(ARTIST_CANONICALIZATION_SETTING, true);
  if (mergeCount > 0) {
    console.log(`[DB Migration] Canonicalized ${mergeCount} duplicate artist row(s)`);
  }
}

// Compound credits like "Alok, Martin Jensen & Jason Derulo" were stored as a
// single artist row in early scans. We can detect them now via the smarter
// splitter and pre-move user attachments (subscriptions, dismissed-auto)
// to the first individual artist before the entity backfill loop reroutes
// `tracks.artist_id` away from the compound row. Once no tracks reference
// the compound row, `purgeOrphanedEntities()` removes it (CASCADE drops
// concert events / cache, which were always wrong for a compound credit).
async function migrateCompoundArtistCredits(db: Pool) {
  if (await getSystemSetting(COMPOUND_CREDIT_SPLIT_SETTING) === true) return;

  const artistsRes = await db.query('SELECT id, name FROM artists WHERE name LIKE $1', ['%,%']);
  let migratedRows = 0;

  for (const row of artistsRes.rows) {
    const split = splitArtistNames(row.name);
    if (split.length < 2) continue;

    const firstIndividualId = await getOrCreateArtist(split[0], null);
    if (firstIndividualId === row.id) continue;

    await db.query(`
      INSERT INTO user_artist_subscriptions (user_id, artist_id, created_at, source)
      SELECT user_id, $1, created_at, source
      FROM user_artist_subscriptions
      WHERE artist_id = $2
      ON CONFLICT (user_id, artist_id) DO UPDATE SET
        created_at = LEAST(user_artist_subscriptions.created_at, EXCLUDED.created_at),
        source = CASE
          WHEN user_artist_subscriptions.source = 'explicit' OR EXCLUDED.source = 'explicit' THEN 'explicit'
          ELSE user_artist_subscriptions.source
        END
    `, [firstIndividualId, row.id]);
    await db.query('DELETE FROM user_artist_subscriptions WHERE artist_id = $1', [row.id]);

    await db.query(`
      INSERT INTO user_dismissed_auto_artists (user_id, artist_id, dismissed_at)
      SELECT user_id, $1, dismissed_at
      FROM user_dismissed_auto_artists
      WHERE artist_id = $2
      ON CONFLICT (user_id, artist_id) DO UPDATE SET
        dismissed_at = GREATEST(user_dismissed_auto_artists.dismissed_at, EXCLUDED.dismissed_at)
    `, [firstIndividualId, row.id]);
    await db.query('DELETE FROM user_dismissed_auto_artists WHERE artist_id = $1', [row.id]);

    migratedRows++;
  }

  if (migratedRows > 0) {
    console.log(`[DB Migration] Pre-moved attachments for ${migratedRows} compound-credit artist row(s)`);
  }
}

// Aligns `albums.artist_name` to the album's track-level resolved artist when
// the stored owner is a compound credit ("Sia & At home with the kids") whose
// halves can't both be resolved to existing artist rows — meaning the album
// header would otherwise render a single non-clickable chunk. Albums whose
// owner splits cleanly via the display parser (e.g. "Tony Bennett & Lady Gaga"
// / "The Chainsmokers + Kygo") are intentionally left alone so the header
// keeps both collaborators as clickable chips.
async function syncAlbumArtistNames(db: Pool) {
  if (await getSystemSetting(ALBUM_ARTIST_NAME_SYNC_SETTING) === true) return;

  const knownKeysRes = await db.query(
    `SELECT normalized_key FROM artists WHERE normalized_key IS NOT NULL`
  );
  const knownKeys = new Set<string>();
  for (const row of knownKeysRes.rows) {
    if (row.normalized_key) knownKeys.add(row.normalized_key);
  }

  const albumsRes = await db.query(`
    SELECT id, artist_name FROM albums
    WHERE artist_name ~ '\\s+[&+]\\s+'
      AND artist_name NOT LIKE '%,%'
  `);

  let updated = 0;
  for (const album of albumsRes.rows) {
    const artistName: string = album.artist_name || '';
    const halves = artistName.split(/\s+[&+]\s+/).map(s => s.trim()).filter(Boolean);
    if (halves.length < 2) continue;

    // Display layer would split cleanly into clickable chips — leave alone.
    if (halves.every(h => knownKeys.has(normalizeArtistIdentityKey(h)))) continue;

    // Otherwise, align to the album's track consensus when all tracks share
    // the same artist_id. Skip multi-artist (compilation-style) albums.
    const consensusRes = await db.query(`
      SELECT a.id AS artist_id, a.name
      FROM tracks t
      JOIN artists a ON a.id = t.artist_id
      WHERE t.album_id = $1
      GROUP BY a.id, a.name
    `, [album.id]);

    if (consensusRes.rows.length !== 1) continue;
    const newName: string = consensusRes.rows[0].name || '';
    if (!newName || newName === artistName) continue;

    await db.query('UPDATE albums SET artist_name = $1 WHERE id = $2', [newName, album.id]);
    updated++;
  }

  await setSystemSetting(ALBUM_ARTIST_NAME_SYNC_SETTING, true);
  if (updated > 0) {
    console.log(`[DB Migration] Aligned ${updated} album artist_name field(s) with track consensus`);
  }
}

export interface ArtistDuplicateCandidate {
  candidateKey: string;
  normalizedKey: string;
  signature: string;
  totalTracks: number;
  artists: Array<{
    id: string;
    name: string;
    mbid: string | null;
    imageUrl?: string;
    trackCount: number;
    albumCount: number;
    displayScore: number;
  }>;
}

function buildArtistDuplicateCandidate(rows: any[]): ArtistDuplicateCandidate {
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const normalizedKey = String(sorted[0].normalized_key || '');
  const signature = sorted
    .map(row => `${row.id}:${Number(row.track_count || 0)}:${Number(row.album_count || 0)}`)
    .join('|');

  return {
    candidateKey: `artist-normalized:${normalizedKey}`,
    normalizedKey,
    signature,
    totalTracks: sorted.reduce((sum, row) => sum + Number(row.track_count || 0), 0),
    artists: sorted
      .map(row => ({
        id: row.id,
        name: row.name,
        mbid: row.mbid || null,
        imageUrl: row.image_url || undefined,
        trackCount: Number(row.track_count || 0),
        albumCount: Number(row.album_count || 0),
        displayScore: scoreArtistDisplayName(row.name),
      }))
      .sort((a, b) => {
        const trackDelta = b.trackCount - a.trackCount;
        if (trackDelta !== 0) return trackDelta;
        const scoreDelta = b.displayScore - a.displayScore;
        if (scoreDelta !== 0) return scoreDelta;
        return a.name.localeCompare(b.name);
      }),
  };
}

export async function getArtistDuplicateCandidates(): Promise<ArtistDuplicateCandidate[]> {
  const db = await initDB();
  await db.query(`
    UPDATE artists
    SET normalized_key = $1
    WHERE normalized_key IS NULL AND name = $2
  `, [normalizeArtistIdentityKey(UNKNOWN_ARTIST), UNKNOWN_ARTIST]);

  const statsRes = await db.query(`
    SELECT
      a.id,
      a.name,
      a.mbid,
      COALESCE(a.normalized_key, '') AS normalized_key,
      a.image_url,
      COUNT(t.id)::int AS track_count,
      COUNT(DISTINCT t.album_id)::int AS album_count
    FROM artists a
    LEFT JOIN tracks t ON t.artist_id = a.id
    WHERE a.normalized_key IS NOT NULL
      AND length(a.normalized_key) >= 3
      AND a.merged_into IS NULL
    GROUP BY a.id, a.name, a.mbid, a.normalized_key, a.image_url
    ORDER BY a.normalized_key ASC, COUNT(t.id) DESC, a.name ASC
  `);

  const allArtists = statsRes.rows;
  const candidatesByKey = new Map<string, ArtistDuplicateCandidate>();

  // (1) Same-canonical-identity duplicates: rows that share normalized_key.
  const byKey = new Map<string, any[]>();
  for (const row of allArtists) {
    const key = row.normalized_key;
    byKey.set(key, [...(byKey.get(key) || []), row]);
  }
  for (const [key, rows] of byKey.entries()) {
    if (rows.length < 2) continue;
    const candidate = buildArtistDuplicateCandidate(rows);
    candidatesByKey.set(candidate.candidateKey, candidate);
  }

  // (2) Collaboration-compound credits like "Sia & At home with the kids" or
  // "The Chainsmokers + Kygo" where the first half ("Sia" / "The Chainsmokers")
  // already exists as its own artist row. Genuine duos ("Nik & Jay",
  // "Chase & Status") aren't surfaced because their first half doesn't exist
  // as a separate artist row in the library.
  const COLLAB_SEPARATOR_RE = /\s+[&+]\s+/;
  const baseByKey = new Map<string, any>();
  for (const row of allArtists) {
    if (!baseByKey.has(row.normalized_key)) baseByKey.set(row.normalized_key, row);
  }
  for (const row of allArtists) {
    const name: string = row.name;
    if (!COLLAB_SEPARATOR_RE.test(name) || name.includes(',')) continue;
    const firstHalf = name.split(COLLAB_SEPARATOR_RE)[0].trim();
    if (!firstHalf) continue;
    const firstHalfKey = normalizeArtistIdentityKey(firstHalf);
    if (!firstHalfKey || firstHalfKey.length < 3) continue;
    if (firstHalfKey === row.normalized_key) continue;
    const base = baseByKey.get(firstHalfKey);
    if (!base || base.id === row.id) continue;

    const compoundKey = `artist-amp-compound:${firstHalfKey}::${row.id}`;
    if (candidatesByKey.has(compoundKey)) continue;

    const built = buildArtistDuplicateCandidate([base, row]);
    // Force the base ("Sia") to lead the artist list so the LibraryTab UI
    // defaults to it as canonical instead of the higher-track compound.
    const baseEntry = built.artists.find(a => a.id === base.id);
    const otherEntries = built.artists.filter(a => a.id !== base.id);
    candidatesByKey.set(compoundKey, {
      ...built,
      candidateKey: compoundKey,
      normalizedKey: firstHalfKey,
      artists: baseEntry ? [baseEntry, ...otherEntries] : built.artists,
    });
  }

  const candidates: ArtistDuplicateCandidate[] = [];
  for (const candidate of candidatesByKey.values()) {
    const review = await db.query(
      'SELECT 1 FROM artist_duplicate_reviews WHERE candidate_key = $1 AND signature = $2 LIMIT 1',
      [candidate.candidateKey, candidate.signature]
    );
    if (review.rows.length === 0) {
      candidates.push(candidate);
    }
  }

  return candidates.sort((a, b) => b.totalTracks - a.totalTracks || a.normalizedKey.localeCompare(b.normalizedKey));
}

export async function dismissArtistDuplicateCandidate(opts: {
  candidateKey: string;
  signature: string;
  artistIds: string[];
  userId?: string | null;
}) {
  const db = await initDB();
  await db.query(`
    INSERT INTO artist_duplicate_reviews (candidate_key, signature, decision, artist_ids, decided_by)
    VALUES ($1, $2, 'dismissed', $3::jsonb, $4)
    ON CONFLICT (candidate_key, signature) DO UPDATE SET
      decision = EXCLUDED.decision,
      artist_ids = EXCLUDED.artist_ids,
      decided_by = EXCLUDED.decided_by,
      created_at = NOW()
  `, [opts.candidateKey, opts.signature, JSON.stringify(opts.artistIds), opts.userId || null]);
}

export async function mergeArtistDuplicateCandidate(opts: {
  candidateKey: string;
  signature: string;
  canonicalArtistId: string;
  duplicateArtistIds: string[];
  userId?: string | null;
}) {
  const db = await initDB();
  const ids = Array.from(new Set([opts.canonicalArtistId, ...opts.duplicateArtistIds].filter(Boolean)));
  if (ids.length < 2) {
    throw new Error('At least two artists are required to merge');
  }

  const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(',');
  const res = await db.query(`
    SELECT a.*, COUNT(t.id)::int AS track_count
    FROM artists a
    LEFT JOIN tracks t ON t.artist_id = a.id
    WHERE a.id IN (${placeholders})
    GROUP BY a.id
  `, ids);

  if (res.rows.length !== ids.length) {
    throw new Error('One or more selected artists no longer exist');
  }

  const rows = res.rows.map((row: any) => ({
    ...row,
    normalized_key: row.normalized_key || normalizeArtistIdentityKey(row.name) || null,
    track_count: Number(row.track_count || 0),
  })) as ArtistCanonicalRow[];

  const canonical = rows.find(row => row.id === opts.canonicalArtistId);
  if (!canonical) throw new Error('Canonical artist not found');

  for (const duplicate of rows) {
    if (duplicate.id === canonical.id) continue;
    await mergeArtistRows(db, canonical, duplicate);
  }

  await db.query(`
    INSERT INTO artist_duplicate_reviews (candidate_key, signature, decision, canonical_artist_id, artist_ids, decided_by)
    VALUES ($1, $2, 'merged', $3, $4::jsonb, $5)
    ON CONFLICT (candidate_key, signature) DO UPDATE SET
      decision = EXCLUDED.decision,
      canonical_artist_id = EXCLUDED.canonical_artist_id,
      artist_ids = EXCLUDED.artist_ids,
      decided_by = EXCLUDED.decided_by,
      created_at = NOW()
  `, [opts.candidateKey, opts.signature, opts.canonicalArtistId, JSON.stringify(ids), opts.userId || null]);

  clearEntityCaches();
}

// Manual merge — accepts any canonical + duplicate ids, no candidate-key
// machinery. Used from the Artist Entities tab when the auto-detector
// doesn't cluster two rows (different normalized keys, e.g. "DJ Tiësto" vs
// "Tiësto") but the user knows they're the same artist. The decision is
// still written to artist_duplicate_reviews for auditability.
export async function mergeArtistsManually(opts: {
  canonicalArtistId: string;
  duplicateArtistIds: string[];
  userId?: string | null;
}) {
  const db = await initDB();
  const ids = Array.from(new Set([opts.canonicalArtistId, ...opts.duplicateArtistIds].filter(Boolean)));
  if (ids.length < 2) {
    throw new Error('At least two artists are required to merge');
  }

  const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(',');
  const res = await db.query(`
    SELECT a.*, COUNT(t.id)::int AS track_count
    FROM artists a
    LEFT JOIN tracks t ON t.artist_id = a.id
    WHERE a.id IN (${placeholders})
    GROUP BY a.id
  `, ids);

  if (res.rows.length !== ids.length) {
    throw new Error('One or more selected artists no longer exist');
  }

  const rows = res.rows.map((row: any) => ({
    ...row,
    normalized_key: row.normalized_key || normalizeArtistIdentityKey(row.name) || null,
    track_count: Number(row.track_count || 0),
  })) as ArtistCanonicalRow[];

  const canonical = rows.find(row => row.id === opts.canonicalArtistId);
  if (!canonical) throw new Error('Canonical artist not found');

  for (const duplicate of rows) {
    if (duplicate.id === canonical.id) continue;
    await mergeArtistRows(db, canonical, duplicate);
  }

  const sortedIds = [...ids].sort();
  const candidateKey = `artist-manual:${canonical.id}`;
  const signature = sortedIds.join(',');

  await db.query(`
    INSERT INTO artist_duplicate_reviews (candidate_key, signature, decision, canonical_artist_id, artist_ids, decided_by)
    VALUES ($1, $2, 'merged', $3, $4::jsonb, $5)
    ON CONFLICT (candidate_key, signature) DO UPDATE SET
      decision = EXCLUDED.decision,
      canonical_artist_id = EXCLUDED.canonical_artist_id,
      artist_ids = EXCLUDED.artist_ids,
      decided_by = EXCLUDED.decided_by,
      created_at = NOW()
  `, [candidateKey, signature, canonical.id, JSON.stringify(ids), opts.userId || null]);

  clearEntityCaches();
}

// Backfill entity IDs for tracks that don't have them yet. The legacy featured
// artist correction is intentionally one-time; new scans already normalize this.
export async function migrateEntityIds() {
  const db = await initDB();
  await canonicalizeArtistEntities(db);
  await migrateCompoundArtistCredits(db);
  await syncAlbumArtistNames(db);

  // One-time deduplication to fix case-sensitive album/genre duplicates.
  try {
    const albumsRes = await db.query('SELECT * FROM albums ORDER BY created_at ASC');
    const seenAlbums = new Map<string, string>();
    for (const row of albumsRes.rows) {
      const lowerTitle = row.title.toLowerCase();
      const lowerArtist = (row.artist_name || UNKNOWN_ARTIST).toLowerCase();
      const key = `${lowerTitle}::::${lowerArtist}`;
      if (seenAlbums.has(key)) {
        const canonicalId = seenAlbums.get(key)!;
        await db.query('UPDATE tracks SET album_id = $1 WHERE album_id = $2', [canonicalId, row.id]);
        await db.query('DELETE FROM albums WHERE id = $1', [row.id]);
      } else {
        seenAlbums.set(key, row.id);
      }
    }

    const genresRes = await db.query('SELECT * FROM genres ORDER BY created_at ASC');
    const seenGenres = new Map<string, string>();
    for (const row of genresRes.rows) {
      const lowerName = row.name.toLowerCase();
      if (seenGenres.has(lowerName)) {
        const canonicalId = seenGenres.get(lowerName)!;
        await db.query('UPDATE tracks SET genre_id = $1 WHERE genre_id = $2', [canonicalId, row.id]);
        await db.query('DELETE FROM genres WHERE id = $1', [row.id]);
      } else {
        seenGenres.set(lowerName, row.id);
      }
    }
    
    // Clear caches after deduplication
    clearEntityCaches();
  } catch(e) {
    console.error('[DB Migration] Deduplication failed:', e);
  }

  const featureArtistBackfillDone = await getSystemSetting(FEATURE_ARTIST_BACKFILL_SETTING) === true;
  const compoundCreditSplitDone = await getSystemSetting(COMPOUND_CREDIT_SPLIT_SETTING) === true;

  const legacyPredicates: string[] = [];
  if (!featureArtistBackfillDone) {
    legacyPredicates.push(
      `artist ~* '(\\mfeat\\.?\\M|\\mft\\.?\\M|\\mfeaturing\\M)'`,
      `album_artist ~* '(\\mfeat\\.?\\M|\\mft\\.?\\M|\\mfeaturing\\M)'`,
    );
  }
  if (!compoundCreditSplitDone) {
    legacyPredicates.push(
      `artist LIKE '%,%'`,
      `album_artist LIKE '%,%'`,
    );
  }
  const legacyFeatureCreditPredicate = legacyPredicates.length > 0
    ? ' OR ' + legacyPredicates.join(' OR ')
    : '';

  const res = await db.query(`
    SELECT id, artist, album_artist, artists, album, genre, genres, mb_artist_id, mb_album_artist_id,
           mb_release_group_id, release_type, is_compilation, year
    FROM tracks
    WHERE artist_id IS NULL
      OR album_id IS NULL
      OR genre_id IS NULL
      OR genres IS NULL
      OR artists IS NULL
      ${legacyFeatureCreditPredicate}
  `);

  if (res.rows.length === 0) {
    if (!featureArtistBackfillDone) {
      await setSystemSetting(FEATURE_ARTIST_BACKFILL_SETTING, true);
    }
    if (!compoundCreditSplitDone) {
      await setSystemSetting(COMPOUND_CREDIT_SPLIT_SETTING, true);
    }
    return;
  }

  console.log(`[DB Migration] Backfilling entity IDs for ${res.rows.length} tracks...`);
  let count = 0;

  for (const row of res.rows) {
    const trackId = (row as any).id;
    const rawArtist = (row as any).artist;
    const rawAlbumArtist = (row as any).album_artist;
    const albumTitle = (row as any).album;
    const rawGenre = (row as any).genre;
    const primaryArtistMbid = (row as any).mb_album_artist_id || (row as any).mb_artist_id || null;
    
    const individualGenres = splitGenreNames(rawGenre);
    const primaryGenreName = individualGenres.length > 0 ? individualGenres[0] : null;
    
    let rawArtistsArray: string[] = [];
    const rawArtistsField = (row as any).artists;
    if (rawArtistsField) {
      if (typeof rawArtistsField === 'string') {
        try { rawArtistsArray = JSON.parse(rawArtistsField); } catch {}
      } else if (Array.isArray(rawArtistsField)) {
        rawArtistsArray = rawArtistsField;
      }
    }
    rawArtistsArray = normalizeArtistNames(rawArtistsArray.length > 0 ? rawArtistsArray : null, rawArtist);
    const albumArtistName = getPrimaryArtistName(rawAlbumArtist, rawArtist, rawArtistsArray);

    // If the primary artist was derived from a compound credit ("A, B & C"),
    // the track's MB artist id was scanned against the compound string and
    // doesn't belong to the first individual. Skip attaching it.
    const primarySource = rawAlbumArtist || rawArtist;
    const primaryDerivedFromCompound = splitArtistNames(primarySource).length > 1;
    const safePrimaryMbid = primaryDerivedFromCompound ? null : primaryArtistMbid;

    // 2. Fetch or create canonical entities, ensuring valid strings
    const primaryArtistKey = normalizeArtistIdentityKey(albumArtistName);
    const artistId = await getOrCreateArtist(albumArtistName, safePrimaryMbid);
    const albumId = await getOrCreateAlbum(albumTitle, albumArtistName, {
      mbReleaseGroupId: (row as any).mb_release_group_id || null,
      year: (row as any).year || null,
      releaseType: (row as any).release_type || null,
      isCompilation: (row as any).is_compilation || false,
    });
    const genreId = await getOrCreateGenre(primaryGenreName);

    // Create/update entities for all individual artists to ensure they exist for 'Also appears on'
    for (const a of rawArtistsArray) {
      if (a && a.trim() !== '') {
         const artistMbid = normalizeArtistIdentityKey(a) === primaryArtistKey ? safePrimaryMbid : null;
         await getOrCreateArtist(a, artistMbid);
      }
    }

    // Prepare JSON arrays
    const tracksGenresJson = JSON.stringify(individualGenres);
    const tracksArtistsJson = JSON.stringify(rawArtistsArray);

    await db.query(
      'UPDATE tracks SET artist_id = $1, album_id = $2, genre_id = $3, genres = $4, artists = $5 WHERE id = $6',
      [artistId, albumId, genreId, tracksGenresJson, tracksArtistsJson, trackId]
    );
    count++;
  }

  const purged = await purgeOrphanedEntities();
  console.log(`[DB Migration] Backfilled entity IDs for ${count} tracks`);
  if (purged.albums > 0 || purged.artists > 0 || purged.genres > 0) {
    console.log(`[DB Migration] Purged orphaned entities after backfill: ${purged.albums} albums, ${purged.artists} artists, ${purged.genres} genres`);
  }
  if (!featureArtistBackfillDone) {
    await setSystemSetting(FEATURE_ARTIST_BACKFILL_SETTING, true);
  }
  if (!compoundCreditSplitDone) {
    await setSystemSetting(COMPOUND_CREDIT_SPLIT_SETTING, true);
  }
}

const RELEASE_GROUP_BACKFILL_SETTING = 'releaseGroupBackfillV1';

// One-shot migration that populates the release-group columns on existing
// album rows. Idempotent: skips when the system setting is set, and any
// row that already has a release_group_id is left alone. Designed to run
// after migrateEntityIds(), since it depends on albums being upserted.
export async function migrateReleaseGroups() {
  const done = await getSystemSetting(RELEASE_GROUP_BACKFILL_SETTING) === true;
  if (done) {
    // Even when the backfill has run before, keep is_va_pseudo current
    // for libraries that have been mutated by scans since.
    await recomputeIsVaPseudo();
    return;
  }

  const db = await initDB();
  console.log('[DB Migration] Backfilling release groups, edition labels, and compilation flags...');

  // 1. Album-level is_compilation from tracks. Primary signal: any track
  //    whose release_type contains "compilation" (MusicBrainz RELEASETYPE
  //    secondary type). Fallback: any track with the legacy is_compilation
  //    flag (TCMP/cpil/COMPILATION=1). Final fallback below at step 4
  //    handles VA-named album_artist for legacies with neither tag.
  await db.query(`
    UPDATE albums al SET is_compilation = TRUE
    WHERE al.is_compilation = FALSE
      AND EXISTS (
        SELECT 1 FROM tracks t
        WHERE t.album_id = al.id
          AND (LOWER(COALESCE(t.release_type, '')) LIKE '%compilation%'
               OR t.is_compilation = TRUE)
      )
  `);

  // 2. Copy mb_release_group_id from any track in the album that has one.
  await db.query(`
    UPDATE albums al SET mb_release_group_id = sub.rgid
    FROM (
      SELECT DISTINCT ON (album_id) album_id, mb_release_group_id AS rgid
      FROM tracks
      WHERE mb_release_group_id IS NOT NULL AND album_id IS NOT NULL
      ORDER BY album_id, mb_release_group_id
    ) sub
    WHERE al.id = sub.album_id AND al.mb_release_group_id IS NULL
  `);

  // 3. Copy release_year (min track year) for any album lacking one.
  await db.query(`
    UPDATE albums al SET release_year = sub.y
    FROM (
      SELECT album_id, MIN(year) AS y
      FROM tracks
      WHERE year IS NOT NULL AND year > 0 AND album_id IS NOT NULL
      GROUP BY album_id
    ) sub
    WHERE al.id = sub.album_id AND al.release_year IS NULL
  `);

  // 4. Last-resort compilation: album_artist literally is "Various Artists"
  //    or its short forms. Only used for albums where neither RELEASETYPE
  //    nor TCMP triggered. This is the legacy name-match precedence, kept
  //    here (not in user-facing query filters) for poorly-tagged libraries.
  await db.query(`
    UPDATE albums al SET is_compilation = TRUE
    WHERE al.is_compilation = FALSE
      AND LOWER(COALESCE(al.artist_name, '')) IN ('various artists', 'various', 'va', 'compilation', 'compilations')
  `);

  // 5. JS-side: extract edition labels and normalized titles for any
  //    album that doesn't have them yet. Albums table is typically small
  //    (single-digit thousands at most) so a JS loop is fine.
  const { extractEditionSuffix } = await import('../utils/editionSuffix');
  const albumsForEdition = await db.query(
    `SELECT id, title FROM albums WHERE normalized_title IS NULL`
  );
  for (const row of albumsForEdition.rows) {
    const { normalizedTitle, editionLabel } = extractEditionSuffix(row.title || '');
    await db.query(
      `UPDATE albums SET normalized_title = $2, edition_label = $3 WHERE id = $1`,
      [row.id, normalizedTitle || row.title || '', editionLabel]
    );
  }

  // 6. Assign release_group_id by MBID for any album that lacks one.
  //    Postgres has no MAX(uuid), so we cast through text to pick a
  //    deterministic representative when albums already share an MBID.
  await db.query(`
    UPDATE albums dst SET release_group_id = src.rgid
    FROM (
      SELECT mb_release_group_id,
             COALESCE(MIN(release_group_id::text)::uuid, gen_random_uuid()) AS rgid
      FROM albums
      WHERE mb_release_group_id IS NOT NULL
      GROUP BY mb_release_group_id
    ) src
    WHERE dst.mb_release_group_id = src.mb_release_group_id
      AND dst.release_group_id IS NULL
  `);

  // 7. Assign release_group_id by (normalized_title, artist_name) heuristic
  //    for remaining albums. Albums sharing the same normalized title and
  //    artist get the same UUID.
  await db.query(`
    UPDATE albums dst SET release_group_id = src.rgid
    FROM (
      SELECT LOWER(normalized_title) AS nt, LOWER(artist_name) AS an,
             COALESCE(MIN(release_group_id::text)::uuid, gen_random_uuid()) AS rgid
      FROM albums
      WHERE manual_group_override = FALSE
      GROUP BY LOWER(normalized_title), LOWER(artist_name)
    ) src
    WHERE LOWER(dst.normalized_title) = src.nt
      AND LOWER(COALESCE(dst.artist_name, '')) = src.an
      AND dst.release_group_id IS NULL
      AND dst.manual_group_override = FALSE
  `);

  // 8. Mint a fresh release_group_id for any remaining orphans.
  await db.query(`
    UPDATE albums SET release_group_id = gen_random_uuid()
    WHERE release_group_id IS NULL
  `);

  // 9. Refresh derived artist flag.
  await recomputeIsVaPseudo();

  await setSystemSetting(RELEASE_GROUP_BACKFILL_SETTING, true);
  console.log('[DB Migration] Release-group backfill complete.');
}

// ==========================================
// PLAYLISTS API
// ==========================================

export async function createPlaylist(
  id: string,
  title: string,
  description: string | null = null,
  isLlmGenerated: boolean = false,
  userId: string | null = null,
  isSystem: boolean = false,
  generationSource?: 'manual' | 'hub' | 'custom' | 'system' | 'on-repeat' | 'repeat-rewind' | 'daylist' | 'artist-radio' | 'seasonal-rewind' | 'year-rewind'
) {
  const db = await initDB();
  const source = generationSource ?? (isSystem ? 'system' : isLlmGenerated ? 'hub' : 'manual');
  await db.query(`
    INSERT INTO playlists (id, title, description, created_at, is_llm_generated, user_id, is_system, generation_source)
    VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      is_system = EXCLUDED.is_system,
      generation_source = EXCLUDED.generation_source
  `, [id, title, description, isLlmGenerated, userId, isSystem, source]);
}

// Upper bound on tracks written in a single playlist insert. Bounds the size
// of the generated bulk-INSERT (and the loop that builds it) so a caller-
// supplied list can't drive unbounded query construction.
const MAX_PLAYLIST_TRACKS = 10000;

export async function addTracksToPlaylist(playlistId: string, trackIds: string[]) {
  const db = await initDB();
  let uniqueTrackIds = Array.from(new Set(trackIds.filter(Boolean)));
  if (uniqueTrackIds.length > MAX_PLAYLIST_TRACKS) {
    console.warn(`[Playlist] Track list for ${playlistId} exceeds cap (${uniqueTrackIds.length} > ${MAX_PLAYLIST_TRACKS}); truncating.`);
    uniqueTrackIds = uniqueTrackIds.slice(0, MAX_PLAYLIST_TRACKS);
  }
  const existingRes = await db.query(
    `SELECT track_id, added_at FROM playlist_tracks WHERE playlist_id = $1`,
    [playlistId]
  );
  const existingAddedAt = new Map<string, string>(
    existingRes.rows.map((row: any) => [
      row.track_id,
      row.added_at instanceof Date ? row.added_at.toISOString() : new Date(row.added_at).toISOString(),
    ])
  );

  await db.query(`DELETE FROM playlist_tracks WHERE playlist_id = $1`, [playlistId]);
  
  if (uniqueTrackIds.length > 0) {
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramCount = 1;

    for (let i = 0; i < uniqueTrackIds.length; i++) {
      placeholders.push(`($${paramCount++}, $${paramCount++}, $${paramCount++}, COALESCE($${paramCount++}::timestamptz, NOW()))`);
      values.push(playlistId, uniqueTrackIds[i], i, existingAddedAt.get(uniqueTrackIds[i]) || null);
    }

    await db.query(`
      INSERT INTO playlist_tracks (playlist_id, track_id, sort_order, added_at)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (playlist_id, track_id)
      DO UPDATE SET
        sort_order = EXCLUDED.sort_order,
        added_at = COALESCE(playlist_tracks.added_at, EXCLUDED.added_at)
    `, values);
  }
}

export async function deleteOldLlmPlaylists(maxAgeMs: number, userId: string | null = null) {
  const db = await initDB();
  const threshold = Date.now() - maxAgeMs;
  let query: string;
  let params: any[];

  if (userId) {
    // User-scoped cleanup
    await db.query(`
      DELETE FROM playlist_tracks
      WHERE playlist_id IN (
        SELECT id FROM playlists
        WHERE is_llm_generated = TRUE
          AND COALESCE(generation_source, 'hub') = 'hub'
          AND pinned = FALSE
          AND created_at < to_timestamp($1 / 1000.0)
          AND user_id = $2
      )
    `, [threshold, userId]);

    const res = await db.query(`
      DELETE FROM playlists
      WHERE is_llm_generated = TRUE
        AND COALESCE(generation_source, 'hub') = 'hub'
        AND pinned = FALSE
        AND created_at < to_timestamp($1 / 1000.0)
        AND user_id = $2
    `, [threshold, userId]);
    return res.rowCount;
  } else {
    // Global cleanup (backward compat)
    await db.query(`
      DELETE FROM playlist_tracks
      WHERE playlist_id IN (
        SELECT id FROM playlists
        WHERE is_llm_generated = TRUE
          AND COALESCE(generation_source, 'hub') = 'hub'
          AND pinned = FALSE
          AND created_at < to_timestamp($1 / 1000.0)
      )
    `, [threshold]);

    const res = await db.query(`
      DELETE FROM playlists
      WHERE is_llm_generated = TRUE
        AND COALESCE(generation_source, 'hub') = 'hub'
        AND pinned = FALSE
        AND created_at < to_timestamp($1 / 1000.0)
    `, [threshold]);
    return res.rowCount;
  }
}

export async function getPlaylists(userId: string | null = null) {
  const db = await initDB();
  let res;
  if (userId) {
    res = await db.query('SELECT * FROM playlists WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  } else {
    res = await db.query('SELECT * FROM playlists ORDER BY created_at DESC');
  }
  return res.rows.map(mapPlaylistRow);
}

function mapPlaylistRow(row: any) {
  return {
    ...row,
    isLlmGenerated: row.is_llm_generated,
    isSystem: row.is_system,
    pinned: row.pinned,
    generationSource: row.generation_source || (row.is_system ? 'system' : row.is_llm_generated ? 'hub' : 'manual'),
    createdAt: new Date(row.created_at).getTime(),
  };
}

// Single-playlist lookup scoped to a user. Returns null when not found or not
// owned by the user (system playlists are stored with user_id set so they
// follow the same scoping rule).
export async function getPlaylistByIdForUser(playlistId: string, userId: string) {
  const db = await initDB();
  const res = await db.query(
    'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
    [playlistId, userId]
  );
  if (res.rows.length === 0) return null;
  return mapPlaylistRow(res.rows[0]);
}

// Bulk-load all playlists for a user with their tracks attached, using two
// queries instead of N+1. Tracks are grouped by playlist_id in JS, preserving
// the per-playlist sort_order.
export async function getPlaylistsForUserWithTracks(userId: string) {
  const db = await initDB();
  const [playlistsRes, tracksRes] = await Promise.all([
    db.query(
      'SELECT * FROM playlists WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    ),
    db.query(
      `
        SELECT
          pt.playlist_id,
          t.*,
          pt.added_at AS playlist_added_at,
          EXISTS (
            SELECT 1 FROM user_loved_tracks ult
            WHERE ult.user_id = $1 AND ult.track_id = t.id
          ) AS is_loved
        FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        JOIN playlists p ON p.id = pt.playlist_id
        WHERE p.user_id = $1
        ORDER BY pt.playlist_id, pt.sort_order ASC
      `,
      [userId]
    ),
  ]);

  const tracksByPlaylist = new Map<string, any[]>();
  for (const row of tracksRes.rows) {
    const playlistId = row.playlist_id;
    const arr = tracksByPlaylist.get(playlistId) || [];
    arr.push(mapTrackRow(row));
    tracksByPlaylist.set(playlistId, arr);
  }

  return playlistsRes.rows.map((row: any) => ({
    ...mapPlaylistRow(row),
    tracks: tracksByPlaylist.get(row.id) || [],
  }));
}

export async function getPlaylistTracks(playlistId: string, userId: string | null = null) {
  const db = await initDB();
  const res = userId
    ? await db.query(`
        SELECT t.*, pt.added_at AS playlist_added_at, EXISTS (
          SELECT 1 FROM user_loved_tracks ult
          WHERE ult.user_id = $2 AND ult.track_id = t.id
        ) AS is_loved
        FROM tracks t
        JOIN playlist_tracks pt ON t.id = pt.track_id
        WHERE pt.playlist_id = $1
        ORDER BY pt.sort_order ASC
      `, [playlistId, userId])
    : await db.query(`
        SELECT t.*, pt.added_at AS playlist_added_at, FALSE AS is_loved FROM tracks t
        JOIN playlist_tracks pt ON t.id = pt.track_id
        WHERE pt.playlist_id = $1
        ORDER BY pt.sort_order ASC
      `, [playlistId]);
  return res.rows.map(mapTrackRow);
}

export async function deletePlaylist(playlistId: string, userId: string | null = null) {
  const db = await initDB();
  if (userId) {
    // Only delete if user owns the playlist
    await db.query('DELETE FROM playlist_tracks WHERE playlist_id = $1', [playlistId]);
    await db.query('DELETE FROM playlists WHERE id = $1 AND user_id = $2', [playlistId, userId]);
  } else {
    // Admin/global delete
    await db.query('DELETE FROM playlist_tracks WHERE playlist_id = $1', [playlistId]);
    await db.query('DELETE FROM playlists WHERE id = $1', [playlistId]);
  }
}

export async function getPlaylistOwner(playlistId: string): Promise<string | null> {
  const db = await initDB();
  const res = await db.query('SELECT user_id FROM playlists WHERE id = $1', [playlistId]);
  if (res.rows.length === 0) return null;
  return (res.rows[0] as any).user_id || null;
}

// Enable/disable a public share link for a playlist the user owns. The token is
// minted once and preserved across re-enables so an already-shared link keeps
// working. `candidateToken` is used only when no token exists yet. Returns the
// resulting { shareToken, isPublic }, or null if the user doesn't own it.
export async function setPlaylistShare(
  playlistId: string,
  userId: string,
  enable: boolean,
  candidateToken: string,
): Promise<{ shareToken: string | null; isPublic: boolean } | null> {
  const db = await initDB();
  const res = await db.query(
    `UPDATE playlists
       SET is_public = $3,
           share_token = CASE WHEN $3 THEN COALESCE(share_token, $4) ELSE share_token END
     WHERE id = $1 AND user_id = $2
     RETURNING share_token, is_public`,
    [playlistId, userId, enable, candidateToken],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as any;
  return { shareToken: row.share_token ?? null, isPublic: !!row.is_public };
}

// Public, read-only snapshot for a share token. Returns ONLY display fields —
// never the base64 path/id (which encode the filesystem location) or anything
// that enables streaming. Null when the token is unknown or sharing is disabled.
export async function getPublicPlaylistByShareToken(token: string): Promise<
  | { name: string; description: string | null; trackCount: number; tracks: Array<{ title: string; artist: string; album: string; duration: number }> }
  | null
> {
  const db = await initDB();
  const plRes = await db.query(
    `SELECT id, title, description FROM playlists WHERE share_token = $1 AND is_public = TRUE`,
    [token],
  );
  if (plRes.rows.length === 0) return null;
  const pl = plRes.rows[0] as any;
  const trackRes = await db.query(
    `SELECT t.title, t.artist, t.album, t.duration
       FROM tracks t
       JOIN playlist_tracks pt ON t.id = pt.track_id
      WHERE pt.playlist_id = $1
      ORDER BY pt.sort_order ASC`,
    [pl.id],
  );
  const tracks = trackRes.rows.map((r: any) => ({
    title: r.title || 'Unknown Title',
    artist: r.artist || 'Unknown Artist',
    album: r.album || '',
    duration: typeof r.duration === 'number' ? r.duration : 0,
  }));
  return { name: pl.title, description: pl.description ?? null, trackCount: tracks.length, tracks };
}

export async function getPlaylistMeta(playlistId: string): Promise<{ userId: string | null; isSystem: boolean } | null> {
  const db = await initDB();
  const res = await db.query('SELECT user_id, is_system FROM playlists WHERE id = $1', [playlistId]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as any;
  return { userId: row.user_id || null, isSystem: !!row.is_system };
}

export async function deleteSystemPlaylistsForUser(userId: string) {
  const db = await initDB();
  await db.query(`
    DELETE FROM playlist_tracks
    WHERE playlist_id IN (
      SELECT id FROM playlists
      WHERE is_system = TRUE
        AND user_id = $1
        AND COALESCE(generation_source, 'system') = 'system'
    )
  `, [userId]);
  const res = await db.query(
    `
      DELETE FROM playlists
      WHERE is_system = TRUE
        AND user_id = $1
        AND COALESCE(generation_source, 'system') = 'system'
    `,
    [userId]
  );
  return res.rowCount || 0;
}

export async function cleanupOrphanedPlaylists() {
  const db = await initDB();
  const res = await db.query(`
    DELETE FROM playlists
    WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)
  `);
  return res.rowCount || 0;
}

export async function togglePlaylistPin(playlistId: string, userId: string, pinned: boolean) {
  const db = await initDB();
  const res = await db.query(
    'UPDATE playlists SET pinned = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [!!pinned, playlistId, userId]
  );
  return res.rows.length > 0;
}

export async function getVectorStats() {
  const db = await initDB();
  
  // Compute means and stddevs in SQL by casting vector to float array.
  // This is significantly faster than fetching all rows and parsing in JS.
  const DIM = 8;
  const selectors = [];
  for (let i = 1; i <= DIM; i++) {
    selectors.push(`AVG((acoustic_vector_8d::text::float8[])[${i}]) as m${i}`);
    selectors.push(`STDDEV((acoustic_vector_8d::text::float8[])[${i}]) as s${i}`);
  }

  const res = await db.query(`
    SELECT ${selectors.join(', ')}
    FROM track_features 
    WHERE acoustic_vector_8d IS NOT NULL
  `);
  
  if (!res.rows[0] || res.rows[0].m1 === null) {
    return null;
  }

  const row = res.rows[0];
  const means = [];
  const stddevs = [];

  for (let i = 1; i <= DIM; i++) {
    means.push(Number(row[`m${i}`]) || 0);
    // Standard deviation can be null or 0; fallback to 1 to prevent division by zero in normalization
    stddevs.push(Number(row[`s${i}`]) || 1);
  }

  return { means, stddevs };
}

// ==========================================
// SYSTEM SETTINGS & GENRE MATRIX
// ==========================================

export async function getGenreMatrixCache() {
  const db = await initDB();
  const res = await db.query('SELECT matrix FROM genre_matrix_cache WHERE id = $1', ['default']);
  if (res.rows.length === 0 || !(res.rows[0] as any).matrix) return {};
  const matrix = (res.rows[0] as any).matrix as string;
  try {
    return JSON.parse(matrix);
  } catch(e) {
    return {};
  }
}

export async function updateGenreMatrixCache(matrix: any) {
  const db = await initDB();
  const matrixStr = JSON.stringify(matrix);
  await db.query(`
    INSERT INTO genre_matrix_cache (id, matrix)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET matrix = EXCLUDED.matrix
  `, ['default', matrixStr]);
}

export async function getSystemSetting(key: string) {
  const db = await initDB();
  const res = await db.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  if (res.rows.length === 0 || !(res.rows[0] as any).value) return null;
  const val = (res.rows[0] as any).value as string;
  try {
    return JSON.parse(val);
  } catch(e) {
    return null;
  }
}
export async function upsertSubGenreMapping(subGenre: string, path: string) {
  const db = await initDB();
  const sanitized = subGenre.toLowerCase().trim().replace(/[^\w\s-]/g, '');
  if (!sanitized) return;
  await db.query(`
    INSERT INTO subgenre_mappings (sub_genre, path)
    VALUES ($1, $2)
    ON CONFLICT (sub_genre) DO UPDATE SET path = EXCLUDED.path
  `, [sanitized, path]);
}

export async function clearSubGenreMappings() {
  const db = await initDB();
  await db.query('DELETE FROM subgenre_mappings');
}

export async function getSubGenreMappings(): Promise<Record<string, string>> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM subgenre_mappings');
  const mappings: Record<string, string> = {};
  res.rows.forEach((row: any) => {
    mappings[row.sub_genre] = row.path;
  });
  return mappings;
}

export async function getGenrePathFromKNN(acoustic8D: number[], embedding?: number[]): Promise<string | null> {
  if (acoustic8D.some(v => !isFinite(v))) return null;
  if (embedding && (embedding.length !== 1280 || embedding.some(v => !isFinite(v)))) embedding = undefined;

  const db = await initDB();
  const acousticStr = `[${acoustic8D.join(',')}]`;
  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
  
  // Tier 3: KNN audio fallback.
  // Finds the most common hierarchical path among the 10 mathematically 
  // closest matches using MusiCNN 8D + EffNet 1280D, or 8D distance fallback.
  const query = embeddingStr
    ? `
    WITH neighbors AS (
      SELECT sm.path
      FROM tracks t
      JOIN track_features tf ON t.id = tf.track_id
      JOIN subgenre_mappings sm ON lower(trim(t.genre)) = sm.sub_genre
      WHERE tf.acoustic_vector_8d IS NOT NULL 
        AND tf.embedding_vector IS NOT NULL
      ORDER BY (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) ASC
      LIMIT 10
    )
    SELECT path, COUNT(*) as frequency
    FROM neighbors
    GROUP BY path
    ORDER BY frequency DESC
    LIMIT 1
  `
    : `
    WITH neighbors AS (
      SELECT sm.path
      FROM tracks t
      JOIN track_features tf ON t.id = tf.track_id
      JOIN subgenre_mappings sm ON lower(trim(t.genre)) = sm.sub_genre
      WHERE tf.acoustic_vector_8d IS NOT NULL 
      ORDER BY tf.acoustic_vector_8d <-> $1::vector ASC
      LIMIT 10
    )
    SELECT path, COUNT(*) as frequency
    FROM neighbors
    GROUP BY path
    ORDER BY frequency DESC
    LIMIT 1
  `;

  const params = embeddingStr ? [acousticStr, embeddingStr] : [acousticStr];
  const res = await db.query(query, params);

  if (res.rows.length > 0) {
    return (res.rows[0] as any).path;
  }
  return null;
}

export async function setSystemSetting(key: string, value: any) {
  const db = await initDB();
  // JSON.stringify(undefined) returns undefined (not a string), which pg then
  // passes as a bare undefined bind parameter — the driver either warns or
  // throws depending on version. Normalize to JSON null so the column stores a
  // well-formed value.
  const serialized = JSON.stringify(value);
  const valStr = serialized === undefined ? 'null' : serialized;
  await db.query(`
    INSERT INTO system_settings (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, valStr]);
}

// ==========================================
// USER MANAGEMENT
// ==========================================

export async function createUser(username: string, passwordHash: string, role: string = 'user') {
  const db = await initDB();
  const res = await db.query(`
    INSERT INTO users (username, password_hash, role)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [username, passwordHash, role]);
  return res.rows[0] as any;
}

export async function getUserById(id: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function getUserByUsername(username: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  return res.rows[0] || null;
}

export async function listUsers() {
  const db = await initDB();
  const res = await db.query('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY created_at ASC');
  return res.rows;
}

export async function updateUser(id: string, fields: { username?: string; passwordHash?: string; role?: string }) {
  const db = await initDB();
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (fields.username) { sets.push(`username = $${idx++}`); vals.push(fields.username); }
  if (fields.passwordHash) { sets.push(`password_hash = $${idx++}`); vals.push(fields.passwordHash); }
  if (fields.role) { sets.push(`role = $${idx++}`); vals.push(fields.role); }

  if (sets.length === 0) return;
  vals.push(id);
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

export async function updateLastLogin(id: string) {
  const db = await initDB();
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
}

export async function deleteUser(id: string) {
  const db = await initDB();
  await db.query('DELETE FROM users WHERE id = $1', [id]);
}

export async function hasUsers(): Promise<boolean> {
  try {
    const db = await initDB();
    const res = await db.query('SELECT COUNT(*) as count FROM users');
    return parseInt((res.rows[0] as any).count, 10) > 0;
  } catch (error: any) {
    // If database is not reachable, we can't determine setup status
    if (error.code === 'ECONNREFUSED') {
      console.warn('[DB] Cannot determine setup status - connection refused.');
      throw error;
    }
    throw error;
  }
}

// ==========================================
// INVITE MANAGEMENT
// ==========================================

export async function createInvite(createdBy: string | null, role: string = 'user', maxUses: number = 1, expiresAt: number | null = null) {
  const db = await initDB();
  const res = await db.query(`
    INSERT INTO invites (created_by, role, max_uses, expires_at)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [createdBy, role, maxUses, expiresAt]);
  return res.rows[0] as any;
}

export async function getInvite(token: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM invites WHERE lower(trim(token)) = lower(trim($1))', [token]);
  return res.rows[0] || null;
}

export async function listInvites() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM invites ORDER BY created_at DESC');
  return res.rows;
}

export async function deleteInvite(token: string) {
  const db = await initDB();
  await db.query('DELETE FROM invites WHERE token = $1', [token]);
}

export async function incrementInviteUses(token: string) {
  const db = await initDB();
  await db.query('UPDATE invites SET uses = uses + 1 WHERE token = $1', [token]);
}

export async function isInviteValid(token: string): Promise<boolean> {
  if (!token) return false;
  const invite = await getInvite(token);
  if (!invite) {
    console.warn(`[Invite] Validation failed: Token "${token}" not found in database.`);
    return false;
  }
  
  // Safe comparison for BIGINT (postgres returns as string) vs JS timestamp
  if (invite.expires_at) {
    const expiresAt = typeof invite.expires_at === 'string' ? parseInt(invite.expires_at, 10) : Number(invite.expires_at);
    if (Date.now() > expiresAt) {
      console.warn(`[Invite] Validation failed: Token "${token}" has expired (expired at ${expiresAt}, now ${Date.now()}).`);
      return false;
    }
  }
  
  if (Number(invite.uses) >= Number(invite.max_uses)) {
    console.warn(`[Invite] Validation failed: Token "${token}" use limit reached (${invite.uses}/${invite.max_uses}).`);
    return false;
  }
  
  return true;
}

// ==========================================
// USER PLAYBACK STATS (per-user telemetry)
// ==========================================

export async function recordPlaybackForUser(userId: string, trackId: string) {
  const db = await initDB();
  await db.query(`
    INSERT INTO user_playback_stats (user_id, track_id, play_count, last_played_at, rating)
    VALUES ($1, $2, 1, NOW(), LEAST(1, 5))
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      play_count = user_playback_stats.play_count + 1,
      last_played_at = NOW(),
      rating = LEAST(user_playback_stats.rating + 1, 5)
  `, [userId, trackId]);

  await db.query(`
    INSERT INTO user_track_play_buckets (user_id, track_id, year_month, play_count)
    VALUES ($1, $2, date_trunc('month', NOW())::date, 1)
    ON CONFLICT (user_id, track_id, year_month) DO UPDATE SET
      play_count = user_track_play_buckets.play_count + 1
  `, [userId, trackId]);

  // Removed legacy tracks table update to prevent write amplification bloat.
  // The frontend should rely on user_playback_stats for user-specific telemetry.
}

export async function recordSkipForUser(userId: string, trackId: string) {
  const db = await initDB();
  await db.query(`
    INSERT INTO user_playback_stats (user_id, track_id, play_count, last_played_at, rating)
    VALUES ($1, $2, 0, NULL, GREATEST(-1, 0))
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      rating = GREATEST(user_playback_stats.rating - 1, 0)
  `, [userId, trackId]);

  // Removed legacy tracks table update to prevent write amplification bloat.
}

export async function getUserPlaybackStats(userId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM user_playback_stats WHERE user_id = $1', [userId]);
  return res.rows;
}

export async function getUserTopTracks(userId: string, limit: number = 10) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.*, ups.play_count, ups.rating as user_rating, ups.last_played_at as user_last_played
    FROM user_playback_stats ups
    JOIN tracks t ON ups.track_id = t.id
    WHERE ups.user_id = $1
    ORDER BY ups.play_count DESC
    LIMIT $2
  `, [userId, limit]);
  return res.rows.map(mapTrackRow);
}

export async function getUserRecentTracks(userId: string, limit: number = 5) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.*, ups.play_count, ups.rating as user_rating, ups.last_played_at as user_last_played
    FROM user_playback_stats ups
    JOIN tracks t ON ups.track_id = t.id
    WHERE ups.user_id = $1 AND ups.last_played_at IS NOT NULL
    ORDER BY ups.last_played_at DESC
    LIMIT $2
  `, [userId, limit]);
  return res.rows.map(mapTrackRow);
}

export async function setTrackLovedForUser(userId: string, trackId: string, loved: boolean) {
  const db = await initDB();
  if (loved) {
    await db.query(`
      INSERT INTO user_loved_tracks (user_id, track_id, loved_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, track_id) DO UPDATE SET loved_at = EXCLUDED.loved_at
    `, [userId, trackId]);
  } else {
    await db.query('DELETE FROM user_loved_tracks WHERE user_id = $1 AND track_id = $2', [userId, trackId]);
  }
}

export async function setTrackRatingForUser(userId: string, trackId: string, rating: number) {
  const db = await initDB();
  const safeRating = Math.max(0, Math.min(5, Math.floor(rating)));
  await db.query(`
    INSERT INTO user_playback_stats (user_id, track_id, play_count, rating, last_played_at)
    VALUES ($1, $2, 0, $3, NULL)
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      rating = EXCLUDED.rating
  `, [userId, trackId, safeRating]);
}

export interface SubsonicApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
}

export interface SubsonicApiKeyWithUserRow extends SubsonicApiKeyRow {
  username: string;
  role: string;
}

export async function createSubsonicApiKey(userId: string, name: string, keyPrefix: string, keyHash: string) {
  const db = await initDB();
  const res = await db.query(`
    INSERT INTO subsonic_api_keys (user_id, name, key_prefix, key_hash)
    VALUES ($1, $2, $3, $4)
    RETURNING id, user_id, name, key_prefix, created_at, last_used_at, revoked_at
  `, [userId, name, keyPrefix, keyHash]);
  return res.rows[0];
}

export async function listSubsonicApiKeys(userId: string) {
  const db = await initDB();
  const res = await db.query(`
    SELECT id, user_id, name, key_prefix, created_at, last_used_at, revoked_at
    FROM subsonic_api_keys
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [userId]);
  return res.rows;
}

export async function listActiveSubsonicApiKeys(): Promise<SubsonicApiKeyRow[]> {
  const db = await initDB();
  const res = await db.query(`
    SELECT id, user_id, name, key_prefix, key_hash, created_at, last_used_at, revoked_at
    FROM subsonic_api_keys
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `);
  return res.rows;
}

export async function getActiveSubsonicApiKeyByPrefix(keyPrefix: string): Promise<SubsonicApiKeyWithUserRow | null> {
  const db = await initDB();
  const res = await db.query(`
    SELECT k.id, k.user_id, k.name, k.key_prefix, k.key_hash, k.created_at, k.last_used_at, k.revoked_at,
           u.username, u.role
    FROM subsonic_api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_prefix = $1 AND k.revoked_at IS NULL
    LIMIT 1
  `, [keyPrefix]);
  return res.rows[0] || null;
}

export async function updateSubsonicApiKeyHash(keyId: string, keyHash: string) {
  const db = await initDB();
  await db.query('UPDATE subsonic_api_keys SET key_hash = $2 WHERE id = $1', [keyId, keyHash]);
}

export async function rotateSubsonicApiKey(userId: string, keyId: string, keyPrefix: string, keyHash: string) {
  const db = await initDB();
  const res = await db.query(`
    UPDATE subsonic_api_keys
    SET key_prefix = $3,
        key_hash = $4,
        last_used_at = NULL
    WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
    RETURNING id, user_id, name, key_prefix, created_at, last_used_at, revoked_at
  `, [keyId, userId, keyPrefix, keyHash]);
  return res.rows[0] || null;
}

export async function touchSubsonicApiKey(keyId: string) {
  const db = await initDB();
  await db.query(`
    UPDATE subsonic_api_keys
    SET last_used_at = NOW()
    WHERE id = $1
      AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')
  `, [keyId]);
}

export async function revokeSubsonicApiKey(userId: string, keyId: string) {
  const db = await initDB();
  const res = await db.query(`
    UPDATE subsonic_api_keys
    SET revoked_at = NOW()
    WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
    RETURNING id
  `, [keyId, userId]);
  return (res.rowCount || 0) > 0;
}

export async function deleteRevokedSubsonicApiKey(userId: string, keyId: string) {
  const db = await initDB();
  const res = await db.query(`
    DELETE FROM subsonic_api_keys
    WHERE id = $1 AND user_id = $2 AND revoked_at IS NOT NULL
    RETURNING id
  `, [keyId, userId]);
  return (res.rowCount || 0) > 0;
}

// ==========================================
// USER SETTINGS (per-user preferences)
// ==========================================

export async function getUserSetting(userId: string, key: string) {
  const db = await initDB();
  const res = await db.query('SELECT value FROM user_settings WHERE user_id = $1 AND key = $2', [userId, key]);
  if (res.rows.length === 0 || !(res.rows[0] as any).value) return null;
  try {
    return JSON.parse((res.rows[0] as any).value);
  } catch {
    return null;
  }
}

export async function setUserSetting(userId: string, key: string, value: any) {
  const db = await initDB();
  const valStr = JSON.stringify(value);
  await db.query(`
    INSERT INTO user_settings (user_id, key, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value
  `, [userId, key, valStr]);
}

export async function deleteUserSettings(userId: string) {
  const db = await initDB();
  await db.query('DELETE FROM user_settings WHERE user_id = $1', [userId]);
}

// ==========================================
// CONCERTS / JAMBASE
// ==========================================

export type ConcertEventRow = {
  jambase_event_id: string;
  artist_id: string;
  event_date: string;
  event_datetime: string | null;
  venue_name: string | null;
  venue_city: string | null;
  venue_region: string | null;
  venue_country: string | null;
  venue_lat: number | null;
  venue_lng: number | null;
  ticket_url: string | null;
  price_min: number | null;
  price_max: number | null;
  price_currency: string | null;
  status: string | null;
  raw_json: any;
  fetched_at: string;
};

export type SubscriptionSource = 'explicit' | 'auto';

export async function getArtistSubscriptions(userId: string) {
  const db = await initDB();
  const res = await db.query(`
    SELECT a.id, a.name, a.image_url, a.mbid, a.jambase_id, uas.created_at, uas.source
    FROM user_artist_subscriptions uas
    JOIN artists a ON a.id = uas.artist_id
    WHERE uas.user_id = $1
    ORDER BY a.name ASC
  `, [userId]);
  return res.rows;
}

export async function countArtistSubscriptions(userId: string): Promise<number> {
  const db = await initDB();
  const res = await db.query('SELECT COUNT(*)::int AS c FROM user_artist_subscriptions WHERE user_id = $1', [userId]);
  return (res.rows[0] as any)?.c ?? 0;
}

export async function isSubscribedToArtist(userId: string, artistId: string): Promise<boolean> {
  const db = await initDB();
  const res = await db.query(
    'SELECT 1 FROM user_artist_subscriptions WHERE user_id = $1 AND artist_id = $2 LIMIT 1',
    [userId, artistId]
  );
  return res.rows.length > 0;
}

// If a user explicitly subscribes to an artist that was previously auto-added,
// promote it to 'explicit' so a later auto-refresh doesn't dislodge it.
export async function addArtistSubscription(userId: string, artistId: string, source: SubscriptionSource = 'explicit') {
  const db = await initDB();
  await db.query(`
    INSERT INTO user_artist_subscriptions (user_id, artist_id, source)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, artist_id) DO UPDATE SET
      source = CASE
        WHEN user_artist_subscriptions.source = 'explicit' THEN 'explicit'
        WHEN EXCLUDED.source = 'explicit' THEN 'explicit'
        ELSE user_artist_subscriptions.source
      END
  `, [userId, artistId, source]);
}

// Returns the source of the row that was deleted (or null if no row existed),
// so the caller can decide whether to dismiss for auto-add purposes.
export async function removeArtistSubscription(userId: string, artistId: string): Promise<SubscriptionSource | null> {
  const db = await initDB();
  const res = await db.query(
    'DELETE FROM user_artist_subscriptions WHERE user_id = $1 AND artist_id = $2 RETURNING source',
    [userId, artistId]
  );
  return res.rows.length > 0 ? ((res.rows[0] as any).source as SubscriptionSource) : null;
}

// ─── Auto-add: dismissed list ──────────────────────────────────────

export async function dismissAutoArtist(userId: string, artistId: string) {
  const db = await initDB();
  await db.query(`
    INSERT INTO user_dismissed_auto_artists (user_id, artist_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, artist_id) DO NOTHING
  `, [userId, artistId]);
}

export async function undismissAutoArtist(userId: string, artistId: string) {
  const db = await initDB();
  await db.query(
    'DELETE FROM user_dismissed_auto_artists WHERE user_id = $1 AND artist_id = $2',
    [userId, artistId]
  );
}

export async function getDismissedAutoArtists(userId: string) {
  const db = await initDB();
  const res = await db.query(`
    SELECT a.id, a.name, a.image_url, d.dismissed_at
    FROM user_dismissed_auto_artists d
    JOIN artists a ON a.id = d.artist_id
    WHERE d.user_id = $1
    ORDER BY d.dismissed_at DESC
  `, [userId]);
  return res.rows;
}

// Returns top-played artists for a user that are eligible to be auto-added:
// not already subscribed and not on the dismissed list. Used by the auto-add
// orchestrator and (for transparency) by a "what would auto-add do?" preview.
export async function getAutoAddCandidates(userId: string, limit: number = 20) {
  const db = await initDB();
  const res = await db.query(`
    SELECT a.id, a.name, a.image_url, a.mbid,
           SUM(ups.play_count)::int AS user_plays,
           MAX(ups.last_played_at) AS last_played_at
    FROM user_playback_stats ups
    JOIN tracks t ON t.id = ups.track_id
    JOIN artists a ON a.id = t.artist_id
    LEFT JOIN user_artist_subscriptions s
      ON s.user_id = ups.user_id AND s.artist_id = a.id
    LEFT JOIN user_dismissed_auto_artists d
      ON d.user_id = ups.user_id AND d.artist_id = a.id
    WHERE ups.user_id = $1
      AND s.artist_id IS NULL
      AND d.artist_id IS NULL
      AND COALESCE(a.is_va_pseudo, FALSE) = FALSE
    GROUP BY a.id, a.name, a.image_url, a.mbid
    HAVING SUM(ups.play_count) >= 3
    ORDER BY user_plays DESC
    LIMIT $2
  `, [userId, limit]);
  return res.rows;
}

export async function setArtistJambaseId(artistId: string, jambaseId: string | null) {
  const db = await initDB();
  await db.query('UPDATE artists SET jambase_id = $1 WHERE id = $2', [jambaseId, artistId]);
}

// Library-only artist search — used by the LiveMusicTab subscription picker.
// Returns artists that have at least one track in the library, ranked by user
// play count (top played first), then alphabetically.
export async function searchLibraryArtists(userId: string, query: string, limit: number = 20) {
  const db = await initDB();
  const trimmed = query.trim();
  const q = `%${trimmed.toLowerCase()}%`;
  // Canonical-key fallback so variants like "n'to" / "tiësto" find the
  // canonical artist row (which may be stored as "NTO" / "Tiesto").
  const keyQuery = normalizeArtistIdentityKey(trimmed);
  const qKey = keyQuery ? `%${keyQuery}%` : null;
  const res = await db.query(`
    SELECT a.id, a.name, a.image_url, a.mbid,
           COALESCE(SUM(ups.play_count), 0)::int AS user_plays
    FROM artists a
    JOIN tracks t ON t.artist_id = a.id
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
    WHERE (LOWER(a.name) LIKE $2 OR ($4::text IS NOT NULL AND a.normalized_key LIKE $4))
      AND COALESCE(a.is_va_pseudo, FALSE) = FALSE
    GROUP BY a.id, a.name, a.image_url, a.mbid
    ORDER BY user_plays DESC, a.name ASC
    LIMIT $3
  `, [userId, q, limit, qKey]);
  return res.rows;
}

// Top played artists in this user's library — used to seed the subscription picker
// with one-click suggestions before the user types anything.
export async function getUserTopArtists(userId: string, limit: number = 10) {
  const db = await initDB();
  const res = await db.query(`
    SELECT a.id, a.name, a.image_url, a.mbid,
           SUM(ups.play_count)::int AS user_plays,
           MAX(ups.last_played_at) AS last_played_at
    FROM user_playback_stats ups
    JOIN tracks t ON t.id = ups.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE ups.user_id = $1
      AND COALESCE(a.is_va_pseudo, FALSE) = FALSE
    GROUP BY a.id, a.name, a.image_url, a.mbid
    ORDER BY user_plays DESC
    LIMIT $2
  `, [userId, limit]);
  return res.rows;
}

// Cache marker for "we fetched this artist's events at time X, got N results".
// Distinct from concert_events because an artist with zero shows would have no
// events row, leaving us no way to tell "never fetched" from "checked, empty".
export async function getArtistConcertsCache(artistId: string) {
  const db = await initDB();
  const res = await db.query(
    'SELECT artist_id, jambase_id, events_count, last_error, fetched_at FROM artist_concerts_cache WHERE artist_id = $1',
    [artistId]
  );
  return res.rows[0] || null;
}

export async function upsertArtistConcertsCache(artistId: string, opts: { jambaseId?: string | null; eventsCount?: number; lastError?: string | null }) {
  const db = await initDB();
  await db.query(`
    INSERT INTO artist_concerts_cache (artist_id, jambase_id, events_count, last_error, fetched_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (artist_id) DO UPDATE SET
      jambase_id = COALESCE(EXCLUDED.jambase_id, artist_concerts_cache.jambase_id),
      events_count = EXCLUDED.events_count,
      last_error = EXCLUDED.last_error,
      fetched_at = NOW()
  `, [artistId, opts.jambaseId ?? null, opts.eventsCount ?? 0, opts.lastError ?? null]);
}

// Replace this artist's cached events. Done in a transaction so a partial
// failure can't leave the cache in a half-rebuilt state.
export async function replaceArtistEvents(artistId: string, events: Omit<ConcertEventRow, 'fetched_at'>[]) {
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM concert_events WHERE artist_id = $1', [artistId]);
    for (const e of events) {
      await client.query(`
        INSERT INTO concert_events (
          jambase_event_id, artist_id, event_date, event_datetime,
          venue_name, venue_city, venue_region, venue_country,
          venue_lat, venue_lng, ticket_url,
          price_min, price_max, price_currency, status, raw_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (jambase_event_id) DO UPDATE SET
          event_date = EXCLUDED.event_date,
          event_datetime = EXCLUDED.event_datetime,
          venue_name = EXCLUDED.venue_name,
          venue_city = EXCLUDED.venue_city,
          venue_region = EXCLUDED.venue_region,
          venue_country = EXCLUDED.venue_country,
          venue_lat = EXCLUDED.venue_lat,
          venue_lng = EXCLUDED.venue_lng,
          ticket_url = EXCLUDED.ticket_url,
          price_min = EXCLUDED.price_min,
          price_max = EXCLUDED.price_max,
          price_currency = EXCLUDED.price_currency,
          status = EXCLUDED.status,
          raw_json = EXCLUDED.raw_json,
          fetched_at = NOW()
      `, [
        e.jambase_event_id, e.artist_id, e.event_date, e.event_datetime,
        e.venue_name, e.venue_city, e.venue_region, e.venue_country,
        e.venue_lat, e.venue_lng, e.ticket_url,
        e.price_min, e.price_max, e.price_currency, e.status,
        e.raw_json ? JSON.stringify(e.raw_json) : null,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Upcoming events for an artist, soonest first, future-dated only.
export async function getUpcomingEventsForArtist(artistId: string, limit: number = 50) {
  const db = await initDB();
  const res = await db.query(`
    SELECT * FROM concert_events
    WHERE artist_id = $1 AND event_date >= CURRENT_DATE
    ORDER BY event_date ASC
    LIMIT $2
  `, [artistId, limit]);
  return res.rows as ConcertEventRow[];
}

// Hub feed: every upcoming event for any artist this user is subscribed to,
// optionally constrained by a bounding box derived from the user's location +
// radius. The radius filter is done in SQL to avoid hauling thousands of rows.
export async function getHubEventsForUser(
  userId: string,
  opts: { lat?: number | null; lng?: number | null; radiusKm?: number | null; limit?: number } = {}
) {
  const db = await initDB();
  const limit = opts.limit ?? 30;
  const params: any[] = [userId];
  let geoFilter = '';
  if (
    typeof opts.lat === 'number' && Number.isFinite(opts.lat) &&
    typeof opts.lng === 'number' && Number.isFinite(opts.lng) &&
    typeof opts.radiusKm === 'number' && opts.radiusKm > 0
  ) {
    // Cheap bounding-box prefilter, then haversine for the precise distance
    // sort. Avoids PostGIS as a dependency.
    const lat = opts.lat;
    const lng = opts.lng;
    const radius = opts.radiusKm;
    const latDelta = radius / 111; // ~111 km per degree latitude
    const lngDelta = radius / (Math.cos((lat * Math.PI) / 180) * 111 || 1);
    params.push(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta);
    params.push(lat, lng, radius);
    geoFilter = `
      AND ce.venue_lat BETWEEN $2 AND $3
      AND ce.venue_lng BETWEEN $4 AND $5
      AND (
        6371 * 2 * ASIN(SQRT(
          POWER(SIN(RADIANS(ce.venue_lat - $6) / 2), 2) +
          COS(RADIANS($6)) * COS(RADIANS(ce.venue_lat)) *
          POWER(SIN(RADIANS(ce.venue_lng - $7) / 2), 2)
        ))
      ) <= $8
    `;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;
  const res = await db.query(`
    SELECT ce.*, a.name AS artist_name, a.image_url AS artist_image_url
    FROM concert_events ce
    JOIN user_artist_subscriptions uas ON uas.artist_id = ce.artist_id
    JOIN artists a ON a.id = ce.artist_id
    WHERE uas.user_id = $1
      AND ce.event_date >= CURRENT_DATE
      ${geoFilter}
    ORDER BY ce.event_date ASC
    LIMIT ${limitParam}
  `, params);
  return res.rows;
}

// Atomic monthly counter. Returns the new count if the call is allowed, or
// null if the hard cap is reached. Single statement, so concurrent callers
// can't overshoot the cap by more than the number of in-flight increments
// that lost the WHERE-clause race.
export async function incrementConcertsApiUsage(opts: { cap?: number | null } = {}): Promise<number | null> {
  const db = await initDB();
  const yearMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const cap = typeof opts.cap === 'number' && opts.cap > 0 ? opts.cap : null;

  // First, ensure the row exists for this month.
  await db.query(`
    INSERT INTO concerts_api_usage (year_month, count, last_call_at)
    VALUES ($1, 0, NULL)
    ON CONFLICT (year_month) DO NOTHING
  `, [yearMonth]);

  // Then, conditionally increment with a cap check inside the same statement.
  if (cap !== null) {
    const res = await db.query(`
      UPDATE concerts_api_usage
      SET count = count + 1, last_call_at = NOW()
      WHERE year_month = $1 AND count < $2
      RETURNING count
    `, [yearMonth, cap]);
    if (res.rows.length === 0) return null;
    return (res.rows[0] as any).count as number;
  } else {
    const res = await db.query(`
      UPDATE concerts_api_usage
      SET count = count + 1, last_call_at = NOW()
      WHERE year_month = $1
      RETURNING count
    `, [yearMonth]);
    return (res.rows[0] as any).count as number;
  }
}

export async function getConcertsApiUsage(yearMonth?: string) {
  const db = await initDB();
  const ym = yearMonth || new Date().toISOString().slice(0, 7);
  const res = await db.query(
    'SELECT year_month, count, last_call_at FROM concerts_api_usage WHERE year_month = $1',
    [ym]
  );
  return res.rows[0] || { year_month: ym, count: 0, last_call_at: null };
}
