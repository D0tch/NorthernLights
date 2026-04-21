import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicDir = new URL('../public/', import.meta.url);
const splashDir = new URL('../public/splash/', import.meta.url);

const colors = {
  bg: '#030208',
  surface: 'rgba(8, 6, 22, 0.58)',
  border: 'rgba(255, 255, 255, 0.09)',
  text: '#edf8f4',
  muted: '#66677b',
  green: '#22c983',
  teal: '#2dd4bf',
  blue: '#0ea5e9',
  rose: '#f43f5e',
};

function iconSvg(size, { maskable = false } = {}) {
  const pad = maskable ? size * 0.19 : size * 0.11;
  const mark = size - pad * 2;
  const radius = maskable ? size * 0.22 : size * 0.19;
  const stroke = Math.max(1, size * 0.004);
  const blur = size * 0.022;
  const streakHeight = size * 0.105;
  const x = pad;
  const y = pad;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="g1" cx="18%" cy="18%" r="52%">
      <stop offset="0%" stop-color="${colors.green}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${colors.green}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="78%" cy="20%" r="56%">
      <stop offset="0%" stop-color="${colors.blue}" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="${colors.blue}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g3" cx="58%" cy="92%" r="55%">
      <stop offset="0%" stop-color="${colors.rose}" stop-opacity="0.13"/>
      <stop offset="100%" stop-color="${colors.rose}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="tile" x1="18%" y1="8%" x2="88%" y2="94%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.09)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.025)"/>
    </linearGradient>
    <linearGradient id="aurora-a" x1="0%" y1="50%" x2="100%" y2="50%">
      <stop offset="0%" stop-color="${colors.green}" stop-opacity="0"/>
      <stop offset="48%" stop-color="${colors.green}" stop-opacity="0.98"/>
      <stop offset="100%" stop-color="${colors.teal}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="aurora-b" x1="0%" y1="50%" x2="100%" y2="50%">
      <stop offset="0%" stop-color="${colors.teal}" stop-opacity="0"/>
      <stop offset="48%" stop-color="${colors.teal}" stop-opacity="0.90"/>
      <stop offset="100%" stop-color="${colors.blue}" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-60%" width="140%" height="220%">
      <feGaussianBlur stdDeviation="${blur}"/>
    </filter>
    <filter id="glow" x="-45%" y="-100%" width="190%" height="300%">
      <feGaussianBlur stdDeviation="${blur * 1.45}" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" fill="${colors.bg}"/>
  <rect width="${size}" height="${size}" fill="url(#g1)"/>
  <rect width="${size}" height="${size}" fill="url(#g2)"/>
  <rect width="${size}" height="${size}" fill="url(#g3)"/>
  <path d="M ${size * 0.05} ${size * 0.66} C ${size * 0.30} ${size * 0.47}, ${size * 0.54} ${size * 0.78}, ${size * 0.94} ${size * 0.38}" fill="none" stroke="${colors.green}" stroke-opacity="0.10" stroke-width="${size * 0.065}" filter="url(#soft)"/>
  <rect x="${x}" y="${y}" width="${mark}" height="${mark}" rx="${radius}" fill="${colors.surface}" stroke="${colors.border}" stroke-width="${stroke}"/>
  <rect x="${x}" y="${y}" width="${mark}" height="${mark}" rx="${radius}" fill="url(#tile)" opacity="0.72"/>
  <g filter="url(#glow)">
    <rect x="${x - mark * 0.18}" y="${y + mark * 0.31}" width="${mark * 1.36}" height="${streakHeight}" rx="${streakHeight / 2}" fill="url(#aurora-a)" transform="rotate(-16 ${size / 2} ${size / 2})"/>
    <rect x="${x - mark * 0.16}" y="${y + mark * 0.52}" width="${mark * 1.32}" height="${streakHeight * 0.86}" rx="${streakHeight / 2}" fill="url(#aurora-b)" transform="rotate(14 ${size / 2} ${size / 2})"/>
  </g>
  <rect x="${x + mark * 0.04}" y="${y + mark * 0.04}" width="${mark * 0.92}" height="${mark * 0.92}" rx="${radius * 0.82}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="${stroke}"/>
