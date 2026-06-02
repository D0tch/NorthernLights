import { create, StateCreator } from 'zustand';
import { persist, PersistOptions } from 'zustand/middleware';
import type { TrackInfo } from '../utils/fileSystem';
import { EMPTY_FILTER_STATE } from '../utils/filterState';
import { extractMetadata } from '../utils/fileSystem';
import { playbackManager, PlaybackState } from '../utils/PlaybackManager';
import { castManager } from '../utils/CastManager';
import { cloneTrackForQueue, ensureQueueEntryIds } from '../utils/queue';
import { preloadManager } from '../utils/PreloadManager';
import { setPlaybackDebugLogging } from '../utils/playbackDebug';
import { savePlaybackContinuitySnapshot } from '../utils/playbackContinuity';
import { audioOutputManager, type AudioOutputDevice } from '../utils/AudioOutputManager';
import {
  getPlaybackTimeSnapshot,
  setPlaybackCurrentTime,
  setPlaybackDuration,
  setPlaybackTimeState,
} from './playbackTime';

import { clearExternalCache } from '../utils/externalImagery';
import type { ToastType } from '../components/Toast';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
}

// Re-entrancy guard: incremented on each playAtIndex call to discard stale callbacks
let playGeneration = 0;

// In-flight dedup + cancellation for the library/playlist fetches. The init
// sequence and the 10s health poller both fire these unawaited; without dedup a
// second call (or a reconnect) duplicates the request, and without an
// AbortController an in-flight fetch can resolve after logout and overwrite
// state with another session's data. Mirrors the promise-cache in externalImagery.ts.
let inFlightLibraryFetch: Promise<void> | null = null;
let inFlightPlaylistsFetch: Promise<void> | null = null;
let libraryFetchAbort: AbortController | null = null;
let playlistsFetchAbort: AbortController | null = null;

// Bumped on each optimistic playlist mutation so a slow in-flight mutation's
// rollback / server-refetch can't clobber a newer optimistic edit applied after it.
let playlistMutationGeneration = 0;

// Sleep timer: fade the audible volume to zero over the final SLEEP_FADE_MS, then
// pause and restore the volume for the next manual play. Timers live at module
// scope (not in the store) since they're imperative side-effects.
let sleepTimerTimeout: ReturnType<typeof setTimeout> | null = null;
let sleepFadeInterval: ReturnType<typeof setInterval> | null = null;
const SLEEP_FADE_MS = 20000;
function clearSleepTimers() {
  if (sleepTimerTimeout) { clearTimeout(sleepTimerTimeout); sleepTimerTimeout = null; }
  if (sleepFadeInterval) { clearInterval(sleepFadeInterval); sleepFadeInterval = null; }
}

// Throttle scrobble-failure toasts (per provider) so a backend outage during a
// long session doesn't spam one toast per finished track.
const lastScrobbleErrorAt: Record<string, number> = {};

function abortInFlightLibraryFetches() {
  libraryFetchAbort?.abort();
  playlistsFetchAbort?.abort();
  libraryFetchAbort = null;
  playlistsFetchAbort = null;
  inFlightLibraryFetch = null;
  inFlightPlaylistsFetch = null;
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

const buildTrackUrls = (trackId: string, path: string, token: string, quality: string = '128k', artHash?: string) => {
  const base = `${window.location.protocol}//${window.location.host}`;
  const tokenParam = token ? `&token=${token}` : '';
  // path is already base64 from the DB — just URL-encode for safe transport
  const pathB64 = encodeURIComponent(path);
  // Prefer a content-hash art URL when the cover has been pre-encoded: it's
  // identical across every track of an album, so the service worker caches and
  // the browser decodes it ONCE per album instead of once per track. Tracks not
  // yet processed (no artHash) fall back to the path-addressed URL, which the
  // server resolves and serves (or live-extracts) transparently.
  const artUrl = artHash
    ? `${base}/api/art?hash=${artHash}${tokenParam}`
    : `${base}/api/art?pathB64=${pathB64}${tokenParam}`;
  return {
    url: `${base}/api/stream/${encodeURIComponent(trackId)}/playlist.m3u8?quality=${quality}${tokenParam}`,
    rawUrl: `${base}/api/stream?pathB64=${pathB64}${tokenParam}`,
    artUrl,
  };
};

const hydrateServerTrack = (track: TrackInfo, token: string, quality: string): TrackInfo => ({
  ...track,
  ...buildTrackUrls(track.id, track.path, token, quality, (track as any).artHash),
});

const dedupeTrackIds = (trackIds: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const trackId of trackIds) {
    if (!trackId || seen.has(trackId)) continue;
    seen.add(trackId);
    result.push(trackId);
  }

  return result;
};

const normalizeHubGenerationSchedule = (value: unknown): string => {
  const schedule = typeof value === 'string' ? value : '';
  return ['Manual Only', 'Hourly', 'Every 2 Hours', 'Every 4 Hours', 'Daily'].includes(schedule)
    ? schedule
    : 'Daily';
};

const defaultSystemPlaylistConfig = {
  upNext: true,
  vault: true,
  jumpBackIn: true,
  genreHeavyRotation: true,
  genreRediscovery: true,
  decadeMixes: true,
  decadeGenreMixes: true,
};

const normalizeSystemPlaylistConfig = (value: unknown): Record<string, boolean> => {
  const parsed = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(
    Object.entries(defaultSystemPlaylistConfig).map(([key, defaultValue]) => [
      key,
      typeof parsed[key] === 'boolean' ? parsed[key] : defaultValue,
    ])
  );
};

const normalizeMbdbLastImport = (value: unknown): PlayerState['mbdbLastImported'] => {
  if (!value) return null;

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const info = parsed as Partial<NonNullable<PlayerState['mbdbLastImported']>>;
  const counts = (info.counts || {}) as Partial<NonNullable<PlayerState['mbdbLastImported']>['counts']>;

  return {
    timestamp: Number(info.timestamp || 0),
    duration: Number(info.duration || 0),
    counts: {
      genres: Number(counts.genres || 0),
      aliases: Number(counts.aliases || 0),
      links: Number(counts.links || 0),
    },
  };
};

const hydratePlaylistTracks = (
  trackIds: string[],
  library: TrackInfo[],
  existingTracks: TrackInfo[],
  authToken: string,
  streamingQuality: PlayerState['streamingQuality']
): TrackInfo[] => {
  const quality = streamingQuality === 'auto' ? '128k' : streamingQuality;
  const libraryById = new Map(library.map((track) => [track.id, track]));
  const existingById = new Map(existingTracks.map((track) => [track.id, track]));

  return trackIds
    .map((trackId) => {
      const existingTrack = existingById.get(trackId);
      const libraryTrack = libraryById.get(trackId);
      return libraryTrack ? { ...existingTrack, ...libraryTrack, playlistAddedAt: existingTrack?.playlistAddedAt } : existingTrack;
    })
    .filter((track): track is TrackInfo => Boolean(track?.id && track?.path))
    .map((track) => ({
      ...track,
      ...buildTrackUrls(track.id, track.path, authToken, quality, (track as any).artHash),
    }));
};

export interface Playlist {
  id: string;
  title: string;
  description: string | null;
  isLlmGenerated: boolean;
  isSystem?: boolean;
  generationSource?: 'manual' | 'hub' | 'custom' | 'system' | 'on-repeat' | 'repeat-rewind' | 'daylist' | 'artist-radio' | 'seasonal-rewind' | 'year-rewind';
  pinned?: boolean;
  createdAt?: number;
  tracks: TrackInfo[];
}

export interface EntityInfo {
  id: string;
  name?: string;
  title?: string;
  artist_name?: string;
}

export interface ArtistInfo extends EntityInfo {
  artist_type?: string;
  area?: string;
  genres?: string;
  community_tags?: string;
  image_url?: string;
  artwork_url?: string;
  listeners?: string;
  lifespan_begin?: string;
  lifespan_end?: string;
  disambiguation?: string;
  mbid?: string;
  bio?: string;
  links?: string;
  members?: string;
  created_at?: string;
  rolesInLibrary?: Array<{ role: string; credits: number }>;
}

export interface TrackCredit {
  artistId: string;
  artistName: string;
  role: string;
  position?: number;
  detail?: string;
  source?: string;
}

export interface AlbumInfo extends EntityInfo {
  image_url?: string;
  mbid?: string;
  description?: string;
  tags?: string;
  listeners?: string;
  playcount?: string;
  created_at?: string;
  release_group_id?: string;
  mb_release_group_id?: string;
  edition_label?: string | null;
  normalized_title?: string;
  release_year?: number | null;
  is_compilation?: boolean;
  manual_group_override?: boolean;
}

export interface AlbumEditionsResponse {
  canonical: AlbumInfo & { track_count?: number };
  editions: Array<AlbumInfo & { track_count?: number }>;
}

export type SortOption = 'name' | 'recentlyAdded' | 'year';

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

export type SortDirection = 'asc' | 'desc';

export interface FilterState {
  facets: FacetSelection;
  sort: SortOption;
  sortDirection: SortDirection;
  queryGroups: QueryGroup[] | null;
  queryResultIds: string[] | null;
}

export type PlaybackLoadPath = 'none' | 'cast' | 'direct' | 'prepared-hls' | 'fallback-hls' | 'lossless-passthrough';
export type PlaybackPrepareStatus = 'idle' | 'preparing' | 'ready' | 'failed';
export type PlaybackRecoveryPath = 'none' | 'normal-hls-after-prepare-failure' | 'normal-hls-after-promotion-failure';
export type PrebufferPolicy = 'off' | 'conservative' | 'aggressive';
export type LlmVetoMode = 'hard' | 'adaptive';
export type QueueMutationOptions = {
  notify?: boolean;
  undo?: boolean;
  message?: string;
};
export type NextTrackOptions = {
  notifyUpNext?: boolean;
};

export interface PlaybackTelemetry {
  lastUpdatedAt: number | null;
  loadPath: PlaybackLoadPath;
  preparedAudioUsed: boolean;
  fallbackHlsLoadUsed: boolean;
  lastTransitionLatencyMs: number | null;
  lastAudibleAt: number | null;
  currentTrackTitle: string | null;
  currentTrackArtist: string | null;
  preparedTrackTitle: string | null;
  preparedTrackArtist: string | null;
  prepareStatus: PlaybackPrepareStatus;
  prepareStartedAt: number | null;
  prepareReadyAt: number | null;
  prepareError: string | null;
  lastFallbackReason: string | null;
  recoveredFromPrepareFailure: boolean;
  recoveryPath: PlaybackRecoveryPath;
  recoveryError: string | null;
  prebufferPolicy: PrebufferPolicy;
  prebufferSkippedReason: string | null;
}

export interface PlayerState {
  // Library State
  library: TrackInfo[];
  libraryFolders: string[];
  isLibraryLoading: boolean;
  // Non-null when the last library/playlist fetch failed (network error or
  // non-OK status). Lets the UI distinguish "genuinely empty" from "load failed"
  // and offer a Retry instead of a blank screen.
  libraryError: string | null;
  playlists: Playlist[];
  isPlaylistsLoading: boolean;
  playlistsError: string | null;

  // Entity State (for navigation)
  artists: ArtistInfo[];
  albums: AlbumInfo[];
  genres: EntityInfo[];

  // Filter State (per view)
  artistFilters: FilterState;
  albumFilters: FilterState;
  setArtistFilters: (filters: FilterState) => void;
  setAlbumFilters: (filters: FilterState) => void;
  clearArtistFilters: () => void;
  clearAlbumFilters: () => void;
  setArtistQueryResultIds: (ids: string[] | null) => void;
  setAlbumQueryResultIds: (ids: string[] | null) => void;

