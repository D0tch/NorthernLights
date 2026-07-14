export type StreamingQualityPreset = 'auto' | '64k' | '128k' | '160k' | '320k' | 'source';

export interface BrowserNetworkInformation extends EventTarget {
    downlink?: number;
    saveData?: boolean;
    addEventListener(type: 'change', listener: () => void): void;
    removeEventListener(type: 'change', listener: () => void): void;
}

type StreamingUrlOptions = {
    saveData?: boolean;
};

export const DEFAULT_ADAPTIVE_BANDWIDTH_ESTIMATE = 500_000;

export interface AdaptiveHlsMetricsSource {
    levels: Array<{ bitrate: number }>;
    currentLevel: number;
    firstLevel: number;
    bandwidthEstimate: number;
    autoLevelCapping: number;
    nextLevel: number;
}

export interface AdaptiveTelemetrySnapshot {
    activeBitrateKbps: number | null;
    bandwidthEstimateKbps: number;
    levelCount: number;
    switchCount: number;
}

export class AdaptiveHlsTelemetryTracker {
    private activeLevel = -1;
    private switchCount = 0;

    public reset(): void {
        this.activeLevel = -1;
        this.switchCount = 0;
    }

    public onManifest(source: AdaptiveHlsMetricsSource): AdaptiveTelemetrySnapshot {
        const level = source.currentLevel >= 0 ? source.currentLevel : source.firstLevel;
        this.activeLevel = level;
        return this.snapshot(source, level);
    }

    public onLevelSwitched(source: AdaptiveHlsMetricsSource, level: number): AdaptiveTelemetrySnapshot {
        if (this.activeLevel >= 0 && this.activeLevel !== level) this.switchCount += 1;
        this.activeLevel = level;
        return this.snapshot(source, level);
    }

    public getSwitchCount(): number {
        return this.switchCount;
    }

    private snapshot(source: AdaptiveHlsMetricsSource, level: number): AdaptiveTelemetrySnapshot {
        const bitrate = source.levels[level]?.bitrate;
        return {
            activeBitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
            bandwidthEstimateKbps: Math.round(source.bandwidthEstimate / 1000),
            levelCount: source.levels.length,
            switchCount: this.switchCount,
        };
    }
}

export function applyAdaptiveDataSaverLevelCap(
    source: AdaptiveHlsMetricsSource,
    saveData: boolean,
): number {
    if (!saveData) {
        source.autoLevelCapping = -1;
        return -1;
    }
    const cappedLevel = source.levels.reduce((selected, level, index) => {
        return level.bitrate <= 64_000 ? index : selected;
    }, 0);
    source.autoLevelCapping = cappedLevel;
    if (source.currentLevel > cappedLevel) source.nextLevel = cappedLevel;
    return cappedLevel;
}

export function getBrowserNetworkInformation(): BrowserNetworkInformation | null {
    if (typeof navigator === 'undefined') return null;
    return (navigator as Navigator & { connection?: BrowserNetworkInformation }).connection ?? null;
}

export function getAdaptiveInitialBandwidthEstimate(connection = getBrowserNetworkInformation()): number {
    const downlink = connection?.downlink;
    if (!downlink || !Number.isFinite(downlink) || downlink <= 0) {
        return DEFAULT_ADAPTIVE_BANDWIDTH_ESTIMATE;
    }
    return Math.max(64_000, Math.min(100_000_000, Math.round(downlink * 1_000_000)));
}

export function isDataSaverEnabled(connection = getBrowserNetworkInformation()): boolean {
    return connection?.saveData === true;
}

export function resolveStreamingQuality(preset: StreamingQualityPreset): string {
    return preset;
}

export function resolveCastStreamingQuality(preset: StreamingQualityPreset): string {
    if (preset === 'source' || preset === 'auto') return '128k';
    return preset;
}

export function applyStreamingQualityToHlsUrl(
    hlsUrl: string,
    preset: StreamingQualityPreset,
    options: StreamingUrlOptions = {},
): string {
    if (!hlsUrl || !hlsUrl.includes('.m3u8')) return hlsUrl;

    try {
        const url = new URL(hlsUrl, window.location.origin);
        url.searchParams.set('quality', resolveStreamingQuality(preset));
        url.searchParams.delete('adaptive');
        url.searchParams.delete('rendition');
        url.searchParams.delete('ladder');
        const saveData = options.saveData ?? isDataSaverEnabled();
        if (preset === 'auto' && saveData) {
            url.searchParams.set('maxBitrate', '64k');
        } else {
            url.searchParams.delete('maxBitrate');
        }
        return url.toString();
    } catch {
        return hlsUrl;
    }
}

export function applyCastStreamingQualityToHlsUrl(hlsUrl: string, preset: StreamingQualityPreset): string {
    if (!hlsUrl || !hlsUrl.includes('.m3u8')) return hlsUrl;

    try {
        const url = new URL(hlsUrl, window.location.origin);
        url.searchParams.set('quality', resolveCastStreamingQuality(preset));
        url.searchParams.delete('adaptive');
        url.searchParams.delete('rendition');
        url.searchParams.delete('ladder');
        url.searchParams.delete('maxBitrate');
        return url.toString();
    } catch {
        return hlsUrl;
    }
}
