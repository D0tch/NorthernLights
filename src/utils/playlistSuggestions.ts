import type { TrackInfo } from './fileSystem';
import { parseArtists } from './artistUtils';

export interface PlaylistSuggestion {
  track: TrackInfo;
  score: number;
  reason: string;
}

function normalize(value: string | undefined | null): string {
  return (value || '').trim().toLowerCase();
}

function listFromValue(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((entry) => String(entry).trim()).filter(Boolean);
        }
      } catch {
        // Fall through to plain string handling.
      }
    }

    return trimmed
      .split(/\s*[,;/]\s*/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function getTrackArtists(track: TrackInfo): string[] {
  const artistList = listFromValue(track.artists);
  if (artistList.length > 0) return artistList;

  const parsedArtist = parseArtists(track.artist);
  if (parsedArtist.length > 0) return parsedArtist;

  return track.albumArtist ? [track.albumArtist] : [];
}

function getTrackGenres(track: TrackInfo): string[] {
  const genres = listFromValue(track.genres);
  if (genres.length > 0) return genres;
  return track.genre ? [track.genre] : [];
}

function formatSharedReason(sharedArtists: string[], sharedGenres: string[], sharedAlbum: string | undefined): string {
  if (sharedArtists.length > 0 && sharedGenres.length > 0) {
    return `Matches ${sharedArtists.slice(0, 2).join(', ')} and leans ${sharedGenres.slice(0, 2).join(' / ')}`;
  }

  if (sharedArtists.length > 0) {
    return `Shares ${sharedArtists.slice(0, 2).join(', ')}`;
  }

  if (sharedGenres.length > 0) {
    return `Fits the ${sharedGenres.slice(0, 2).join(' / ')} lane`;
  }

  if (sharedAlbum) {
    return `Neighboring cut from ${sharedAlbum}`;
  }

  return 'Close metadata fit';
}

export function getSuggestedPlaylistTracks(
  library: TrackInfo[],
  playlistTracks: TrackInfo[],
  limit: number = 10
): PlaylistSuggestion[] {
  if (playlistTracks.length === 0) return [];

  const playlistTrackIds = new Set(playlistTracks.map((track) => track.id));
  const playlistArtists = new Map<string, number>();
  const playlistGenres = new Map<string, number>();
  const playlistAlbums = new Map<string, number>();
  const playlistAlbumArtists = new Map<string, number>();

  for (const track of playlistTracks) {
    for (const artist of getTrackArtists(track)) {
      const key = normalize(artist);
      if (!key) continue;
      playlistArtists.set(key, (playlistArtists.get(key) || 0) + 1);
    }

    for (const genre of getTrackGenres(track)) {
      const key = normalize(genre);
      if (!key) continue;
      playlistGenres.set(key, (playlistGenres.get(key) || 0) + 1);
    }

    const albumKey = normalize(track.album);
    if (albumKey) playlistAlbums.set(albumKey, (playlistAlbums.get(albumKey) || 0) + 1);

    const albumArtistKey = normalize(track.albumArtist);
    if (albumArtistKey) playlistAlbumArtists.set(albumArtistKey, (playlistAlbumArtists.get(albumArtistKey) || 0) + 1);
  }

  const candidates = library
    .filter((track) => !playlistTrackIds.has(track.id))
    .map((track) => {
      const sharedArtists = getTrackArtists(track).filter((artist) => playlistArtists.has(normalize(artist)));
      const sharedGenres = getTrackGenres(track).filter((genre) => playlistGenres.has(normalize(genre)));
      const sharedAlbum = track.album && playlistAlbums.has(normalize(track.album)) ? track.album : undefined;
      const albumArtistBonus = track.albumArtist ? (playlistAlbumArtists.get(normalize(track.albumArtist)) || 0) : 0;

      let score = 0;

      for (const artist of sharedArtists) {
        score += 3.5 + (playlistArtists.get(normalize(artist)) || 0) * 0.35;
      }

      for (const genre of sharedGenres) {
        score += 2 + (playlistGenres.get(normalize(genre)) || 0) * 0.25;
      }

      if (sharedAlbum) {
        score += 3.25;
      }

      if (albumArtistBonus > 0) {
        score += 1.75 + albumArtistBonus * 0.2;
      }

      if (track.year && playlistTracks.some((playlistTrack) => playlistTrack.year && Math.abs((playlistTrack.year || 0) - track.year!) <= 2)) {
        score += 0.6;
      }

      if (track.artUrl) {
        score += 0.15;
      }

      return {
        track,
        score,
        reason: formatSharedReason(sharedArtists, sharedGenres, sharedAlbum),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.track.title || a.track.path).localeCompare(b.track.title || b.track.path, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    });

  const selected: PlaylistSuggestion[] = [];
  const primaryArtistCount = new Map<string, number>();

  for (const candidate of candidates) {
    const primaryArtist = normalize(getTrackArtists(candidate.track)[0]);
    if (primaryArtist && (primaryArtistCount.get(primaryArtist) || 0) >= 2 && selected.length < limit - 1) {
      continue;
    }

    if (primaryArtist) {
      primaryArtistCount.set(primaryArtist, (primaryArtistCount.get(primaryArtist) || 0) + 1);
    }

    selected.push(candidate);
    if (selected.length >= limit) break;
  }

  return selected;
}
