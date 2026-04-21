import Bottleneck from 'bottleneck';
import { MetadataProvider, ArtistData, ProviderSettings, LyricsData } from './types';
import { fetchWithRetry } from './utils';

export class ProviderError extends Error {
  constructor(message: string, public provider: string, public statusCode?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class GeniusProvider implements MetadataProvider {
  // Genius rate limits aren't strictly documented but ~5-10/sec is usually safe
  private limiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 200,
  });

  private async fetch<T>(url: string, apiKey: string): Promise<T> {
    try {
      const res = await this.limiter.schedule(() => 
        fetchWithRetry(url, { headers: { Authorization: `Bearer ${apiKey}` } })
      );
      
      if (!res.ok) {
        if (res.status === 429) {
          throw new ProviderError('Rate Limited', 'genius', 429);
        }
        throw new ProviderError(`Genius HTTP ${res.status}`, 'genius', res.status);
      }
      
      return await res.json() as T;
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`fetch failed: ${err.message}`, 'genius');
    }
  }

  async getArtistInfo(name: string, _: string | null | undefined, settings: ProviderSettings): Promise<Partial<ArtistData>> {
    const apiKey = settings?.geniusApiKey;
    if (!apiKey) return {};

    try {
      // 1. Search for artist
      const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(name)}`;
      const searchData: any = await this.fetch(searchUrl, apiKey);
      
      const hits = searchData?.response?.hits;
      if (!hits || hits.length === 0) return {};

      // Priority 1: Exact artist name match
      let match = hits.find((h: any) => 
         h.type === 'song' && 
         h.result?.primary_artist?.name?.toLowerCase() === name.toLowerCase()
      );
      
      // Priority 2: Case-insensitive contains match
      if (!match) {
        match = hits.find((h: any) => 
          h.type === 'song' && 
          h.result?.primary_artist?.name?.toLowerCase().includes(name.toLowerCase())
        );
      }
      
      // Fallback
      if (!match) match = hits[0];

      const artistId = match?.result?.primary_artist?.id;
      let imageUrl = match?.result?.primary_artist?.image_url;

      if (imageUrl && imageUrl.includes('default_cover_image.png')) {
        imageUrl = undefined; // Don't return default avatar
      }

      const result: Partial<ArtistData> = { ...(imageUrl && { imageUrl }) };

      // 2. Fetch bio if we got an artist ID
      if (artistId) {
        const artistUrl = `https://api.genius.com/artists/${artistId}`;
        const artistData: any = await this.fetch(artistUrl, apiKey);
        
        const bioPlain = artistData?.response?.artist?.description?.plain;
        if (typeof bioPlain === 'string' && bioPlain.trim().length > 0 && bioPlain !== '?') {
          result.bio = bioPlain;
        }
      }

      return result;
    } catch (err: any) {
      console.warn(`[GeniusProvider] Artist info fetch failed for "${name}":`, err.message);
      return {};
    }
  }

  async getAlbumImage(albumName: string, artistName: string, _: string | null | undefined, settings: ProviderSettings): Promise<string | undefined> {
    const apiKey = settings?.geniusApiKey;
    if (!apiKey) return undefined;

    try {
      const query = `${artistName} ${albumName}`;
      const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
      const searchData: any = await this.fetch(searchUrl, apiKey);
      
      const hits = searchData?.response?.hits;
      if (!hits || hits.length === 0) return undefined;

      const songHit = hits.find((h: any) => h.type === 'song');
      const imageUrl = songHit?.result?.song_art_image_url || songHit?.result?.header_image_url;
      
      if (imageUrl && !imageUrl.includes('default_cover_image.png')) {
        return imageUrl;
      }
    } catch (err: any) {
      console.warn(`[GeniusProvider] Album art fetch failed for "${albumName}":`, err.message);
    }
    return undefined;
  }

  async getLyrics(trackName: string, artistName: string, settings: ProviderSettings): Promise<LyricsData | undefined> {
    const apiKey = settings?.geniusApiKey;
    if (!apiKey) return undefined;

    try {
      const query = `${artistName} ${trackName}`;
      const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
      const searchData: any = await this.fetch(searchUrl, apiKey);
      
      const hits = searchData?.response?.hits;
      if (!hits || hits.length === 0) return undefined;

      const artistLower = artistName.toLowerCase();
      const titleLower = trackName.toLowerCase();
      
      const exactHit = hits.find((h: any) =>
        h.type === 'song' &&
        h.result?.primary_artist?.name?.toLowerCase().includes(artistLower) &&
        h.result?.title?.toLowerCase().includes(titleLower)
      );
      
      const songHit = exactHit || hits.find((h: any) => h.type === 'song');
      if (!songHit) return undefined;

      const song = songHit.result;
      const thumbnailUrl = song.song_art_image_thumbnail_url;
      
      return {
        songUrl: song.url,
        title: song.title || trackName,
        artist: song.primary_artist?.name || artistName,
        thumbnailUrl: thumbnailUrl?.includes('default_cover_image.png') ? undefined : thumbnailUrl,
      };
    } catch (err: any) {
      console.warn(`[GeniusProvider] Lyrics fetch failed for "${trackName}":`, err.message);
      return undefined;
    }
  }
}
