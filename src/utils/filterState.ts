import type { TrackInfo } from './fileSystem';
import type { ArtistInfo, AlbumInfo } from '../store/index';
import {
  Music,
  Users,
  Globe,
  Calendar,
  Disc,
  Tag,
  Image,
  Headphones,
  ListMusic,
} from 'lucide-react';
import React from 'react';

export type SortOption = 'name' | 'recentlyAdded' | 'year';
export type SortDirection = 'asc' | 'desc';

/** Natural direction for each sort key. Picking a sort resets to this. */
export const DEFAULT_SORT_DIRECTION: Record<SortOption, SortDirection> = {
  name: 'asc',
  recentlyAdded: 'desc',
  year: 'desc',
};

export interface FacetSelection {
  [facetKey: string]: string[];
}

export interface QueryCondition {
  metadataType: string;
  operator: string;
  value: string;
}

export interface QueryGroup {
  id: string;
  conditions: QueryCondition[];
}

export interface FilterState {
  facets: FacetSelection;
  sort: SortOption;
  sortDirection: SortDirection;
  queryGroups: QueryGroup[] | null;
  queryResultIds: string[] | null;
}

export const EMPTY_FILTER_STATE: FilterState = {
  facets: {},
  sort: 'name',
  sortDirection: DEFAULT_SORT_DIRECTION.name,
  queryGroups: null,
  queryResultIds: null,
};

export interface FacetDefinition<T = Record<string, any>> {
  key: string;
  label: string;
  icon: React.FC<any>;
  extractValues: (items: T[]) => { value: string; count: number }[];
  filterItem: (item: T, selectedValues: string[]) => boolean;
}

function countValues(values: string[]): { value: string; count: number }[] {
  const map = new Map<string, number>();
  values.forEach(v => { if (v) map.set(v, (map.get(v) || 0) + 1); });
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Parse a list field that may arrive as a JSON array (of strings or of
 * `{name}` objects, depending on the metadata provider) or as a legacy
 * CSV string. Returns a deduplicated, trimmed list of names.
 */
function parseListField(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map(v => (typeof v === 'string' ? v : (v as any)?.name ?? ''))
      .map(s => String(s).trim())
      .filter(Boolean);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map(item =>
            typeof item === 'string'
              ? item
              : item && typeof item === 'object' && typeof item.name === 'string'
                ? item.name
                : ''
          )
          .map(s => s.trim())
          .filter(Boolean);
      }
    } catch {
      /* fall through to CSV */
    }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

const splitAndNormalize = parseListField;

function deriveDecade(yearStr: string | number | undefined | null): string | null {
  if (yearStr == null) return null;
  const year = typeof yearStr === 'string' ? parseInt(yearStr, 10) : yearStr;
  if (!Number.isFinite(year) || year < 1900) return null;
  const decade = Math.floor(year / 10) * 10;
  return `${decade}s`;
}

export const ARTIST_FACETS: FacetDefinition<ArtistInfo>[] = [
  {
    key: 'genre',
    label: 'Genre',
    icon: Music,
    extractValues: (artists) => {
      const all: string[] = [];
      artists.forEach(a => {
        splitAndNormalize(a.genres).forEach(g => all.push(g));
        if (a.community_tags) splitAndNormalize(a.community_tags).forEach(t => all.push(t));
      });
      return countValues(all);
    },
    filterItem: (artist, selected) => {
      if (selected.length === 0) return true;
      const itemGenres = [...splitAndNormalize(artist.genres), ...splitAndNormalize(artist.community_tags)];
      return selected.some(s => itemGenres.some(g => g.toLowerCase() === s.toLowerCase()));
    },
  },
  {
    key: 'type',
    label: 'Type',
    icon: Users,
    extractValues: (artists) =>
      countValues(artists.map(a => a.artist_type || '').filter(Boolean)),
    filterItem: (artist, selected) => {
      if (selected.length === 0) return true;
      return selected.includes(artist.artist_type || '');
    },
  },
  {
    key: 'country',
    label: 'Country',
    icon: Globe,
    extractValues: (artists) =>
      countValues(artists.map(a => a.area || '').filter(Boolean)),
    filterItem: (artist, selected) => {
      if (selected.length === 0) return true;
      return selected.includes(artist.area || '');
    },
  },
  {
    key: 'decade',
    label: 'Decade',
    icon: Calendar,
    extractValues: (artists) =>
      countValues(artists.map(a => deriveDecade(a.lifespan_begin)).filter(Boolean) as string[]),
    filterItem: (artist, selected) => {
      if (selected.length === 0) return true;
      const d = deriveDecade(artist.lifespan_begin);
      return d ? selected.includes(d) : false;
    },
  },
];

