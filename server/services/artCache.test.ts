import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { findFolderArtwork, resolveArtwork } from './artCache';

async function jpeg(width: number, height: number, color = '#8040c0'): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  }).jpeg().toBuffer();
}

describe('resolveArtwork', () => {
  it('accepts a clean embedded image', async () => {
    const data = await jpeg(320, 240);
    const art = await resolveArtwork([{ data, format: 'image/jpeg', type: 'Cover (front)' }]);
    expect(art).toMatchObject({ format: 'image/jpeg', width: 320, height: 240, source: 'embedded' });
  });

  it('removes an ASF prefix before a complete JPEG', async () => {
    const data = await jpeg(400, 400);
    const prefixed = Buffer.concat([Buffer.from('f\0r\0o\0n\0t\0\0\0'), data]);
    const art = await resolveArtwork([{ data: prefixed, format: 'broken' }]);
    expect(art).toMatchObject({ format: 'image/jpeg', width: 400, height: 400 });
    expect(art?.data.subarray(0, 3)).toEqual(Buffer.from([0xFF, 0xD8, 0xFF]));
  });

  it('reconstructs a JPEG whose SOI and JFIF prefix were lost', async () => {
    const data = await jpeg(500, 450);
    const dqt = data.indexOf(Buffer.from([0xFF, 0xDB]));
    expect(dqt).toBeGreaterThan(0);
    const malformed = Buffer.concat([
      Buffer.from('corrupt-asf-prefix'),
      data.subarray(dqt),
      // An incidental BMP signature previously prevented JPEG recovery.
      Buffer.from('trailing-BM-noise'),
    ]);
    const art = await resolveArtwork([{ data: malformed, format: 'image/jpeg\0broken' }]);
    expect(art).toMatchObject({ format: 'image/jpeg', width: 500, height: 450 });
    expect(art?.data.subarray(0, 2)).toEqual(Buffer.from([0xFF, 0xD8]));
  });

  it('reconstructs a JPEG that starts inside its first quantization segment', async () => {
    const data = await jpeg(500, 494);
    const dqt = data.indexOf(Buffer.from([0xFF, 0xDB]));
    expect(dqt).toBeGreaterThan(0);
    const missingMarker = data.subarray(dqt + 2);
    const art = await resolveArtwork([{ data: missingMarker, format: 'image/jpeg\0broken' }]);
    expect(art).toMatchObject({ format: 'image/jpeg', width: 500, height: 494 });
    await expect(sharp(art?.data).stats()).resolves.toBeDefined();
  });

  it('skips a corrupt first picture and prefers a valid front cover', async () => {
    const back = await jpeg(1200, 1200, '#202020');
    const front = await jpeg(600, 600, '#ffffff');
    const art = await resolveArtwork([
      { data: back, format: 'image/jpeg', type: 'Cover (back)' },
      { data: Buffer.from('not an image'), format: 'image/jpeg' },
      { data: front, format: 'image/jpeg', type: 'Cover (front)' },
    ]);
    expect(art).toMatchObject({ width: 600, height: 600, pictureType: 'Cover (front)' });
  });

  it('returns null for random marker bytes that sharp cannot decode', async () => {
    const data = Buffer.from([0x00, 0xFF, 0xDB, 0x00, 0x04, 0x01, 0x02, 0x03]);
    await expect(resolveArtwork([{ data, format: 'image/jpeg' }])).resolves.toBeNull();
  });
});

describe('folder artwork fallback', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aurora-art-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('uses deterministic conventional filename precedence', async () => {
    await Promise.all([
      fs.promises.writeFile(path.join(dir, 'AlbumArtSmall.jpg'), await jpeg(64, 64)),
      fs.promises.writeFile(path.join(dir, 'Folder.jpg'), await jpeg(300, 300)),
      fs.promises.writeFile(path.join(dir, 'cover.png'), await sharp({
        create: { width: 700, height: 700, channels: 3, background: '#101010' },
      }).png().toBuffer()),
      fs.promises.writeFile(path.join(dir, 'artist.jpg'), await jpeg(1000, 1000)),
    ]);

    const paths = await findFolderArtwork(path.join(dir, 'track.wma'));
    expect(paths.map((entry) => path.basename(entry))).toEqual([
      'cover.png',
      'Folder.jpg',
      'AlbumArtSmall.jpg',
    ]);

    const art = await resolveArtwork([], path.join(dir, 'track.wma'));
    expect(art).toMatchObject({ source: 'folder', width: 700, height: 700 });
    expect(path.basename(art?.sourcePath || '')).toBe('cover.png');
  });
});
