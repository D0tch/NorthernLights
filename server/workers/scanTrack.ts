import * as mm from 'music-metadata';

// Protocol: Each line on stdin: { id, filePathBase64, nameStr }
// Each line on stdout: { id, metadata: { ... } } or { id, error }

function sanitizeUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  // Strip null bytes, BOM, and ASCII control characters (except tab)
  const cleaned = raw
    .replace(/\x00/g, '')           // null bytes (crash Postgres)
    .replace(/\uFEFF/g, '')         // BOM
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
    .trim();
  if (!cleaned) return null;
  // Must be http(s) and a plausible length
  if (!/^https?:\/\/.{3,}/i.test(cleaned)) return null;
  if (cleaned.length > 2048) return null;
  // Validate parseable by URL constructor
  try { new URL(cleaned); } catch { return null; }
  return cleaned;
}

function extractUrlTags(native: Record<string, any[]>): { url: string; type: string }[] {
  const results: { url: string; type: string }[] = [];
  const seen = new Set<string>();

  const add = (raw: string, type: string) => {
    const url = sanitizeUrl(raw);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ url, type });
  };

  for (const [format, tags] of Object.entries(native || {})) {
    if (!Array.isArray(tags)) continue;

    if (format === 'vorbis') {
      for (const tag of tags) {
        const id = (tag.id || '').toUpperCase();
        const val = typeof tag.value === 'string' ? tag.value : '';
        switch (id) {
          case 'URL_OFFICIAL_ARTIST_SITE':
          case 'WEBSITE': add(val, 'official homepage'); break;
          case 'URL_OFFICIAL_RELEASE_SITE': add(val, 'official audio source'); break;
          case 'URL_DISCOGS_ARTIST_PAGE':
          case 'URL_DISCOGS_RELEASE_PAGE': add(val, 'discogs'); break;
          case 'URL_SOUNDCLOUD': add(val, 'soundcloud'); break;
          case 'URL_YOUTUBE': add(val, 'youtube'); break;
          case 'URL_WIKIPEDIA_ARTIST':
          case 'URL_WIKIPEDIA_RELEASE': add(val, 'wikipedia'); break;
          case 'URL_SPOTIFY_ARTIST':
          case 'URL_SPOTIFY_ALBUM': add(val, 'spotify'); break;
          case 'URL_BANDCAMP': add(val, 'bandcamp'); break;
        }
      }
    } else if (format.startsWith('ID3v2')) {
      for (const tag of tags) {
        const id = tag.id || '';
        const val = tag.value;
        switch (id) {
          case 'WOAR': if (typeof val === 'string') add(val, 'official homepage'); break;
          case 'WOAS': if (typeof val === 'string') add(val, 'official audio source'); break;
          case 'WORS': if (typeof val === 'string') add(val, 'streaming'); break;
          case 'WPUB': if (typeof val === 'string') add(val, 'official homepage'); break;
          case 'WCOM': if (typeof val === 'string') add(val, 'commercial'); break;
          case 'WXXX': {
            if (typeof val === 'object' && val?.url) {
              const desc = (val.description || '').toLowerCase();
              let type = 'other';
              if (desc.includes('spotify')) type = 'spotify';
              else if (desc.includes('youtube')) type = 'youtube';
              else if (desc.includes('instagram') || desc.includes('facebook') || desc.includes('twitter') || desc.includes('x.com')) type = 'social network';
              else if (desc.includes('discogs')) type = 'discogs';
              else if (desc.includes('bandcamp')) type = 'bandcamp';
              else if (desc.includes('soundcloud')) type = 'soundcloud';
              else if (desc.includes('wikipedia')) type = 'wikipedia';
              add(val.url, type);
            }
            break;
          }
        }
      }
    }
  }

  return results;
}

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: { id: string; filePathBase64: string; nameStr: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    try {
      const utf8Path = Buffer.from(msg.filePathBase64, 'base64').toString('utf8');

      // parseFile() accepts a plain string path — no Buffer hacks needed.
      // duration: true forces music-metadata to scan MPEG frames when the
      // file lacks a Xing/Info/LAME header or TLEN tag (common for DJ-mix
      // compilations); without it format.duration is undefined and we
      // persist 0 forever.
      const metadata = await mm.parseFile(utf8Path, { skipCovers: true, duration: true });
      const rawUrls = extractUrlTags(metadata.native || {});

      process.stdout.write(JSON.stringify({
        id: msg.id,
        metadata: {
            artist: metadata.common.artist || metadata.common.albumartist || null,
            albumartist: metadata.common.albumartist || null,
            title: metadata.common.title || null,
            artists: metadata.common.artists || null,
            album: metadata.common.album || null,
            genre: metadata.common.genre || null,
            duration: metadata.format.duration || 0,
            trackNumber: metadata.common.track.no || null,
            discNumber: metadata.common.disk?.no || null,
            year: metadata.common.year || null,
            releaseType: metadata.common.releasetype ? metadata.common.releasetype[0] : null,
            isCompilation: metadata.common.compilation || false,
            bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
            format: metadata.format.container || metadata.format.codec || null,
            isrc: metadata.common.isrc?.[0] || null,
            mbRecordingId: metadata.common.musicbrainz_recordingid || null,
            mbTrackId: metadata.common.musicbrainz_trackid || null,
            mbAlbumId: metadata.common.musicbrainz_albumid || null,
            mbArtistId: Array.isArray(metadata.common.musicbrainz_artistid) ? metadata.common.musicbrainz_artistid[0] : (metadata.common.musicbrainz_artistid || null),
            mbAlbumArtistId: Array.isArray(metadata.common.musicbrainz_albumartistid) ? metadata.common.musicbrainz_albumartistid[0] : (metadata.common.musicbrainz_albumartistid || null),
            mbReleaseGroupId: metadata.common.musicbrainz_releasegroupid || null,
            mbWorkId: metadata.common.musicbrainz_workid || null,
            rawUrls: rawUrls.length > 0 ? rawUrls : null,
        }
      }) + '\n');
    } catch (err: any) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: err?.message || String(err) }) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
