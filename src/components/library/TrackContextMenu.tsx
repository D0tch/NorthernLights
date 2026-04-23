import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store';
import {
    Play, Plus, ListPlus, Check,
    ChevronRight, ChevronLeft,
    Search, X, Disc3, Mic2, ListMinus,
} from 'lucide-react';

// ─── helpers ──────────────────────────────────────────────────────────────────

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

// Normalise track.artists → string[]
function getArtistNames(track: any): string[] {
    if (Array.isArray(track.artists) && track.artists.length > 0) return track.artists;
    if (typeof track.artists === 'string' && track.artists.trim()) {
        try { return JSON.parse(track.artists); } catch { return [track.artists]; }
    }
    if (track.artist) return [track.artist];
    return [];
}

// ─── Navigation stack hook ────────────────────────────────────────────────────
// `stack` is a list of panel IDs; empty means "main" is shown.
// push / pop are the only mutations; each sub-panel just calls pop() to go back.

function useMenuNav() {
    const [stack, setStack] = useState<string[]>([]);
    const push  = useCallback((id: string) => setStack(s => [...s, id]), []);
    const pop   = useCallback(() => setStack(s => s.slice(0, -1)), []);
    const reset = useCallback(() => setStack([]), []);
    const current = stack[stack.length - 1] ?? null; // null → main visible
    return { stack, current, push, pop, reset };
}

// ─── Generic filterable-list sub-panel ───────────────────────────────────────
// Self-contained: owns its filter input ref and state.
// isActive = this panel is the top of the stack (fully visible).
// isPast   = this panel is in the stack but not on top (hidden behind next panel).

interface FilterableListPanelProps {
    title: string;
    placeholder: string;
    items: { id: string; label: string; icon?: React.ReactNode }[];
    onSelect: (id: string, label: string) => void;
    onBack: () => void;
    isActive: boolean;
    isMobile: boolean;
    emptyText?: string;
}

