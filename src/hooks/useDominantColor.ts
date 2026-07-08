import { useState, useEffect, useMemo } from 'react';
import { TrackInfo } from '../utils/fileSystem';

const FALLBACK_COLOR = 'var(--color-primary)';
const COLOR_CACHE_MAX_ENTRIES = 400;
// Cache the full extracted palette per image; the dominant color is just its
// first entry. The cached value is a `|`-joined list of hex colors.
const dominantColorCache = new Map<string, string[]>();
const dominantColorInFlight = new Map<string, Promise<string[]>>();
// How many distinct cover colors to surface for multi-color gradients.
const MAX_PALETTE_COLORS = 4;
// Minimum squared RGB distance between two palette colors so a gradient isn't
// built from near-identical shades.
const MIN_COLOR_DISTANCE_SQ = 48 * 48;

function getCacheKey(imageUrl: string, quality: number, crossOrigin: string): string {
  return `${quality}:${crossOrigin}:${imageUrl}`;
}

function readCachedColor(key: string): string[] | undefined {
  const cached = dominantColorCache.get(key);
  if (!cached) return undefined;
  dominantColorCache.delete(key);
  dominantColorCache.set(key, cached);
  return cached;
}

function writeCachedColor(key: string, palette: string[]): void {
  dominantColorCache.set(key, palette);

  if (dominantColorCache.size <= COLOR_CACHE_MAX_ENTRIES) return;
  const oldestKey = dominantColorCache.keys().next().value;
  if (oldestKey) dominantColorCache.delete(oldestKey);
}

function toHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Extract the most frequent quantized colors from an image. Returns up to
// MAX_PALETTE_COLORS distinct colors ordered by frequency (dominant first),
// filtered so they're visually distinct from each other.
function extractPalette(imageUrl: string, quality: number = 10, crossOrigin = 'Anonymous'): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = crossOrigin;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('No canvas context'));

      const size = Math.min(img.width, 64);
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(img, 0, 0, size, size);

      const { data } = ctx.getImageData(0, 0, size, size);
      const colorCounts: Record<string, number> = {};

      for (let i = 0; i < data.length; i += 4 * quality) {
        const r = Math.round(data[i] / 16) * 16;
        const g = Math.round(data[i + 1] / 16) * 16;
        const b = Math.round(data[i + 2] / 16) * 16;
        const key = `${r},${g},${b}`;
        colorCounts[key] = (colorCounts[key] || 0) + 1;
      }

      const ranked = Object.entries(colorCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => key.split(',').map(Number) as [number, number, number]);

      if (ranked.length === 0) return reject(new Error('No colors extracted'));

      const chosen: [number, number, number][] = [];
      for (const [r, g, b] of ranked) {
        const distinct = chosen.every(([cr, cg, cb]) => {
          const dr = r - cr, dg = g - cg, db = b - cb;
          return dr * dr + dg * dg + db * db >= MIN_COLOR_DISTANCE_SQ;
        });
        if (distinct) chosen.push([r, g, b]);
        if (chosen.length >= MAX_PALETTE_COLORS) break;
      }
      // Always keep at least the dominant color, even if everything was similar.
      if (chosen.length === 0) chosen.push(ranked[0]);

      resolve(chosen.map(([r, g, b]) => toHex(r, g, b)));
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageUrl;
  });
}

function getPalette(imageUrl: string, quality: number, crossOrigin: string): Promise<string[]> {
  const key = getCacheKey(imageUrl, quality, crossOrigin);
  const cached = readCachedColor(key);
  if (cached) return Promise.resolve(cached);

  const inFlight = dominantColorInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = extractPalette(imageUrl, quality, crossOrigin)
    .then(palette => {
      writeCachedColor(key, palette);
      return palette;
    })
    .catch(() => {
      writeCachedColor(key, [FALLBACK_COLOR]);
      return [FALLBACK_COLOR];
    })
    .finally(() => {
      dominantColorInFlight.delete(key);
    });

  dominantColorInFlight.set(key, promise);
  return promise;
}

// Palette-extraction quality used for the mobile now-playing backdrop. The mini
// player prefetches with the same value so the cache key matches and the sheet
// mounts with its colors already resolved (no fallback→derived fade on open).
export const NOW_PLAYING_PALETTE_QUALITY = 12;

