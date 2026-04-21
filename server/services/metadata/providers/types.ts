export interface ArtistData {
  imageUrl?: string;
  bio?: string;
  disambiguation?: string;
  area?: string;
  type?: string;
  lifeSpan?: { begin?: string; end?: string };
  links?: { url: string; type: string }[];
  genres?: string[];
}

export interface LyricsData {
  songUrl: string;
  title: string;
  artist: string;
  thumbnailUrl?: string;
}

export interface ProviderSettings {
  lastFmApiKey: string;
  geniusApiKey: string;
  musicBrainzEnabled: boolean;
  providerArtistImage: string;
  providerArtistBio: string;
  providerAlbumArt: string;
}

export interface MetadataProvider {
  /** Given an artist name (and optional MBID), return basic artist metadata. */
  getArtistInfo?(name: string, mbArtistId?: string | null, settings?: ProviderSettings): Promise<Partial<ArtistData>>;
  
  /** Given album and artist name (and optional MBID), return the cover art URL. */
  getAlbumImage?(albumName: string, artistName: string, mbAlbumId?: string | null, settings?: ProviderSettings): Promise<string | undefined>;
  
  /** Given a genre name, return a representative image. */
  getGenreImage?(genreName: string, settings?: ProviderSettings): Promise<string | undefined>;
  
  /** Given a genre name, return info summary. */
  getGenreInfo?(genreName: string, settings?: ProviderSettings): Promise<{ imageUrl?: string; summary?: string } | undefined>;
  
  /** Fetch lyrics or track URL. */
  getLyrics?(trackName: string, artistName: string, settings?: ProviderSettings): Promise<LyricsData | undefined>;
}
