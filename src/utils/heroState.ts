// Minimal hero placeholder data passed via React Router `Link state` so detail
// routes can paint their hero immediately on navigation, before store data
// hydrates or fetches complete.
//
// All fields are optional from the consumer's perspective: state may be absent
// (deep link, refresh) and the detail view must still render correctly.

export interface PlaylistHeroState {
  kind: 'playlist';
  title?: string;
  description?: string;
  trackCount?: number;
  artUrls?: string[];
  isLlmGenerated?: boolean;
  isSystem?: boolean;
  pinned?: boolean;
  backLabel?: string;
}

export interface AlbumHeroState {
  kind: 'album';
  title?: string;
  artist?: string;
  artUrl?: string;
  subtitle?: string;
  backLabel?: string;
}

export interface ArtistHeroState {
  kind: 'artist';
  name?: string;
  imageUrl?: string;
  backLabel?: string;
}

type AnyHeroState = PlaylistHeroState | AlbumHeroState | ArtistHeroState;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const matches = <T extends AnyHeroState>(value: unknown, kind: T['kind']): value is T =>
  isObject(value) && (value as { kind?: unknown }).kind === kind;

export const readPlaylistHeroState = (state: unknown): PlaylistHeroState | undefined =>
  matches<PlaylistHeroState>(state, 'playlist') ? state : undefined;

export const readAlbumHeroState = (state: unknown): AlbumHeroState | undefined =>
  matches<AlbumHeroState>(state, 'album') ? state : undefined;

export const readArtistHeroState = (state: unknown): ArtistHeroState | undefined =>
  matches<ArtistHeroState>(state, 'artist') ? state : undefined;

// Legacy callers used `{ backLabel: '...' }` without a kind field. Fall back to
// extracting just backLabel from any shape so existing back-button behaviour
// keeps working while we migrate.
export const readBackLabel = (state: unknown): string | undefined => {
  if (!isObject(state)) return undefined;
  const label = state.backLabel;
  return typeof label === 'string' ? label : undefined;
};
