import React, { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Disc3,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pin,
  Play,
  Plus,
  Sparkles,
} from 'lucide-react';
import { AlbumArt } from '../AlbumArt';
import { LoveButton } from '../LoveButton';
import { BackButton } from './BackButton';
import { useDominantColor } from '../../hooks/useDominantColor';
import { useToast } from '../../hooks/useToast';
import { usePlayerStore } from '../../store';
import { formatTime } from '../../utils/formatTime';
import { parseArtists } from '../../utils/artistUtils';
import type { TrackInfo } from '../../utils/fileSystem';
import { getSuggestedPlaylistTracks } from '../../utils/playlistSuggestions';

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes} min`;
}

function formatPlaylistAddedDate(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '--';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

function reorderTracks(tracks: TrackInfo[], fromIndex: number, toIndex: number): TrackInfo[] {
  const nextTracks = [...tracks];
  const [moved] = nextTracks.splice(fromIndex, 1);
  if (!moved) return tracks;
  nextTracks.splice(toIndex, 0, moved);
  return nextTracks;
}

function buildBackdropTiles(artUrls: string[]): Array<string | null> {
  const count = artUrls.length > 0 ? 30 : 18;
  if (artUrls.length === 0) {
    return Array.from({ length: count }, () => null);
  }

  return Array.from({ length: count }, (_, index) => artUrls[(index * 5 + Math.floor(index / 4)) % artUrls.length]);
}

interface PlaylistTrackRowProps {
  id: string;
  track: TrackInfo;
  index: number;
  totalTracks: number;
  getArtistLink: (artistName: string, track: TrackInfo) => string | null;
  onPlay: (index: number) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onContextMenu: (track: TrackInfo, x: number, y: number, playlistId: string, playlistTrackIndex: number) => void;
  playlistId: string;
}

const PlaylistTrackRow = memo(({
  id,
  track,
  index,
  totalTracks,
  getArtistLink,
  onPlay,
  onMove,
  onContextMenu,
  playlistId,
}: PlaylistTrackRowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const artistNames = Array.isArray(track.artists) && track.artists.length > 0
    ? track.artists
    : parseArtists(track.artist || track.albumArtist || '');

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 10 : 1,
      }}
      className="grid grid-cols-[28px_44px_minmax(0,1fr)_56px_40px] md:grid-cols-[34px_52px_minmax(0,1.4fr)_minmax(0,1fr)_120px_92px_40px] gap-2 md:gap-3 px-2 md:px-4 py-2 border-b border-black/5 dark:border-white/5 cursor-pointer items-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg my-0.5 group"
    >
      <div
        className="text-center md:text-left text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm tabular-nums"
        onClick={() => onPlay(index)}
      >
        {index + 1}
      </div>

      <div className="w-11 h-11 md:w-13 md:h-13 shrink-0 overflow-hidden rounded-lg md:rounded-xl border border-black/10 dark:border-white/10 bg-black/10 dark:bg-white/10">
        {track.artUrl ? (
          <img src={track.artUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Disc3 className="h-5 w-5 text-[var(--color-text-muted)] opacity-40" />
          </div>
        )}
      </div>

      <div className="min-w-0" onClick={() => onPlay(index)}>
        <span className="block truncate text-sm md:text-base font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
          {track.title || track.path.split(/[\\/]/).pop()}
        </span>
        <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
          {artistNames.length > 0 ? artistNames.map((artistName, artistIndex) => {
            const artistLink = getArtistLink(artistName, track);
            return (
              <React.Fragment key={`${artistName}-${artistIndex}`}>
                {artistIndex > 0 && ' · '}
                {artistLink ? (
                  <Link
                    to={artistLink}
                    state={{ backLabel: 'Back to Playlist' }}
                    onClick={(event) => event.stopPropagation()}
                    className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                  >
                    {artistName}
                  </Link>
                ) : (
                  <span>{artistName}</span>
                )}
              </React.Fragment>
            );
          }) : 'Unknown Artist'}
        </span>
      </div>

      <div className="hidden md:block min-w-0">
        <span className="block truncate text-sm text-[var(--color-text-secondary)]">
          {track.album || '--'}
        </span>
      </div>

      <div className="hidden md:block text-sm text-[var(--color-text-muted)] tabular-nums">
        {formatPlaylistAddedDate(track.playlistAddedAt)}
      </div>

      <div className="text-[var(--color-text-muted)] flex flex-row items-center justify-end md:justify-start md:gap-2">
        <span className="w-12 text-right md:text-left hidden md:inline text-sm tabular-nums">
          {formatTime(track.duration, '--:--')}
        </span>
        <span className="w-12 text-right text-sm tabular-nums md:hidden">
          {formatTime(track.duration, '--:--')}
        </span>
      </div>

      <div className="text-[var(--color-text-muted)] flex flex-row items-center justify-end md:gap-2">
        <div className="flex flex-col md:hidden mr-1">
          <button
            aria-label="Move up"
            onClick={(event) => {
              event.stopPropagation();
              if (index > 0) onMove(index, index - 1);
            }}
            disabled={index === 0}
            className="p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
          >
            <ChevronUp size={14} />
          </button>
          <button
            aria-label="Move down"
            onClick={(event) => {
              event.stopPropagation();
              if (index < totalTracks - 1) onMove(index, index + 1);
            }}
            disabled={index === totalTracks - 1}
            className="p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
          >
            <ChevronDown size={14} />
          </button>
        </div>

        <div className="opacity-100 md:opacity-0 md:group-hover:opacity-100 flex items-center transition-opacity">
          <LoveButton track={track} size={16} className="p-1.5" />
          <button
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
            onClick={(event) => event.stopPropagation()}
            className="hidden md:flex cursor-grab text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/10 rounded-md p-1.5 active:cursor-grabbing"
          >
            <GripVertical size={18} />
          </button>
          <button
            aria-label="More options"
            onClick={(event) => {
              event.stopPropagation();
              onContextMenu(track, event.clientX, event.clientY, playlistId, index);
            }}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/10 rounded-md p-1.5"
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
      </div>
    </div>
  );
});

PlaylistTrackRow.displayName = 'PlaylistTrackRow';

export const PlaylistDetail: React.FC = () => {
  const { playlistId } = useParams<{ playlistId: string }>();
  const navigate = useNavigate();
  const { addToast } = useToast();

  const playlists = usePlayerStore((state) => state.playlists);
  const library = usePlayerStore((state) => state.library);
  const artists = usePlayerStore((state) => state.artists);
  const currentUser = usePlayerStore((state) => state.currentUser);
  const setPlaylist = usePlayerStore((state) => state.setPlaylist);
  const playNext = usePlayerStore((state) => state.playNext);
  const openContextMenu = usePlayerStore((state) => state.openContextMenu);
  const replaceTracksInUserPlaylist = usePlayerStore((state) => state.replaceTracksInUserPlaylist);
  const addTracksToUserPlaylist = usePlayerStore((state) => state.addTracksToUserPlaylist);

  const playlist = useMemo(
    () => playlists.find((entry) => entry.id === playlistId),
    [playlists, playlistId]
  );

  const playlistTracks = playlist?.tracks || [];
  const deferredPlaylistTracks = useDeferredValue(playlistTracks);
  const { bgColor } = useDominantColor(playlistTracks);

  const heroArtUrls = useMemo(
    () => Array.from(new Set(playlistTracks.map((track) => track.artUrl).filter(Boolean) as string[])).slice(0, 8),
    [playlistTracks]
  );

  const backdropTiles = useMemo(
    () => buildBackdropTiles(heroArtUrls),
    [heroArtUrls]
  );

  const sortableItems = useMemo(
    () => playlistTracks.map((track, index) => `${track.id}-${index}`),
    [playlistTracks]
  );

  const totalDuration = useMemo(
    () => playlistTracks.reduce((sum, track) => sum + (track.duration || 0), 0),
    [playlistTracks]
  );

  const artistCount = useMemo(() => {
    const seen = new Set<string>();
    for (const track of playlistTracks) {
      const names = Array.isArray(track.artists) && track.artists.length > 0
        ? track.artists
        : parseArtists(track.artist || track.albumArtist || '');
      for (const name of names) {
        if (name) seen.add(name.toLowerCase());
      }
    }
    return seen.size;
  }, [playlistTracks]);

  const suggestionEntries = useMemo(
    () => getSuggestedPlaylistTracks(library, deferredPlaylistTracks, 8),
    [library, deferredPlaylistTracks]
  );

  const [saveLabel, setSaveLabel] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const setSavingState = useCallback((label: string | null, saving: boolean) => {
    setSaveLabel(label);
    setIsSaving(saving);
  }, []);

  const getArtistLink = useCallback((artistName: string, track: TrackInfo): string | null => {
    const entity = artists.find((entry) => entry.name?.toLowerCase() === artistName.toLowerCase());
    if (entity) return `/library/artist/${entity.id}`;
    if (track.artistId) return `/library/artist/${track.artistId}`;
    return null;
  }, [artists]);

  const persistTracks = useCallback(
    async (nextTracks: TrackInfo[], pendingLabel: string, successMessage: string) => {
      if (!playlist) return;

      setSavingState(pendingLabel, true);
      try {
        await replaceTracksInUserPlaylist(playlist.id, nextTracks.map((track) => track.id));
        setSavingState(successMessage, false);
        window.setTimeout(() => {
          setSaveLabel((current) => (current === successMessage ? null : current));
        }, 1200);
      } catch {
        setSavingState(null, false);
        addToast('Failed to update playlist.', 'error');
      }
    },
    [addToast, playlist, replaceTracksInUserPlaylist, setSavingState]
  );

  const handlePlayFromIndex = useCallback((startIndex: number) => {
    if (playlistTracks.length === 0) return;
    void setPlaylist(playlistTracks, startIndex);
  }, [playlistTracks, setPlaylist]);

  const handleMoveTrack = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const nextTracks = reorderTracks(playlistTracks, fromIndex, toIndex);
    void persistTracks(nextTracks, 'Saving order...', 'Order saved');
  }, [persistTracks, playlistTracks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    const fromIndex = sortableItems.indexOf(activeId);
    const toIndex = sortableItems.indexOf(overId);

    if (fromIndex !== -1 && toIndex !== -1) {
      const nextTracks = reorderTracks(playlistTracks, fromIndex, toIndex);
      void persistTracks(nextTracks, 'Saving order...', 'Order saved');
    }
  }, [persistTracks, playlistTracks, sortableItems]);

  const handleAddSuggestion = useCallback(async (track: TrackInfo) => {
    if (!playlist) return;

    setSavingState('Adding track...', true);
    try {
      await addTracksToUserPlaylist(playlist.id, [track.id]);
      setSavingState('Track added', false);
      window.setTimeout(() => {
        setSaveLabel((current) => (current === 'Track added' ? null : current));
      }, 1200);
    } catch {
      setSavingState(null, false);
      addToast('Failed to add track to playlist.', 'error');
    }
  }, [addToast, addTracksToUserPlaylist, playlist, setSavingState]);

  if (!playlistId) {
    return <div className="page-container">Playlist not found.</div>;
  }

  if (!playlist) {
    return (
      <div className="page-container">
        <BackButton onClick={() => navigate('/playlists')}>Back to Playlists</BackButton>
        <div className="text-[var(--color-text-muted)]">Playlist not found.</div>
      </div>
    );
  }

  return (
    <div className="page-container relative overflow-x-hidden">
      <div className="pointer-events-none absolute left-1/2 top-0 h-[32rem] md:h-[44rem] w-screen -translate-x-1/2 overflow-hidden z-0">
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at top, color-mix(in srgb, ${bgColor} 18%, transparent) 0%, transparent 64%)`,
          }}
        />
        <div
          className="absolute left-1/2 top-[-4%] grid w-[165vw] md:w-[138vw] lg:w-[118vw] grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 opacity-20 md:opacity-25"
          style={{
            transform: 'translateX(-50%) rotate(-18deg) scale(1.1)',
            WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 10%, rgba(0,0,0,0.56) 18%, rgba(0,0,0,0.26) 24%, rgba(0,0,0,0.10) 30%, rgba(0,0,0,0.03) 36%, transparent 42%)',
            maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 10%, rgba(0,0,0,0.56) 18%, rgba(0,0,0,0.26) 24%, rgba(0,0,0,0.10) 30%, rgba(0,0,0,0.03) 36%, transparent 42%)',
          }}
        >
          {backdropTiles.map((tile, index) => (
            <div
              key={`${tile || 'empty'}-${index}`}
              className="aspect-square overflow-hidden rounded-[1.4rem] border border-white/10 bg-black/5 shadow-xl dark:bg-white/5"
            >
              {tile ? (
                <img src={tile} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Disc3 className="h-8 w-8 text-[var(--color-text-muted)] opacity-30" />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-[var(--color-bg)]/14 via-transparent via-10% to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent via-18% to-[var(--color-bg)]/82" />
        <div className="absolute bottom-0 left-0 w-full h-44 md:h-56 bg-gradient-to-t from-[var(--color-bg)] via-[var(--color-bg)]/94 via-46% to-transparent" />
        <div className="absolute bottom-0 left-0 w-full h-24 md:h-32 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.08)_0%,transparent_72%)] dark:bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.05)_0%,transparent_72%)]" />
      </div>

      <div className="relative z-10">
        <BackButton onClick={() => navigate('/playlists')}>Back to Playlists</BackButton>

        <div className="flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
          <div className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl relative overflow-hidden backdrop-blur-xl bg-black/10 dark:bg-white/5">
            <div className="grid h-full w-full grid-cols-2 gap-0.5">
              {(heroArtUrls.length > 0 ? heroArtUrls.slice(0, 4) : [null, null, null, null]).map((artUrl, index) => (
                <div key={`${artUrl || 'fallback'}-${index}`} className="overflow-hidden bg-black/10 dark:bg-white/10">
                  {artUrl ? (
                    <img src={artUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Disc3 className="h-8 w-8 text-[var(--color-text-muted)] opacity-40" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col justify-end items-center md:items-start max-w-full">
            <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">
              {playlist.isLlmGenerated ? 'AI Curated Playlist' : `Playlist by ${currentUser?.username || 'You'}`}
            </div>

            <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight my-2 leading-tight text-[var(--color-text-primary)] line-clamp-2" title={playlist.title}>
              {playlist.title}
            </h1>

            <h2 className="text-xl text-[var(--color-text-secondary)] flex flex-wrap justify-center md:justify-start items-center gap-2 mb-2 w-full truncate">
              <span className="shrink-0 text-sm md:text-xl text-[var(--color-text-muted)]">
                {playlistTracks.length} track{playlistTracks.length !== 1 ? 's' : ''}
                {totalDuration > 0 && (
                  <span className="inline-flex items-center gap-1 ml-1">
                    • <Clock className="w-3.5 h-3.5 inline" /> {formatDuration(totalDuration)}
                  </span>
                )}
                {artistCount > 0 && <span className="ml-1"> • {artistCount} artist{artistCount !== 1 ? 's' : ''}</span>}
                {playlist.pinned && <span className="ml-1"> • <Pin className="w-3.5 h-3.5 inline" /> pinned</span>}
              </span>
            </h2>

            <p className="shrink-0 text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4 mt-2 line-clamp-3 max-w-3xl">
              {playlist.description || 'Reorder the sequence, trim the weak links, and grow this playlist with nearby tracks from your library.'}
            </p>

            <div className="mt-2 flex flex-wrap justify-center md:justify-start items-center gap-3 w-full md:w-auto">
              <button
                onClick={() => handlePlayFromIndex(0)}
                disabled={playlistTracks.length === 0}
                className="btn btn-primary btn-lg"
              >
                <span className="inline-flex items-center gap-2">
                  <Play size={18} fill="currentColor" />
                  Play Playlist
                </span>
              </button>
              {saveLabel && (
                <div className="inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-[var(--color-primary)]" />}
                  <span>{saveLabel}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mb-8">
          <div className="grid grid-cols-[28px_44px_minmax(0,1fr)_56px_40px] md:grid-cols-[34px_52px_minmax(0,1.4fr)_minmax(0,1fr)_120px_92px_40px] gap-2 md:gap-3 px-2 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
            <div className="text-center md:text-left">#</div>
            <div aria-hidden="true" />
            <div>Title</div>
            <div className="hidden md:block">Album</div>
            <div className="hidden md:block">Date Added</div>
            <div className="text-right md:text-left">Time</div>
            <div aria-hidden="true" />
          </div>

          {playlistTracks.length === 0 ? (
            <div className="px-6 py-12 text-center text-[var(--color-text-secondary)] border-b border-black/5 dark:border-white/5">
              Add tracks from the library to start shaping this playlist.
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
                <div className="space-y-0.5">
                  {playlistTracks.map((track, index) => {
                    const itemId = sortableItems[index];

                    return (
                      <PlaylistTrackRow
                        key={itemId}
                        id={itemId}
                        track={track}
                        index={index}
                        totalTracks={playlistTracks.length}
                        getArtistLink={getArtistLink}
                        onPlay={handlePlayFromIndex}
                        onMove={handleMoveTrack}
                        onContextMenu={openContextMenu}
                        playlistId={playlist.id}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {suggestionEntries.length > 0 && (
          <div className="pt-2">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)]">Suggested Tracks</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                  Nearby picks from your library based on the artists, albums, and genre clusters already in this playlist.
                </p>
              </div>
              <div className="rounded-full border border-[var(--glass-border)] bg-black/5 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)] dark:bg-white/5 shrink-0">
                {suggestionEntries.length} suggestions
              </div>
            </div>

            <div className="space-y-3">
              {suggestionEntries.map(({ track, reason }) => (
                <div
                  key={track.id}
                  className="flex items-center gap-3 rounded-2xl border border-black/5 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] px-3 py-3"
                >
                  <AlbumArt
                    artUrl={track.artUrl}
                    artist={track.artist}
                    album={track.album}
                    className="w-14 h-14 rounded-xl shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm md:text-base font-medium text-[var(--color-text-primary)]">
                      {track.title || track.path.split(/[\\/]/).pop()}
                    </div>
                    <div className="truncate text-xs md:text-sm text-[var(--color-text-secondary)]">
                      {track.artist || track.albumArtist || 'Unknown Artist'}
                    </div>
                    <div className="truncate text-xs text-[var(--color-text-muted)] mt-1">
                      {reason}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => playNext(track)}
                      className="btn btn-ghost btn-sm hidden sm:inline-flex"
                    >
                      Play Next
                    </button>
                    <button
                      onClick={() => void handleAddSuggestion(track)}
                      className="btn btn-primary btn-sm"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Plus className="w-3.5 h-3.5" />
                        Add
                      </span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
