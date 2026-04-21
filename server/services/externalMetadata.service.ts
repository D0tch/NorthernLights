import { getSystemSetting } from '../database';
import { MetadataCache } from './metadata/MetadataCache';
import { LastFmProvider } from './metadata/providers/lastfm.provider';
import { GeniusProvider } from './metadata/providers/genius.provider';
import { MusicBrainzProvider } from './metadata/providers/musicbrainz.provider';
import { ProviderSettings, ArtistData, LyricsData, MetadataProvider } from './metadata/providers/types';
import { fetchWithRetry } from './metadata/providers/utils';

// Instantiate distinct, rate-limited providers
const _providers: Record<string, MetadataProvider> = {
  lastfm: new LastFmProvider(),
  genius: new GeniusProvider(),
  musicbrainz: new MusicBrainzProvider(),
};

async function getProviderSettings(): Promise<ProviderSettings> {
  return {
    lastFmApiKey: (await getSystemSetting('lastFmApiKey')) || '',
    geniusApiKey: (await getSystemSetting('geniusApiKey')) || '',
    musicBrainzEnabled: (await getSystemSetting('musicBrainzEnabled')) === true || (await getSystemSetting('musicBrainzEnabled')) === 'true',
    providerArtistImage: (await getSystemSetting('providerArtistImage')) || 'lastfm',
    providerArtistBio: (await getSystemSetting('providerArtistBio')) || 'lastfm',
    providerAlbumArt: (await getSystemSetting('providerAlbumArt')) || 'lastfm',
  };
}

/**
 * Determine the ordered list of providers to try based on user preference and key availability.
 */
function buildFetchPriority(preferredProvider: string, settings: ProviderSettings, requireKeyForGenius = true): MetadataProvider[] {
  const result: MetadataProvider[] = [];
  const seen = new Set<string>();

  const push = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      result.push(_providers[key]);
    }
  };

  // Add preferred if it has keys assigned
  if (preferredProvider === 'genius' && (!requireKeyForGenius || settings.geniusApiKey)) push('genius');
  if (preferredProvider === 'lastfm' && settings.lastFmApiKey) push('lastfm');
  if (preferredProvider === 'musicbrainz' && settings.musicBrainzEnabled) push('musicbrainz');

  // Fallbacks
  if (settings.lastFmApiKey) push('lastfm');
  if (!requireKeyForGenius || settings.geniusApiKey) push('genius');
  if (settings.musicBrainzEnabled) push('musicbrainz');

  return result;
}

// ─── Public API ─────────────────────────────────────────────────────

export async function getArtistData(name: string, mbArtistId?: string | null): Promise<ArtistData> {
  if (!name) return {};

  const settings = await getProviderSettings();
  const cached = await MetadataCache.getCachedArtist(name);

  // Return fresh cache immediately
  if (cached && MetadataCache.isCacheFresh(cached.last_updated)) {
    if (cached.image_url || cached.bio) {
      return {
        imageUrl: cached.image_url || undefined,
        bio: cached.bio || undefined,
      };
    }
  }

  const data: ArtistData = {};

  // 1. MusicBrainz structural data first (if enabled and we have MBID)
  if (settings.musicBrainzEnabled && (mbArtistId || cached?.mbid)) {
    const structuralData = await _providers.musicbrainz.getArtistInfo!(name, mbArtistId || cached?.mbid, settings);
    Object.assign(data, structuralData);
  }

  // 2. Resolve Imagery
  const imgProviders = buildFetchPriority(settings.providerArtistImage, settings);
  for (const provider of imgProviders) {
    if (!provider.getArtistInfo) continue;
    const partial = await provider.getArtistInfo(name, mbArtistId || cached?.mbid, settings);
    if (partial.imageUrl) {
      data.imageUrl = partial.imageUrl;
      break;
    }
  }

  // 3. Resolve Biology
  const bioProviders = buildFetchPriority(settings.providerArtistBio, settings);
  for (const provider of bioProviders) {
    if (!provider.getArtistInfo) continue;
    const partial = await provider.getArtistInfo(name, mbArtistId || cached?.mbid, settings);
    if (partial.bio) {
      data.bio = partial.bio;
      break;
    }
  }

  // Always cache our best attempt (even if null) to prevent hammering
  await MetadataCache.upsertArtistCache(name, data.imageUrl || null, data.bio || null, mbArtistId || cached?.mbid || null);

  return data;
}

