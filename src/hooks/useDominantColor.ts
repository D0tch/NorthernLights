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

export const useDominantColor = (tracks: TrackInfo[], options?: { crossOrigin?: string; quality?: number }) => {
  const artUrls = useMemo(
    () => Array.from(new Set(tracks.map(t => t.artUrl).filter(Boolean) as string[])).slice(0, 4),
    [tracks]
  );
  const primaryArt = artUrls[0] || '';
  const [bgColor, setBgColor] = useState<string>(FALLBACK_COLOR);
  // `palette` = one dominant color per track (cross-track, e.g. Hub tiles).
  const [palette, setPalette] = useState<string[]>([]);
  // `colors` = the multi-color palette of the primary cover (single image),
  // for vibrant gradients built from one artwork (e.g. now-playing background).
  const [colors, setColors] = useState<string[]>([]);
  const quality = options?.quality ?? 10;
  const crossOrigin = options?.crossOrigin ?? 'Anonymous';
  const paletteKey = artUrls.join('|');

  useEffect(() => {
    if (!primaryArt) {
      setBgColor(FALLBACK_COLOR);
      setPalette([]);
      setColors([]);
      return;
    }

    let cancelled = false;
    Promise.all(artUrls.map((url) => getPalette(url, quality, crossOrigin)))
      .then(palettes => {
        if (cancelled) return;
        const dominantPerTrack = Array.from(new Set(palettes.map(p => p[0]).filter(Boolean)));
        setBgColor(dominantPerTrack[0] || FALLBACK_COLOR);
        setPalette(dominantPerTrack);
        setColors(palettes[0] ?? []);
      });

    return () => { cancelled = true; };
  }, [primaryArt, paletteKey, quality, crossOrigin]);

  return { artUrls, primaryArt, bgColor, palette, colors };
};
