jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({
  initDB: jest.fn(),
  touchSubsonicApiKey: jest.fn(),
  getActiveSubsonicApiKeyByPrefix: jest.fn(),
  updateSubsonicApiKeyHash: jest.fn(),
  getPlaylists: jest.fn(),
  getPlaylistTracks: jest.fn(),
  getPlaylistMeta: jest.fn(),
  createPlaylist: jest.fn(),
  addTracksToPlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
  recordPlaybackForUser: jest.fn(),
  setTrackLovedForUser: jest.fn(),
  setTrackRatingForUser: jest.fn(),
}));
jest.mock('../state', () => ({
  isPathAllowed: jest.fn(),
  pathToBuffer: jest.fn(),
}));
jest.mock('../services/hlsStream.service', () => ({
  getOrCreateHlsSession: jest.fn(),
  getSessionInfo: jest.fn(),
  touchSession: jest.fn(),
  getSessionOutputDir: jest.fn(),
}));
jest.mock('../services/scopedToken.service', () => ({
  generateScopedToken: jest.fn(),
  verifyScopedToken: jest.fn(),
}));

import {
  buildAlbumListPayload,
  buildSearchPayload,
  buildSubsonicXml,
  mapAlbum,
  mapArtist,
  mapTrackToSubsonic,
  normalizeSearchQuery,
  openSubsonicExtensionsPayload,
  parseSubsonicAuthParams,
  subsonicError,
  subsonicSuccess,
} from './subsonic.routes';