export async function getAlbumImage(albumName: string, artistName: string, mbAlbumId?: string | null): Promise<string | undefined> {
  if (!albumName || !artistName) return undefined;

  const settings = await getProviderSettings();
  const cached = await MetadataCache.getCachedAlbum(albumName, artistName);

  if (cached && MetadataCache.isCacheFresh(cached.last_updated) && cached.image_url) {
    return cached.image_url;
  }

  const artProviders = buildFetchPriority(settings.providerAlbumArt, settings);
  let resolvedUrl: string | undefined = undefined;

  for (const provider of artProviders) {
    if (!provider.getAlbumImage) continue;
    resolvedUrl = await provider.getAlbumImage(albumName, artistName, mbAlbumId || cached?.mbid, settings);
    if (resolvedUrl) break;
  }

  // Cache hit or miss
  await MetadataCache.upsertAlbumCache(albumName, artistName, resolvedUrl || null, mbAlbumId || cached?.mbid || null);
  
  return resolvedUrl;
}

export async function getGenreImage(genreName: string): Promise<string | undefined> {
  if (!genreName) return undefined;

  const cached = await MetadataCache.getCachedGenre(genreName);
  if (cached && MetadataCache.isCacheFresh(cached.last_updated) && cached.image_url) {
    return cached.image_url;
  }

  const settings = await getProviderSettings();
  
  // Genres primarily rely on LastFM directly
  const imageUrl = await _providers.lastfm.getGenreImage!(genreName, settings);
  
  if (imageUrl || cached) {
    await MetadataCache.upsertGenreCache(genreName, imageUrl || cached?.image_url || null, cached?.description || null);
  }

  return imageUrl || undefined;
}

export async function getGenreInfo(genreName: string): Promise<{ imageUrl?: string; summary?: string } | undefined> {
  if (!genreName) return undefined;

  const cached = await MetadataCache.getCachedGenre(genreName);
  if (cached && MetadataCache.isCacheFresh(cached.last_updated) && (cached.description || cached.image_url)) {
    return {
      imageUrl: cached.image_url || undefined,
      summary: cached.description || undefined,
    };
  }

  const settings = await getProviderSettings();
  const info = await _providers.lastfm.getGenreInfo!(genreName, settings);

  if (info?.summary || cached) {
    await MetadataCache.upsertGenreCache(genreName, cached?.image_url || null, info?.summary || null);
  }

  return info;
}

export async function getLyrics(trackName: string, artistName: string): Promise<LyricsData | undefined> {
  if (!trackName || !artistName) return undefined;
  
  const settings = await getProviderSettings();
  return _providers.genius.getLyrics!(trackName, artistName, settings);
}

export async function testLastFm(providedApiKey?: string, providedSecret?: string): Promise<{ status: string; error?: string; username?: string }> {
  try {
    const settings = await getProviderSettings();
    const apiKey = providedApiKey || settings.lastFmApiKey;
    const sharedSecret = providedSecret || (await getSystemSetting('lastFmSharedSecret')) || '';
    
    if (!apiKey) return { status: 'error', error: 'No API key configured' };
    if (!sharedSecret) return { status: 'error', error: 'No Shared Secret configured' };

    // Use utils manually for the test bypass to avoid bottleneck queue
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=Radiohead&api_key=${encodeURIComponent(apiKey.trim())}&format=json`;
    const res = await fetchWithRetry(url);
    
    // Safely parse JSON to avoid crashing on HTML error pages
    const rawText = await res.text();
    let json;
    try {
        json = JSON.parse(rawText);
    } catch (parseErr) {
        return { status: 'error', error: `Invalid response format (HTTP ${res.status}): ${rawText.substring(0, 100)}` };
    }

    if (json.error) {
      return { status: 'error', error: json.message || `API error ${json.error}` };
    }
    if (json.artist) {
      return { status: 'ok' };
    }
    return { status: 'error', error: 'Unexpected response' };
  } catch (err: any) {
    return { status: 'error', error: err.message || 'Network error' };
  }
}

export async function clearExternalCache(): Promise<void> {
  return MetadataCache.clearAllCaches();
}
