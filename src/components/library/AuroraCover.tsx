import React, { useId } from 'react';

// Procedural cover art for generated playlist families — pure inline SVG built
// from the --aurora-cover-* tokens (no raster assets, no network, theme-stable
// like every other cover gradient). Four deliberately distinct motifs so the
// families never read as the same thing at a glance:
//
//   wrapped     — a horizontal wave horizon: seasonal sky over a wave-split
//                 field, soft bloom along the crest, big period label.
//   favourites  — vertical aurora curtains (green/teal): light pillars over a
//                 night base, genre label. Genre heavy-rotation mixes.
//   rediscover  — echo arcs (violet/rose): a low glow with soft concentric
//                 rings radiating out, genre label. Genre rediscovery mixes.
//   decade      — a sweeping aurora ribbon with the decade numeral printed
//                 into the art, always readable. Decade / decade-genre mixes.
//
// Everything is deterministic from `seed` (playlist id/title): same playlist
// always gets the same cover, different playlists spread across variants.

export type AuroraCoverVariant = 'wrapped' | 'favourites' | 'rediscover' | 'decade';

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

/**
 * Genre for the cover from an engine-mix title. New forms "Your Trance
 * favourites" / "Rediscover Trance", plus the legacy "Trance Heavy Rotation" /
 * "Trance Rediscovery" until playlists regenerate.
 */
export function systemGenreCoverLabel(title: string | null | undefined): string {
  const t = (title || '').trim();
  const fav = /^Your\s+(.+)\s+favourites$/i.exec(t);
  if (fav) return fav[1];
  const red = /^Rediscover\s+(.+)$/i.exec(t);
  if (red) return red[1];
  return t.replace(/\s+(Heavy Rotation|Rediscovery)$/i, '').trim();
}

/**
 * Short decade numeral for the cover from an engine-mix title: "The 2010's" /
 * "Trance from the 2010's" → "10's"; legacy "90's Mix" / "90's Pop" → "90's".
 */