  // Playlist State (Current Play Queue)
  playlist: TrackInfo[];

  // Scanning State
  isScanning: boolean;
  scanPhase: 'idle' | 'walk' | 'metadata' | 'analysis';
  scannedFiles: number;
  totalFiles: number;
  activeWorkers: number;
  activeFiles: string[];
  scanningFile: string | null; // legacy fallback

  // Setup State
  needsSetup: boolean | null;
  checkSetupStatus: () => Promise<void>;

  // Playback State (Transient)
  currentIndex: number | null;
  playbackState: PlaybackState;
  isBuffering: boolean;
  castConnected: boolean;
  audioOutputSupported: boolean;
  audioOutputPickerSupported: boolean;
  audioOutputDevices: AudioOutputDevice[];
  audioOutputDeviceId: string;
  audioOutputDeviceLabel: string;
  audioOutputActive: boolean;
  audioOutputSelecting: boolean;
  audioOutputError: string | null;
  playbackTelemetry: PlaybackTelemetry;

  // Settings State (Persisted)
  volume: number;
  shuffle: boolean;
  repeat: "none" | "one" | "all";
  theme: 'light' | 'dark';
  reducedMotion: boolean;
  lastFmApiKey: string;
  lastFmSharedSecret: string;
  lastFmScrobbleEnabled: boolean;
  lastFmConnected: boolean;
  lastFmUsername: string;
  listenBrainzScrobbleEnabled: boolean;
  listenBrainzConnected: boolean;
  listenBrainzUsername: string;
  geniusApiKey: string;
  musicBrainzEnabled: boolean;
  musicBrainzClientId: string;
  musicBrainzClientSecret: string;
  musicBrainzConnected: boolean;
  musicBrainzRedirectUri: string;
  providerArtistImage: 'lastfm' | 'genius' | 'musicbrainz';
  providerArtistArtwork: 'genius' | 'none';
  providerArtistBio: 'lastfm' | 'genius';
  providerAlbumArt: 'lastfm' | 'genius' | 'musicbrainz';
  authToken: string | null; // Account JWT token
  mediaAccessToken: string | null; // Scoped token for HLS/art/Cast URLs
  sseAccessToken: string | null; // Scoped token for EventSource URLs
  authExpired: boolean;
  authExpiredMessage: string | null;
  authExpiredUsername: string;
  streamingQuality: 'auto' | '64k' | '128k' | '160k' | '320k' | 'source';
  playbackDebugLogging: boolean;
  prebufferPolicy: PrebufferPolicy;

  // Current User State
  currentUser: { id: string; username: string; role: string } | null;

  // Last.fm scrobble tracking (internal, not persisted)
  _scrobbleStartAt: number | null;
  _scrobbleEligible: boolean;

  // Global Engine Settings
  discoveryLevel: number;
  genreStrictness: number;
  artistAmnesiaLimit: number;
  llmPlaylistDiversity: number;
  llmVetoMode: LlmVetoMode;
  llmGenreCohesion: number;
  llmDiscoveryBias: number;
  llmArtistSpread: number;
  genrePenaltyCurve: number;
  llmRecoveryStrength: number;
  llmAdjacentReach: number;
  llmTracksPerPlaylist: number;
  llmPlaylistCount: number;
  audioAnalysisCpu: string;
  scannerConcurrency: string;
  hubGenerationSchedule: string;
  systemPlaylistConfig: Record<string, boolean>;
  hlsLoggingEnabled: boolean;
  ffmpegLoggingEnabled: boolean;
  openSubsonicEnabled: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModelName: string;
  llmConnected: boolean; // Live connection status
  mbdbLastImported: { timestamp: number; duration: number; counts: { genres: number; aliases: number; links: number } } | null;
  genreMatrixLastRun: number | null;
  genreMatrixLastResult: string | null;
  genreMatrixProgress: string | null;
  autoFolderWalk: boolean;

  // Concerts / Jambase (system-level, admin)
  jambaseEnabled: boolean;
  jambaseMaxSubscriptionsPerUser: number;
  jambaseCacheTtlDays: number;
  jambaseMonthlyCap: number;
  jambaseHardStop: boolean;

  // Concerts (per-user)
  concertsEnabled: boolean;
  concertsLat: number | null;
  concertsLng: number | null;
  concertsLocationLabel: string;
  concertsRadiusKm: number;
  concertsAutoAddEnabled: boolean;

  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean) => void;

  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;

  setSettings: (settings: Partial<PlayerState>) => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  
  isInfinityMode: boolean;
  isFetchingInfinity: boolean;
  toggleInfinityMode: () => void;
  ensureInfinityQueue: () => Promise<void>;
  fetchNextInfinityTrack: (isPrefetch?: boolean) => Promise<void>;

  fetchLibraryFromServer: () => Promise<void>;
  fetchPlaylistsFromServer: () => Promise<void>;
  fetchPlaylistFromServer: (playlistId: string) => Promise<boolean>;
  createPlaylist: (title: string, description?: string) => Promise<Playlist | null>;
  deletePlaylist: (playlistId: string) => Promise<void>;
  togglePin: (playlistId: string, pinned: boolean) => Promise<void>;
  replaceTracksInUserPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>;
  addTracksToUserPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>;
  setAuthToken: (token: string, mediaAccessToken?: string | null, sseAccessToken?: string | null) => void;
  clearAuthToken: () => void;
  expireAuthSession: (message?: string) => void;
  login: (username: string, password: string) => Promise<boolean>;
  register: (inviteToken: string, username: string, password: string) => Promise<boolean>;
  getAuthHeader: () => Record<string, string>;
  addLibraryFolder: (folderPath: string) => Promise<void>;
  removeLibraryFolder: (folderName: string) => Promise<void>;
  rescanLibrary: (specificFolder?: string) => Promise<void>;
  addTracksToLibrary: (newTracks: TrackInfo[]) => void;
  setIsScanning: (
    isScanning: boolean,
    phase?: 'idle' | 'walk' | 'metadata' | 'analysis',
    scanned?: number,
    total?: number,
    workers?: number,
    activeFiles?: string[],
    fileName?: string | null
  ) => void;

  // Library Actions
  deleteTrackFromLibrary: (trackId: string) => Promise<void>;
  toggleTrackLove: (track: TrackInfo) => Promise<void>;

  // Play Queue Actions
  setPlaylist: (tracks: TrackInfo[], startIndex?: number) => Promise<void>;
  addTrackToPlaylist: (track: TrackInfo, options?: QueueMutationOptions) => void;
  playNext: (track: TrackInfo, options?: QueueMutationOptions) => void;
  removeFromPlaylist: (index: number) => void;
  moveInPlaylist: (fromIndex: number, toIndex: number) => void;
  clearPlaylist: () => void;
  restoreQueueSnapshot: (playlist: TrackInfo[], currentIndex: number | null) => void;

  // Global Track Context Menu
  contextMenu: { track: TrackInfo; x: number; y: number; playlistId?: string; playlistTrackIndex?: number } | null;
  openContextMenu: (track: TrackInfo, x: number, y: number, playlistId?: string, playlistTrackIndex?: number) => void;
  closeContextMenu: () => void;

  // Playback Actions
  playAtIndex: (index: number) => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
  nextTrack: (options?: NextTrackOptions) => Promise<void>;
  prevTrack: () => Promise<void>;
  setVolume: (v: number) => void;
  // Sleep timer. sleepTimerEndsAt is the epoch-ms fire time (null = inactive);
  // it's transient (not persisted). startSleepTimer(0) cancels.
  sleepTimerEndsAt: number | null;
  startSleepTimer: (minutes: number) => void;
  cancelSleepTimer: () => void;
  selectAudioOutput: () => Promise<void>;
  setAudioOutputDevice: (deviceId: string) => Promise<void>;
  refreshAudioOutputs: () => Promise<void>;
  clearAudioOutput: () => Promise<void>;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setCastConnected: (connected: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setReducedMotion: (enabled: boolean) => void;
  setLastFmApiKey: (key: string) => void;
  setLastFmSharedSecret: (secret: string) => void;
  setLastFmScrobbleEnabled: (enabled: boolean) => void;
  setLastFmConnected: (connected: boolean) => void;
  setLastFmUsername: (username: string) => void;
  setListenBrainzScrobbleEnabled: (enabled: boolean) => void;
  setListenBrainzConnected: (connected: boolean) => void;
  setListenBrainzUsername: (username: string) => void;
  setGeniusApiKey: (key: string) => void;
  setMusicBrainzEnabled: (enabled: boolean) => void;
  setMusicBrainzClientId: (id: string) => void;
  setMusicBrainzClientSecret: (secret: string) => void;
  setMusicBrainzConnected: (connected: boolean) => void;
  setMusicBrainzRedirectUri: (uri: string) => void;
  setProviderArtistImage: (provider: 'lastfm' | 'genius' | 'musicbrainz') => void;
  setProviderArtistArtwork: (provider: 'genius' | 'none') => void;
  setProviderArtistBio: (provider: 'lastfm' | 'genius') => void;
  setProviderAlbumArt: (provider: 'lastfm' | 'genius' | 'musicbrainz') => void;
  setLlmConnected: (connected: boolean) => void;

  // Manager sync callbacks
  syncTimeUpdate: (time: number) => void;
  syncDuration: (duration: number) => void;
  syncPlaybackState: (state: PlaybackState) => void;
  recordPlaybackTelemetry: (telemetry: Partial<PlaybackTelemetry>) => void;

  // Engine session state
  sessionHistoryTrackIds: string[];
  recordPlay: (trackId: string) => void;
  recordSkip: (trackId: string) => void;

  // Toast state
  toasts: ToastItem[];
  addToast: (message: string, type: ToastType, options?: { actionLabel?: string; onAction?: () => void; duration?: number }) => void;
  removeToast: (id: number) => void;

  // PWA update state
  pendingUpdate: boolean;
  setPendingUpdate: (val: boolean) => void;

  // True when the browser blocked playback for lack of a user gesture
  // (autoplay policy). UI can show a "tap to play" affordance.
  autoplayBlocked: boolean;
  setAutoplayBlocked: (val: boolean) => void;
}