// Warm the palette cache ahead of need (e.g. from the always-mounted mini
// player, so opening now-playing paints the cover colors on its first frame).
export function prefetchPalette(imageUrl: string, options?: { crossOrigin?: string; quality?: number }): void {
  void getPalette(imageUrl, options?.quality ?? 10, options?.crossOrigin ?? 'Anonymous');
}

type DominantColorState = {
  bgColor: string;
  // One dominant color per track (cross-track, e.g. Hub tiles).
  palette: string[];
  // The multi-color palette of the primary cover (single image), for vibrant
  // gradients built from one artwork (e.g. now-playing background).
  colors: string[];
};

const EMPTY_COLOR_STATE: DominantColorState = { bgColor: FALLBACK_COLOR, palette: [], colors: [] };

function deriveColorState(palettes: string[][]): DominantColorState {
  const dominantPerTrack = Array.from(new Set(palettes.map(p => p[0]).filter(Boolean)));
  return {
    bgColor: dominantPerTrack[0] || FALLBACK_COLOR,
    palette: dominantPerTrack,
    colors: palettes[0] ?? [],
  };
}

function sameColorState(a: DominantColorState, b: DominantColorState): boolean {
  return a.bgColor === b.bgColor
    && a.palette.join('|') === b.palette.join('|')
    && a.colors.join('|') === b.colors.join('|');
}

// Every palette straight from the cache, or null if any is missing.
function peekPalettes(artUrls: string[], quality: number, crossOrigin: string): string[][] | null {
  if (artUrls.length === 0) return null;
  const cached = artUrls.map(url => dominantColorCache.get(getCacheKey(url, quality, crossOrigin)));
  return cached.every(Boolean) ? (cached as string[][]) : null;
}

export const useDominantColor = (tracks: TrackInfo[], options?: { crossOrigin?: string; quality?: number }) => {
  const artUrls = useMemo(
    () => Array.from(new Set(tracks.map(t => t.artUrl).filter(Boolean) as string[])).slice(0, 4),
    [tracks]
  );
  const primaryArt = artUrls[0] || '';
  const quality = options?.quality ?? 10;
  const crossOrigin = options?.crossOrigin ?? 'Anonymous';
  const paletteKey = artUrls.join('|');

  // Derive synchronously whenever every palette is already cached (the common
  // case — the mini player prefetches the current track's palette). A track
  // change then updates the colors in the SAME render as the track itself, so
  // downstream backdrops start ONE cross-fade instead of a second one a beat
  // later, and a fresh mount (reopening the now-playing sheet) paints the real
  // colors on its first frame instead of fading in from the fallback.
  const resolved = useMemo(() => {
    const cached = peekPalettes(artUrls, quality, crossOrigin);
    return cached ? deriveColorState(cached) : null;
    // artUrls is keyed by paletteKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteKey, quality, crossOrigin]);

  // Async fallback: the last extracted colors. Read only while the current
  // urls aren't all cached yet — i.e. it keeps the PREVIOUS track's colors up
  // while a cold cover extracts, then hands over to the cache-derived value.
  const [state, setState] = useState<DominantColorState>(EMPTY_COLOR_STATE);

  useEffect(() => {
    if (!primaryArt) {
      setState(prev => (sameColorState(prev, EMPTY_COLOR_STATE) ? prev : EMPTY_COLOR_STATE));
      return;
    }

    let cancelled = false;
    Promise.all(artUrls.map((url) => getPalette(url, quality, crossOrigin)))
      .then(palettes => {
        if (cancelled) return;
        setState(prev => {
          const next = deriveColorState(palettes);
          // Bail on identical values (e.g. the cache-seeded initial state) so
          // consumers' memos keep their identity and no cross-fade is kicked off.
          return sameColorState(prev, next) ? prev : next;
        });
      });

    return () => { cancelled = true; };
  }, [primaryArt, paletteKey, quality, crossOrigin]);

  const effective = resolved ?? state;
  return { artUrls, primaryArt, bgColor: effective.bgColor, palette: effective.palette, colors: effective.colors };
};
