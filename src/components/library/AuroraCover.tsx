import React, { useId } from 'react';

// Procedural cover art for generated playlist families — pure inline SVG built
// from the --aurora-cover-* tokens (no raster assets, no network, theme-stable
// like every other cover gradient). Two deliberately distinct motifs so the
// families never read as the same thing at a glance:
//
//   wrapped  — a horizontal wave horizon: seasonal sky over a wave-split field,
//              soft bloom along the crest, big period label bottom-left.
//   discover — vertical aurora curtains: translucent light pillars over a deep
//              night base. No label (title + owner byline sit below the card).
//
// Everything is deterministic from `seed` (playlist id): same playlist always
// gets the same cover, different playlists spread across variants.

export type WrappedPalette = 'spring' | 'summer' | 'autumn' | 'winter' | 'year';

// FNV-1a; tiny and stable across sessions (covers must never shuffle on reload).
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic bucket pick for a seed — exported for tests and callers. */
export function auroraSeedVariant(seed: string, buckets: number): number {
  if (buckets <= 0) return 0;
  return hashSeed(seed || '') % buckets;
}

/** "Spring 2026" → seasonal palette; "2025 Wrapped" (or anything else) → full-year. */
export function wrappedCoverPalette(title: string | null | undefined): WrappedPalette {
  const m = /^(winter|spring|summer|autumn)\s+\d{4}$/i.exec((title || '').trim());
  return m ? (m[1].toLowerCase() as WrappedPalette) : 'year';
}

/** Cover label: "2025 Wrapped" → "2025"; season titles pass through unchanged. */
export function wrappedCoverLabel(title: string | null | undefined): string {
  return (title || '').replace(/\s+Wrapped$/i, '').trim();
}

// ─── Wrapped: wave horizon ─────────────────────────────────────────────
// Hand-tuned field shapes (200×200 box, gentle 1–1.5 undulation crests). The
// crest path is reused via <use> for the bloom layers, so it lives in <defs>
// with no fill of its own.
const WAVE_PATHS = [
  'M0 118 C 34 104, 64 134, 100 121 C 136 108, 168 96, 200 110 L 200 200 L 0 200 Z',
  'M0 104 C 40 122, 72 94, 110 110 C 148 126, 172 122, 200 102 L 200 200 L 0 200 Z',
  'M0 128 C 28 112, 66 142, 104 126 C 142 110, 166 104, 200 122 L 200 200 L 0 200 Z',
];

// ─── Discover: aurora curtains ─────────────────────────────────────────
// Each curtain is a gently swaying full-height band; the vertical gradient does
// the fading so the path stays simple. Hand-tuned layout tuples.
interface Curtain { x: number; w: number; sway: number }
const CURTAIN_LAYOUTS: Curtain[][] = [
  [{ x: 34, w: 26, sway: 10 }, { x: 92, w: 34, sway: -12 }, { x: 150, w: 22, sway: 8 }],
  [{ x: 22, w: 30, sway: -10 }, { x: 78, w: 24, sway: 12 }, { x: 138, w: 36, sway: -8 }],
  [{ x: 48, w: 36, sway: 12 }, { x: 118, w: 26, sway: -14 }, { x: 164, w: 20, sway: 6 }],
];

function curtainPath({ x, w, sway }: Curtain): string {
  const r = x + w;
  return `M${x} 0 C ${x + sway} 60, ${x - sway} 130, ${x} 200 L ${r} 200 C ${r - sway} 130, ${r + sway} 60, ${r} 0 Z`;
}

interface AuroraCoverProps {
  variant: 'wrapped' | 'discover';
  /** Deterministic seed (playlist id) — picks wave/curtain variant + palette spread. */
  seed: string;
  /** Wrapped only: playlist title, parsed for the seasonal palette. */
  title?: string | null;
  /** Wrapped only: big bottom-left label (e.g. "2025", "Spring 2026"). */
  label?: string;
}

/** Absolute-fill cover; parent supplies the rounded, clipped square. */
export const AuroraCover: React.FC<AuroraCoverProps> = ({ variant, seed, title, label }) => {
  const uid = useId();
  const hash = hashSeed(seed || title || '');
  const flip = (hash & 0x8) !== 0;

  let svgBody: React.ReactNode;
  if (variant === 'wrapped') {
    const palette = wrappedCoverPalette(title);
    const wave = WAVE_PATHS[hash % WAVE_PATHS.length];
    const skyA = `var(--aurora-cover-${palette}-sky-a)`;
    const skyB = `var(--aurora-cover-${palette}-sky-b)`;
    const fieldA = `var(--aurora-cover-${palette}-field-a)`;
    const fieldB = `var(--aurora-cover-${palette}-field-b)`;
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor={skyA} />
            <stop offset="1" stopColor={skyB} />
          </linearGradient>
          <linearGradient id={`${uid}-field`} x1="0" y1="0" x2="0.25" y2="1">
            <stop offset="0" stopColor={fieldA} />
            <stop offset="1" stopColor={fieldB} />
          </linearGradient>
          <path id={`${uid}-wave`} d={wave} />
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-sky)`} />
        {/* Bloom: stacked translucent copies of the field shape, drifting up from
            the crest — soft aurora glow without SVG filters (cheap across rails). */}
        <use href={`#${uid}-wave`} transform="translate(0,-26)" fill="#ffffff" opacity="0.05" />
        <use href={`#${uid}-wave`} transform="translate(0,-15)" fill="#ffffff" opacity="0.07" />
        <use href={`#${uid}-wave`} transform="translate(0,-7)" fill="#ffffff" opacity="0.09" />
        <use href={`#${uid}-wave`} fill={`url(#${uid}-field)`} />
      </>
    );
  } else {
    const p = (auroraSeedVariant(seed, 4) + 1) as 1 | 2 | 3 | 4;
    const tintA = `var(--aurora-cover-disc-${p}a)`;
    const tintB = `var(--aurora-cover-disc-${p}b)`;
    const curtains = CURTAIN_LAYOUTS[(hash >>> 4) % CURTAIN_LAYOUTS.length];
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-night`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="var(--aurora-cover-night-a)" />
            <stop offset="1" stopColor="var(--aurora-cover-night-b)" />
          </linearGradient>
          {curtains.map((_, i) => (
            <linearGradient key={i} id={`${uid}-c${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={i === 1 ? tintB : tintA} stopOpacity="0.08" />
              <stop offset="0.3" stopColor={i === 1 ? tintB : tintA} stopOpacity="0.5" />
              <stop offset="1" stopColor={i === 1 ? tintB : tintA} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        {curtains.map((c, i) => (
          <path key={i} d={curtainPath(c)} fill={`url(#${uid}-c${i})`} />
        ))}
      </>
    );
  }

  return (
    <div className="absolute inset-0" aria-hidden="true">
      <svg
        viewBox="0 0 200 200"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        <g transform={flip ? 'scale(-1,1) translate(-200,0)' : undefined}>{svgBody}</g>
      </svg>
      {label && (
        <>
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/35 to-transparent" />
          <span className="absolute inset-x-3 bottom-3 line-clamp-2 text-left text-2xl font-black leading-none tracking-normal text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
            {label}
          </span>
        </>
      )}
    </div>
  );
};