/** Enriched album type with derived metadata fields attached by deriveAlbumMetadata */
export interface EnrichedAlbum extends AlbumInfo {
  _derivedGenres?: string;
  _derivedReleaseType?: string;
  _derivedYear?: number | null;
  _trackCount?: number;
}

export const ALBUM_FACETS: FacetDefinition<EnrichedAlbum>[] = [
  {
    key: 'genre',
    label: 'Genre',
    icon: Music,
    extractValues: (albums) => {
      const all: string[] = [];
      albums.forEach(a => {
        splitAndNormalize(a._derivedGenres).forEach(g => all.push(g));
        splitAndNormalize(a.tags).forEach(t => all.push(t));
      });
      return countValues(all);
    },
    filterItem: (album, selected) => {
      if (selected.length === 0) return true;
      const itemGenres = [...splitAndNormalize(album._derivedGenres), ...splitAndNormalize(album.tags)];
      return selected.some(s => itemGenres.some(g => g.toLowerCase() === s.toLowerCase()));
    },
  },
  {
    key: 'type',
    label: 'Type',
    icon: Disc,
    extractValues: (albums) =>
      countValues(albums.map(a => a._derivedReleaseType || 'Album').filter(Boolean)),
    filterItem: (album, selected) => {
      if (selected.length === 0) return true;
      const t = album._derivedReleaseType || 'Album';
      return selected.includes(t);
    },
  },
  {
    key: 'decade',
    label: 'Decade',
    icon: Calendar,
    extractValues: (albums) =>
      countValues(albums.map(a => deriveDecade(a._derivedYear)).filter(Boolean) as string[]),
    filterItem: (album, selected) => {
      if (selected.length === 0) return true;
      const d = deriveDecade(album._derivedYear);
      return d ? selected.includes(d) : false;
    },
  },
  {
    key: 'artist',
    label: 'Artist',
    icon: Users,
    extractValues: (albums) =>
      countValues(albums.map(a => a.artist_name || '').filter(Boolean)),
    filterItem: (album, selected) => {
      if (selected.length === 0) return true;
      return selected.some(s => (album.artist_name || '').toLowerCase() === s.toLowerCase());
    },
  },
];

export function applyFacetFilters<T extends Record<string, any>>(
  items: T[],
  facets: FacetSelection,
  facetDefs: FacetDefinition<T>[],
): T[] {
  let result = items;
  for (const def of facetDefs) {
    const selected = facets[def.key];
    if (!selected || selected.length === 0) continue;
    result = result.filter(item => def.filterItem(item, selected));
  }
  return result;
}

export function applyQueryResultFilter<T extends { id: string }>(
  items: T[],
  queryResultIds: string[] | null,
): T[] {
  if (!queryResultIds) return items;
  const idSet = new Set(queryResultIds);
  return items.filter(item => idSet.has(item.id));
}

/**
 * Sort items by the given option.
 *
 * Pre-computes all sort keys in a single O(N) pass to avoid
 * repeated Date parsing / parseInt inside the O(N log N) comparator.
 */
export function applySort<T extends Record<string, any>>(
  items: T[],
  sort: SortOption,
  direction: SortDirection = DEFAULT_SORT_DIRECTION[sort],
  nameKey: string = 'name',
): T[] {
  const sorted = [...items];
  // Each case sorts in its natural direction; flip at the end if needed.
  switch (sort) {
    case 'name':
      sorted.sort((a, b) => (a[nameKey] || '').localeCompare(b[nameKey] || ''));
      break;

    case 'recentlyAdded': {
      const timeMap = new Map<T, number>();
      for (const item of sorted) {
        timeMap.set(item, item.created_at ? new Date(item.created_at).getTime() : 0);
      }
      sorted.sort((a, b) => timeMap.get(b)! - timeMap.get(a)!);
      break;
    }

    case 'year': {
      const yearMap = new Map<T, number>();
      for (const item of sorted) {
        const raw = item._derivedYear || item.lifespan_begin;
        yearMap.set(item, raw ? parseInt(String(raw), 10) || 0 : 0);
      }
      sorted.sort((a, b) => yearMap.get(b)! - yearMap.get(a)!);
      break;
    }
  }

  if (direction !== DEFAULT_SORT_DIRECTION[sort]) {
    sorted.reverse();
  }

  return sorted;
}

