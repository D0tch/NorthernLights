import type { TrackInfo } from './fileSystem';
import { applyStreamingQualityToHlsUrl, type StreamingQualityPreset } from './streaming';

type PrewarmOptions = {
    castConnected?: boolean;
};

class PreloadManager {
    private static instance: PreloadManager;
    private readonly inFlight = new Map<string, Promise<void>>();
    private readonly completedAt = new Map<string, number>();
    private readonly completedTtlMs = 10 * 60 * 1000;

    public static getInstance(): PreloadManager {
        if (!PreloadManager.instance) {
            PreloadManager.instance = new PreloadManager();
        }
        return PreloadManager.instance;
    }

    public prewarmNext(
        playlist: TrackInfo[],
        currentIndex: number | null,
        streamingQuality: StreamingQualityPreset,
        options: PrewarmOptions = {}
    ): void {
        if (currentIndex === null || currentIndex < 0) return;
        const nextTrack = playlist[currentIndex + 1];
        if (!nextTrack) return;
        this.prewarmTrack(nextTrack, streamingQuality, options);
    }

    public prewarmTrack(
        track: TrackInfo,
        streamingQuality: StreamingQualityPreset,
        options: PrewarmOptions = {}
    ): void {
        const prewarmUrl = this.buildPrewarmUrl(track, streamingQuality, options);
        if (!prewarmUrl) return;

        const key = prewarmUrl.toString();
        const completedAt = this.completedAt.get(key);
        if (completedAt && Date.now() - completedAt < this.completedTtlMs) return;
        if (this.inFlight.has(key)) return;

        console.info(`[Preload] Prewarming next HLS session: ${track.title || 'Unknown Title'}${track.artist ? ` by ${track.artist}` : ''}`);

        const request = fetch(prewarmUrl, {
            method: 'POST',
            keepalive: true,
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HLS prewarm failed with HTTP ${response.status}`);
                }
                console.info(`[Preload] Next HLS session ready: ${track.title || 'Unknown Title'}${track.artist ? ` by ${track.artist}` : ''}`);
                this.completedAt.set(key, Date.now());
            })
            .catch((error) => {
                console.warn('[Preload] HLS prewarm skipped/failed:', error);
            })
            .finally(() => {
                this.inFlight.delete(key);
                this.pruneCompleted();
            });

        this.inFlight.set(key, request);
    }

    private buildPrewarmUrl(
        track: TrackInfo,
        streamingQuality: StreamingQualityPreset,
        options: PrewarmOptions
    ): URL | null {
        if (!track.url || !track.url.includes('/playlist.m3u8')) return null;

        try {
            const hlsUrl = new URL(applyStreamingQualityToHlsUrl(track.url, streamingQuality), window.location.origin);
            hlsUrl.pathname = hlsUrl.pathname.replace(/\/playlist\.m3u8$/, '/prewarm');
            if (!hlsUrl.searchParams.has('codec')) {
                hlsUrl.searchParams.set('codec', options.castConnected ? 'aac' : 'aac');
            }
            return hlsUrl;
        } catch {
            return null;
        }
    }

    private pruneCompleted(): void {
        const now = Date.now();
        for (const [key, completedAt] of this.completedAt.entries()) {
            if (now - completedAt >= this.completedTtlMs) {
                this.completedAt.delete(key);
            }
        }
    }
}

export const preloadManager = PreloadManager.getInstance();