// Remove `PlayerPersist` hack as it was unnecessary and broke inference further

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {
      // Setup PlaybackManager callbacks to update store state
      playbackManager.setCallbacks({
        onTimeUpdate: (time) => {
          setPlaybackCurrentTime(time);
          persistContinuitySnapshot(false);
          // Check scrobble eligibility (>50% duration or 4 minutes, whichever is earlier, and track >30s)
          const state = get();
          const { duration } = getPlaybackTimeSnapshot();
          if (!state._scrobbleEligible && state._scrobbleStartAt && duration > 30) {
            const halfDuration = duration / 2;
            const threshold = Math.min(halfDuration, 240); // 4 minutes = 240s
            if (time >= threshold) {
              set({ _scrobbleEligible: true });
            }
          }
        },
        onDuration: (duration) => {
          // Only accept the player-reported duration if it's valid AND at least
          // as large as what we currently have. This prevents the early HLS
          // loadedmetadata (~10s = one segment) from overwriting the DB duration
          // that was set in playAtIndex. Once hls.js parses the full VOD playlist,
          // durationchange fires with the real total and we accept it.
          if (isFinite(duration) && duration > 0) {
            const current = getPlaybackTimeSnapshot().duration;
            if (duration >= current || current === 0) {
              setPlaybackDuration(duration);
              persistContinuitySnapshot(true);
            }
          }
        },
        onPlayStateChange: (state) => {
          set({ playbackState: state });
          persistContinuitySnapshot(true);
        },
        onEnded: () => {
          // Scrobble the completed track if eligible
          const state = get();
          const {
            lastFmConnected, lastFmScrobbleEnabled,
            listenBrainzConnected, listenBrainzScrobbleEnabled,
            _scrobbleEligible, _scrobbleStartAt,
          } = state;
          const currentTrack = state.currentIndex !== null ? state.playlist[state.currentIndex] : null;
          if (_scrobbleEligible && _scrobbleStartAt && currentTrack?.artist && currentTrack?.title) {
            const authHeaders = (get() as any).getAuthHeader();
            const { duration } = getPlaybackTimeSnapshot();
            const payload = {
              tracks: [{
                artist: currentTrack.artist,
                track: currentTrack.title,
                album: currentTrack.album || '',
                albumArtist: currentTrack.albumArtist || '',
                duration: Math.round(duration),
                timestamp: Math.floor(_scrobbleStartAt / 1000),
                mbid: currentTrack.mbTrackId || '',
              }],
            };
            // Surface scrobble failures (throttled per provider) so users notice
            // when this otherwise-invisible feature silently breaks. Success stays
            // quiet to avoid a toast on every finished track.
            const scrobbleTo = (provider: string, url: string) => {
              fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(payload),
              })
                .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
                .catch(() => {
                  const now = Date.now();
                  if (now - (lastScrobbleErrorAt[provider] || 0) > 60000) {
                    lastScrobbleErrorAt[provider] = now;
                    get().addToast(`Couldn't scrobble to ${provider}.`, 'error', { duration: 4000 });
                  }
                });
            };
            if (lastFmConnected && lastFmScrobbleEnabled) scrobbleTo('Last.fm', '/api/providers/lastfm/scrobble');
            if (listenBrainzConnected && listenBrainzScrobbleEnabled) scrobbleTo('ListenBrainz', '/api/providers/listenbrainz/scrobble');
          }
          set({ _scrobbleStartAt: null, _scrobbleEligible: false });

          // Auto-play next track based on repeat and shuffle rules
          const { repeat, nextTrack, stop, fetchNextInfinityTrack } = get();
          if (repeat === 'one') {
            // Let the audio element handle loop if we implemented it, or manually replay
            get().playAtIndex(get().currentIndex!);
          } else if (repeat === 'none') {
            // Stop at end of list
            const currentIdx = get().currentIndex!;
            if (currentIdx < get().playlist.length - 1 || get().shuffle) {
              void nextTrack({ notifyUpNext: true });
            } else if (get().isInfinityMode) {
              // Infinity Mode bounds reached! Fetch the next track natively
              fetchNextInfinityTrack(false);
            } else {
              stop();
            }
          } else {
            // repeat === 'all'
            void nextTrack({ notifyUpNext: true });
          }
        },
        onVolumeChange: (volume) => {
          // Sync volume from cast device → store (e.g., changed via Google Home)
          set({ volume });
        },
        onMuteChange: (_muted) => {
          // When muted, show volume as 0; volume will restore via VOLUME_LEVEL_CHANGED
          if (_muted) {
            set({ volume: 0 });
          }
          // When unmuted, VOLUME_LEVEL_CHANGED fires with the restored value
        },
        onTrackChange: (index) => {
          // Receiver auto-advanced to next track in the queue — sync sender UI
          const state = get();
          if (index !== state.currentIndex && index >= 0 && index < state.playlist.length) {
            setPlaybackTimeState({ currentTime: 0, duration: state.playlist[index].duration || 0 });
            set({
              currentIndex: index,
              _scrobbleStartAt: Date.now(),
              _scrobbleEligible: false,
            });
            persistContinuitySnapshot(true);
          }
        },
        onBufferingChange: (isBuffering) => {
          set({ isBuffering });
        }
      });

      // Wire up CastManager state changes to the store
      setTimeout(() => {
        castManager.addStateChangeListener((castState) => {
          set({ castConnected: castState === 'CONNECTED' });
          const state = get();
          if (state.prebufferPolicy !== 'off') {
            preloadManager.prewarmNext(state.playlist, state.currentIndex, state.streamingQuality, {
              castConnected: castState === 'CONNECTED',
            });
          }
        });
      }, 0);

      setTimeout(() => {
        const persisted = get();
        const initialAudioOutput = audioOutputManager.initialize(
          persisted.audioOutputDeviceId,
          persisted.audioOutputDeviceLabel
        );
        set({
          audioOutputSupported: initialAudioOutput.supported,
          audioOutputPickerSupported: initialAudioOutput.pickerSupported,
          audioOutputDevices: initialAudioOutput.devices,
          audioOutputDeviceId: initialAudioOutput.deviceId,
          audioOutputDeviceLabel: initialAudioOutput.label,
          audioOutputActive: initialAudioOutput.active,
          audioOutputSelecting: initialAudioOutput.selecting,
          audioOutputError: initialAudioOutput.error,
        });

        audioOutputManager.subscribe((audioOutput) => {
          set({
            audioOutputSupported: audioOutput.supported,
            audioOutputPickerSupported: audioOutput.pickerSupported,
            audioOutputDevices: audioOutput.devices,
            audioOutputDeviceId: audioOutput.deviceId,
            audioOutputDeviceLabel: audioOutput.label,
            audioOutputActive: audioOutput.active,
            audioOutputSelecting: audioOutput.selecting,
            audioOutputError: audioOutput.error,
          });
        });
      }, 0);

      const prewarmNextFromState = (state: PlayerState, currentIndex: number | null = state.currentIndex) => {
        const nextIndex = currentIndex !== null ? currentIndex + 1 : null;
        const nextTrack = nextIndex !== null ? state.playlist[nextIndex] : null;
        const isActuallyCasting = castManager.isConnected();
        if (state.prebufferPolicy === 'off') {
          playbackManager.clearPreparedAudio();
          get().recordPlaybackTelemetry({
            prepareStatus: 'idle',
            preparedTrackTitle: null,
            preparedTrackArtist: null,
            prebufferPolicy: state.prebufferPolicy,
            prebufferSkippedReason: 'policy-off',
          });
          return;
        }
        preloadManager.prewarmNext(state.playlist, currentIndex, state.streamingQuality, {
          castConnected: isActuallyCasting,
        });
        if (!isActuallyCasting && nextTrack?.url) {
          playbackManager.prepareNextUrl(
            nextTrack.url,
            nextTrack.rawUrl || '',
            nextTrack.title,
            nextTrack.artist || ((nextTrack.artists as string[])?.join(', ')),
            nextTrack.artUrl,
            nextTrack.album,
            nextTrack.format
          );
        }
      };

      let lastContinuitySnapshotAt = 0;
      const persistContinuitySnapshot = (force = false) => {
        const now = Date.now();
        if (!force && now - lastContinuitySnapshotAt < 5000) return;
        lastContinuitySnapshotAt = now;
        const state = get();
        const { currentTime, duration } = getPlaybackTimeSnapshot();
        savePlaybackContinuitySnapshot({
          playlist: state.playlist,
          currentIndex: state.currentIndex,
          currentTime,
          duration,
          playbackState: state.playbackState,
          wasPlaying: state.playbackState === 'playing',
          repeat: state.repeat,
          shuffle: state.shuffle,
          streamingQuality: state.streamingQuality,
        });
      };

      return {
        // Initial State
        library: [] as TrackInfo[],
        libraryFolders: [] as string[],
        isLibraryLoading: false as boolean,
        libraryError: null as string | null,
        playlists: [] as Playlist[],
        isPlaylistsLoading: false as boolean,
        playlistsError: null as string | null,
        artists: [] as ArtistInfo[],
        albums: [] as AlbumInfo[],
        genres: [] as EntityInfo[],
        artistFilters: { ...EMPTY_FILTER_STATE } as FilterState,
        albumFilters: { ...EMPTY_FILTER_STATE } as FilterState,
        setArtistFilters: (filters: FilterState) => { set({ artistFilters: filters }); },
        setAlbumFilters: (filters: FilterState) => { set({ albumFilters: filters }); },
        clearArtistFilters: () => { set({ artistFilters: { ...EMPTY_FILTER_STATE } }); },
        clearAlbumFilters: () => { set({ albumFilters: { ...EMPTY_FILTER_STATE } }); },
        setArtistQueryResultIds: (ids: string[] | null) => { set({ artistFilters: { ...get().artistFilters, queryResultIds: ids } }); },
        setAlbumQueryResultIds: (ids: string[] | null) => { set({ albumFilters: { ...get().albumFilters, queryResultIds: ids } }); },
        playlist: [] as TrackInfo[],

        isScanning: false as boolean,
        scanPhase: 'idle' as 'idle' | 'walk' | 'metadata' | 'analysis',
        scannedFiles: 0,
        totalFiles: 0,
        activeWorkers: 0,
        activeFiles: [] as string[],
        scanningFile: null as string | null,

        needsSetup: null as boolean | null,

        currentIndex: null as number | null,
        playbackState: 'stopped' as PlaybackState,
        isBuffering: false as boolean,
        castConnected: false as boolean,
        audioOutputSupported: false,
        audioOutputPickerSupported: false,
        audioOutputDevices: [{ deviceId: '', label: 'System default', isDefault: true }],
        audioOutputDeviceId: '',
        audioOutputDeviceLabel: '',
        audioOutputActive: false,
        audioOutputSelecting: false,
        audioOutputError: null,
        playbackTelemetry: {
          lastUpdatedAt: null,
          loadPath: 'none',
          preparedAudioUsed: false,
          fallbackHlsLoadUsed: false,
          lastTransitionLatencyMs: null,
          lastAudibleAt: null,
          currentTrackTitle: null,
          currentTrackArtist: null,
          preparedTrackTitle: null,
          preparedTrackArtist: null,
          prepareStatus: 'idle',
          prepareStartedAt: null,
          prepareReadyAt: null,
          prepareError: null,
          lastFallbackReason: null,
          recoveredFromPrepareFailure: false,
          recoveryPath: 'none',
          recoveryError: null,
          prebufferPolicy: 'conservative',
          prebufferSkippedReason: null,
        } as PlaybackTelemetry,
        volume: 1,
        shuffle: false as boolean,
        repeat: "none" as "none" | "one" | "all",
        theme: 'light' as 'light' | 'dark',
        reducedMotion: (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) || false,
        lastFmApiKey: '',
        lastFmSharedSecret: '',
        lastFmScrobbleEnabled: false as boolean,
        lastFmConnected: false as boolean,
        lastFmUsername: '',
        listenBrainzScrobbleEnabled: false as boolean,
        listenBrainzConnected: false as boolean,
        listenBrainzUsername: '',
        geniusApiKey: '',
        musicBrainzEnabled: false as boolean,
        musicBrainzClientId: '',
        musicBrainzClientSecret: '',
        musicBrainzConnected: false as boolean,
        musicBrainzRedirectUri: '',
        providerArtistImage: 'lastfm' as 'lastfm' | 'genius' | 'musicbrainz',
        providerArtistArtwork: 'genius' as 'genius' | 'none',
        providerArtistBio: 'lastfm' as 'lastfm' | 'genius',
        providerAlbumArt: 'lastfm' as 'lastfm' | 'genius' | 'musicbrainz',
        jambaseEnabled: false as boolean,
        jambaseMaxSubscriptionsPerUser: 10,
        jambaseCacheTtlDays: 7,
        jambaseMonthlyCap: 1000,
        jambaseHardStop: true as boolean,
        concertsEnabled: false as boolean,
        concertsLat: null as number | null,
        concertsLng: null as number | null,
        concertsLocationLabel: '',
        concertsRadiusKm: 50,
        concertsAutoAddEnabled: false as boolean,
        authToken: null as string | null,
        mediaAccessToken: null as string | null,
        sseAccessToken: null as string | null,
        authExpired: false,
        authExpiredMessage: null as string | null,
        authExpiredUsername: '',
        streamingQuality: 'auto' as 'auto' | '64k' | '128k' | '160k' | '320k' | 'source',
        playbackDebugLogging: false as boolean,
        prebufferPolicy: 'conservative' as PrebufferPolicy,
        currentUser: null as { id: string; username: string; role: string } | null,

        // Last.fm scrobble state
        _scrobbleStartAt: null as number | null,
        _scrobbleEligible: false as boolean,

        isInfinityMode: true as boolean,
        isFetchingInfinity: false as boolean,


        discoveryLevel: 50,
        genreStrictness: 50,
        artistAmnesiaLimit: 50,
        llmPlaylistDiversity: 50,
        llmVetoMode: 'hard' as LlmVetoMode,
        llmGenreCohesion: 50,
        llmDiscoveryBias: 45,
        llmArtistSpread: 70,
        genrePenaltyCurve: 50,
        llmRecoveryStrength: 50,
        llmAdjacentReach: 50,
        llmTracksPerPlaylist: 10,
        llmPlaylistCount: 3,
        audioAnalysisCpu: 'Balanced',
        scannerConcurrency: 'SSD',
        hubGenerationSchedule: 'Daily',
        systemPlaylistConfig: { ...defaultSystemPlaylistConfig },
        hlsLoggingEnabled: false,
        ffmpegLoggingEnabled: false,
        openSubsonicEnabled: true,
        llmBaseUrl: '',
        llmApiKey: '',
        llmModelName: '',
        llmConnected: false,
        mbdbLastImported: null,
        genreMatrixLastRun: null as number | null,
        genreMatrixLastResult: null as string | null,
        genreMatrixProgress: null as string | null,
        autoFolderWalk: false as boolean,

        isSidebarCollapsed: false as boolean,
        setIsSidebarCollapsed: (collapsed: boolean) => set({ isSidebarCollapsed: collapsed }),

        isSidebarOpen: false as boolean,
        setIsSidebarOpen: (open: boolean) => set({ isSidebarOpen: open }),

        sessionHistoryTrackIds: [] as string[],

        // Actions
        checkSetupStatus: async () => {
          try {
            const res = await fetch('/api/setup/status');
            if (res.ok) {
              const data = await res.json();
              set({ needsSetup: data.needsSetup });
            } else {
              set({ needsSetup: false });
            }
          } catch (e) {
            console.error("Failed to check setup status", e);
            set({ needsSetup: false }); // Fallback assuming standard boot
          }
        },

        setIsScanning: (isScanning, phase = 'idle', scanned = 0, total = 0, workers = 0, activeFiles = [], fileName = null) => 
          set({ 
            isScanning, 
            scanPhase: phase, 
            scannedFiles: scanned, 
            totalFiles: total, 
            activeWorkers: workers, 
            activeFiles,
            scanningFile: fileName 
          }),

        setTheme: (theme: 'light' | 'dark') => {
          set({ theme });
          if (theme === 'dark') {
            document.documentElement.classList.add('dark');
          } else {
            document.documentElement.classList.remove('dark');
          }
        },

        setReducedMotion: (enabled: boolean) => {
          set({ reducedMotion: enabled });
          if (enabled) {
            document.documentElement.classList.add('reduced-motion');
          } else {
            document.documentElement.classList.remove('reduced-motion');
          }
        },

        setAuthToken: (token: string, mediaAccessToken: string | null = null, sseAccessToken: string | null = null) => set({
          authToken: token,
          mediaAccessToken: mediaAccessToken || token,
          sseAccessToken: sseAccessToken || token,
          authExpired: false,
          authExpiredMessage: null,
        }),

        clearAuthToken: () => set({
          authToken: null,
          mediaAccessToken: null,
          sseAccessToken: null,
          currentUser: null,
          authExpired: false,
          authExpiredMessage: null,
          authExpiredUsername: '',
        }),

        expireAuthSession: (message = 'Your session expired. Log in again to continue.') => {
          // Cancel any in-flight library/playlist fetch so it can't resolve after
          // logout and repopulate state with the previous session's data.
          abortInFlightLibraryFetches();
          return set((state: PlayerState) => ({
          authToken: null,
          mediaAccessToken: null,
          sseAccessToken: null,
          currentUser: null,
          authExpired: true,
          authExpiredMessage: message,
          authExpiredUsername: state.currentUser?.username || state.authExpiredUsername || '',
          isLibraryLoading: false,
          isPlaylistsLoading: false,
          isFetchingInfinity: false,
          isScanning: false,
          scanPhase: 'idle',
          scannedFiles: 0,
          totalFiles: 0,
          activeWorkers: 0,
          activeFiles: [],
          scanningFile: null,
        }));
        },

        login: async (username: string, password: string) => {
          try {
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password })
            });
            if (res.ok) {
              const data = await res.json();
              set({
                authToken: data.token,
                mediaAccessToken: data.mediaToken || data.token,
                sseAccessToken: data.sseToken || data.token,
                currentUser: data.user,
                authExpired: false,
                authExpiredMessage: null,
                authExpiredUsername: '',
              });
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },

        register: async (inviteToken: string, username: string, password: string) => {
          try {
            const res = await fetch('/api/auth/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ inviteToken, username, password })
            });
            if (res.ok) {
              const data = await res.json();
              set({
                authToken: data.token,
                mediaAccessToken: data.mediaToken || data.token,
                sseAccessToken: data.sseToken || data.token,
                currentUser: data.user,
                authExpired: false,
                authExpiredMessage: null,
                authExpiredUsername: '',
              });
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },

        // Helper for Auth Header (JWT Bearer)
        getAuthHeader: () => {
          const { authToken } = get();
          if (authToken) {
            return { 'Authorization': 'Bearer ' + authToken };
          }
          return {} as Record<string, string>;
        },

        setSettings: (settings: Partial<PlayerState>) => {
          const previousStreamingQuality = get().streamingQuality;
          const previousPrebufferPolicy = get().prebufferPolicy;
          set((state: PlayerState) => ({ ...state, ...settings }));
          if (settings.playbackDebugLogging !== undefined) {
            setPlaybackDebugLogging(settings.playbackDebugLogging);
            castManager.setDiagnosticsVerbose(settings.playbackDebugLogging);
          }
          if (settings.prebufferPolicy && settings.prebufferPolicy !== previousPrebufferPolicy) {
            playbackManager.clearPreparedAudio();
            get().recordPlaybackTelemetry({
              prepareStatus: 'idle',
              preparedTrackTitle: null,
              preparedTrackArtist: null,
              prebufferPolicy: settings.prebufferPolicy,
              prebufferSkippedReason: settings.prebufferPolicy === 'off' ? 'policy-off' : null,
            });
            if (settings.prebufferPolicy !== 'off') {
              prewarmNextFromState(get());
            }
          }
          if (settings.streamingQuality && settings.streamingQuality !== previousStreamingQuality) {
            playbackManager.clearPreparedAudio();
            prewarmNextFromState(get());
          }
        },

        loadSettings: async () => {
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/settings', { headers: authHeaders });
            if (res.ok) {
              const data = await res.json();
              set({
                discoveryLevel: data.discoveryLevel !== undefined ? data.discoveryLevel : 50,
                genreStrictness: data.genreStrictness !== undefined ? data.genreStrictness : 50,
                artistAmnesiaLimit: data.artistAmnesiaLimit !== undefined ? data.artistAmnesiaLimit : 50,
                llmPlaylistDiversity: data.llmPlaylistDiversity !== undefined ? data.llmPlaylistDiversity : 50,
                llmVetoMode: data.llmVetoMode === 'adaptive' ? 'adaptive' : 'hard',
                llmGenreCohesion: data.llmGenreCohesion !== undefined ? data.llmGenreCohesion : (data.genreBlendWeight !== undefined ? data.genreBlendWeight : 50),
                llmDiscoveryBias: data.llmDiscoveryBias !== undefined ? data.llmDiscoveryBias : 45,
                llmArtistSpread: data.llmArtistSpread !== undefined ? data.llmArtistSpread : 70,
                genrePenaltyCurve: data.genrePenaltyCurve !== undefined ? data.genrePenaltyCurve : 50,
                llmRecoveryStrength: data.llmRecoveryStrength !== undefined ? data.llmRecoveryStrength : 50,
                llmAdjacentReach: data.llmAdjacentReach !== undefined ? data.llmAdjacentReach : 50,
                llmTracksPerPlaylist: data.llmTracksPerPlaylist !== undefined ? data.llmTracksPerPlaylist : 10,
                llmPlaylistCount: data.llmPlaylistCount !== undefined ? data.llmPlaylistCount : 3,
                audioAnalysisCpu: data.audioAnalysisCpu || 'Balanced',
                scannerConcurrency: data.scannerConcurrency || 'SSD',
                hubGenerationSchedule: normalizeHubGenerationSchedule(data.hubGenerationSchedule),
                systemPlaylistConfig: normalizeSystemPlaylistConfig(data.systemPlaylistConfig),
                hlsLoggingEnabled: data.hlsLoggingEnabled === true,
                ffmpegLoggingEnabled: data.ffmpegLoggingEnabled === true,
                openSubsonicEnabled: data.openSubsonicEnabled !== false,
                llmBaseUrl: data.llmBaseUrl || '',
                llmApiKey: data.llmApiKey || '',
                llmModelName: data.llmModelName || '',
                mbdbLastImported: normalizeMbdbLastImport(data.mbdbLastImport),
                genreMatrixLastRun: data.genreMatrixLastRun || null,
                genreMatrixLastResult: data.genreMatrixLastResult || null,
                genreMatrixProgress: data.genreMatrixProgress || null,
                lastFmApiKey: data.lastFmApiKey || '',
                lastFmSharedSecret: data.lastFmSharedSecret || '',
                lastFmScrobbleEnabled: data.lastFmScrobbleEnabled ?? false,
                lastFmConnected: data.lastFmConnected ?? false,
                lastFmUsername: data.lastFmUsername || '',
                listenBrainzScrobbleEnabled: data.listenBrainzScrobbleEnabled ?? false,
                listenBrainzConnected: data.listenBrainzConnected ?? false,
                listenBrainzUsername: data.listenBrainzUsername || '',
                geniusApiKey: data.geniusApiKey || '',
                musicBrainzEnabled: data.musicBrainzEnabled ?? false,
                musicBrainzClientId: data.musicBrainzClientId || '',
                musicBrainzClientSecret: data.musicBrainzClientSecret || '',
                musicBrainzConnected: data.musicBrainzConnected ?? false,
                musicBrainzRedirectUri: data.musicBrainzRedirectUri || '',
                providerArtistImage: data.providerArtistImage || 'lastfm',
                providerArtistArtwork: data.providerArtistArtwork || 'genius',
                providerArtistBio: data.providerArtistBio || 'lastfm',
                providerAlbumArt: data.providerAlbumArt || 'lastfm',
                autoFolderWalk: data.autoFolderWalk === 'true' || data.autoFolderWalk === true,
                jambaseEnabled: data.jambaseEnabled ?? false,
                jambaseMaxSubscriptionsPerUser: typeof data.jambaseMaxSubscriptionsPerUser === 'number' ? data.jambaseMaxSubscriptionsPerUser : 10,
                jambaseCacheTtlDays: typeof data.jambaseCacheTtlDays === 'number' ? data.jambaseCacheTtlDays : 7,
                jambaseMonthlyCap: typeof data.jambaseMonthlyCap === 'number' ? data.jambaseMonthlyCap : 1000,
                jambaseHardStop: data.jambaseHardStop ?? true,
                concertsEnabled: data.concertsEnabled ?? false,
                concertsLat: typeof data.concertsLat === 'number' ? data.concertsLat : null,
                concertsLng: typeof data.concertsLng === 'number' ? data.concertsLng : null,
                concertsLocationLabel: data.concertsLocationLabel || '',
                concertsRadiusKm: typeof data.concertsRadiusKm === 'number' ? data.concertsRadiusKm : 50,
                concertsAutoAddEnabled: data.concertsAutoAddEnabled ?? false
              });

              // Auto-validate LLM connection if credentials exist
              if (data.llmBaseUrl && data.llmModelName) {
                try {
                  const healthRes = await fetch('/api/health/llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ llmBaseUrl: data.llmBaseUrl, llmApiKey: data.llmApiKey || '' })
                  });
                  const healthData = await healthRes.json();
                  set({ llmConnected: healthRes.ok && healthData.status === 'ok' });
                } catch {
                  set({ llmConnected: false });
                }
              }
            }
          } catch (e) {
            console.error('Failed to load DB settings', e);
          }
        },

        saveSettings: async () => {
           try {
              const state = get();
              const authHeaders = (state as any).getAuthHeader();
              const payload = {
                discoveryLevel: state.discoveryLevel,
                genreStrictness: state.genreStrictness,
                artistAmnesiaLimit: state.artistAmnesiaLimit,
                llmPlaylistDiversity: state.llmPlaylistDiversity,
                llmVetoMode: state.llmVetoMode,
                llmGenreCohesion: state.llmGenreCohesion,
                llmDiscoveryBias: state.llmDiscoveryBias,
                llmArtistSpread: state.llmArtistSpread,
                genrePenaltyCurve: state.genrePenaltyCurve,
                llmRecoveryStrength: state.llmRecoveryStrength,
                llmAdjacentReach: state.llmAdjacentReach,
                llmTracksPerPlaylist: state.llmTracksPerPlaylist,
                llmPlaylistCount: state.llmPlaylistCount,
                audioAnalysisCpu: state.audioAnalysisCpu,
                scannerConcurrency: state.scannerConcurrency,
                hubGenerationSchedule: state.hubGenerationSchedule,
                systemPlaylistConfig: state.systemPlaylistConfig,
                hlsLoggingEnabled: state.hlsLoggingEnabled,
                ffmpegLoggingEnabled: state.ffmpegLoggingEnabled,
                openSubsonicEnabled: state.openSubsonicEnabled,
                llmBaseUrl: state.llmBaseUrl,
                llmApiKey: state.llmApiKey,
                llmModelName: state.llmModelName,
                lastFmApiKey: state.lastFmApiKey,
                lastFmSharedSecret: state.lastFmSharedSecret,
                lastFmScrobbleEnabled: state.lastFmScrobbleEnabled,
                listenBrainzScrobbleEnabled: state.listenBrainzScrobbleEnabled,
                geniusApiKey: state.geniusApiKey,
                musicBrainzEnabled: state.musicBrainzEnabled,
                musicBrainzClientId: state.musicBrainzClientId,
                musicBrainzClientSecret: state.musicBrainzClientSecret,
                musicBrainzRedirectUri: state.musicBrainzRedirectUri,
                providerArtistImage: state.providerArtistImage,
                providerArtistArtwork: state.providerArtistArtwork,
                providerArtistBio: state.providerArtistBio,
                providerAlbumArt: state.providerAlbumArt,
                autoFolderWalk: state.autoFolderWalk,
                jambaseEnabled: state.jambaseEnabled,
                jambaseMaxSubscriptionsPerUser: state.jambaseMaxSubscriptionsPerUser,
                jambaseCacheTtlDays: state.jambaseCacheTtlDays,
                jambaseMonthlyCap: state.jambaseMonthlyCap,
                jambaseHardStop: state.jambaseHardStop,
                concertsEnabled: state.concertsEnabled,
                concertsLat: state.concertsLat,
                concertsLng: state.concertsLng,
                concertsLocationLabel: state.concertsLocationLabel,
                concertsRadiusKm: state.concertsRadiusKm,
                concertsAutoAddEnabled: state.concertsAutoAddEnabled
              };
              await fetch('/api/settings', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify(payload)
              });
              // Clear cached external imagery when provider settings change
              clearExternalCache();
           } catch(e) {
              console.error('Failed to save settings', e);
           }
        },
        toggleInfinityMode: () => {
          const state = get();
          const newMode = !state.isInfinityMode;
          set({ isInfinityMode: newMode });
          if (newMode) {
            get().ensureInfinityQueue();
          }
        },

        ensureInfinityQueue: async () => {
          const state = get();
          if (!state.isInfinityMode || state.isFetchingInfinity) return;

          const currentIndex = state.currentIndex !== null ? state.currentIndex : 0;
          const remaining = Math.max(0, state.playlist.length - 1 - currentIndex);
          
          // Prefetch if there are no upcoming tracks in the queue
          if (remaining < 1 && state.playlist.length > 0) {
            await get().fetchNextInfinityTrack(true);
          }
        },

        fetchNextInfinityTrack: async (isPrefetch = false) => {
          const state = get();
          if (state.isFetchingInfinity) return;
          
          set({ isFetchingInfinity: true });
          try {
            const authHeaders = (state as any).getAuthHeader();
            const payload = {
              sessionHistoryTrackIds: state.sessionHistoryTrackIds,
              settings: {
                discoveryLevel: state.discoveryLevel,
                genreStrictness: state.genreStrictness,
                artistAmnesiaLimit: state.artistAmnesiaLimit,
              }
            };
            const res = await fetch('/api/recommend', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify(payload)
            });
            if (res.ok) {
              const data = await res.json();
              if (data.track) {
                const { mediaAccessToken, authToken, streamingQuality } = state;
                const token = mediaAccessToken || authToken || '';
                const quality = streamingQuality === 'auto' ? '128k' : streamingQuality;

                const track = {
                  ...data.track,
                  isInfinity: true,
                  ...hydrateServerTrack(data.track, token, quality),
                };
                get().addTrackToPlaylist(track);
                if (!isPrefetch) {
                  get().playAtIndex(state.playlist.length); // Play the newly appended track
                }
              } else if (!isPrefetch) {
                get().stop();
              }
            } else if (!isPrefetch) {
               get().stop();
            }
          } catch (e) {
            console.error("Failed to fetch infinity track", e);
            if (!isPrefetch) get().stop();
          } finally {
            set({ isFetchingInfinity: false });
          }
        },

        fetchLibraryFromServer: async () => {
          // Dedup: a second caller (init + health poller) joins the in-flight request.
          if (inFlightLibraryFetch) return inFlightLibraryFetch;
          libraryFetchAbort?.abort();
          const ac = new AbortController();
          libraryFetchAbort = ac;
          set({ isLibraryLoading: true, libraryError: null });
          const run = (async () => {
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/library', { headers: authHeaders, signal: ac.signal });
            if (res.ok) {
              const data = await res.json();
              
              const { mediaAccessToken, authToken, streamingQuality } = get();
              const token = mediaAccessToken || authToken || '';
              const quality = streamingQuality === 'auto' ? '128k' : streamingQuality;

              const libraryWithUrls = data.tracks.map((t: TrackInfo) => hydrateServerTrack(t, token, quality));

              set((state: PlayerState): Partial<PlayerState> => {
                const libraryById = new Map(libraryWithUrls.map((track: TrackInfo) => [track.id, track]));
                const libraryIds = new Set(libraryById.keys());
                const queueChanged = state.playlist.some((track: TrackInfo) => !libraryIds.has(track.id));
                let nextQueue = state.playlist.map((track: TrackInfo) => {
                  const latestTrack = libraryById.get(track.id);
                  return latestTrack
                    ? {
                        ...track,
                        ...latestTrack,
                        queueEntryId: track.queueEntryId,
                        playlistAddedAt: track.playlistAddedAt,
                      }
                    : track;
                });
                let nextIndex = state.currentIndex;
                const refreshedContextMenuTrack = state.contextMenu
                  ? libraryById.get(state.contextMenu.track.id)
                  : null;

                if (queueChanged) {
                  const currentTrack = state.currentIndex !== null ? state.playlist[state.currentIndex] : null;
                  nextQueue = nextQueue.filter((track: TrackInfo) => libraryIds.has(track.id));

                  if (currentTrack && !libraryIds.has(currentTrack.id)) {
                    playbackManager.stop();
                    nextIndex = null;
                  } else if (state.currentIndex !== null && currentTrack) {
                    const remappedIndex = nextQueue.findIndex((track: TrackInfo) => track.id === currentTrack.id);
                    nextIndex = remappedIndex >= 0 ? remappedIndex : null;
                  }
                }

                return {
                  library: libraryWithUrls,
                  libraryFolders: data.directories,
                  artists: data.artists || [] as ArtistInfo[],
                  albums: data.albums || [] as AlbumInfo[],
                  genres: data.genres || [],
                  playlist: nextQueue,
                  currentIndex: nextIndex,
                  contextMenu: state.contextMenu && refreshedContextMenuTrack
                    ? { ...state.contextMenu, track: { ...state.contextMenu.track, ...refreshedContextMenuTrack } }
                    : state.contextMenu,
                  isLibraryLoading: false,
                };
              });
            } else {
              const msg = `Couldn't load your library (server returned ${res.status}).`;
              set({ isLibraryLoading: false, libraryError: msg });
              get().addToast(msg, 'error', { actionLabel: 'Retry', onAction: () => { void get().fetchLibraryFromServer(); } });
            }
          } catch (e) {
            // Aborted on logout — drop silently; don't surface an error or clear loading.
            if (isAbortError(e) || ac.signal.aborted) return;
            console.error("Failed to fetch library from server", e);
            const msg = "Couldn't reach the server to load your library.";
            set({ isLibraryLoading: false, libraryError: msg });
            get().addToast(msg, 'error', { actionLabel: 'Retry', onAction: () => { void get().fetchLibraryFromServer(); } });
          } finally {
            if (libraryFetchAbort === ac) libraryFetchAbort = null;
            inFlightLibraryFetch = null;
          }
          })();
          inFlightLibraryFetch = run;
          return run;
        },

        fetchPlaylistsFromServer: async () => {
           if (inFlightPlaylistsFetch) return inFlightPlaylistsFetch;
           playlistsFetchAbort?.abort();
           const ac = new AbortController();
           playlistsFetchAbort = ac;
           set({ isPlaylistsLoading: true, playlistsError: null });
           const run = (async () => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/playlists', { headers: authHeaders, signal: ac.signal });
              if (res.ok) {
                 const data = await res.json();

                 const { mediaAccessToken, authToken, library } = get();
                 const token = mediaAccessToken || authToken || '';

                 // Map track objects inside playlists to have full stream URLs
                 const populatedPlaylists = data.playlists.map((pl: any) => {
                    const mappedTracks = pl.tracks.map((t: any) => {
                       // Prefer library track (up-to-date art, etc.), fall back to API data
                       const fullTrack = library.find((lt: TrackInfo) => lt.id === t.id);
                       const track = fullTrack ? { ...t, ...fullTrack, playlistAddedAt: t.playlistAddedAt } : t;
                       if (!track.path) return null;
                       const quality = (get().streamingQuality === 'auto' ? '128k' : get().streamingQuality);
                       return {
                         ...track,
                         ...buildTrackUrls(track.id, track.path, token, quality, (track as any).artHash),
                       };
                    }).filter(Boolean);
                    return { ...pl, tracks: mappedTracks };
                 });

                 set({ playlists: populatedPlaylists });
              } else {
                 set({ playlistsError: `Couldn't load playlists (server returned ${res.status}).` });
              }
           } catch (e) {
              if (isAbortError(e) || ac.signal.aborted) return; // aborted on logout
              console.error("Failed to fetch playlists from server", e);
              set({ playlistsError: "Couldn't reach the server to load playlists." });
           } finally {
              if (!ac.signal.aborted) set({ isPlaylistsLoading: false });
              if (playlistsFetchAbort === ac) playlistsFetchAbort = null;
              inFlightPlaylistsFetch = null;
           }
           })();
           inFlightPlaylistsFetch = run;
           return run;
        },

        // Fetch a single playlist with its tracks and upsert it into the
        // playlists array. Avoids the cost of refetching every playlist when
        // the user opens just one. Returns false when the playlist is not
        // accessible (404 / unauthenticated / network failure).
        fetchPlaylistFromServer: async (playlistId: string) => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, { headers: authHeaders });
              if (!res.ok) return false;

              const data = await res.json();
              const pl = data.playlist;
              if (!pl) return false;

              const { mediaAccessToken, authToken, library, streamingQuality } = get();
              const token = mediaAccessToken || authToken || '';
              const quality = (streamingQuality === 'auto' ? '128k' : streamingQuality);

              const mappedTracks = (pl.tracks || []).map((t: any) => {
                 const fullTrack = library.find((lt: TrackInfo) => lt.id === t.id);
                 const track = fullTrack ? { ...t, ...fullTrack, playlistAddedAt: t.playlistAddedAt } : t;
                 if (!track.path) return null;
                 return {
                   ...track,
                   ...buildTrackUrls(track.id, track.path, token, quality, (track as any).artHash),
                 };
              }).filter(Boolean);

              const populated = { ...pl, tracks: mappedTracks };

              set((state) => {
                 const idx = state.playlists.findIndex((p) => p.id === pl.id);
                 if (idx === -1) return { playlists: [populated, ...state.playlists] };
                 const next = state.playlists.slice();
                 next[idx] = populated;
                 return { playlists: next };
              });
              return true;
           } catch (e) {
              console.error('Failed to fetch single playlist from server', e);
              return false;
           }
        },

        createPlaylist: async (title: string, description?: string) => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/playlists', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify({ title, description })
              });
              if (res.ok) {
                 // Server returns the created playlist ({ id, title, description,
                 // isLlmGenerated, tracks: [] }). Capture it before refetching so
                 // callers can navigate straight into the new (empty) playlist.
                 const created = await res.json().catch(() => null);
                 await get().fetchPlaylistsFromServer();
                 return created as Playlist | null;
              }
           } catch (e) {
               console.error("Failed to create playlist", e);
            }
            return null;
         },

         deletePlaylist: async (playlistId: string) => {
            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}`, {
                  method: 'DELETE',
                  headers: authHeaders,
               });
               if (res.ok) {
                  set({ playlists: get().playlists.filter((p: Playlist) => p.id !== playlistId) });
               }
            } catch (e) {
               console.error("Failed to delete playlist", e);
            }
         },

         togglePin: async (playlistId: string, pinned: boolean) => {
            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}/pin`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ pinned })
               });
               if (res.ok) {
                  set({
                     playlists: get().playlists.map((p: Playlist) =>
                        p.id === playlistId ? { ...p, pinned } : p
                     )
                  });
               }
            } catch (e) {
               console.error("Failed to toggle pin", e);
            }
         },

         replaceTracksInUserPlaylist: async (playlistId: string, trackIds: string[]) => {
           const nextTrackIds = dedupeTrackIds(trackIds);
           const previousPlaylists = get().playlists;
           const targetPlaylist = previousPlaylists.find((playlist) => playlist.id === playlistId);
           if (!targetPlaylist) return;

           const myGen = ++playlistMutationGeneration;

           const optimisticTracks = hydratePlaylistTracks(
             nextTrackIds,
             get().library,
             targetPlaylist.tracks,
             get().mediaAccessToken || get().authToken || '',
             get().streamingQuality
           );

           set({
             playlists: previousPlaylists.map((playlist) =>
               playlist.id === playlistId
                 ? { ...playlist, tracks: optimisticTracks }
                 : playlist
             ),
           });

           try {
             const authHeaders = (get() as any).getAuthHeader();
             const res = await fetch(`/api/playlists/${playlistId}/tracks`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json', ...authHeaders },
               body: JSON.stringify({ trackIds: nextTrackIds }),
             });

             if (!res.ok) {
               throw new Error(`Playlist update failed with status ${res.status}`);
             }

             // Only reconcile with the server if a newer optimistic mutation hasn't
             // superseded this one — otherwise the refetch would clobber it.
             if (myGen === playlistMutationGeneration) {
               await get().fetchPlaylistsFromServer();
             }
           } catch (e) {
             // Same guard for rollback: don't revert over a newer edit's state.
             if (myGen === playlistMutationGeneration) {
               set({ playlists: previousPlaylists });
             }
             console.error(`Failed to replace tracks in playlist ${playlistId}`, e);
             throw e;
           }
         },

         addTracksToUserPlaylist: async (playlistId: string, trackIds: string[]) => {
           const existingTrackIds = get().playlists
             .find((playlist) => playlist.id === playlistId)
             ?.tracks
             .map((track) => track.id) || [];

           const mergedTrackIds = dedupeTrackIds([...existingTrackIds, ...trackIds]);
           try {
             await get().replaceTracksInUserPlaylist(playlistId, mergedTrackIds);
           } catch (e) {
             console.error(`Failed to add tracks to playlist ${playlistId}`, e);
             throw e;
           }
        },

        addTracksToLibrary: (newTracks: TrackInfo[]) => set((state: PlayerState) => {
          const existingIds = new Set(state.library.map(t => t.id));
          const uniqueNew = newTracks.filter(t => !existingIds.has(t.id));
          if (uniqueNew.length === 0) return state;
          return { library: [...state.library, ...uniqueNew] };
        }),

        toggleTrackLove: async (track: TrackInfo) => {
          if (!track?.id) return;
          const nextLoved = !track.isLoved;
          const applyLoved = (isLoved: boolean) => set((state: PlayerState) => {
            const updateTrack = (candidate: TrackInfo) =>
              candidate.id === track.id ? { ...candidate, isLoved } : candidate;
            return {
              library: state.library.map(updateTrack),
              playlist: state.playlist.map(updateTrack),
              playlists: state.playlists.map((playlist) => ({
                ...playlist,
                tracks: playlist.tracks.map(updateTrack),
              })),
              contextMenu: state.contextMenu && state.contextMenu.track.id === track.id
                ? { ...state.contextMenu, track: { ...state.contextMenu.track, isLoved } }
                : state.contextMenu,
            };
          });

          applyLoved(nextLoved);

          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/library/love', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ trackId: track.id, loved: nextLoved }),
            });
            if (!res.ok) throw new Error(`Love update failed with status ${res.status}`);

            const data = await res.json().catch(() => null);
            const failedProviders = Array.isArray(data?.providers)
              ? data.providers.filter((provider: any) => provider.status === 'failed')
              : [];
            if (failedProviders.length > 0) {
              get().addToast('Saved locally; one provider sync failed', 'info');
            }
          } catch (error) {
            applyLoved(!!track.isLoved);
            get().addToast('Failed to update favorite', 'error');
            console.error('Failed to update loved track', error);
            throw error;
          }
        },

        deleteTrackFromLibrary: async (trackId: string) => {
          // This would ideally hit a DELETE /api/library/:id endpoint
          // For now we just remove from UI state
          set((state: PlayerState): Partial<PlayerState> => {
            const newLibrary = state.library.filter(t => t.id !== trackId);
            // If the deleted track was the currently playing one in the playlist, stop it.
            let newIndex = state.currentIndex;
            if (state.currentIndex !== null) {
              const currentTrackId = state.playlist[state.currentIndex]?.id;
              if (currentTrackId === trackId) {
                playbackManager.stop();
                newIndex = null;
              }
            }
            // Remove it from the playlist array as well
            const newPlaylist = state.playlist.filter(t => t.id !== trackId);
            // Adjust the newIndex depending on items removed before it
            if (newIndex !== null && newPlaylist.length !== state.playlist.length) {
              const deletedPlaylistIdx = state.playlist.findIndex(t => t.id === trackId);
              if (deletedPlaylistIdx < newIndex) {
                newIndex = newIndex - 1;
              }
            }

            return { library: newLibrary, playlist: newPlaylist, currentIndex: newIndex };
          });
        },

        addLibraryFolder: async (folderPath: string) => {
          const state = get();
          if (state.libraryFolders.includes(folderPath)) return;

          set({ libraryFolders: [...state.libraryFolders, folderPath] });

          try {
            const authHeaders = (get() as any).getAuthHeader();
            
            // Instantly register the folder to the DB so page refreshes don't lose it
            await fetch('/api/library/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ path: folderPath })
            });

            // Queue a scan for JUST this newly added folder
            await get().rescanLibrary(folderPath);
          } catch (e) {
            console.error('Failed to add and scan folder', e);
          }
        },

        removeLibraryFolder: async (folderPath: string) => {
          set((state: PlayerState) => ({
            libraryFolders: state.libraryFolders.filter((f: string) => f !== folderPath)
          }));
          
          try {
            const authHeaders = (get() as any).getAuthHeader();
            await fetch('/api/library/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ path: folderPath })
            });
            await get().fetchLibraryFromServer();
          } catch (e) {
            console.error('Failed to remove folder from backend', e);
          }
        },

        rescanLibrary: async (specificFolder?: string) => {
          const state = get();

          const foldersToScan = specificFolder ? [specificFolder] : state.libraryFolders;

          // Trigger scans sequentially with backoff
          for (const folderPath of foldersToScan) {
            let scanStarted = false;
            while (!scanStarted) {
              try {
                const authHeaders = (get() as any).getAuthHeader();
                const res = await fetch('/api/library/scan', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ path: folderPath })
                });
                
                if (res.status === 400) {
                  const errorData = await res.json();
                  if (errorData.error === 'Scan already in progress') {
                    // Wait if the backend is busy with another directory's scan
                    await new Promise(r => setTimeout(r, 1000));
                  } else {
                    console.error('Scan error:', errorData.error);
                    scanStarted = true; // other 400 error, skip
                  }
                } else if (!res.ok) {
                  console.error('Scan error:', res.statusText);
                  scanStarted = true; // other error, skip
                } else {
                  scanStarted = true; // Success
                }
              } catch (e) {
                console.error(`Failed to trigger scan for ${folderPath}`, e);
                scanStarted = true;
              }
            }
          }

          // Fetch the final library to reflect the new tracks
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const fetchRes = await fetch('/api/library', { headers: authHeaders });
            if (fetchRes.ok) {
              const data = await fetchRes.json();
              
              const { mediaAccessToken, authToken, streamingQuality } = get();
              const token = mediaAccessToken || authToken || '';
              const quality = streamingQuality === 'auto' ? '128k' : streamingQuality;

              const latestLibrary = data.tracks.map((t: TrackInfo) => hydrateServerTrack(t, token, quality));
              set({
                library: latestLibrary,
                 artists: data.artists || [] as ArtistInfo[],
                 albums: data.albums || [] as AlbumInfo[],
                genres: data.genres || []
              });
            }
          } catch (e) {
            console.error('Failed to fetch updated library', e);
          }
        },

        setPlaylist: async (playlist: TrackInfo[], startIndex: number = 0) => {
          const queuePlaylist = playlist.map((track) => cloneTrackForQueue(track));
          set({ playlist: queuePlaylist, currentIndex: startIndex });
          persistContinuitySnapshot(true);
          if (queuePlaylist.length > 0 && startIndex < queuePlaylist.length) {
            await get().playAtIndex(startIndex);
          } else {
            get().stop();
          }
        },

        addTrackToPlaylist: (track: TrackInfo, options?: QueueMutationOptions) => set((state: PlayerState) => {
          const snapshot = options?.undo ? state.playlist.map((item) => ({ ...item })) : null;
          const snapshotIndex = state.currentIndex;
          const queueTrack = cloneTrackForQueue(track);
          const nextPlaylist = [...state.playlist, queueTrack];
          if (castManager.isConnected()) {
            void castManager.appendToQueue(queueTrack);
          }
          prewarmNextFromState({ ...state, playlist: nextPlaylist });
          queueMicrotask(() => {
            persistContinuitySnapshot(true);
            if (options?.notify) {
              const title = queueTrack.title || queueTrack.path.split(/[\\/]/).pop() || 'track';
              get().addToast(options.message || `Added "${title}" to queue.`, 'success', options.undo && snapshot ? {
                actionLabel: 'Undo',
                onAction: () => get().restoreQueueSnapshot(snapshot, snapshotIndex),
                duration: 6500,
              } : undefined);
            }
          });
          return { playlist: nextPlaylist };
        }),

        playNext: (track: TrackInfo, options?: QueueMutationOptions) => set((state: PlayerState) => {
          const snapshot = options?.undo ? state.playlist.map((item) => ({ ...item })) : null;
          const snapshotIndex = state.currentIndex;
          const newPlaylist = [...state.playlist];
          const insertAt = state.currentIndex !== null ? state.currentIndex + 1 : newPlaylist.length;
          const queueTrack = cloneTrackForQueue(track);
          newPlaylist.splice(insertAt, 0, queueTrack);
          if (castManager.isConnected()) {
            void castManager.insertNextInQueue(queueTrack);
          }
          prewarmNextFromState({ ...state, playlist: newPlaylist });
          queueMicrotask(() => {
            persistContinuitySnapshot(true);
            if (options?.notify) {
              const title = queueTrack.title || queueTrack.path.split(/[\\/]/).pop() || 'track';
              get().addToast(options.message || `Will play "${title}" next.`, 'success', options.undo && snapshot ? {
                actionLabel: 'Undo',
                onAction: () => get().restoreQueueSnapshot(snapshot, snapshotIndex),
                duration: 6500,
              } : undefined);
            }
          });
          return { playlist: newPlaylist };
        }),

        // Global context menu
        contextMenu: null as { track: TrackInfo; x: number; y: number; playlistId?: string; playlistTrackIndex?: number } | null,
        openContextMenu: (track: TrackInfo, x: number, y: number, playlistId?: string, playlistTrackIndex?: number) => set({ contextMenu: { track, x, y, playlistId, playlistTrackIndex } }),
        closeContextMenu: () => set({ contextMenu: null }),

        removeFromPlaylist: (index: number) => set((state: PlayerState) => {
          const newPlaylist = [...state.playlist];
          const [removed] = newPlaylist.splice(index, 1);

          let newIndex = state.currentIndex;
          if (state.currentIndex === index) {
            if (castManager.isConnected()) {
              newIndex = state.currentIndex;
            } else {
              playbackManager.stop();
              newIndex = null;
            }
          } else if (state.currentIndex !== null && index < state.currentIndex) {
            newIndex = state.currentIndex - 1;
          }
          if (castManager.isConnected() && removed?.queueEntryId) {
            void castManager.removeFromQueue(removed.queueEntryId);
          }
          prewarmNextFromState({ ...state, playlist: newPlaylist, currentIndex: newIndex }, newIndex);
          queueMicrotask(() => persistContinuitySnapshot(true));
          return { playlist: newPlaylist, currentIndex: newIndex };
        }),

        moveInPlaylist: (fromIndex: number, toIndex: number) => set((state: PlayerState) => {
          const newPlaylist = [...state.playlist];
          const [moved] = newPlaylist.splice(fromIndex, 1);
          if (!moved) return state;
          newPlaylist.splice(toIndex, 0, moved);

          let newIndex = state.currentIndex;
          if (state.currentIndex !== null) {
            if (state.currentIndex === fromIndex) {
              newIndex = toIndex;
            } else {
              if (fromIndex < state.currentIndex && toIndex >= state.currentIndex) newIndex = state.currentIndex - 1;
              if (fromIndex > state.currentIndex && toIndex <= state.currentIndex) newIndex = state.currentIndex + 1;
            }
          }
          if (castManager.isConnected() && moved?.queueEntryId) {
            void castManager.moveQueueItem(moved.queueEntryId, toIndex);
          }

          prewarmNextFromState({ ...state, playlist: newPlaylist, currentIndex: newIndex }, newIndex);
          queueMicrotask(() => persistContinuitySnapshot(true));
          return { playlist: newPlaylist, currentIndex: newIndex };
        }),

        clearPlaylist: () => {
          playbackManager.stop();
          if (castManager.isConnected()) {
            castManager.stop();
          }
          setPlaybackTimeState({ currentTime: 0, duration: 0 });
          set({
            playlist: [],
            currentIndex: null,
            playbackState: 'stopped',
            isBuffering: false,
          });
          persistContinuitySnapshot(true);
        },

        restoreQueueSnapshot: (playlist: TrackInfo[], currentIndex: number | null) => {
          const restored = ensureQueueEntryIds(playlist.map((track) => ({ ...track }))).tracks;
          const boundedIndex = currentIndex !== null && restored[currentIndex] ? currentIndex : (restored.length ? 0 : null);
          set({
            playlist: restored,
            currentIndex: boundedIndex,
          });
          prewarmNextFromState({ ...get(), playlist: restored, currentIndex: boundedIndex }, boundedIndex);
          persistContinuitySnapshot(true);

          if (castManager.isConnected() && boundedIndex !== null) {
            const { repeat } = get();
            void castManager.ensureQueuePlayback(
              restored.map((item) => ({
                queueEntryId: item.queueEntryId,
                url: item.url || '',
                rawUrl: item.rawUrl || '',
                title: item.title || 'Unknown Title',
                artist: item.artist || ((item.artists as string[])?.join(', ')) || 'Unknown Artist',
                artUrl: item.artUrl,
                album: item.album,
                format: item.format,
                duration: item.duration,
              })),
              boundedIndex,
              repeat
            );
          }
        },

        // Playback Actions
        playAtIndex: async (index: number) => {
          const { volume, repeat } = get();
          const normalized = ensureQueueEntryIds(get().playlist);
          const playlist = normalized.tracks;
          if (normalized.changed) {
            set({ playlist });
          }
          const track = playlist[index];
          if (!track) return;

          // Rebuild stream/raw/art URLs from the CURRENT media token rather than
          // trusting the persisted URL: the token may have rotated since the track
          // was queued (most visibly across an offline reload), in which case the
          // baked-in token fails auth — and because `url` is non-empty, the
          // fileHandle fallback below is skipped, so the track dies silently.
          // For server tracks (those with a base64 `path`) this also keeps the SW
          // cache key stable within a session. Local-only tracks (fileHandle, no
          // path) are left untouched.
          const { mediaAccessToken, authToken, streamingQuality } = get();
          const freshToken = mediaAccessToken || authToken || '';
          const freshQuality = streamingQuality === 'auto' ? '128k' : streamingQuality;
          const playable: TrackInfo = track.path && freshToken
            ? { ...track, ...buildTrackUrls(track.id, track.path, freshToken, freshQuality, (track as any).artHash) }
            : track;

          const generation = ++playGeneration;

          // Immediately set the DB-known duration so the UI doesn't flash "0:10"
          // while waiting for hls.js to parse the full manifest.
          setPlaybackTimeState({ currentTime: 0, duration: track.duration || 0 });
          set({ isBuffering: true });

          try {
            // Set volume before playing
            playbackManager.setVolume(volume);

            if (castManager.isConnected()) {
              await castManager.ensureQueuePlayback(
                playlist.map((item) => ({
                  queueEntryId: item.queueEntryId,
                  url: item.url || '',
                  rawUrl: item.rawUrl || '',
                  title: item.title || 'Unknown Title',
                  artist: item.artist || ((item.artists as string[])?.join(', ')) || 'Unknown Artist',
                  artUrl: item.artUrl,
                  album: item.album,
                  format: item.format,
                  duration: item.duration,
                })),
                index,
                repeat
              );
            } else if (playable.url) {
              // Not casting: play locally — pass both HLS and raw URLs (rebuilt
              // with the current token above).
              await playbackManager.playUrl(playable.url, playable.rawUrl || '', playable.title, playable.artist || ((playable.artists as string[])?.join(', ')), playable.artUrl, playable.album, playable.format);
            } else if (track.fileHandle) {
               // Fallback for local file handles
               await playbackManager.playFile(track.fileHandle);
            }
            // A newer playAtIndex call has taken over — discard this result
            if (generation !== playGeneration) return;
            set({ currentIndex: index, isBuffering: false, _scrobbleStartAt: Date.now(), _scrobbleEligible: false });
            persistContinuitySnapshot(true);

            // Telemetry: record successful playback and push to session history
            get().recordPlay(track.id);

            // Send "now playing" to scrobble providers if connected
            const state = get();
            if (track.artist && track.title) {
              const authHeaders = (get() as any).getAuthHeader();
              const nowPlayingBody = JSON.stringify({
                artist: track.artist,
                track: track.title,
                album: track.album || '',
                albumArtist: track.albumArtist || '',
                duration: track.duration ? Math.round(track.duration) : undefined,
                mbid: track.mbTrackId || '',
              });
              if (state.lastFmConnected && state.lastFmScrobbleEnabled) {
                fetch('/api/providers/lastfm/now-playing', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: nowPlayingBody,
                }).catch(() => {});
              }
              if (state.listenBrainzConnected && state.listenBrainzScrobbleEnabled) {
                fetch('/api/providers/listenbrainz/now-playing', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: nowPlayingBody,
                }).catch(() => {});
              }
            }

            // Pre-fetch infinite track if bounds are reached
            get().ensureInfinityQueue();
            prewarmNextFromState(get(), index);
          } catch (e) {
            // A newer playAtIndex call has taken over — don't chain into nextTrack
            if (generation !== playGeneration) return;
            set({ isBuffering: false });
            console.error("Error playing track", e);
            get().nextTrack();
          }
        },

        pause: () => {
          playbackManager.pause();
          persistContinuitySnapshot(true);
        },

        resume: async () => {
          await playbackManager.resume();
          persistContinuitySnapshot(true);
        },

        stop: () => {
          playbackManager.stop();
          setPlaybackTimeState({ currentTime: 0, duration: 0 });
          set({ currentIndex: null, playbackState: 'stopped' });
          persistContinuitySnapshot(true);
        },

        nextTrack: async (options?: NextTrackOptions) => {
          const { playlist, currentIndex, shuffle } = get();
          if (playlist.length === 0) return;

          // Telemetry: record skip for the track we are leaving
          if (currentIndex !== null && playlist[currentIndex]) {
            get().recordSkip(playlist[currentIndex].id);
          }

          let nextIndex = 0;
          if (shuffle) {
            nextIndex = Math.floor(Math.random() * playlist.length);
          } else if (currentIndex !== null) {
            nextIndex = (currentIndex + 1) % playlist.length;
          }

          if (options?.notifyUpNext && playlist.length > 1) {
            const upcoming = playlist[nextIndex];
            if (upcoming) {
              const title = upcoming.title || upcoming.path.split(/[\\/]/).pop() || 'track';
              get().addToast(`Up next: ${title}`, 'info', { duration: 3200 });
            }
          }

          await get().playAtIndex(nextIndex);
        },

        prevTrack: async () => {
          const { playlist, currentIndex } = get();
          const { currentTime } = getPlaybackTimeSnapshot();
          if (playlist.length === 0) return;

          // If we are more than 3 seconds in, just restart the track
          if (currentTime > 3 && currentIndex !== null) {
            playbackManager.seek(0);
            setPlaybackCurrentTime(0);
            persistContinuitySnapshot(true);
            return;
          }

          let prevIndex = playlist.length - 1;
          if (currentIndex !== null) {
            prevIndex = (currentIndex - 1 + playlist.length) % playlist.length;
          }

          await get().playAtIndex(prevIndex);
        },

        setVolume: (v: number) => {
          playbackManager.setVolume(v);
          set({ volume: v });
        },

        sleepTimerEndsAt: null,
        startSleepTimer: (minutes: number) => {
          clearSleepTimers();
          if (!minutes || minutes <= 0) {
            playbackManager.setVolume(get().volume); // undo any in-progress fade
            set({ sleepTimerEndsAt: null });
            return;
          }
          const totalMs = minutes * 60000;
          set({ sleepTimerEndsAt: Date.now() + totalMs });
          const fadeStartDelay = Math.max(0, totalMs - SLEEP_FADE_MS);
          sleepTimerTimeout = setTimeout(() => {
            const startVol = get().volume;
            const fadeStart = Date.now();
            sleepFadeInterval = setInterval(() => {
              const frac = Math.min(1, (Date.now() - fadeStart) / SLEEP_FADE_MS);
              playbackManager.setVolume(startVol * (1 - frac));
              if (frac >= 1) {
                clearSleepTimers();
                get().pause();
                playbackManager.setVolume(startVol); // restore for the next manual play
                set({ sleepTimerEndsAt: null });
                get().addToast('Sleep timer ended playback.', 'info');
              }
            }, 250);
          }, fadeStartDelay);
        },
        cancelSleepTimer: () => {
          clearSleepTimers();
          playbackManager.setVolume(get().volume); // restore if cancelled mid-fade
          set({ sleepTimerEndsAt: null });
        },

        selectAudioOutput: async () => {
          const state = get();
          if (state.castConnected) {
            state.addToast('Disconnect Cast before choosing a local output.', 'info');
            return;
          }

          const output = await playbackManager.selectAudioOutputDevice(undefined);
          if (output.error) {
            state.addToast(output.error, 'error');
          } else if (output.active) {
            state.addToast(`Playing on ${output.label || 'selected output'}.`, 'success');
          } else {
            state.addToast('Using system default audio output.', 'info');
          }
        },

        setAudioOutputDevice: async (deviceId: string) => {
          const state = get();
          if (state.castConnected) {
            state.addToast('Disconnect Cast before choosing a local output.', 'info');
            return;
          }

          const output = deviceId
            ? await playbackManager.selectAudioOutputDevice(deviceId)
            : await playbackManager.clearAudioOutputDevice();
          if (output.error) {
            state.addToast(output.error, 'error');
          } else if (output.active) {
            state.addToast(`Playing on ${output.label || 'selected output'}.`, 'success');
          } else {
            state.addToast('Using system default audio output.', 'info');
          }
        },

        refreshAudioOutputs: async () => {
          const output = await audioOutputManager.refreshDevices();
          if (output.error) {
            get().addToast(output.error, 'error');
          }
        },

        clearAudioOutput: async () => {
          await playbackManager.clearAudioOutputDevice();
          get().addToast('Using system default audio output.', 'info');
        },

        toggleShuffle: () => set((state: PlayerState) => ({ shuffle: !state.shuffle })),

        cycleRepeat: () => set((state: PlayerState) => {
          const nextMode = state.repeat === 'none' ? 'all' : state.repeat === 'all' ? 'one' : 'none';
          if (castManager.isConnected()) {
            void castManager.setRepeatMode(nextMode);
          }
          return { repeat: nextMode };
        }),

        setCastConnected: (connected: boolean) => set({ castConnected: connected }),

        syncTimeUpdate: (time: number) => setPlaybackCurrentTime(time),
        syncDuration: (duration: number) => setPlaybackDuration(duration),
        syncPlaybackState: (state: PlaybackState) => set({ playbackState: state }),
        recordPlaybackTelemetry: (telemetry: Partial<PlaybackTelemetry>) => set((state: PlayerState) => ({
          playbackTelemetry: {
            ...state.playbackTelemetry,
            ...telemetry,
            lastUpdatedAt: Date.now(),
          },
        })),
        
        setLastFmApiKey: (key: string) => set({ lastFmApiKey: key }),
        setLastFmSharedSecret: (secret: string) => set({ lastFmSharedSecret: secret }),
        setLastFmScrobbleEnabled: (enabled: boolean) => set({ lastFmScrobbleEnabled: enabled }),
        setLastFmConnected: (connected: boolean) => set({ lastFmConnected: connected }),
        setLastFmUsername: (username: string) => set({ lastFmUsername: username }),
        setListenBrainzScrobbleEnabled: (enabled: boolean) => set({ listenBrainzScrobbleEnabled: enabled }),
        setListenBrainzConnected: (connected: boolean) => set({ listenBrainzConnected: connected }),
        setListenBrainzUsername: (username: string) => set({ listenBrainzUsername: username }),
        setGeniusApiKey: (key: string) => set({ geniusApiKey: key }),
        setMusicBrainzEnabled: (enabled: boolean) => set({ musicBrainzEnabled: enabled }),
        setMusicBrainzClientId: (id: string) => set({ musicBrainzClientId: id }),
        setMusicBrainzClientSecret: (secret: string) => set({ musicBrainzClientSecret: secret }),
        setMusicBrainzConnected: (connected: boolean) => set({ musicBrainzConnected: connected }),
        setMusicBrainzRedirectUri: (uri: string) => set({ musicBrainzRedirectUri: uri }),
        setProviderArtistImage: (provider: 'lastfm' | 'genius' | 'musicbrainz') => set({ providerArtistImage: provider }),
        setProviderArtistArtwork: (provider: 'genius' | 'none') => set({ providerArtistArtwork: provider }),
        setProviderArtistBio: (provider: 'lastfm' | 'genius') => set({ providerArtistBio: provider }),
        setProviderAlbumArt: (provider: 'lastfm' | 'genius' | 'musicbrainz') => set({ providerAlbumArt: provider }),
        setLlmConnected: (connected: boolean) => set({ llmConnected: connected }),

        recordPlay: (trackId: string) => {
          // Push trackId to the 50-item rolling session history
          set((state: PlayerState) => {
            const updated = [...state.sessionHistoryTrackIds, trackId].slice(-50);
            return { sessionHistoryTrackIds: updated };
          });
          // Fire-and-forget telemetry to backend
          const authHeaders = (get() as any).getAuthHeader();
          fetch('/api/playback/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ trackId })
          }).catch((e: Error) => console.warn('Telemetry record failed:', e));
        },

        recordSkip: (trackId: string) => {
          // Fire-and-forget telemetry to backend
          const authHeaders = (get() as any).getAuthHeader();
          fetch('/api/playback/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ trackId })
          }).catch((e: Error) => console.warn('Telemetry skip failed:', e));
        },

        toasts: [],
        addToast: (message: string, type: ToastType, options?: { actionLabel?: string; onAction?: () => void; duration?: number }) => {
          const id = Date.now();
          set((state: PlayerState) => ({
            toasts: [...state.toasts, {
              id,
              message,
              type,
              duration: options?.duration,
              actionLabel: options?.actionLabel,
              onAction: options?.onAction,
            }]
          }));
        },
        removeToast: (id: number) => {
          set((state: PlayerState) => ({
            toasts: state.toasts.filter(t => t.id !== id)
          }));
        },

        pendingUpdate: false,
        setPendingUpdate: (val: boolean) => {
          set({ pendingUpdate: val } as Partial<PlayerState>);
        },

        autoplayBlocked: false,
        setAutoplayBlocked: (val: boolean) => {
          set({ autoplayBlocked: val } as Partial<PlayerState>);
        },
      };
    },
    {
      name: "player-store",
      // Only persist lightweight user settings, NOT the library.
      // The library is always fetched fresh from the server on boot.
      partialize: (state: PlayerState) => ({
        volume: state.volume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        theme: state.theme,
        reducedMotion: state.reducedMotion,
        lastFmApiKey: state.lastFmApiKey,
        lastFmScrobbleEnabled: state.lastFmScrobbleEnabled,
        lastFmConnected: state.lastFmConnected,
        lastFmUsername: state.lastFmUsername,
        listenBrainzScrobbleEnabled: state.listenBrainzScrobbleEnabled,
        listenBrainzConnected: state.listenBrainzConnected,
        listenBrainzUsername: state.listenBrainzUsername,
        geniusApiKey: state.geniusApiKey,
        musicBrainzEnabled: state.musicBrainzEnabled,
        musicBrainzClientId: state.musicBrainzClientId,
        musicBrainzClientSecret: state.musicBrainzClientSecret,
        musicBrainzConnected: state.musicBrainzConnected,
        musicBrainzRedirectUri: state.musicBrainzRedirectUri,
        llmConnected: state.llmConnected,
        providerArtistImage: state.providerArtistImage,
        providerArtistArtwork: state.providerArtistArtwork,
        providerArtistBio: state.providerArtistBio,
        providerAlbumArt: state.providerAlbumArt,
        authToken: state.authToken,
        mediaAccessToken: state.mediaAccessToken,
        sseAccessToken: state.sseAccessToken,
        currentUser: state.currentUser,
        streamingQuality: state.streamingQuality,
        playbackDebugLogging: state.playbackDebugLogging,
        prebufferPolicy: state.prebufferPolicy,
        audioOutputDeviceId: state.audioOutputDeviceId,
        audioOutputDeviceLabel: state.audioOutputDeviceLabel,
        // Persist playlist and stable playback state; resume position is handled by the throttled continuity snapshot.
        playlist: state.playlist ? state.playlist.map((t: TrackInfo) => {
          const { fileHandle, ...rest } = t;
          return rest;
        }) : [],
        currentIndex: state.currentIndex,
        playbackState: state.playbackState,
      }),
      onRehydrateStorage: () => (state) => {
        setPlaybackDebugLogging(state?.playbackDebugLogging === true);
        castManager.setDiagnosticsVerbose(state?.playbackDebugLogging === true);
      },
    }
  )
);
