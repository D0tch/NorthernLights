jest.mock('./metadata', () => ({
  getAlbumImage: jest.fn(),
}));

import { getAlbumImage } from './metadata';
import {
  clearProviderArtworkLookupCache,
  providerArtworkProxyPath,
  resolveProviderArtworkUrl,
} from './artworkFallback.service';

const getAlbumImageMock = getAlbumImage as jest.MockedFunction<typeof getAlbumImage>;

describe('artwork provider fallback', () => {
  beforeEach(() => {
    clearProviderArtworkLookupCache();
    getAlbumImageMock.mockReset();
  });

  it('uses an already-cached album image without a provider lookup', async () => {
    await expect(resolveProviderArtworkUrl({
      albumId: 'album-1',
      album: 'Album',
      artist: 'Artist',
      cachedImageUrl: 'https://example.test/cover.jpg',
    })).resolves.toBe('https://example.test/cover.jpg');
    expect(getAlbumImageMock).not.toHaveBeenCalled();
  });

  it('deduplicates provider lookups, including negative results', async () => {
    getAlbumImageMock.mockResolvedValue(undefined);
    const context = { albumId: 'album-1', album: 'Album', artist: 'Artist' };
    await Promise.all([
      resolveProviderArtworkUrl(context),
      resolveProviderArtworkUrl(context),
      resolveProviderArtworkUrl(context),
    ]);
    await resolveProviderArtworkUrl(context);
    expect(getAlbumImageMock).toHaveBeenCalledTimes(1);
  });

  it('evicts failed requests so a later lookup can retry', async () => {
    getAlbumImageMock
      .mockRejectedValueOnce(new Error('provider offline'))
      .mockResolvedValueOnce('https://example.test/recovered.jpg');
    const context = { albumId: 'album-1', album: 'Album', artist: 'Artist' };
    await expect(resolveProviderArtworkUrl(context)).rejects.toThrow('provider offline');
    await expect(resolveProviderArtworkUrl(context)).resolves.toBe('https://example.test/recovered.jpg');
    expect(getAlbumImageMock).toHaveBeenCalledTimes(2);
  });

  it('builds an encoded path through the allowlisted image proxy', () => {
    expect(providerArtworkProxyPath('https://coverartarchive.org/release/a/front-500'))
      .toBe('/api/providers/external/proxy-image?url=https%3A%2F%2Fcoverartarchive.org%2Frelease%2Fa%2Ffront-500');
  });
});
