import type { TrackInfo } from './fileSystem';
import type { ArtistInfo, AlbumInfo } from '../store/index';
import {
  ARTIST_FACETS,
  ALBUM_FACETS,
  applyFacetFilters,
  applyQueryResultFilter,
  applySort,
  deriveAlbumMetadata,
  type EnrichedAlbum,
  type FilterState,
} from './filterState';

// Library-wide derivations (whole-library passes: grouping tracks by album,
// enriching album metadata, extracting facet values) are expensive and were
// recomputed on every navigation into LibraryHome — `useMemo` caches are
// discarded when the route unmounts, so returning to /library/albums paid the
// full cost again even when nothing changed.
//
// These single-slot memos live at module scope, so they survive route
// unmount/remount. Keyed by argument reference (the `library` / `albums` /
// `artists` arrays from the store, which only change identity on a scan or
// edit), a repeat navigation is an O(1) reference check instead of two full
// library passes. The first computation per data version still runs; every
// subsequent visit until the next library change is free.

function singleSlotMemo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null;
  let lastResult: R;
  return (...args: A): R => {
    if (
      lastArgs !== null &&
      lastArgs.length === args.length &&
      lastArgs.every((arg, i) => Object.is(arg, args[i]))
    ) {
      return lastResult;
    }
    lastResult = fn(...args);
    lastArgs = args;
    return lastResult;
  };
}

export interface TracksByAlbumResult {
  genres: string[];
  tracksByAlbum: Map<string, TrackInfo[]>;
}

// Group library tracks by `album::::artist` (collapsing per-album artist into a
// single name, or "Various Artists" when ambiguous) and collect the genre set.
// Extracted verbatim from LibraryHome's former inline useMemo.
export const getTracksByAlbumAndGenres = singleSlotMemo((library: TrackInfo[]): TracksByAlbumResult => {
  const albumGroups = new Map<string, TrackInfo[]>();
  const genreSet = new Set<string>();

  library.forEach((track) => {
    if (track.album) {
      const group = albumGroups.get(track.album) || [];
      group.push(track);
      albumGroups.set(track.album, group);
    }
    if ((track as any).genre) {
      genreSet.add((track as any).genre);
    }
  });

  const tracksByAlbum = new Map<string, TrackInfo[]>();

  for (const [albumTitle, tracks] of albumGroups.entries()) {
    const subAlbums = new Map<string, TrackInfo[]>();
    tracks.forEach((track) => {
      const explicitAA = track.albumArtist || '';
      const subGroup = subAlbums.get(explicitAA) || [];
      subGroup.push(track);
      subAlbums.set(explicitAA, subGroup);
    });

    for (const [explicitAA, subTracks] of subAlbums.entries()) {
      const artistName = explicitAA !== ''
        ? explicitAA
        : (() => {
            const uniqueArtists = new Set(subTracks.map((t) => t.artist || 'Unknown Artist'));
            return uniqueArtists.size === 1 ? Array.from(uniqueArtists)[0] : 'Various Artists';
          })();
      const albumKey = `${albumTitle}::::${artistName}`;
      const sortedTracks = [...subTracks].sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));
      tracksByAlbum.set(albumKey, sortedTracks);
    }
  }

  return {
    genres: Array.from(genreSet).sort(),
    tracksByAlbum,
  };
});

export const getEnrichedAlbums = singleSlotMemo(
  (albums: AlbumInfo[], tracks: TrackInfo[]): EnrichedAlbum[] => deriveAlbumMetadata(albums, tracks)
);

export const getArtistFacetValues = singleSlotMemo(
  (artists: ArtistInfo[]) => ARTIST_FACETS.map((f) => f.extractValues(artists))
);

export const getAlbumFacetValues = singleSlotMemo(
  (albums: EnrichedAlbum[]) => ALBUM_FACETS.map((f) => f.extractValues(albums))
);

// Facet-filter + query-filter + sort pipelines. These lived as in-component
// `useMemo`s, which are discarded on unmount, so navigating into the artists or
// albums tab re-ran the full filter+sort pass every time even when neither the
// entities nor the filters had changed. Module-scope single-slot memos (keyed
// by entity-array + filter-object identity — both stable until a scan/edit or a
// filter change) make a repeat navigation an O(1) reference check.
export const getFilteredArtists = singleSlotMemo(
  (artists: ArtistInfo[], filters: FilterState): ArtistInfo[] => {
    let result = applyFacetFilters(artists, filters.facets, ARTIST_FACETS);
    if (filters.queryResultIds) result = applyQueryResultFilter(result, filters.queryResultIds);
    return applySort(result, filters.sort, filters.sortDirection, 'name');
  }
);

export const getFilteredAlbums = singleSlotMemo(
  (albums: EnrichedAlbum[], filters: FilterState): EnrichedAlbum[] => {
    let result = applyFacetFilters(albums, filters.facets, ALBUM_FACETS);
    if (filters.queryResultIds) result = applyQueryResultFilter(result, filters.queryResultIds);
    return applySort(result, filters.sort, filters.sortDirection, 'title');
  }
);
