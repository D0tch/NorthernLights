import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

// Pre-encoded album-art cache.
//
// Album art is encoded ONCE at ingestion time (in the scanTrack worker) to AVIF
// at fixed sizes and stored on disk, addressed by the SHA-256 of the embedded
// picture bytes. Because the key is the image content, an album's N tracks that
// share identical embedded art collapse to ONE set of files. The /api/art
// endpoint then streams these bytes directly instead of re-parsing the audio
// file and sending the full-resolution embedded image on every request.
//
// This module is intentionally DB-free so the scanTrack worker (spawned as a
// separate process) can import it without pulling in the pg pool.

// Sibling to the Postgres data dir by convention (see DB_DATA_DIR usage).
export const ART_CACHE_DIR = path.resolve(process.env.ART_CACHE_DIR || './art-cache');

// Square bounding boxes (px). Covers are resized "inside" this box without
// enlargement, so non-square art keeps its aspect ratio.
//   256  — grid thumbnails (album/artist/playlist cards)
//   640  — detail-page hero
//   1024 — full-screen now-playing
export const ART_SIZES = [256, 640, 1024] as const;
export type ArtSize = (typeof ART_SIZES)[number];
export const DEFAULT_ART_SIZE: ArtSize = 640;

export function isValidArtSize(n: number): n is ArtSize {
  return (ART_SIZES as readonly number[]).includes(n);
}

// SHA-256 of the picture bytes, truncated to 32 hex chars — ample to avoid
// collisions across a personal library while keeping filenames short.
export function hashArt(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

// Sharded by the first two hex chars to avoid one enormous flat directory.
export function artCachePath(hash: string, size: ArtSize): string {
  return path.join(ART_CACHE_DIR, hash.slice(0, 2), `${hash}_${size}.avif`);
}

export function artExists(hash: string, size: ArtSize): boolean {
  try {
    return fs.statSync(artCachePath(hash, size)).size > 0;
  } catch {
    return false;
  }
}

// Scan for the first JPEG/PNG/GIF/WebP/BMP signature in `buf`. Returns the
// offset, or -1 if none found within the first 4 KiB. Recovers the real image
// data when music-metadata's WMA WM/Picture parser slices the buffer at the
// wrong offset (the description terminator is skipped), leaving a small
// UTF-16LE prefix in front of the actual image bytes.
export function findImageStart(buf: Uint8Array): number {
  const maxScan = Math.min(buf.length - 12, 4096);
  for (let i = 0; i <= maxScan; i++) {
    const b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2], b3 = buf[i + 3];
    if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return i;
    if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return i;
    if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return i;
    if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46
        && buf[i + 8] === 0x57 && buf[i + 9] === 0x45 && buf[i + 10] === 0x42 && buf[i + 11] === 0x50) return i;
    if (b0 === 0x42 && b1 === 0x4D) return i;
  }
  return -1;
}

// Encode `bytes` to AVIF at every configured size, skipping any size whose file
// already exists (the on-disk dedup guard — safe across concurrent workers and
// repeat scans). Idempotent.
export async function encodeArt(bytes: Uint8Array, hash: string): Promise<void> {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await Promise.all(ART_SIZES.map(async (size) => {
    if (artExists(hash, size)) return;
    const outPath = artCachePath(hash, size);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    // Write to a temp file then rename so a concurrent reader never sees a
    // half-written file.
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    try {
      await sharp(input)
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .avif({ quality: 62, effort: 4 })
        .toFile(tmpPath);
      await fs.promises.rename(tmpPath, outPath);
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }));
}

// Remove every size variant for hashes that are no longer referenced. The
// caller supplies `isReferenced` (a DB-backed refcount check) so this module
// stays DB-free. Removes the shard directory too when it empties out.
export async function cleanupOrphanArt(
  hashes: Iterable<string>,
  isReferenced: (hash: string) => Promise<boolean>,
): Promise<void> {
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    if (await isReferenced(hash)) continue;
    for (const size of ART_SIZES) {
      await fs.promises.rm(artCachePath(hash, size), { force: true }).catch(() => {});
    }
    const shardDir = path.join(ART_CACHE_DIR, hash.slice(0, 2));
    try {
      const remaining = await fs.promises.readdir(shardDir);
      if (remaining.length === 0) await fs.promises.rmdir(shardDir).catch(() => {});
    } catch {
      /* shard already gone */
    }
  }
}
