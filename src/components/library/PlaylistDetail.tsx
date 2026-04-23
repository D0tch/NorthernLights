import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
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

function reorderTracks(tracks: TrackInfo[], fromIndex: number, toIndex: number): TrackInfo[] {
  const nextTracks = [...tracks];
  const [moved] = nextTracks.splice(fromIndex, 1);
  if (!moved) return tracks;
  nextTracks.splice(toIndex, 0, moved);
  return nextTracks;
}

function buildBackdropTiles(artUrls: string[], totalTracks: number): Array<string | null> {
  // Generate up to 150 tiles to ensure the grid can stretch across large ultra-wide monitors
  const count = Math.max(24, Math.min(150, totalTracks > 0 ? totalTracks * 3 : 24));
  
  if (artUrls.length === 0) {
    return Array.from({ length: count }, () => null);
  }

  return Array.from({ length: count }, (_, index) => {
    // Pseudo-random offset using prime numbers to break repeating patterns across ANY column count
    const offsetIndex = (index * 7) + Math.floor(index / 3) * 5;
    return artUrls[offsetIndex % artUrls.length];
  });
}

interface PlaylistTrackRowProps {
  id: string;
  track: TrackInfo;
  index: number;
  totalTracks: number;
  onPlay: (index: number) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onContextMenu: (track: TrackInfo, x: number, y: number, playlistId: string, index: number) => void;
  playlistId: string;
}

const PlaylistTrackRow: React.FC<PlaylistTrackRowProps> = ({
  id,
  track,
  index,
  totalTracks,
  onPlay,
  onMove,
  onContextMenu,
  playlistId,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const artistsStore = usePlayerStore(state => state.artists);

  const getArtistLink = (artistName: string): string | null => {
    const entity = artistsStore.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase());
    if (entity) return `/library/artist/${entity.id}`;
    if (track?.artistId) return `/library/artist/${track.artistId}`;
    return null;
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 20 : 1,
      }}
      className="grid grid-cols-[30px_1fr_80px] md:grid-cols-[40px_1fr_160px] gap-2 px-2 md:px-4 py-2 border-b border-black/5 dark:border-white/5 items-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:bg-black/5 dark:focus-visible:bg-white/5 rounded-lg my-0.5 group"
    >
      <div 
        className="text-center md:text-left text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm tabular-nums cursor-pointer"
        onClick={() => onPlay(index)}
      >
        {index + 1}
      </div>

      <div 
        className="flex items-center gap-3 min-w-0 cursor-pointer"
        onClick={() => onPlay(index)}
      >
        <AlbumArt
          artUrl={track.artUrl}
          artist={track.artist}
          album={track.album}
          className="hidden md:block h-10 w-10 shrink-0 rounded-md object-cover shadow-sm border border-black/10 dark:border-white/10"
        />
        <div className="min-w-0">
          <span className="block truncate text-sm md:text-base font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
            {track.title || track.path.split(/[\\/]/).pop()}
          </span>
          {((track.artists && Array.isArray(track.artists) && track.artists.length > 0) || (track.artist || track.albumArtist)) ? (
              <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                  {(Array.isArray(track.artists) && track.artists.length > 0 ? track.artists : parseArtists(track.artist || track.albumArtist || '')).map((a, j) => {
                      const link = getArtistLink(a);
                      return (
                          <React.Fragment key={a + j}>
                              {j > 0 && ' · '}
                              {link ? (
                                  <Link
                                      to={link}
                                      onClick={(e) => e.stopPropagation()}
                                      className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                                  >{a}</Link>
                              ) : (
                                  <span>{a}</span>
                              )}
                          </React.Fragment>
                      );
                  })}
              </span>
          ) : (
              <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                  Unknown Artist
              </span>
          )}
        </div>
      </div>

      <div className="text-[var(--color-text-muted)] flex flex-row items-center justify-end md:gap-2">
        <span className="w-12 text-right hidden md:inline text-sm tabular-nums mr-2">
          {formatTime(track.duration, '--:--')}
        </span>

        <div className="flex flex-col md:hidden mr-1">
          <button onClick={(e) => { e.stopPropagation(); if (index > 0) onMove(index, index - 1); }} disabled={index === 0} className="p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"><ChevronUp size={14} /></button>
          <button onClick={(e) => { e.stopPropagation(); if (index < totalTracks - 1) onMove(index, index + 1); }} disabled={index === totalTracks - 1} className="p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"><ChevronDown size={14} /></button>
        </div>

        <div className="opacity-100 md:opacity-0 md:group-hover:opacity-100 flex items-center transition-opacity">
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
};

