import Bottleneck from 'bottleneck';
import { MetadataProvider, ArtistData, ProviderSettings } from './types';
import { fetchWithRetry } from './utils';
import { mbFetch } from '../../musicbrainz.service'; // Leverage existing properly queued/authenticated MB service

export class MusicBrainzProvider implements MetadataProvider {
  // CoverArtArchive allows roughly 10 requests per second. 
  // We keep it separate from the main MB queue.
  private caaLimiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 100, // 10 per sec
  });

  private extractMbLinks(relations: any[]): { url: string; type: string }[] {
    if (!Array.isArray(relations)) return [];
    return relations
      .filter((r: any) => r.target_type === 'url' && r.url?.resource)
      .map((r: any) => ({
        url: r.url.resource,
        type: r.type || 'other'
      }));
  }

  async getArtistInfo(_: string, mbArtistId?: string | null, settings?: ProviderSettings): Promise<Partial<ArtistData>> {
    if (!settings?.musicBrainzEnabled || !mbArtistId) return {};

    try {
      const url = `https://musicbrainz.org/ws/2/artist/${mbArtistId}?inc=url-rels+tags+genres+ratings&fmt=json`;
      const mbArtist = await mbFetch(url); // mbFetch handles its own 1-sec queue and error throwing
      
      if (!mbArtist) return {};

      const result: Partial<ArtistData> = {};
      
      if (mbArtist.disambiguation) result.disambiguation = mbArtist.disambiguation;
      if (mbArtist.area?.name) result.area = mbArtist.area.name;
      if (mbArtist.type) result.type = mbArtist.type;
      
      if (mbArtist['life-span']) {
        result.lifeSpan = {
          begin: mbArtist['life-span'].begin || undefined,
          end: mbArtist['life-span'].ended ? mbArtist['life-span'].end || undefined : undefined
        };
      }
      
      result.links = this.extractMbLinks(mbArtist.relations);
      
      if (Array.isArray(mbArtist.genres) && mbArtist.genres.length > 0) {
        result.genres = mbArtist.genres.map((g: any) => g.name);
      }

      return result;
    } catch (err: any) {
      console.warn(`[MusicBrainzProvider] Artist info fetch failed for MBID "${mbArtistId}":`, err.message);
      return {};
    }
  }

  async getAlbumImage(albumName: string, artistName: string, mbAlbumId?: string | null, settings?: ProviderSettings): Promise<string | undefined> {
    if (!settings?.musicBrainzEnabled) return undefined;

    try {
      // 1. Try directly via MBID if provided
      if (mbAlbumId) {
        const coverUrl = `https://coverartarchive.org/release/${mbAlbumId}/front-500`;
        const res = await this.caaLimiter.schedule(() => fetchWithRetry(coverUrl, { method: 'HEAD' }));
        if (res.ok) return coverUrl;
      }

      // 2. Try text search if MusicBrainz is the preferred album art provider
      if (settings?.providerAlbumArt === 'musicbrainz' && !mbAlbumId) {
        const searchQuery = `${artistName} ${albumName}`;
        const searchUrl = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(searchQuery)}&limit=5&fmt=json`;
        
        const mbResult = await mbFetch(searchUrl);
        const hits = mbResult?.['release-groups'];
        
        if (hits && hits.length > 0) {
          const match = hits.find((h: any) =>
            h.title?.toLowerCase() === albumName.toLowerCase() &&
            h['artist-credit']?.some((ac: any) => ac.name?.toLowerCase() === artistName.toLowerCase())
          ) || hits[0];
          
          if (match?.id) {
            const rgUrl = `https://musicbrainz.org/ws/2/release-group/${match.id}?inc=releases&fmt=json`;
            const rgJson = await mbFetch(rgUrl);
            
            const releases = rgJson.releases || [];
            for (const release of releases.slice(0, 3)) {
              try {
                const coverUrl = `https://coverartarchive.org/release/${release.id}/front-500`;
                const headRes = await this.caaLimiter.schedule(() => fetchWithRetry(coverUrl, { method: 'HEAD' }));
                if (headRes.ok) return coverUrl;
              } catch {
                // Ignore specific CAA failures
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[MusicBrainzProvider] Album image fetch failed for "${albumName}":`, err.message);
    }
    
    return undefined;
  }
}