</svg>`;
}

function splashSvg(width, height) {
  const min = Math.min(width, height);
  const icon = min * 0.24;
  const top = height * 0.35 - icon / 2;
  const titleSize = min * 0.092;
  const subtitleSize = min * 0.026;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="bg-a" cx="14%" cy="18%" r="58%">
      <stop offset="0%" stop-color="${colors.green}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${colors.green}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bg-b" cx="88%" cy="22%" r="62%">
      <stop offset="0%" stop-color="${colors.blue}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${colors.blue}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bg-c" cx="58%" cy="98%" r="58%">
      <stop offset="0%" stop-color="${colors.rose}" stop-opacity="0.11"/>
      <stop offset="100%" stop-color="${colors.rose}" stop-opacity="0"/>
    </radialGradient>
    <filter id="wash" x="-20%" y="-80%" width="140%" height="260%">
      <feGaussianBlur stdDeviation="${min * 0.028}"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="${colors.bg}"/>
  <rect width="${width}" height="${height}" fill="url(#bg-a)"/>
  <rect width="${width}" height="${height}" fill="url(#bg-b)"/>
  <rect width="${width}" height="${height}" fill="url(#bg-c)"/>
  <path d="M ${width * -0.1} ${height * 0.62} C ${width * 0.20} ${height * 0.38}, ${width * 0.58} ${height * 0.76}, ${width * 1.12} ${height * 0.42}" fill="none" stroke="${colors.green}" stroke-opacity="0.12" stroke-width="${min * 0.08}" filter="url(#wash)"/>
  <path d="M ${width * -0.04} ${height * 0.54} C ${width * 0.30} ${height * 0.78}, ${width * 0.62} ${height * 0.32}, ${width * 1.08} ${height * 0.58}" fill="none" stroke="${colors.blue}" stroke-opacity="0.09" stroke-width="${min * 0.06}" filter="url(#wash)"/>
  <svg x="${(width - icon) / 2}" y="${top}" width="${icon}" height="${icon}" viewBox="0 0 512 512">
    ${iconSvg(512, { maskable: false }).replace(/^[\s\S]*?<svg[^>]*>|<\/svg>$/g, '')}
  </svg>
  <text x="${width / 2}" y="${top + icon + min * 0.13}" text-anchor="middle" fill="${colors.text}" font-size="${titleSize}" font-family="Syne, Avenir Next, Arial, sans-serif" font-weight="800">Aurora</text>
  <text x="${width / 2}" y="${top + icon + min * 0.19}" text-anchor="middle" fill="${colors.muted}" font-size="${subtitleSize}" font-family="DM Sans, Arial, sans-serif" font-weight="700" letter-spacing="${subtitleSize * 0.22}">NORTHERNLIGHTS</text>
</svg>`;
}

async function writePng(svg, file, density = 2) {
  await sharp(Buffer.from(svg), { density: 72 * density }).png({ compressionLevel: 9 }).toFile(fileURLToPath(file));
}

async function main() {
  await mkdir(splashDir, { recursive: true });

  const iconTargets = [
    ['icon-192.png', 192, false],
    ['icon-384.png', 384, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
    ['apple-touch-icon.png', 180, false],
    ['favicon-32.png', 32, false],
  ];

  for (const [name, size, maskable] of iconTargets) {
    await writePng(iconSvg(size, { maskable }), new URL(name, publicDir), 1);
  }

  await Promise.all([
    writeFile(new URL('icon-192.svg', publicDir), iconSvg(192, { maskable: false })),
    writeFile(new URL('icon-512.svg', publicDir), iconSvg(512, { maskable: false })),
  ]);

  const splashTargets = [
    ['apple-splash-750x1334.png', 750, 1334],
    ['apple-splash-828x1792.png', 828, 1792],
    ['apple-splash-1170x2532.png', 1170, 2532],
    ['apple-splash-1284x2778.png', 1284, 2778],
    ['apple-splash-1290x2796.png', 1290, 2796],
    ['apple-splash-1668x2388.png', 1668, 2388],
    ['apple-splash-2048x2732.png', 2048, 2732],
    ['pwa-screenshot-wide.png', 2880, 1620],
    ['pwa-screenshot-narrow.png', 1290, 2796],
  ];

  for (const [name, width, height] of splashTargets) {
    await writePng(splashSvg(width, height), new URL(name, splashDir), 1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
