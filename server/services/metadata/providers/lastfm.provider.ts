import Bottleneck from 'bottleneck';
import { MetadataProvider, ArtistData, ProviderSettings } from './types';
import { cleanHtml, fetchWithRetry } from './utils';

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

export class ProviderError extends Error {
  constructor(message: string, public provider: string, public statusCode?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class LastFmProvider implements MetadataProvider {
  // Last.fm allows 5 requests per second
  private limiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 200,
  });

  private extractImage(images: any[]): string | undefined {
    if (!Array.isArray(images)) return undefined;
    const largeImg = images.find((i: any) => i.size === 'mega' || i.size === 'extralarge' || i.size === 'large');
    if (largeImg && largeImg['#text'] && !largeImg['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) {
      return largeImg['#text'];
    }
    return undefined;
  }

  private async fetch<T>(url: string): Promise<T> {
    try {
      const res = await this.limiter.schedule(() => fetchWithRetry(url));
      if (!res.ok) {
        throw new ProviderError(`LastFM HTTP ${res.status}`, 'lastfm', res.status);
      }
      const json = await res.json();
      if (json.error) {
        // Last.fm rate limit error code is 29
        if (json.error === 29) {
          throw new ProviderError('Rate Limited', 'lastfm', 429);
        }
        throw new ProviderError(`API Error: ${json.message}`, 'lastfm');
      }
      return json as T;
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`fetch failed: ${err.message}`, 'lastfm');
    }
  }

  async getArtistInfo(name: string, _: string | null | undefined, settings: ProviderSettings): Promise<Partial<ArtistData>> {
    const apiKey = settings?.lastFmApiKey;
    if (!apiKey) return {};
    
    try {
      const url = `${LASTFM_API}?method=artist.getinfo&artist=${encodeURIComponent(name)}&api_key=${apiKey}&format=json`;
      const data: any = await this.fetch(url);
      
      const artist = data?.artist;
      if (!artist) return {};

      const result: Partial<ArtistData> = {};
      
      if (artist.bio?.summary) {
        result.bio = cleanHtml(artist.bio.summary.split('<a href')[0].trim());
      }
      
      if (artist.image) {
        result.imageUrl = this.extractImage(artist.image);
      }
      
      return result;
    } catch (err: any) {
      console.warn(`[LastFmProvider] Artist info fetch failed for "${name}":`, err.message);
      return {}; // Fail silently gracefully to allow manager to fallback
    }
  }

  async getAlbumImage(albumName: string, artistName: string, _: string | null | undefined, settings: ProviderSettings): Promise<string | undefined> {
    const apiKey = settings?.lastFmApiKey;
    if (!apiKey) return undefined;

    try {
      const url = `${LASTFM_API}?method=album.getinfo&api_key=${apiKey}&artist=${encodeURIComponent(artistName)}&album=${encodeURIComponent(albumName)}&format=json`;
      const data: any = await this.fetch(url);
      
      if (data?.album?.image) {
        return this.extractImage(data.album.image);
      }
    } catch (err: any) {
      console.warn(`[LastFmProvider] Album info fetch failed for "${albumName}":`, err.message);
    }
    return undefined;
  }

  async getGenreImage(genreName: string, settings: ProviderSettings): Promise<string | undefined> {
    const apiKey = settings?.lastFmApiKey;
    if (!apiKey) return undefined;

    try {
      const url = `${LASTFM_API}?method=tag.gettopalbums&tag=${encodeURIComponent(genreName)}&api_key=${apiKey}&format=json&limit=1`;
      const data: any = await this.fetch(url);
      
      if (data?.albums?.album && data.albums.album.length > 0) {
        return this.extractImage(data.albums.album[0].image);
      }
    } catch (err: any) {
      console.warn(`[LastFmProvider] Genre top albums fetch failed for "${genreName}":`, err.message);
    }
    return undefined;
  }

  async getGenreInfo(genreName: string, settings: ProviderSettings): Promise<{ imageUrl?: string; summary?: string } | undefined> {
    const apiKey = settings?.lastFmApiKey;
    if (!apiKey) return undefined;

    try {
      const url = `${LASTFM_API}?method=tag.getinfo&tag=${encodeURIComponent(genreName)}&api_key=${apiKey}&format=json`;
      const data: any = await this.fetch(url);
      
      if (data?.tag?.wiki?.summary) {
        const summary = cleanHtml(data.tag.wiki.summary.split('<a href')[0].trim());
        return { summary: summary.length > 0 ? summary : undefined };
      }
    } catch (err: any) {
      console.warn(`[LastFmProvider] Genre info fetch failed for "${genreName}":`, err.message);
    }
    return undefined;
  }
}
