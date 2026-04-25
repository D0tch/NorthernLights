import { useState, useEffect, useMemo } from 'react';
import { TrackInfo } from '../utils/fileSystem';

const FALLBACK_COLOR = 'var(--color-primary)';
const COLOR_CACHE_MAX_ENTRIES = 400;
const dominantColorCache = new Map<string, string>();
const dominantColorInFlight = new Map<string, Promise<string>>();

function getCacheKey(imageUrl: string, quality: number, crossOrigin: string): string {
  return `${quality}:${crossOrigin}:${imageUrl}`;
}

function readCachedColor(key: string): string | undefined {
  const cached = dominantColorCache.get(key);
  if (!cached) return undefined;
  dominantColorCache.delete(key);
  dominantColorCache.set(key, cached);
  return cached;
}

function writeCachedColor(key: string, color: string): void {
  dominantColorCache.set(key, color);

  if (dominantColorCache.size <= COLOR_CACHE_MAX_ENTRIES) return;
  const oldestKey = dominantColorCache.keys().next().value;
  if (oldestKey) dominantColorCache.delete(oldestKey);
}

function extractDominantColor(imageUrl: string, quality: number = 10, crossOrigin = 'Anonymous'): Promise<string> {
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

      let maxCount = 0;
      let dominant = '0,0,0';
      for (const [key, count] of Object.entries(colorCounts)) {
        if (count > maxCount) {
          maxCount = count;
          dominant = key;
        }
      }

      const [r, g, b] = dominant.split(',').map(Number);
      resolve(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageUrl;
  });
}

function getDominantColor(imageUrl: string, quality: number, crossOrigin: string): Promise<string> {
  const key = getCacheKey(imageUrl, quality, crossOrigin);
  const cached = readCachedColor(key);
  if (cached) return Promise.resolve(cached);

  const inFlight = dominantColorInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = extractDominantColor(imageUrl, quality, crossOrigin)
    .then(color => {
      writeCachedColor(key, color);
      return color;
    })
    .catch(() => {
      writeCachedColor(key, FALLBACK_COLOR);
      return FALLBACK_COLOR;
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
  const quality = options?.quality ?? 10;
  const crossOrigin = options?.crossOrigin ?? 'Anonymous';

  useEffect(() => {
    if (!primaryArt) {
      setBgColor(FALLBACK_COLOR);
      return;
    }

    let cancelled = false;
    getDominantColor(primaryArt, quality, crossOrigin)
      .then(color => { if (!cancelled) setBgColor(color); })

    return () => { cancelled = true; };
  }, [primaryArt, quality, crossOrigin]);

  return { artUrls, primaryArt, bgColor };
};
