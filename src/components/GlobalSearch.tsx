import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Search as SearchIcon, X, Play, MoreHorizontal, ArrowLeft } from 'lucide-react';
import { TrackInfo } from '../utils/fileSystem';
import { AlbumArt } from './AlbumArt';
import { ArtistInitial } from './library/ArtistInitial';
import { LoveButton } from './LoveButton';

// ─── helpers ─────────────────────────────────────────────────────────────────

function useIsMobile(breakpoint = 640) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);
    return isMobile;
}

// ─── shared result-list subcomponent ─────────────────────────────────────────

interface ResultsProps {
    query: string;
    matchedArtists: { name: string; id: string }[];
    matchedAlbums: { title: string; artist: string; id: string; artUrl?: string }[];
    matchedTracks: TrackInfo[];
    onArtistClick: (id: string) => void;
    onAlbumClick: (id: string) => void;
    onTrackPlay: (track: TrackInfo) => void;
    openContextMenu: (track: TrackInfo, x: number, y: number) => void;
}

const SearchResults: React.FC<ResultsProps> = ({
    query,
    matchedArtists,
    matchedAlbums,
    matchedTracks,
    onArtistClick,
    onAlbumClick,
    onTrackPlay,
    openContextMenu,
}) => {
    const noResults =
        matchedArtists.length === 0 && matchedAlbums.length === 0 && matchedTracks.length === 0;

    return (
        <div className="flex flex-col gap-6">
            {noResults && (
                <div className="text-center text-[var(--color-text-muted)] py-12 text-sm">
                    No results found for &ldquo;{query}&rdquo;
                </div>
            )}

            {matchedArtists.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">
                        Artists
                    </h4>
                    <div className="grid grid-cols-1 gap-1">
                        {matchedArtists.map(artist => (
                            <button
                                key={artist.id}
                                onClick={() => onArtistClick(artist.id)}
                                className="flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <div className="w-10 h-10 rounded-full bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0 text-[var(--color-primary)] font-bold">
                                    <ArtistInitial name={artist.name} className="text-base" />
                                </div>
                                <span className="font-medium text-[var(--color-text-primary)] truncate">
                                    {artist.name}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {matchedAlbums.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">
                        Albums
                    </h4>
                    <div className="grid grid-cols-1 gap-1">
                        {matchedAlbums.map(album => (
                            <button
                                key={album.id}
                                onClick={() => onAlbumClick(album.id)}
                                className="flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                {album.artUrl ? (
                                    <img
                                        src={album.artUrl}
                                        className="w-10 h-10 rounded-md object-cover shadow-sm flex-shrink-0"
                                        alt=""
                                    />
                                ) : (
                                    <div className="w-10 h-10 flex-shrink-0 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center">
                                        <span className="text-[var(--color-text-muted)] text-[8px] uppercase">
                                            No Art
                                        </span>
                                    </div>
                                )}
                                <div className="flex flex-col overflow-hidden text-left flex-1 min-w-0">
                                    <span className="font-medium text-[var(--color-text-primary)] truncate">
                                        {album.title}
                                    </span>
                                    <span className="text-xs text-[var(--color-text-secondary)] truncate">
                                        {album.artist}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {matchedTracks.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">
                        Tracks
                    </h4>
                    <div className="grid grid-cols-1 gap-1">
                        {matchedTracks.map((track, i) => (
                            <div
                                key={track.id || i}
                                className="group flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <div
                                    className="relative w-10 h-10 flex-shrink-0 cursor-pointer"
                                    onClick={() => onTrackPlay(track)}
                                >
                                    <AlbumArt
                                        artUrl={track.artUrl}
                                        artist={track.artist}
                                        size={40}
                                        className="w-full h-full rounded-md object-cover shadow-sm"
                                    />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-md transition-opacity flex items-center justify-center">
                                        <Play size={16} className="text-white ml-0.5" />
                                    </div>
                                </div>
                                <div className="flex flex-col flex-1 overflow-hidden min-w-0 text-left">
                                    <span className="font-medium text-[var(--color-text-primary)] truncate">
                                        {track.title || track.path.split(/[\\\/]/).pop()}
                                    </span>
                                    <span className="text-xs text-[var(--color-text-secondary)] truncate">
                                        {typeof track.artists === 'string'
                                            ? track.artists
                                            : track.artists?.join(', ') ||
                                              track.artist ||
                                              'Unknown Artist'}
                                    </span>
                                </div>
                                <button
                                    aria-label="More options"
                                    onClick={e => {
                                        e.stopPropagation();
                                        openContextMenu(track, e.clientX, e.clientY);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-2 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-all flex-shrink-0"
                                >
                                    <MoreHorizontal size={16} />
                                </button>
                                <LoveButton track={track} size={15} className="p-2 flex-shrink-0" />
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── main component ───────────────────────────────────────────────────────────

export const GlobalSearch: React.FC = () => {
    const library = usePlayerStore((state: any) => state.library);
    const artists = usePlayerStore((state: any) => state.artists);
    const albums = usePlayerStore((state: any) => state.albums);
    const setPlaylist = usePlayerStore((state: any) => state.setPlaylist);
    const openContextMenu = usePlayerStore((state: any) => state.openContextMenu);
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    const [isExpanded, setIsExpanded] = useState(false);
    const [query, setQuery] = useState('');
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

    const inputRef = useRef<HTMLInputElement>(null);
    const mobileInputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // ── open ──────────────────────────────────────────────────────────────────
    const handleExpand = () => {
        setIsExpanded(true);
        if (isMobile) {
            // Lock body scroll while overlay is open
            document.body.style.overflow = 'hidden';
            setTimeout(() => mobileInputRef.current?.focus(), 80);
        } else {
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    };

    // ── close ─────────────────────────────────────────────────────────────────
    const handleClose = useCallback(() => {
        setIsExpanded(false);
        setQuery('');
        document.body.style.overflow = '';
    }, []);

    // ── desktop: close on outside click / Escape ──────────────────────────────
    useEffect(() => {
        if (isMobile) return; // handled by overlay on mobile

        const handleClickOutside = (e: MouseEvent) => {
            const outside =
                containerRef.current && !containerRef.current.contains(e.target as Node);
            const outsideDD =
                dropdownRef.current && !dropdownRef.current.contains(e.target as Node);
            if (outside && outsideDD) handleClose();
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                handleClose();
                inputRef.current?.blur();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isMobile, handleClose]);

    // ── mobile: Escape key ────────────────────────────────────────────────────
    useEffect(() => {
        if (!isMobile) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') handleClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isMobile, handleClose]);

    // ── Restore scroll if breakpoint changes while overlay is open ────────────
    useEffect(() => {
        if (!isMobile && isExpanded) {
            document.body.style.overflow = '';
        }
    }, [isMobile, isExpanded]);

    // ── desktop: portal position ──────────────────────────────────────────────
    useEffect(() => {
        if (!isExpanded || isMobile || !containerRef.current) return;

        const updatePosition = () => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                setDropdownStyle({
                    top: `${rect.bottom + 12}px`,
                    right: `${window.innerWidth - rect.right}px`,
                });
            }
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        const scrollParent = containerRef.current.closest('.overflow-x-auto');
        if (scrollParent) scrollParent.addEventListener('scroll', updatePosition);

        return () => {
            window.removeEventListener('resize', updatePosition);
            if (scrollParent) scrollParent.removeEventListener('scroll', updatePosition);
        };
    }, [isExpanded, isMobile]);

    // ── filter logic ──────────────────────────────────────────────────────────
    const q = query.toLowerCase().trim();
    const hasQuery = q.length > 0;

    let matchedArtists: { name: string; id: string }[] = [];
    let matchedAlbums: { title: string; artist: string; id: string; artUrl?: string }[] = [];
    let matchedTracks: TrackInfo[] = [];

    if (hasQuery) {
        matchedArtists = artists
            .filter((a: any) => a.name?.toLowerCase().includes(q))
            .slice(0, 5)
            .map((a: any) => ({ name: a.name, id: a.id }));

        const albumMatches = albums
            .filter(
                (a: any) =>
                    a.title?.toLowerCase().includes(q) || a.artist_name?.toLowerCase().includes(q)
            )
            .slice(0, 5);
        matchedAlbums = albumMatches.map((a: any) => {
            const track = library.find((t: TrackInfo) => t.albumId === a.id);
            return { title: a.title, artist: a.artist_name || 'Unknown Artist', id: a.id, artUrl: track?.artUrl };
        });

        const tracksSet = new Set<string>();
        library.forEach((track: TrackInfo) => {
            if (track.title?.toLowerCase().includes(q) || track.path.toLowerCase().includes(q)) {
                if (!tracksSet.has(track.id)) {
                    matchedTracks.push(track);
                    tracksSet.add(track.id);
                }
            }
        });

        if (matchedArtists.length > 0) {
            const matchedArtistNames = new Set(matchedArtists.map((a: any) => a.name.toLowerCase()));
            library.forEach((track: TrackInfo) => {
                if (tracksSet.has(track.id)) return;
                const tArtists: string[] = Array.isArray(track.artists) ? track.artists : [];
                if (tArtists.some(a => matchedArtistNames.has(a.toLowerCase()))) {
                    matchedTracks.push(track);
                    tracksSet.add(track.id);
                }
            });
        }

        matchedTracks = matchedTracks.slice(0, 10);
    }

    // ── shared handlers ───────────────────────────────────────────────────────
    const handleArtistClick = (artistId: string) => {
        navigate(`/library/artist/${artistId}`);
        handleClose();
    };
    const handleAlbumClick = (albumId: string) => {
        navigate(`/library/album/${albumId}`);
        handleClose();
    };
    const handleTrackPlay = (track: TrackInfo) => {
        if (!track) return;
        setPlaylist([track], 0);
        handleClose();
    };

    const sharedResultsProps: ResultsProps = {
        query,
        matchedArtists,
        matchedAlbums,
        matchedTracks,
        onArtistClick: handleArtistClick,
        onAlbumClick: handleAlbumClick,
        onTrackPlay: handleTrackPlay,
        openContextMenu,
    };

    // ── pill (trigger) ────────────────────────────────────────────────────────
    const pill = (
        <div ref={containerRef} className="relative z-[60] flex items-center ml-auto h-9">
            <div
                className={`
                    flex items-center rounded-full border backdrop-blur-md transition-all duration-300 overflow-hidden
                    ${isExpanded && !isMobile
                        ? 'w-64 sm:w-80 bg-[var(--glass-bg)] border-[var(--color-primary)] shadow-[0_0_12px_rgba(34,201,131,0.2)]'
                        : 'w-[104px] bg-black/10 dark:bg-white/10 border-black/10 dark:border-white/15 hover:bg-black/15 dark:hover:bg-white/15 hover:border-[var(--glass-border-hover)] cursor-pointer'
                    }
                `}
                onClick={!isExpanded || isMobile ? handleExpand : undefined}
            >
                <div className="pl-4 pr-2 py-2 flex items-center justify-center text-[var(--color-text-secondary)]">
                    <SearchIcon size={16} />
                </div>

                {isExpanded && !isMobile ? (
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search library..."
                        className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--color-text-primary)] py-2 pr-4 placeholder-[var(--color-text-muted)]"
                    />
                ) : (
                    <span className="text-sm font-semibold pr-4 text-[var(--color-text-secondary)] select-none">
                        Search
                    </span>
                )}

                {isExpanded && !isMobile && hasQuery && (
                    <button
                        onClick={() => setQuery('')}
                        className="pr-3 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            {/* Desktop dropdown portal */}
            {isExpanded && !isMobile && hasQuery &&
                createPortal(
                    <div
                        ref={dropdownRef}
                        style={dropdownStyle}
                        className="fixed w-[calc(100vw-2rem)] sm:w-[400px] max-h-[70vh] overflow-y-auto bg-[var(--glass-bg)] backdrop-blur-3xl border border-[var(--glass-border)] rounded-2xl shadow-[var(--shadow-2xl)] p-4 animate-in fade-in slide-in-from-top-4 duration-200 z-[100]"
                    >
                        <SearchResults {...sharedResultsProps} />
                    </div>,
                    document.body
                )}
        </div>
    );

    // ── mobile full-screen overlay portal ────────────────────────────────────
    const mobileOverlay = isMobile && isExpanded &&
        createPortal(
            <div className="fixed inset-0 z-[200] flex flex-col bg-[var(--color-background)]">
                {/* Header bar */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-black/10 dark:border-white/10 bg-white/70 dark:bg-black/40 backdrop-blur-xl">
                    <button
                        aria-label="Close search"
                        onClick={handleClose}
                        className="flex-shrink-0 p-1 -ml-1 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] active:scale-95 transition-all"
                    >
                        <ArrowLeft size={22} />
                    </button>

                    {/* Input */}
                    <div className="flex-1 flex items-center gap-2 rounded-full px-4 py-2 bg-black/5 dark:bg-white/10 border border-[var(--color-primary)]/60 shadow-[0_0_12px_rgba(34,201,131,0.15)] focus-within:border-[var(--color-primary)] focus-within:shadow-[0_0_16px_rgba(34,201,131,0.25)] transition-all">
                        <SearchIcon size={16} className="text-[var(--color-text-muted)] flex-shrink-0" />
                        <input
                            ref={mobileInputRef}
                            type="search"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Search library…"
                            autoComplete="off"
                            className="flex-1 bg-transparent border-none outline-none text-base text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
                        />
                        {hasQuery && (
                            <button
                                onClick={() => setQuery('')}
                                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] active:scale-90 transition-transform"
                            >
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Results scroll area */}
                <div className="flex-1 overflow-y-auto overscroll-contain p-4">
                    {hasQuery ? (
                        <SearchResults {...sharedResultsProps} />
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--color-text-muted)]">
                            <SearchIcon size={40} strokeWidth={1.2} />
                            <p className="text-sm">Search artists, albums &amp; tracks</p>
                        </div>
                    )}
                </div>
            </div>,
            document.body
        );

    return (
        <>
            {pill}
            {mobileOverlay}
        </>
    );
};