const FilterableListPanel: React.FC<FilterableListPanelProps> = ({
    title, placeholder, items, onSelect, onBack, isActive, isMobile, emptyText = 'No results',
}) => {
    const [filter, setFilter] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Reset filter whenever this panel becomes active
    useEffect(() => {
        if (isActive) {
            setFilter('');
            setTimeout(() => inputRef.current?.focus(), 140);
        }
    }, [isActive]);

    const filtered = items.filter(i =>
        i.label.toLowerCase().includes(filter.toLowerCase().trim())
    );

    return (
        <div
            className="absolute inset-0 flex flex-col bg-[var(--glass-bg)]"
            style={{
                transform: isActive ? 'translateX(0)' : 'translateX(100%)',
                transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
                // Keep panel in DOM so transition plays nicely; it's visually hidden when off-screen
                pointerEvents: isActive ? 'auto' : 'none',
            }}
        >
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--glass-border)] flex-shrink-0">
                <button
                    onClick={onBack}
                    className="p-1 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors active:scale-90"
                    aria-label="Back"
                >
                    <ChevronLeft size={18} />
                </button>
                <span className="text-sm font-semibold text-[var(--color-text-primary)] flex-1 truncate">
                    {title}
                </span>
            </div>

            {/* Filter */}
            <div className="px-3 py-2 border-b border-[var(--glass-border)] flex-shrink-0">
                <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 bg-black/10 dark:bg-white/5 border border-[var(--color-border)]">
                    <Search size={13} className="text-[var(--color-text-muted)] flex-shrink-0" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder={placeholder}
                        className="flex-1 bg-transparent border-none outline-none text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
                    />
                    {filter && (
                        <button
                            onClick={() => setFilter('')}
                            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] active:scale-90 transition-all"
                        >
                            <X size={12} />
                        </button>
                    )}
                </div>
            </div>

            {/* List */}
            <div className="overflow-y-auto flex-1 py-1.5" style={{ maxHeight: isMobile ? '60vh' : '260px' }}>
                {filtered.length === 0 ? (
                    <div className="text-center text-[var(--color-text-muted)] text-xs py-6">{emptyText}</div>
                ) : (
                    filtered.map(item => (
                        <button
                            key={item.id}
                            onClick={() => onSelect(item.id, item.label)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[var(--color-text-primary)] hover:bg-white/5 active:bg-white/10 transition-colors text-left"
                        >
                            {item.icon && (
                                <span className="text-[var(--color-text-secondary)] flex-shrink-0">
                                    {item.icon}
                                </span>
                            )}
                            <span className="truncate">{item.label}</span>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
};

// ─── Shared small helpers ─────────────────────────────────────────────────────

const Divider = () => <div className="h-px bg-[var(--glass-border)] my-1.5 mx-3" />;

const MenuButton: React.FC<{
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    trailingIcon?: React.ReactNode;
    danger?: boolean;
}> = ({ icon, label, onClick, trailingIcon, danger }) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors active:bg-white/10
            ${danger
                ? 'text-rose-500 hover:bg-rose-500/10'
                : 'text-[var(--color-text-primary)] hover:bg-white/5'
            }`}
    >
        <span className={`flex-shrink-0 ${danger ? 'text-rose-500' : 'text-[var(--color-text-secondary)]'}`}>{icon}</span>
        <span className="flex-1 text-left">{label}</span>
        {trailingIcon && (
            <span className="text-[var(--color-text-muted)] flex-shrink-0">{trailingIcon}</span>
        )}
    </button>
);

// ─── Main component ───────────────────────────────────────────────────────────

export const TrackContextMenu: React.FC = () => {
    const {
        contextMenu, closeContextMenu,
        playlists, artists: artistEntities,
        addTracksToUserPlaylist, replaceTracksInUserPlaylist,
        playNext, setPlaylist,
    } = usePlayerStore();

    const navigate  = useNavigate();
    const menuRef   = useRef<HTMLDivElement>(null);
    const isMobile  = useIsMobile();
    const nav       = useMenuNav();

    const [addedStatus, setAddedStatus] = useState<string | null>(null);
    const [isVisible,   setIsVisible]   = useState(false);

    // ── open/close lifecycle ──────────────────────────────────────────────────
    useEffect(() => {
        if (contextMenu) {
            setAddedStatus(null);
            nav.reset();
            requestAnimationFrame(() => setIsVisible(true));
        } else {
            setIsVisible(false);
        }
    }, [contextMenu]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Escape: pop panel or close ────────────────────────────────────────────
    useEffect(() => {
        if (!contextMenu) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (nav.current) nav.pop();
            else closeContextMenu();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [contextMenu, nav, closeContextMenu]);

    // ── desktop: click outside closes ────────────────────────────────────────
    useEffect(() => {
        if (!contextMenu || isMobile) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                closeContextMenu();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [contextMenu, isMobile, closeContextMenu]);

    if (!contextMenu) return null;
    const { track, x, y, playlistId: contextPlaylistId, playlistTrackIndex } = contextMenu;

    // ── desktop position ──────────────────────────────────────────────────────
    const menuW = 248, menuH = 340;
    const posX = Math.min(x, window.innerWidth  - menuW - 16);
    const posY = Math.min(y, window.innerHeight - menuH - 16);

    // ── derived data ──────────────────────────────────────────────────────────
    const artistNames    = getArtistNames(track);
    const multiArtist    = artistNames.length > 1;

    const resolveArtistId = (name: string) =>
        artistEntities.find((a: any) => a.name?.toLowerCase() === name.toLowerCase())?.id ?? null;

    // ── actions ───────────────────────────────────────────────────────────────
    const done = (msg: string) => {
        setAddedStatus(msg);
        setTimeout(() => closeContextMenu(), 900);
    };

    const handlePlayNow  = () => { setPlaylist([track], 0); closeContextMenu(); };
    const handlePlayNext = () => { playNext(track); done('Added to queue'); };

    const handleAddToPlaylist = async (playlistId: string) => {
        try { await addTracksToUserPlaylist(playlistId, [track.id]); done('Added to playlist'); }
        catch { setAddedStatus(null); }
    };

    const handleRemoveFromPlaylist = async () => {
        if (!contextPlaylistId || playlistTrackIndex === undefined) return;
        const pl = playlists.find(p => p.id === contextPlaylistId);
        if (!pl) return;
        const nextTrackIds = pl.tracks
            .filter((_, i) => i !== playlistTrackIndex)
            .map(t => t.id);
        try {
            await replaceTracksInUserPlaylist(contextPlaylistId, nextTrackIds);
            done('Removed from playlist');
        } catch { setAddedStatus(null); }
    };

    const handleGoToAlbum = () => {
        if (track.albumId) navigate(`/library/album/${track.albumId}`);
        closeContextMenu();
    };

    const handleGoToArtist = (name: string) => {
        const id = resolveArtistId(name);
        if (id) navigate(`/library/artist/${id}`);
        closeContextMenu();
    };

    // ── panel item lists ──────────────────────────────────────────────────────
    const playlistItems = playlists.map(pl => ({
        id: pl.id,
        label: pl.title,
        icon: <ListPlus size={14} />,
    }));

    const artistItems = artistNames.map(name => ({
        id: name,
        label: name,
        icon: <Mic2 size={14} />,
    }));

    // ── Whether any sub-panel is open (main slides left) ─────────────────────
    const subPanelOpen = nav.current !== null;

    // ── inner shell — contains main + all sub-panels stacked absolutely ───────
    const inner = (
        <div
            ref={menuRef}
            className={`
                relative overflow-hidden
                bg-[var(--glass-bg)] backdrop-blur-3xl
                border border-[var(--glass-border)] rounded-2xl shadow-2xl
                ${isMobile ? 'w-full rounded-b-none' : 'w-[248px]'}
            `}
            onContextMenu={e => e.preventDefault()}
        >
            {/* ── MAIN PANEL ── slides left when a sub-panel is active ──────── */}
            <div
                style={{
                    transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1), opacity 0.28s',
                    transform: subPanelOpen ? 'translateX(-18px)' : 'translateX(0)',
                    opacity:   subPanelOpen ? 0 : 1,
                    pointerEvents: subPanelOpen ? 'none' : 'auto',
                }}
            >
                {/* Track header */}
                <div className="px-4 py-3 border-b border-[var(--glass-border)]">
                    <div className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
                        {track.title}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
                        {artistNames.join(', ') || track.artist}
                    </div>
                </div>

                {addedStatus ? (
                    <div className="p-5 flex items-center justify-center gap-2 text-[var(--color-primary)] text-sm font-medium">
                        <Check size={16} /> {addedStatus}
                    </div>
                ) : (
                    <div className="py-1.5">
                        <MenuButton icon={<Play size={15} />} label="Play Now"  onClick={handlePlayNow}  />
                        <MenuButton icon={<Plus size={15} />} label="Play Next" onClick={handlePlayNext} />

                        {/* Go to Album */}
                        {track.albumId && (
                            <>
                                <Divider />
                                <MenuButton icon={<Disc3 size={15} />} label="Go to Album" onClick={handleGoToAlbum} />
                            </>
                        )}

                        {/* Go to Artist — direct if single, sub-panel if multiple */}
                        {artistNames.length === 1 && (
                            <MenuButton
                                icon={<Mic2 size={15} />}
                                label="Go to Artist"
                                onClick={() => handleGoToArtist(artistNames[0])}
                            />
                        )}
                        {multiArtist && (
                            <MenuButton
                                icon={<Mic2 size={15} />}
                                label="Go to Artist"
                                onClick={() => nav.push('artists')}
                                trailingIcon={<ChevronRight size={15} />}
                            />
                        )}

                        {/* Add to Playlist */}
                        {playlists.length > 0 && (
                            <>
                                <Divider />
                                <MenuButton
                                    icon={<ListPlus size={15} />}
                                    label="Add to Playlist"
                                    onClick={() => nav.push('playlists')}
                                    trailingIcon={<ChevronRight size={15} />}
                                />
                            </>
                        )}

                        {/* Remove from Playlist — only when opened from within a playlist */}
                        {contextPlaylistId && playlistTrackIndex !== undefined && (
                            <>
                                <Divider />
                                <MenuButton
                                    icon={<ListMinus size={15} />}
                                    label="Remove from Playlist"
                                    onClick={() => void handleRemoveFromPlaylist()}
                                    danger
                                />
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* ── SUB-PANELS — absolutely overlaid, each slides in independently ── */}

            <FilterableListPanel
                title="Add to Playlist"
                placeholder="Filter playlists…"
                items={playlistItems}
                onSelect={(id) => void handleAddToPlaylist(id)}
                onBack={nav.pop}
                isActive={nav.current === 'playlists'}
                isMobile={isMobile}
                emptyText="No playlists found"
            />

            <FilterableListPanel
                title="Go to Artist"
                placeholder="Filter artists…"
                items={artistItems}
                onSelect={(_id, label) => handleGoToArtist(label)}
                onBack={nav.pop}
                isActive={nav.current === 'artists'}
                isMobile={isMobile}
                emptyText="No artists found"
            />

            {/*
             * ── Adding a new sub-panel in the future is this simple: ───────────
             *
             * <FilterableListPanel
             *     title="My New Panel"
             *     placeholder="Filter…"
             *     items={myItems}
             *     onSelect={(id) => handleMyAction(id)}
             *     onBack={nav.pop}
             *     isActive={nav.current === 'my-panel'}
             *     isMobile={isMobile}
             * />
             *
             * Then add a MenuButton in the main panel:
             *     <MenuButton ... onClick={() => nav.push('my-panel')} trailingIcon={<ChevronRight size={15} />} />
             */}
        </div>
    );

    // ── MOBILE: bottom-sheet ──────────────────────────────────────────────────
    if (isMobile) {
        return createPortal(
            <>
                <div
                    className="fixed inset-0 z-[9998] transition-opacity duration-200"
                    style={{
                        background: 'rgba(0,0,0,0.55)',
                        opacity: isVisible ? 1 : 0,
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                    }}
                    onClick={closeContextMenu}
                />
                <div
                    className="fixed bottom-0 left-0 right-0 z-[9999] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
                    style={{ transform: isVisible ? 'translateY(0)' : 'translateY(100%)' }}
                >
                    <div className="flex justify-center pt-3 pb-1 bg-[var(--glass-bg)] rounded-t-2xl border-t border-x border-[var(--glass-border)]">
                        <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
                    </div>
                    {inner}
                    <div className="h-[env(safe-area-inset-bottom,0px)] bg-[var(--glass-bg)] border-x border-[var(--glass-border)]" />
                </div>
            </>,
            document.body
        );
    }

    // ── DESKTOP: positioned dropdown ──────────────────────────────────────────
    return createPortal(
        <div
            className="fixed z-[9999]"
            style={{
                top: posY, left: posX,
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(-4px)',
                transition: 'opacity 0.15s, transform 0.15s',
                transformOrigin: 'top left',
            }}
        >
            {inner}
        </div>,
        document.body
    );
};
