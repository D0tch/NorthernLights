import React, { memo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlbumArt } from '../AlbumArt';
import { Play } from 'lucide-react';
import { prefetchAlbumDetail } from '../../utils/routePrefetch';
import { readBackLabel, type AlbumHeroState } from '../../utils/heroState';
import { albumTransitionName, withViewTransition } from '../../utils/viewTransition';

interface AlbumCardProps {
    title: string;
    artist: string;
    artUrl?: string;
    subtitle?: string;
    editionLabel?: string | null;
    onPlay: (e: React.MouseEvent) => void;
    onOpen?: () => void;
    linkTo?: string;
    linkState?: unknown;
    // Optional: provide the canonical album id for the cover's
    // view-transition-name. When omitted we derive a name from `linkTo` as a
    // fallback so callers don't have to pass it everywhere.
    albumId?: string;
}

export const AlbumCardSkeleton: React.FC = () => (
    <div className="flex flex-col animate-pulse">
        <div className="aspect-square w-full mb-3 rounded-2xl bg-[var(--color-surface-variant)]" />
        <div className="px-1 space-y-1.5">
            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
        </div>
    </div>
);

export const AlbumCard: React.FC<AlbumCardProps> = memo(({ title, artist, artUrl, subtitle, editionLabel, onPlay, onOpen, linkTo, linkState, albumId }) => {
    const navigate = useNavigate();
    const handlePrefetch = useCallback(() => {
        if (linkTo) prefetchAlbumDetail();
    }, [linkTo]);

    // Derive a hero placeholder from the card's own props so the detail view
    // can paint its hero before tracks hydrate. Preserve any caller-supplied
    // backLabel so the back button keeps its previous wording.
    const navState: AlbumHeroState | undefined = linkTo
        ? {
            kind: 'album',
            title,
            artist,
            artUrl,
            subtitle,
            backLabel: readBackLabel(linkState),
        }
        : undefined;

    // Per-entity transition name shared with AlbumDetail's hero. Browser pairs
    // the matching names across the navigation and morphs them.
    const transitionId = albumId || linkTo;
    const coverStyle: React.CSSProperties | undefined = transitionId
        ? { viewTransitionName: albumTransitionName(transitionId) }
        : undefined;

    const handleLinkClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
        // Preserve middle-click / modifier-click open-in-new-tab behaviour.
        if (!linkTo || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        withViewTransition(() => navigate(linkTo, { state: navState }));
    }, [linkTo, navState, navigate]);

    return (
        <div
            className="group flex flex-col relative cursor-pointer"
            role={!linkTo ? "button" : undefined}
            tabIndex={!linkTo ? 0 : undefined}
            onClick={!linkTo ? onOpen : undefined}
            onPointerEnter={handlePrefetch}
            onPointerDown={handlePrefetch}
            onFocus={handlePrefetch}
            onKeyDown={!linkTo ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (onOpen) onOpen();
                }
            } : undefined}
        >
            {/* Semantic Invisible Link Overlay */}
            {linkTo && (
                <Link
                    to={linkTo}
                    state={navState}
                    onClick={handleLinkClick}
                    className="absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    aria-label={`View album: ${title}`}
                />
            )}

            {/* Art container */}
            <div
                style={coverStyle}
                className="relative aspect-square w-full mb-3 rounded-2xl border border-black/5 dark:border-white/5 bg-white/5 dark:bg-black/20 shadow-md overflow-hidden transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100">
                <AlbumArt
                    artUrl={artUrl}
                    artist={artist}
                    album={title}
                    size={400}
                    className="w-full h-full object-cover"
                />

                {/* Edition badge (matches Hub "Uniquely yours" pill) */}
                {editionLabel && (
                    <span className="absolute top-2.5 left-2.5 z-20 text-[10px] font-bold uppercase tracking-[0.15em] text-white/95 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full pointer-events-none">
                        {editionLabel.toLowerCase()}
                    </span>
                )}

                {/* Hover overlay */}
                <div className="absolute inset-0 bg-transparent group-hover:bg-black/40 transition-colors duration-300 flex items-center justify-center z-10 pointer-events-none rounded-2xl">
                    <button
                        onClick={(e) => { 
                            e.preventDefault(); 
                            e.stopPropagation(); 
                            onPlay(e); 
                        }}
                        aria-label={`Play ${title}`}
                        className="
                            z-20 pointer-events-auto
                            w-14 h-14 rounded-full
                            flex items-center justify-center
                            opacity-0 md:scale-75
                            md:group-hover:opacity-100 md:group-hover:scale-100
                            transition-ui duration-300 ease-out
                            hover:scale-110 active:scale-95
                            motion-reduce:transition-none
                            bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white backdrop-blur-sm
                            shadow-[0_4px_24px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_32px_rgba(16,185,129,0.5)]
                            focus-visible:opacity-100 focus-visible:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white
                        "
                    >
                        <Play size={24} fill="currentColor" className="text-white ml-1" />
                    </button>
                </div>
            </div>

            {/* Text */}
            <div className="flex flex-col px-1 relative z-10 pointer-events-none">
                <div className="font-semibold text-sm md:text-base tracking-wide truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors motion-reduce:transition-none">
                    {title}
                </div>
                {subtitle && (
                    <div className="text-xs md:text-sm text-[var(--color-text-secondary)] truncate mt-0.5">{subtitle}</div>
                )}
            </div>
        </div>
    );
});

AlbumCard.displayName = 'AlbumCard';
