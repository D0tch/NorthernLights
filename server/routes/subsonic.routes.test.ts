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
  getUserSetting: jest.fn(),
  setUserSetting: jest.fn(),
  getSystemSetting: jest.fn(),
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
jest.mock('../services/debugLogger.service', () => ({
  writeDebugLog: jest.fn(),
}));
jest.mock('../services/lastfm.service', () => ({
  scrobbleTracks: jest.fn(),
  updateNowPlaying: jest.fn(),
}));
jest.mock('../services/listenbrainz.service', () => ({
  scrobbleTracks: jest.fn(),
  updateNowPlaying: jest.fn(),
}));

import {
  buildAlbumListPayload,
  buildSearchPayload,
  buildSubsonicScrobbleEvents,
  buildStructuredLyrics,
  buildSubsonicUser,
  buildSubsonicXml,
  isSubsonicProviderScrobbleBridgeEnabled,
  isSubsonicSubmission,
  mapAlbum,
  mapArtist,
  mapTrackToSubsonic,
  normalizeSearchQuery,
  openSubsonicExtensionsPayload,
  parseSubsonicAuthParams,
  queueProviderScrobbleReports,
  sendProviderScrobbleReports,
  subsonicError,
  subsonicSuccess,
} from './subsonic.routes';

const databaseMock = jest.requireMock('../database') as { getUserSetting: jest.Mock };
const lastFmMock = jest.requireMock('../services/lastfm.service') as { scrobbleTracks: jest.Mock; updateNowPlaying: jest.Mock };
const listenBrainzMock = jest.requireMock('../services/listenbrainz.service') as { scrobbleTracks: jest.Mock; updateNowPlaying: jest.Mock };
const debugLoggerMock = jest.requireMock('../services/debugLogger.service') as { writeDebugLog: jest.Mock };
const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('subsonic route helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it('advertises songLyrics and indexBasedQueue alongside apiKey auth', () => {
    const names = ((openSubsonicExtensionsPayload().openSubsonicExtensions as any).extension as any[]).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['apiKeyAuthentication', 'formPost', 'songLyrics', 'indexBasedQueue']));
  });

  it('maps user role to Subsonic capability flags (admin gets adminRole/settingsRole)', () => {
    const admin = buildSubsonicUser('root', 'admin');
    expect(admin).toMatchObject({ username: 'root', adminRole: true, settingsRole: true, streamRole: true, scrobblingEnabled: true });
    const user = buildSubsonicUser('alice', 'user');
    expect(user).toMatchObject({ username: 'alice', adminRole: false, settingsRole: false, downloadRole: true, playlistRole: true });
    // Out-of-scope server-side features are off; no legacy/admin-over-Subsonic.
    expect(user.podcastRole).toBe(false);
    expect(user.shareRole).toBe(false);
    expect(user.jukeboxRole).toBe(false);
  });

  it('builds structuredLyrics for synced and unsynced embedded lyrics', () => {
    const synced = buildStructuredLyrics(
      [{ language: 'eng', syncText: [{ timestamp: 0, text: 'one' }, { timestamp: 1500, text: 'two' }] }],
      'Artist', 'Title',
    );
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ displayArtist: 'Artist', displayTitle: 'Title', lang: 'eng', synced: true });
    expect((synced[0] as any).line).toEqual([{ start: 0, value: 'one' }, { start: 1500, value: 'two' }]);

    const unsynced = buildStructuredLyrics([{ text: 'line a\r\nline b' }], 'A', 'T');
    expect(unsynced[0]).toMatchObject({ synced: false, lang: 'und' });
    expect((unsynced[0] as any).line).toEqual([{ value: 'line a' }, { value: 'line b' }]);

    // No lyric tags → no structured entries (caller returns empty lyricsList).
    expect(buildStructuredLyrics([])).toEqual([]);
    expect(buildStructuredLyrics([{ text: '   ' }])).toEqual([]);
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

  it('parses scrobble submissions and repeated id/time params', () => {
    const playedAt = new Date('2026-06-12T10:11:12.000Z');
    const encoded = Buffer.from('track/with+chars', 'utf8').toString('base64url');
    const events = buildSubsonicScrobbleEvents(
      [`song:v1:${encoded}`, 'song:legacy-track', 'raw-track', ''],
      [String(playedAt.getTime()), '', 'not-a-time', '123'],
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      rawId: `song:v1:${encoded}`,
      trackId: 'track/with+chars',
      timestamp: Math.floor(playedAt.getTime() / 1000),
    });
    expect(events[0].playedAt?.toISOString()).toBe('2026-06-12T10:11:12.000Z');
    expect(events[1]).toMatchObject({ rawId: 'song:legacy-track', trackId: 'legacy-track' });
    expect(events[2]).toMatchObject({ rawId: 'raw-track', trackId: 'raw-track' });
    expect(events[2].playedAt).toBeUndefined();
  });

  it('distinguishes Subsonic scrobble submissions from now-playing notifications', () => {
    expect(isSubsonicSubmission(undefined)).toBe(true);
    expect(isSubsonicSubmission('true')).toBe(true);
    expect(isSubsonicSubmission('1')).toBe(true);
    expect(isSubsonicSubmission('false')).toBe(false);
    expect(isSubsonicSubmission('0')).toBe(false);
  });

  it('keeps the Subsonic provider scrobble bridge opt-in per user', async () => {
    databaseMock.getUserSetting.mockResolvedValueOnce(null);
    await expect(isSubsonicProviderScrobbleBridgeEnabled('user-1')).resolves.toBe(false);

    databaseMock.getUserSetting.mockResolvedValueOnce('true');
    await expect(isSubsonicProviderScrobbleBridgeEnabled('user-1')).resolves.toBe(true);

    expect(databaseMock.getUserSetting).toHaveBeenCalledWith('user-1', 'subsonicProviderScrobbleEnabled');
  });

  it('queues provider scrobble forwarding without waiting for the provider request', async () => {
    databaseMock.getUserSetting.mockImplementation(async (_userId: string, key: string) => (
      ['subsonicProviderScrobbleEnabled', 'lastFmConnected', 'lastFmScrobbleEnabled'].includes(key)
    ));
    let resolveProvider: (value: unknown) => void = () => {};
    lastFmMock.scrobbleTracks.mockReturnValueOnce(new Promise((resolve) => { resolveProvider = resolve; }));

    expect(queueProviderScrobbleReports('user-1', [{ artist: 'Artist', track: 'Title' } as any], true)).toBeUndefined();
    await flushPromises();

    expect(lastFmMock.scrobbleTracks).toHaveBeenCalledWith('user-1', [{ artist: 'Artist', track: 'Title' }]);
    expect(listenBrainzMock.scrobbleTracks).not.toHaveBeenCalled();

    resolveProvider({ status: 'ok' });
    await flushPromises();
  });

  it('contains and logs provider bridge failures', async () => {
    databaseMock.getUserSetting.mockImplementation(async (_userId: string, key: string) => (
      ['subsonicProviderScrobbleEnabled', 'lastFmConnected', 'lastFmScrobbleEnabled'].includes(key)
    ));
    lastFmMock.scrobbleTracks.mockRejectedValueOnce(new Error('provider offline'));

    await expect(sendProviderScrobbleReports('user-1', [{ artist: 'Artist', track: 'Title' } as any], true)).resolves.toBeUndefined();

    expect(debugLoggerMock.writeDebugLog).toHaveBeenCalledWith(
      'subsonic-api.log',
      expect.stringContaining('provider_error provider=lastfm action=scrobble count=1 message=provider offline'),
    );
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
