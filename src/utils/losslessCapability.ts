// Decide whether the current browser can play a track's source codec natively,
// so the player can bypass HLS transcoding and stream the original bytes
// (lossless passthrough via /api/stream?pathB64=…, Range-seekable).
//
// The server stores `tracks.format` as music-metadata's `format.container ||
// format.codec`, which yields a wide variety of strings ("FLAC", "MPEG 1
// Layer 3", "M4A/isom", "ASF/Windows Media", "WAVE", "Ogg", "ALAC", etc.).
// We normalize on substring matches and probe HTMLAudioElement.canPlayType.

const probeCache = new Map<string, boolean>();

function probe(mime: string): boolean {
    if (probeCache.has(mime)) return probeCache.get(mime)!;
    let result = false;
    try {
        const a = document.createElement('audio');
        const verdict = a.canPlayType(mime);
        result = verdict === 'probably' || verdict === 'maybe';
    } catch {
        result = false;
    }
    probeCache.set(mime, result);
    return result;
}

export function canBrowserPlayNative(format: string | null | undefined): boolean {
    if (!format) return false;
    const f = format.toLowerCase();

    // FLAC — Chrome/Firefox/Edge/Safari 11+
    if (f.includes('flac')) return probe('audio/flac') || probe('audio/x-flac');

    // MP3 — universally supported
    if (f.includes('mpeg') || f.includes('mp3') || f.includes('mp2') || f.includes('layer 3')) {
        return probe('audio/mpeg');
    }

    // WAV / PCM
    if (f.includes('wave') || f.includes('wav') || f.includes('riff') || f.includes('pcm')) {
        return probe('audio/wav') || probe('audio/wave');
    }

    // Ogg Vorbis / Opus
    if (f.includes('opus')) return probe('audio/ogg; codecs="opus"') || probe('audio/opus');
    if (f.includes('vorbis') || f.includes('ogg')) return probe('audio/ogg; codecs="vorbis"') || probe('audio/ogg');

    // M4A container — could hold AAC (universal) or ALAC (Safari/Chrome desktop). Probe both.
    if (f.includes('mp4') || f.includes('m4a') || f.includes('isom') || f.includes('mpeg-4') || f.includes('aac') || f.includes('alac')) {
        if (probe('audio/mp4; codecs="mp4a.40.2"')) return true; // AAC-LC
        if (probe('audio/mp4; codecs="alac"')) return true;      // ALAC
        return probe('audio/mp4');
    }

    // WMA / ASF — browsers don't support natively. Keep on HLS path
    // (where the legacy /api/stream WMA branch transcodes to MP3 for raw URL,
    //  but the HLS pipeline handles it more reliably for now).
    if (f.includes('asf') || f.includes('wma')) return false;

    // APE, DSF, DSD, TAK, etc. — no native support
    return false;
}

/**
 * Lossless MIME to cast a file *progressively* (raw bytes, platform player), or
 * null if it isn't a Cast-native lossless container. Per the Cast SDK: FLAC
 * (≤96/24) and WAV/LPCM play on every Cast audio device; ALAC is unsupported
 * everywhere (→ null, falls back to AAC HLS). Format-string based so it works on
 * existing rows without the `lossless` backfill (FLAC/WAV are inherently lossless).
 */
export function castLosslessMime(format: string | null | undefined): string | null {
    if (!format) return null;
    const f = format.toLowerCase();
    if (f.includes('flac')) return 'audio/flac';
    if (f.includes('wave') || f.includes('wav') || f.includes('riff') || f.includes('pcm')) return 'audio/wav';
    return null;
}
