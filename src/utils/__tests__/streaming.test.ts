import {
  AdaptiveHlsTelemetryTracker,
  DEFAULT_ADAPTIVE_BANDWIDTH_ESTIMATE,
  applyAdaptiveDataSaverLevelCap,
  applyCastStreamingQualityToHlsUrl,
  applyStreamingQualityToHlsUrl,
  getAdaptiveInitialBandwidthEstimate,
  resolveCastStreamingQuality,
  resolveStreamingQuality,
  type BrowserNetworkInformation,
  type AdaptiveHlsMetricsSource,
} from '../streaming';

describe('streaming quality URL resolution', () => {
  const sourceUrl = 'https://aurora.test/api/stream/track/playlist.m3u8?quality=128k&token=secret';

  it('preserves Auto for browser playback while Cast remains fixed at 128 kbps', () => {
    expect(resolveStreamingQuality('auto')).toBe('auto');
    expect(resolveCastStreamingQuality('auto')).toBe('128k');
    expect(resolveCastStreamingQuality('source')).toBe('128k');

    const browserUrl = new URL(applyStreamingQualityToHlsUrl(sourceUrl, 'auto', { saveData: false }));
    expect(browserUrl.searchParams.get('quality')).toBe('auto');
    expect(browserUrl.searchParams.get('token')).toBe('secret');

    const castUrl = new URL(applyCastStreamingQualityToHlsUrl(browserUrl.toString(), 'auto'));
    expect(castUrl.searchParams.get('quality')).toBe('128k');
    expect(castUrl.searchParams.get('maxBitrate')).toBeNull();
  });

  it('caps an Auto master request at 64 kbps when Data Saver is active', () => {
    const url = new URL(applyStreamingQualityToHlsUrl(sourceUrl, 'auto', { saveData: true }));
    expect(url.searchParams.get('quality')).toBe('auto');
    expect(url.searchParams.get('maxBitrate')).toBe('64k');
    expect(url.searchParams.get('token')).toBe('secret');
  });

  it('removes adaptive variant markers when hydrating a master URL or fixed preset', () => {
    const variantUrl = `${sourceUrl}&adaptive=1&rendition=64k&ladder=64k%2C128k&maxBitrate=64k`;
    const url = new URL(applyStreamingQualityToHlsUrl(variantUrl, '160k', { saveData: true }));
    expect(url.searchParams.get('quality')).toBe('160k');
    expect(url.searchParams.get('adaptive')).toBeNull();
    expect(url.searchParams.get('rendition')).toBeNull();
    expect(url.searchParams.get('ladder')).toBeNull();
    expect(url.searchParams.get('maxBitrate')).toBeNull();
  });

  it('seeds hls.js from measured downlink and keeps the 500 kbps unknown default', () => {
    const connection = { downlink: 7.25 } as BrowserNetworkInformation;
    expect(getAdaptiveInitialBandwidthEstimate(connection)).toBe(7_250_000);
    expect(getAdaptiveInitialBandwidthEstimate(null)).toBe(DEFAULT_ADAPTIVE_BANDWIDTH_ESTIMATE);
  });

  it('caps an already-running adaptive level immediately for Data Saver', () => {
    const source: AdaptiveHlsMetricsSource = {
      levels: [{ bitrate: 64_000 }, { bitrate: 128_000 }, { bitrate: 320_000 }],
      currentLevel: 2,
      firstLevel: 0,
      bandwidthEstimate: 4_000_000,
      autoLevelCapping: -1,
      nextLevel: 2,
    };
    expect(applyAdaptiveDataSaverLevelCap(source, true)).toBe(0);
    expect(source.autoLevelCapping).toBe(0);
    expect(source.nextLevel).toBe(0);
    expect(applyAdaptiveDataSaverLevelCap(source, false)).toBe(-1);
    expect(source.autoLevelCapping).toBe(-1);
  });

  it('publishes telemetry only for manifest and level-switch boundaries', () => {
    const tracker = new AdaptiveHlsTelemetryTracker();
    const source: AdaptiveHlsMetricsSource = {
      levels: [{ bitrate: 64_000 }, { bitrate: 128_000 }, { bitrate: 320_000 }],
      currentLevel: -1,
      firstLevel: 1,
      bandwidthEstimate: 2_400_000,
      autoLevelCapping: -1,
      nextLevel: -1,
    };
    const updates = [tracker.onManifest(source)];
    source.bandwidthEstimate = 900_000;
    updates.push(tracker.onLevelSwitched(source, 0));

    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      activeBitrateKbps: 128,
      bandwidthEstimateKbps: 2400,
      levelCount: 3,
      switchCount: 0,
    });
    expect(updates[1]).toEqual({
      activeBitrateKbps: 64,
      bandwidthEstimateKbps: 900,
      levelCount: 3,
      switchCount: 1,
    });
  });
});