export function hasActiveFilters(state: FilterState): boolean {
  const hasFacets = Object.values(state.facets).some(v => v.length > 0);
  const hasQuery = state.queryGroups !== null && state.queryGroups.length > 0;
  const hasNonDefaultSort = state.sort !== 'name';
  const hasNonDefaultDirection = state.sortDirection !== DEFAULT_SORT_DIRECTION[state.sort];
  return hasFacets || hasQuery || hasNonDefaultSort || hasNonDefaultDirection;
}

export function deriveAlbumMetadata(albums: AlbumInfo[], tracks: TrackInfo[]): EnrichedAlbum[] {
  const tracksByAlbum = new Map<string, TrackInfo[]>();
  tracks.forEach(t => {
    const key = `${t.album}::::${t.albumArtist || t.artist || ''}`;
    const list = tracksByAlbum.get(key) || [];
    list.push(t);
    tracksByAlbum.set(key, list);
  });

  return albums.map((album) => {
    const key = `${album.title}::::${album.artist_name || ''}`;
    const albumTracks = tracksByAlbum.get(key) || [];
    const genres = new Set<string>();
    const releaseTypes = new Set<string>();
    let earliestYear: number | null = null;

    albumTracks.forEach(t => {
      if (t.genre) genres.add(t.genre);
      if (t.genres) {
        parseListField(t.genres as any).forEach(g => genres.add(g));
      }
      if (t.releaseType) releaseTypes.add(t.releaseType);
      if (t.year) {
        const y = typeof t.year === 'number' ? t.year : parseInt(t.year, 10);
        if (Number.isFinite(y) && (earliestYear === null || y < earliestYear)) earliestYear = y;
      }
    });

    return {
      ...album,
      _derivedGenres: Array.from(genres).join(','),
      _derivedReleaseType: releaseTypes.size === 1 ? Array.from(releaseTypes)[0] : (releaseTypes.size > 1 ? 'Various' : 'Album'),
      _derivedYear: earliestYear,
      _trackCount: albumTracks.length,
    };
  });
}

export const ARTIST_QUERY_METADATA_TYPES = [
  { key: 'genre', label: 'Genre', icon: Music, operators: ['contains', 'equals'] },
  { key: 'artist_type', label: 'Type', icon: Users, operators: ['equals'] },
  { key: 'area', label: 'Country', icon: Globe, operators: ['contains', 'equals'] },
  { key: 'lifespan_begin', label: 'Decade', icon: Calendar, operators: ['equals', 'before', 'after'] },
  { key: 'community_tags', label: 'Community tags', icon: Tag, operators: ['contains'] },
  { key: 'image_url', label: 'Has image', icon: Image, operators: ['is', 'is not'] },
  { key: 'listeners', label: 'Listeners', icon: Headphones, operators: ['greater than', 'less than', 'equals'] },
  { key: 'name', label: 'Name', icon: ListMusic, operators: ['contains', 'equals', 'starts with'] },
];

export const ALBUM_QUERY_METADATA_TYPES = [
  { key: 'genre', label: 'Genre', icon: Music, operators: ['contains', 'equals'] },
  { key: 'release_type', label: 'Type', icon: Disc, operators: ['equals'] },
  { key: 'year', label: 'Decade', icon: Calendar, operators: ['equals', 'before', 'after'] },
  { key: 'artist_name', label: 'Artist', icon: Users, operators: ['contains', 'equals'] },
  { key: 'tags', label: 'Tags', icon: Tag, operators: ['contains'] },
  { key: 'image_url', label: 'Has image', icon: Image, operators: ['is', 'is not'] },
  { key: 'listeners', label: 'Listeners', icon: Headphones, operators: ['greater than', 'less than', 'equals'] },
  { key: 'title', label: 'Title', icon: ListMusic, operators: ['contains', 'equals', 'starts with'] },
];

let _groupIdCounter = 0;
export function createGroupId(): string {
  return `group_${++_groupIdCounter}_${Date.now()}`;
}
