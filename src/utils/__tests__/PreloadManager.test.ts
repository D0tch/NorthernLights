import type { TrackInfo } from '../fileSystem';
import { preloadManager } from '../PreloadManager';

const makeTrack = (id: string): TrackInfo => ({
  id,
  path: `/${id}.flac`,
  title: id,
  url: `/api/stream/${id}/playlist.m3u8?quality=128k`,
});

describe('PreloadManager', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('prewarms only the immediate next track by default', () => {
    const playlist = [makeTrack('current-default'), makeTrack('next-default'), makeTrack('later-default')];

    preloadManager.prewarmNext(playlist, 0, '128k');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/stream/next-default/prewarm' }),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('prewarms two queued tracks for aggressive preparation', () => {
    const playlist = [makeTrack('current-aggressive'), makeTrack('next-aggressive'), makeTrack('later-aggressive')];

    preloadManager.prewarmNext(playlist, 0, '128k', { aheadCount: 2 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pathname: '/api/stream/next-aggressive/prewarm' }),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pathname: '/api/stream/later-aggressive/prewarm' }),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('stops at the end of the queue', () => {
    const playlist = [makeTrack('current-tail'), makeTrack('next-tail')];

    preloadManager.prewarmNext(playlist, 0, '128k', { aheadCount: 2 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