describe('subsonic route helpers', () => {
  it('accepts API-key-only auth params', () => {
    expect(parseSubsonicAuthParams({ apiKey: 'aurora_sub_test' })).toEqual({ apiKey: 'aurora_sub_test' });
    expect(parseSubsonicAuthParams({ api_key: 'aurora_sub_test' })).toEqual({ apiKey: 'aurora_sub_test' });
  });

  it('rejects unsupported and conflicting auth params with OpenSubsonic codes', () => {
    expect(parseSubsonicAuthParams({ u: 'alice', p: 'secret' }).error?.code).toBe(41);
    expect(parseSubsonicAuthParams({ t: 'token', s: 'salt' }).error?.code).toBe(42);
    expect(parseSubsonicAuthParams({ apiKey: 'aurora_sub_test', u: 'alice' }).error?.code).toBe(43);
    expect(parseSubsonicAuthParams({}).error?.code).toBe(43);
  });

  it('advertises apiKeyAuthentication so clients can discover apiKey auth before logging in', () => {
    const payload = openSubsonicExtensionsPayload();
    const extensions = (payload.openSubsonicExtensions as any).extension as Array<{ name: string; versions: number[] }>;
    const names = extensions.map((e) => e.name);
    expect(names).toContain('apiKeyAuthentication');
    expect(names).toContain('formPost');
    // The extensions list must be self-contained (no auth context) so the
    // endpoint can be served before authentication, per the OpenSubsonic spec.
    expect(extensions.every((e) => Array.isArray(e.versions) && e.versions.length > 0)).toBe(true);
  });

  it('treats the Subsonic match-all query ("" / empty / whitespace) as an empty query for full-library sync', () => {
    // Symfonium (compatibility mode OFF) enumerates the library via search3
    // with query="", which arrives as the literal two characters "".
    expect(normalizeSearchQuery('""')).toBe('');
    expect(normalizeSearchQuery("''")).toBe('');
    expect(normalizeSearchQuery('')).toBe('');
    expect(normalizeSearchQuery('   ')).toBe('');
    expect(normalizeSearchQuery(undefined)).toBe('');
    // A real query is preserved; wrapping quotes are stripped, inner text kept.
    expect(normalizeSearchQuery('rock')).toBe('rock');
    expect(normalizeSearchQuery('"hello world"')).toBe('hello world');
    expect(normalizeSearchQuery('  beatles ')).toBe('beatles');
  });

  it('builds standard success and error envelopes', () => {
    const ok = subsonicSuccess({ ping: true });
    expect(ok['subsonic-response']).toMatchObject({
      status: 'ok',
      version: '1.16.1',
      type: 'aurora',
      openSubsonic: true,
      ping: true,
    });

    const failed = subsonicError(44, 'Invalid key');
    expect(failed['subsonic-response']).toMatchObject({
      status: 'failed',
      error: { code: 44, message: 'Invalid key' },
    });
  });

  it('serializes XML response metadata and nested errors', () => {
    const xml = buildSubsonicXml(subsonicError(41, 'Use API keys'));
    expect(xml).toContain('<subsonic-response');
    expect(xml).toContain('status="failed"');
    expect(xml).toContain('version="1.16.1"');
    expect(xml).toContain('<error code="41" message="Use API keys"></error>');
  });

  it('maps Aurora tracks to Subsonic song fields without leaking file paths', () => {
    const song = mapTrackToSubsonic({
      id: 'track/with+unsafe=chars',
      path: '/music/Artist/Album/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      artist_id: 'artist-1',
      album_id: 'album-1',
      duration: 123.4,
      bitrate: 960000,
      track_number: 2,
      genre: 'Ambient',
      is_loved: true,
      user_rating: 5,
    });

    expect(song).toMatchObject({
      parent: 'album:album-1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      artistId: 'artist:artist-1',
      albumId: 'album:album-1',
      duration: 123,
      bitRate: 960,
      track: 2,
      genre: 'Ambient',
      contentType: 'audio/flac',
      userRating: 5,
    });
    expect(song.id).toMatch(/^song:v1:[A-Za-z0-9_-]+$/);
    expect(song.coverArt).toBe(song.id);
    expect(song.id).not.toContain('/');
    expect(song.id).not.toContain('+');
    expect(song.id).not.toContain('=');
    expect(song.path).toBeUndefined();
    expect(song.starred).toBeDefined();
  });

  it('uses zero duration for tracks with missing duration so sync clients receive an integer', () => {
    const song = mapTrackToSubsonic({
      id: 'track-1',
      path: '/music/Artist/Album/song.mp3',
      title: 'Song',
      duration: null,
    });

    expect(song.duration).toBe(0);
  });

  it('derives a valid slash-free suffix and correct contentType from the base64-encoded path', () => {
    const b64 = (p: string) => Buffer.from(p, 'utf8').toString('base64');
    const cases = [
      { path: '/music/A/B/song.mp3', format: 'MPEG', suffix: 'mp3', contentType: 'audio/mpeg' },
      { path: '/music/A/B/song.m4a', format: 'M4A/mp42/isom', suffix: 'm4a', contentType: 'audio/mp4' },
      { path: '/music/A/B/song.wma', format: 'ASF/audio', suffix: 'wma', contentType: 'audio/x-ms-wma' },
      { path: '/music/A/B/song.wav', format: 'WAVE', suffix: 'wav', contentType: 'audio/wav' },
      { path: '/music/A/B/song.flac', format: 'FLAC', suffix: 'flac', contentType: 'audio/flac' },
    ];
    for (const c of cases) {
      const song = mapTrackToSubsonic({ id: 't', path: b64(c.path), format: c.format, title: 'x' });
      expect(song.suffix).toBe(c.suffix);
      expect(String(song.suffix)).not.toContain('/');
      expect(song.contentType).toBe(c.contentType);
    }
  });

  it('emits size from file_size and created from file_mtime (BIGINT comes back as a string from pg)', () => {
    const b64 = Buffer.from('/music/A/B/song.mp3', 'utf8').toString('base64');
    const song = mapTrackToSubsonic({
      id: 't', path: b64, format: 'MPEG', title: 'x',
      file_size: '7654321',      // pg returns BIGINT as a string
      file_mtime: '1700000000000',
    });
    expect(song.size).toBe(7654321);
    expect(typeof song.size).toBe('number');
    expect(song.created).toBe(new Date(1700000000000).toISOString());
  });

  it('falls back to a slash-free suffix from the container name when a track has no path', () => {
    const song = mapTrackToSubsonic({ id: 't', path: null, format: 'M4A/mp42/isom', title: 'x' });
    expect(song.suffix).toBe('m4a');
    expect(String(song.suffix)).not.toContain('/');
    expect(song.contentType).toBe('audio/mp4');
  });

  it('includes a title on artist directory entries for directory-browsing clients', () => {
    const artist = mapArtist({ id: 'artist-1', name: 'Artist' }, 3);

    expect(artist).toMatchObject({
      id: 'artist:artist-1',
      name: 'Artist',
      title: 'Artist',
      albumCount: 3,
    });
  });

  it('maps Aurora albums to ID3 album fields expected by sync clients', () => {
    const album = mapAlbum({
      id: 'album-1',
      title: 'Album',
      artist_name: 'Artist',
      artist_id: 'artist-1',
      song_count: 12,
      duration: 3600,
      play_count: 4,
      release_year: 2001,
      genre: 'Rock',
    });

    expect(album).toMatchObject({
      id: 'album:album-1',
      album: 'Album',
      name: 'Album',
      title: 'Album',
      artist: 'Artist',
      artistId: 'artist:artist-1',
      songCount: 12,
      duration: 3600,
      playCount: 4,
      year: 2001,
      genre: 'Rock',
      isDir: true,
    });
  });

  it('returns only the response root matching album-list method variants', () => {
    const legacy = buildAlbumListPayload('getalbumlist', [{ id: 'album-1', title: 'Album' }]);
    const id3 = buildAlbumListPayload('getalbumlist2', [{ id: 'album-1', title: 'Album' }]);

    expect(legacy).toHaveProperty('albumList');
    expect(legacy).not.toHaveProperty('albumList2');
    expect(id3).toHaveProperty('albumList2');
    expect(id3).not.toHaveProperty('albumList');
  });

  it('returns only the response root matching search method variants', () => {
    const result = { artist: [], album: [], song: [] };

    expect(buildSearchPayload('search', result)).toHaveProperty('searchResult');
    expect(buildSearchPayload('search2', result)).toHaveProperty('searchResult2');
    expect(buildSearchPayload('search3', result)).toHaveProperty('searchResult3');
    expect(buildSearchPayload('search3', result)).not.toHaveProperty('searchResult2');
  });
});
