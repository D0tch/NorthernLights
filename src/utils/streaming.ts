export type StreamingQualityPreset = 'auto' | '64k' | '128k' | '160k' | '320k' | 'source';

export function resolveStreamingQuality(preset: StreamingQualityPreset): string {
    return preset === 'auto' ? '128k' : preset;
}

export function applyStreamingQualityToHlsUrl(hlsUrl: string, preset: StreamingQualityPreset): string {
    if (!hlsUrl || !hlsUrl.includes('.m3u8')) return hlsUrl;

    try {
        const url = new URL(hlsUrl, window.location.origin);
        url.searchParams.set('quality', resolveStreamingQuality(preset));
        return url.toString();
    } catch {
        return hlsUrl;
    }
}
