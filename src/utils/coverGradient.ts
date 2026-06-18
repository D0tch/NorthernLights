// Procedural cover-color gradients shared by the Hub feature tile and the
// mobile now-playing background. Given a seed (so the same cover always rolls
// the same layout) and a palette of extracted cover colors, these build a
// vibrant multi-layer CSS gradient string.

// Aurora-spectrum fallback palette when a cover doesn't yield usable colors.
// Mirrors the brand spectrum (oxygen green → teal → sky blue → rose pink).
export const AURORA_FALLBACK_PALETTE = ['#22c983', '#2dd4bf', '#0ea5e9', '#f43f5e'];

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function asHexColor(color: string | undefined, fallback: string): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = asHexColor(hex, AURORA_FALLBACK_PALETTE[0]).slice(1);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Coerce a palette into at least 4 distinct, valid hex colors, padding from the
// aurora fallback when needed. Deterministic for a given seed.
function normalizePalette(seed: string, palette: string[], fallbackColor: string): string[] {
  const fallbackPalette = AURORA_FALLBACK_PALETTE;
  const usablePalette = [...palette, fallbackColor]
    .map((color, index) => asHexColor(color, fallbackPalette[index % fallbackPalette.length]))
    .filter(Boolean);
  const colors = Array.from(new Set(usablePalette));
  while (colors.length < 4) colors.push(fallbackPalette[(colors.length + hashString(seed)) % fallbackPalette.length]);
  return colors;
}

// Hub feature-tile gradient. Layout rolls deterministically from the seed.
export function buildRolledCoverGradient(seed: string, palette: string[], fallbackColor: string): string {
  const colors = normalizePalette(seed, palette, fallbackColor);

  const roll = hashString(`${seed}:${colors.join('|')}`);
  const pick = (offset: number) => colors[(roll + offset) % colors.length];
  const angle = roll % 360;
  const x1 = 18 + (roll % 58);
  const y1 = 14 + ((roll >> 4) % 62);
  const x2 = 22 + ((roll >> 8) % 56);
  const y2 = 20 + ((roll >> 12) % 58);
  const conicX = 34 + ((roll >> 16) % 36);
  const conicY = 28 + ((roll >> 20) % 42);

  const c1 = pick(0);
  const c2 = pick(1);
  const c3 = pick(2);
  const c4 = pick(3);

  return [
    `radial-gradient(circle at ${x1}% ${y1}%, ${hexToRgba(c1, 0.70)} 0%, ${hexToRgba(c1, 0.34)} 24%, transparent 58%)`,
    `radial-gradient(circle at ${x2}% ${y2}%, ${hexToRgba(c2, 0.62)} 0%, ${hexToRgba(c2, 0.28)} 22%, transparent 56%)`,
    `conic-gradient(from ${angle}deg at ${conicX}% ${conicY}%, ${hexToRgba(c3, 0.58)}, ${hexToRgba(c4, 0.48)}, ${hexToRgba(c2, 0.52)}, ${hexToRgba(c1, 0.58)})`,
    `linear-gradient(${(angle + 90) % 360}deg, ${hexToRgba(c1, 0.46)}, ${hexToRgba(c4, 0.38)})`,
  ].join(', ');
}

// Full-bleed, punchier mesh for the mobile now-playing background. Higher
// alphas and three radial hotspots so the cover's colors read vividly across
// the whole screen (the "very vibrant" no-video state).
export function buildCoverMeshGradient(seed: string, palette: string[], fallbackColor: string): string {
  const colors = normalizePalette(seed, palette, fallbackColor);

  const roll = hashString(`${seed}:mesh:${colors.join('|')}`);
  const pick = (offset: number) => colors[(roll + offset) % colors.length];
  const angle = roll % 360;
  const x1 = 12 + (roll % 30);
  const y1 = 6 + ((roll >> 4) % 26);
  const x2 = 58 + ((roll >> 8) % 34);
  const y2 = 8 + ((roll >> 12) % 28);
  const x3 = 28 + ((roll >> 16) % 44);
  const y3 = 52 + ((roll >> 20) % 30);

  const c1 = pick(0);
  const c2 = pick(1);
  const c3 = pick(2);
  const c4 = pick(3);

  return [
    `radial-gradient(circle at ${x1}% ${y1}%, ${hexToRgba(c1, 0.85)} 0%, ${hexToRgba(c1, 0.45)} 26%, transparent 60%)`,
    `radial-gradient(circle at ${x2}% ${y2}%, ${hexToRgba(c2, 0.78)} 0%, ${hexToRgba(c2, 0.36)} 24%, transparent 58%)`,
    `radial-gradient(circle at ${x3}% ${y3}%, ${hexToRgba(c3, 0.70)} 0%, ${hexToRgba(c3, 0.30)} 28%, transparent 62%)`,
    `conic-gradient(from ${angle}deg at 50% 40%, ${hexToRgba(c4, 0.50)}, ${hexToRgba(c2, 0.42)}, ${hexToRgba(c1, 0.50)}, ${hexToRgba(c3, 0.46)}, ${hexToRgba(c4, 0.50)})`,
    `linear-gradient(${(angle + 90) % 360}deg, ${hexToRgba(c1, 0.55)}, ${hexToRgba(c4, 0.40)})`,
  ].join(', ');
}