export function systemDecadeCoverLabel(title: string | null | undefined): string {
  const t = (title || '').trim();
  const full = /\b(?:19|20)(\d0)'?s\b/.exec(t);
  if (full) return `${full[1]}'s`;
  const short = /\b(\d0)'s\b/.exec(t);
  if (short) return `${short[1]}'s`;
  return t.replace(/\s+Mix$/i, '').trim();
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

// ─── Favourites: aurora curtains ───────────────────────────────────────
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

// ─── Rediscover: echo arcs ─────────────────────────────────────────────
// A low glow with concentric rings radiating out — light returning. Two
// hand-tuned origins (flip covers the mirrored pair).
const ECHO_ORIGINS = [
  { cx: 58, cy: 148 },
  { cx: 74, cy: 132 },
];
const ECHO_RADII = [26, 52, 82, 116];

interface AuroraCoverProps {
  variant: AuroraCoverVariant;
  /** Deterministic seed (playlist id/title) — picks shape variant + palette spread. */
  seed: string;
  /** Wrapped only: playlist title, parsed for the seasonal palette. */
  title?: string | null;
  /**
   * Cover text. wrapped/favourites/rediscover: big bottom-left label. decade:
   * the numeral printed into the art (e.g. "10's").
   */
  label?: string;
}

/** Absolute-fill cover; parent supplies the rounded, clipped square. */
export const AuroraCover: React.FC<AuroraCoverProps> = ({ variant, seed, title, label }) => {
  const uid = useId();
  const hash = hashSeed(seed || title || '');
  const flip = (hash & 0x8) !== 0;
  // The decade numeral is part of the art itself, not the bottom-left overlay.
  const overlayLabel = variant === 'decade' ? undefined : label;

  let svgBody: React.ReactNode;
  if (variant === 'wrapped') {
    const palette = wrappedCoverPalette(title);
    const wave = WAVE_PATHS[hash % WAVE_PATHS.length];
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor={`var(--aurora-cover-${palette}-sky-a)`} />
            <stop offset="1" stopColor={`var(--aurora-cover-${palette}-sky-b)`} />
          </linearGradient>
          <linearGradient id={`${uid}-field`} x1="0" y1="0" x2="0.25" y2="1">
            <stop offset="0" stopColor={`var(--aurora-cover-${palette}-field-a)`} />
            <stop offset="1" stopColor={`var(--aurora-cover-${palette}-field-b)`} />
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
  } else if (variant === 'favourites') {
    // Green/teal end of the spectrum — the "your heavy rotation" family.
    const p = (auroraSeedVariant(seed, 2) + 1) as 1 | 2;
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
  } else if (variant === 'rediscover') {
    // Violet/rose end of the spectrum — echoes of what you used to play.
    const p = (auroraSeedVariant(seed, 2) + 3) as 3 | 4;
    const tintA = `var(--aurora-cover-disc-${p}a)`;
    const tintB = `var(--aurora-cover-disc-${p}b)`;
    const { cx, cy } = ECHO_ORIGINS[(hash >>> 4) % ECHO_ORIGINS.length];
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-night`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="var(--aurora-cover-night-a)" />
            <stop offset="1" stopColor="var(--aurora-cover-night-b)" />
          </linearGradient>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0" stopColor={tintA} stopOpacity="0.55" />
            <stop offset="0.6" stopColor={tintA} stopOpacity="0.18" />
            <stop offset="1" stopColor={tintA} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        <circle cx={cx} cy={cy} r="64" fill={`url(#${uid}-glow)`} />
        {ECHO_RADII.map((r, i) => (
          <circle
            key={r}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={i % 2 === 0 ? tintA : tintB}
            strokeWidth={2.5 - i * 0.4}
            opacity={0.42 - i * 0.09}
          />
        ))}
      </>
    );
  } else {
    // decade — a sweeping ribbon with the numeral printed into the art. One
    // thin band recrosses the glyph at low opacity so it sits *in* the aurora
    // while staying easily readable.
    const p = (auroraSeedVariant(seed, 4) + 1) as 1 | 2 | 3 | 4;
    const tintA = `var(--aurora-cover-disc-${p}a)`;
    const tintB = `var(--aurora-cover-disc-${p}b)`;
    svgBody = (
      <>
        <defs>
          <linearGradient id={`${uid}-night`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="var(--aurora-cover-night-a)" />
            <stop offset="1" stopColor="var(--aurora-cover-night-b)" />
          </linearGradient>
          <linearGradient id={`${uid}-ribbon`} x1="0" y1="0" x2="1" y2="0.4">
            <stop offset="0" stopColor={tintA} stopOpacity="0.5" />
            <stop offset="1" stopColor={tintB} stopOpacity="0.2" />
          </linearGradient>
        </defs>
        <rect width="200" height="200" fill={`url(#${uid}-night)`} />
        <path
          d="M-10 152 C 44 96, 118 176, 210 84 L 210 122 C 118 214, 44 134, -10 192 Z"
          fill={`url(#${uid}-ribbon)`}
        />
        {label && (
          <text
            x="100"
            y="124"
            textAnchor="middle"
            fontSize="66"
            fontWeight="900"
            fill="#ffffff"
            opacity="0.96"
            style={{ fontFamily: 'inherit', letterSpacing: '-0.02em' }}
          >
            {label}
          </text>
        )}
        <path
          d="M-10 112 C 52 150, 128 84, 210 128 L 210 142 C 128 100, 52 166, -10 128 Z"
          fill={tintB}
          opacity="0.16"
        />
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
        <g transform={flip && variant !== 'decade' ? 'scale(-1,1) translate(-200,0)' : undefined}>
          {svgBody}
        </g>
      </svg>
      {overlayLabel && (
        <>
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/35 to-transparent" />
          <span className="absolute inset-x-3 bottom-3 line-clamp-2 text-left text-2xl font-black leading-none tracking-normal text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
            {overlayLabel}
          </span>
        </>
      )}
    </div>
  );
};