export const PlaylistDetail: React.FC = () => {
  const { playlistId } = useParams<{ playlistId: string }>();
  const navigate = useNavigate();
  const { addToast } = useToast();

  const playlists = usePlayerStore((state) => state.playlists);
  const library = usePlayerStore((state) => state.library);
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

  const { artUrls, bgColor } = useDominantColor(playlist?.tracks || []);
  
  const allArtUrls = useMemo(() => {
    if (!playlist) return [];
    return Array.from(new Set(playlist.tracks.map((t) => t.artUrl).filter(Boolean) as string[]));
  }, [playlist]);

  const backdropTiles = useMemo(
    () => buildBackdropTiles(allArtUrls, playlist?.tracks?.length || 0),
    [allArtUrls, playlist?.tracks?.length]
  );

  const sortableItems = useMemo(
    () => (playlist?.tracks || []).map((t, idx) => `${t.id}-${idx}`),
    [playlist]
  );

  const totalDuration = useMemo(
    () => (playlist?.tracks || []).reduce((sum, track) => sum + (track.duration || 0), 0),
    [playlist]
  );

  const artistCount = useMemo(() => {
    if (!playlist) return 0;
    return new Set(
      playlist.tracks
        .flatMap((track) => (track.artist || track.albumArtist ? [track.artist || track.albumArtist || ''] : []))
        .map((artist) => artist.toLowerCase())
        .filter(Boolean)
    ).size;
  }, [playlist]);

  const suggestionEntries = useMemo(
    () => getSuggestedPlaylistTracks(library, playlist?.tracks || [], 8),
    [library, playlist]
  );

  const [saveLabel, setSaveLabel] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const setSavingState = useCallback((label: string | null, saving: boolean) => {
    setSaveLabel(label);
    setIsSaving(saving);
  }, []);

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

  const handlePlayFromIndex = useCallback(
    (startIndex: number) => {
      if (!playlist || playlist.tracks.length === 0) return;
      void setPlaylist(playlist.tracks, startIndex);
    },
    [playlist, setPlaylist]
  );

  const handleRemoveTrack = useCallback(
    (index: number) => {
      if (!playlist) return;
      const nextTracks = playlist.tracks.filter((_, trackIndex) => trackIndex !== index);
      void persistTracks(nextTracks, 'Removing track...', 'Playlist updated');
    },
    [persistTracks, playlist]
  );

  const handleMoveTrack = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!playlist || fromIndex === toIndex) return;
      const nextTracks = reorderTracks(playlist.tracks, fromIndex, toIndex);
      void persistTracks(nextTracks, 'Saving order...', 'Order saved');
    },
    [persistTracks, playlist]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!playlist) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const fromIndex = sortableItems.indexOf(active.id as string);
      const toIndex = sortableItems.indexOf(over.id as string);
      if (fromIndex === -1 || toIndex === -1) return;

      const nextTracks = reorderTracks(playlist.tracks, fromIndex, toIndex);
      void persistTracks(nextTracks, 'Saving order...', 'Order saved');
    },
    [persistTracks, playlist, sortableItems]
  );

  const handleAddSuggestion = useCallback(
    async (track: TrackInfo) => {
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
    },
    [addToast, addTracksToUserPlaylist, playlist, setSavingState]
  );

  if (!playlistId) {
    return <div className="page-container">Playlist not found.</div>;
  }

  if (!playlist) {
    return (
      <div className="page-container">
        <BackButton onClick={() => navigate('/playlists')}>Back to Playlists</BackButton>
        <div className="rounded-[2rem] border border-[var(--glass-border)] bg-[var(--glass-bg)] p-8 text-center text-[var(--color-text-secondary)] shadow-[0_30px_90px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
          Playlist not found.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1 relative">
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        {/* Solid base */}
        <div className="absolute inset-0 bg-[var(--color-bg)]" />
        
        {/* Colorful gradient glow behind the mosaic */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at top, color-mix(in srgb, ${bgColor} 20%, transparent) 0%, transparent 60%)`
          }}
        />

        {/* The Mosaic with a CSS mask to slowly fade it out downwards */}
        <div
          className="absolute inset-0"
          style={{
            WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 50%)',
            maskImage: 'linear-gradient(to bottom, black 0%, transparent 50%)',
          }}
        >
          <div
            className="absolute left-1/2 top-[-20vh] grid w-[250vw] sm:w-[200vw] md:w-[150vw] lg:w-[120vw] grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-3 sm:gap-4 md:gap-5 opacity-25 dark:opacity-20 blur-[2px]"
            style={{ transform: 'translateX(-50%) perspective(1000px) rotateX(35deg) rotateY(-5deg) rotateZ(-15deg) scale(1.4)' }}
          >
            {backdropTiles.map((tile, index) => (
              <div
                key={`${tile || 'empty'}-${index}`}
                className="aspect-square overflow-hidden rounded-[1.9rem] border border-white/10 bg-black/5 shadow-[0_30px_80px_rgba(0,0,0,0.18)] dark:bg-white/5"
              >
                {tile ? (
                  <img src={tile} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Disc3 className="h-10 w-10 text-[var(--color-text-muted)] opacity-40" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Additional gradient safety net at the bottom */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent via-40% to-[var(--color-bg)] to-70%" />
      </div>

      <div className="relative z-10 flex flex-col flex-1 min-h-0">
        <div className="shrink-0 mb-6">
          <BackButton onClick={() => navigate('/playlists')}>Back to Playlists</BackButton>
        </div>

        <div className="shrink-0 flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
          <div className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl relative overflow-hidden backdrop-blur-xl bg-black/10 dark:bg-white/5">
            <div className="grid h-full w-full grid-cols-2 gap-0.5">
              {(artUrls.length > 0 ? artUrls.slice(0, 4) : [null, null, null, null]).map((artUrl, index) => (
                <div key={`${artUrl || 'fallback'}-${index}`} className="overflow-hidden bg-black/10 dark:bg-white/10">
                  {artUrl ? (
                    <img src={artUrl} alt="" className="h-full w-full object-cover" />
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
                {playlist.tracks.length} track{playlist.tracks.length !== 1 ? 's' : ''}
                {totalDuration > 0 && (
                  <span className="inline-flex items-center gap-1 ml-1">
                    • <Clock className="w-3.5 h-3.5 inline" /> {formatDuration(totalDuration)}
                  </span>
                )}
              </span>
            </h2>

            <p className="shrink-0 text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4 mt-2 line-clamp-3 max-w-3xl">
              {playlist.description || 'Reorder the sequence, trim the weak links, and grow this playlist with nearby tracks from your library.'}
            </p>

            <div className="mt-2 flex justify-center md:justify-start w-full md:w-auto gap-3">
              <button
                onClick={() => handlePlayFromIndex(0)}
                disabled={playlist.tracks.length === 0}
                className="flex items-center justify-center gap-2 px-8 py-3.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold text-sm tracking-widest uppercase rounded-full shadow-[0_4px_24px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_32px_rgba(16,185,129,0.4)] hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 transition-all duration-300 w-full md:w-auto disabled:opacity-50 disabled:pointer-events-none"
              >
                <Play size={18} fill="currentColor" className="ml-1" />
                PLAY PLAYLIST
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-y-auto overflow-x-hidden flex-1 min-h-0 hide-scrollbar pb-6">
          <div className="grid grid-cols-[30px_1fr_80px] md:grid-cols-[40px_1fr_160px] px-2 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
            <div className="text-center md:text-left">#</div>
            <div>Title</div>
            <div className="text-right hidden md:block mr-2">Time</div>
          </div>

          {playlist.tracks.length === 0 ? (
            <div className="px-6 py-12 text-center text-[var(--color-text-secondary)] border-b border-black/5 dark:border-white/5">
              Add tracks from the library to start shaping this playlist.
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
                <div className="space-y-0.5">
                  {playlist.tracks.map((track, index) => {
                    const itemId = sortableItems[index];
                    return (
                      <PlaylistTrackRow
                        key={itemId}
                        id={itemId}
                        track={track}
                        index={index}
                        totalTracks={playlist.tracks.length}
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

          {suggestionEntries.length > 0 && (
            <div className="mt-12 w-full overflow-hidden">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3 px-2 md:px-4">
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

              <div className="grid gap-3 sm:gap-4 lg:grid-cols-2 px-2 md:px-4">
                {suggestionEntries.map(({ track, reason }) => (
                  <article
                    key={track.id}
                    className="flex flex-row items-center gap-3 sm:gap-4 rounded-xl border border-black/5 dark:border-white/5 bg-black/5 p-3 sm:p-4 transition-colors hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 min-w-0 overflow-hidden"
                  >
                    <AlbumArt
                      artUrl={track.artUrl}
                      artist={track.artist}
                      album={track.album}
                      className="h-12 w-12 sm:h-14 sm:w-14 rounded-md sm:rounded-lg border border-black/10 dark:border-white/10 object-cover shadow-sm shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm sm:text-base font-semibold text-[var(--color-text-primary)]">
                        {track.title || track.path.split(/[\\/]/).pop()}
                      </div>
                      <div className="truncate text-xs sm:text-sm text-[var(--color-text-secondary)] mt-0.5">
                        {track.artist || track.albumArtist || 'Unknown Artist'}
                      </div>
                      <p className="mt-1 sm:mt-1.5 text-[11px] sm:text-xs leading-relaxed text-[var(--color-text-muted)] line-clamp-1 sm:line-clamp-2">{reason}</p>
                    </div>
                    <div className="flex gap-2 sm:flex-col shrink-0">
                      <button
                        onClick={() => void handleAddSuggestion(track)}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 text-[var(--color-text-primary)] font-medium text-xs rounded-lg transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
