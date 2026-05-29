import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { AlbumCard, AlbumCardSkeleton } from './AlbumCard';
import { ArtistInitial } from './ArtistInitial';
import { useExternalImage } from '../../hooks/useExternalImage';
import { useArtistData } from '../../hooks/useArtistData';
import { fetchGenreImage } from '../../utils/externalImagery';
import { useInView } from '../../hooks/useInView';
import { FilterBar } from './FilterBar';
import { QueryBuilderModal } from './QueryBuilderModal';
import { MobileFilterOverlay } from './MobileFilterOverlay';
import {
  ARTIST_FACETS,
  ALBUM_FACETS,
  applyFacetFilters,
  applySort,
  applyQueryResultFilter,
  deriveAlbumMetadata,
  hasActiveFilters,
  QueryGroup,
  type EnrichedAlbum,
} from '../../utils/filterState';
import type { ArtistInfo } from '../../store/index';
import { prefetchArtistDetail } from '../../utils/routePrefetch';
import type { ArtistHeroState } from '../../utils/heroState';
import { artistTransitionName, withViewTransition } from '../../utils/viewTransition';
import { VirtualizedCardGrid } from './VirtualizedCardGrid';

const ArtistCardSkeleton: React.FC = () => (
    <div className="flex flex-col items-center animate-pulse">
        <div className="w-full aspect-square rounded-full bg-[var(--color-surface-variant)] mb-4" />
        <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
    </div>
);

const GenreCardSkeleton: React.FC = () => (
    <div className="animate-pulse rounded-2xl aspect-video md:aspect-square bg-[var(--color-surface-variant)]" />
);

const GenreCard: React.FC<{ genre: string }> = ({ genre }) => {
    const [ref, inView] = useInView();
    const { imageUrl } = useExternalImage(() => fetchGenreImage(genre), [genre], { enabled: inView });

    return (
        <div
            ref={ref}
            className="genre-card group flex flex-col items-center justify-center cursor-pointer transition-transform duration-300 hover:scale-105 relative overflow-hidden rounded-2xl aspect-video md:aspect-square bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)]"
        >
            {imageUrl && (
                <div className="absolute inset-0 z-0">
                    <img src={imageUrl} alt={genre} className="w-full h-full object-cover opacity-40 transition-transform duration-500 group-hover:scale-110" />
                    <div className="absolute inset-0 bg-black/40 mix-blend-multiply" />
                </div>
            )}
            <div className="relative z-10 p-4 w-full flex items-center justify-center h-full">
                <div className="font-bold text-xl md:text-2xl text-[var(--color-primary)] text-center shadow-black drop-shadow-lg filter group-hover:scale-110 transition-transform">{genre}</div>
            </div>
        </div>
    );
};

const ArtistLink: React.FC<{ to: string; state: ArtistHeroState; children: React.ReactNode }> = ({ to, state, children }) => {
    const navigate = useNavigate();
    const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        withViewTransition(() => navigate(to, { state }), prefetchArtistDetail());
    }, [navigate, state, to]);
    return (
        <Link
            to={to}
            state={state}
            onClick={handleClick}
            className="no-underline"
            onPointerEnter={prefetchArtistDetail}
            onPointerDown={prefetchArtistDetail}
            onFocus={prefetchArtistDetail}
        >
            {children}
        </Link>
    );
};

const ArtistCard: React.FC<{ artist: string; artistId?: string }> = ({ artist, artistId }) => {
    const [ref, inView] = useInView();
    const { imageUrl } = useArtistData(artist, undefined, { enabled: inView });
    const transitionName = artistTransitionName(artistId);
    const avatarStyle = transitionName ? ({ viewTransitionName: transitionName } as React.CSSProperties) : undefined;

    return (
        <div
            ref={ref}
            className="artist-card group flex flex-col items-center cursor-pointer transition-transform duration-300 hover:scale-105"
        >
            <div
                style={avatarStyle}
                className="w-full aspect-square rounded-full overflow-hidden shadow-[var(--shadow-sm)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] mb-4 flex items-center justify-center transition-ui duration-300 group-hover:border-[var(--color-primary)] group-hover:shadow-[var(--shadow-md)]"
            >
                {imageUrl ? (
                    <img src={imageUrl} alt={artist} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
                ) : (
                    <ArtistInitial name={artist} className="text-4xl md:text-5xl text-[var(--color-primary)] opacity-50 group-hover:opacity-100 transition-opacity" />
                )}
            </div>
            <div className="font-bold text-base md:text-lg text-center text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors truncate w-full px-2">{artist}</div>
        </div>
    );
};

const GRID_SKELETON_COUNT = 12;

function useIsMobile(breakpoint = 768) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);
    return isMobile;
}

export const LibraryHome: React.FC<{ section?: 'artists' | 'albums' | 'genres' }> = ({ section }) => {
    const library = usePlayerStore(state => state.library);
    const isLibraryLoading = usePlayerStore(state => state.isLibraryLoading);
    const artistEntities = usePlayerStore(state => state.artists);
    const albumEntities = usePlayerStore(state => state.albums);
    const genreEntities = usePlayerStore(state => state.genres);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
    const artistFilters = usePlayerStore(state => state.artistFilters);
    const albumFilters = usePlayerStore(state => state.albumFilters);
    const setArtistFilters = usePlayerStore(state => state.setArtistFilters);
    const setAlbumFilters = usePlayerStore(state => state.setAlbumFilters);
    const setArtistQueryResultIds = usePlayerStore(state => state.setArtistQueryResultIds);
    const setAlbumQueryResultIds = usePlayerStore(state => state.setAlbumQueryResultIds);

    const isMobile = useIsMobile();
    const pageRef = useRef<HTMLDivElement>(null);
    const [queryBuilderOpen, setQueryBuilderOpen] = useState(false);
    const [queryBuilderView, setQueryBuilderView] = useState<'artists' | 'albums'>('artists');
    const [mobileOverlayOpen, setMobileOverlayOpen] = useState(false);
    const [mobileOverlayView, setMobileOverlayView] = useState<'artists' | 'albums'>('artists');

    const { genres, tracksByAlbum } = useMemo(() => {
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
            tracks.forEach(track => {
                const explicitAA = track.albumArtist || '';
                const subGroup = subAlbums.get(explicitAA) || [];
                subGroup.push(track);
                subAlbums.set(explicitAA, subGroup);
            });

            for (const [explicitAA, subTracks] of subAlbums.entries()) {
                const artistName = explicitAA !== ''
                    ? explicitAA
                    : (() => {
                        const uniqueArtists = new Set(subTracks.map(t => t.artist || 'Unknown Artist'));
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
    }, [library]);

    const enrichedAlbums = useMemo(
        () => deriveAlbumMetadata(albumEntities, library),
        [albumEntities, library]
    );

    const artistFacetValues = useMemo(
        () => ARTIST_FACETS.map(f => f.extractValues(artistEntities)),
        [artistEntities]
    );

    const albumFacetValues = useMemo(
        () => ALBUM_FACETS.map(f => f.extractValues(enrichedAlbums)),
        [enrichedAlbums]
    );

    const filteredArtists = useMemo(() => {
        let result = applyFacetFilters(artistEntities, artistFilters.facets, ARTIST_FACETS);
        if (artistFilters.queryResultIds) {
            result = applyQueryResultFilter(result, artistFilters.queryResultIds);
        }
        result = applySort(result, artistFilters.sort, artistFilters.sortDirection, 'name');
        return result;
    }, [artistEntities, artistFilters]);

    const filteredAlbums = useMemo(() => {
        let result = applyFacetFilters(enrichedAlbums, albumFilters.facets, ALBUM_FACETS);
        if (albumFilters.queryResultIds) {
            result = applyQueryResultFilter(result, albumFilters.queryResultIds);
        }
        result = applySort(result, albumFilters.sort, albumFilters.sortDirection, 'title');
        return result;
    }, [enrichedAlbums, albumFilters]);

    const handleOpenQueryBuilder = useCallback((view: 'artists' | 'albums') => {
        setQueryBuilderView(view);
        setQueryBuilderOpen(true);
    }, []);

    const handleApplyQuery = useCallback(async (groups: QueryGroup[]) => {
        const view = queryBuilderView;
        const authHeaders = (usePlayerStore.getState() as any).getAuthHeader();
        try {
            const res = await fetch(`/api/filter/${view}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ groups }),
            });
            if (!res.ok) {
                let message = `Query filter failed (${res.status})`;
                try {
                    const err = await res.json();
                    if (err?.error) message = err.error;
                } catch { /* response wasn't JSON */ }
                usePlayerStore.getState().addToast?.(message, 'error');
                return;
            }
            const data = await res.json();
            if (view === 'artists') {
                usePlayerStore.getState().setArtistFilters({
                    ...artistFilters,
                    queryGroups: groups,
                    queryResultIds: data.ids,
                });
            } else {
                usePlayerStore.getState().setAlbumFilters({
                    ...albumFilters,
                    queryGroups: groups,
                    queryResultIds: data.ids,
                });
            }
        } catch {
            usePlayerStore.getState().addToast?.('Query filter failed', 'error');
        }
    }, [queryBuilderView, artistFilters, albumFilters]);

    const showAlbums = !section || section === 'albums';
    const showArtists = section === 'artists';
    const showGenres = section === 'genres';

    if (isLibraryLoading && library.length === 0) {
        return (
            <div className="library-home page-container" ref={pageRef}>
                <div className="library-sections">
                    {showAlbums && (
                        <section className="library-section mb-8 md:mb-12">
                            <div className="album-grid">
                                {Array.from({ length: GRID_SKELETON_COUNT }).map((_, i) => (
                                    <AlbumCardSkeleton key={i} />
                                ))}
                            </div>
                        </section>
                    )}
                    {showArtists && (
                        <section className="library-section mb-8 md:mb-12">
                            <div className="artist-grid">
                                {Array.from({ length: GRID_SKELETON_COUNT }).map((_, i) => (
                                    <ArtistCardSkeleton key={i} />
                                ))}
                            </div>
                        </section>
                    )}
                    {showGenres && (
                        <section className="library-section">
                            <div className="genre-grid">
                                {Array.from({ length: GRID_SKELETON_COUNT }).map((_, i) => (
                                    <GenreCardSkeleton key={i} />
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </div>
        );
    }

    if (library.length === 0) {
        return null;
    }

    return (
        <div className="library-home page-container" ref={pageRef}>
            <div className="library-sections">
                {showAlbums && (
                    <section className="library-section mb-8 md:mb-12">
                        <FilterBar
                            view="albums"
                            filterState={albumFilters}
                            onFilterChange={setAlbumFilters}
                            onOpenQueryBuilder={() => {
                                if (isMobile) {
                                    setMobileOverlayView('albums');
                                    setMobileOverlayOpen(true);
                                } else {
                                    handleOpenQueryBuilder('albums');
                                }
                            }}
                            facetValues={albumFacetValues}
                            isMobile={isMobile}
                        />
                        {filteredAlbums.length === 0 && hasActiveFilters(albumFilters) ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <p className="text-[var(--color-text-muted)] text-sm mb-3">
                                    No albums match these filters
                                </p>
                                <button
                                    onClick={() => usePlayerStore.getState().clearAlbumFilters()}
                                    className="btn btn-ghost btn-sm"
                                >
                                    Clear filters
                                </button>
                            </div>
                        ) : (
                            <VirtualizedCardGrid
                                items={filteredAlbums as any[]}
                                getKey={(album: any) => album.id || `${album.title}::::${album.artist_name || ''}`}
                                estimatedRowHeight={(colWidth) => colWidth + 52}
                                scrollParentRef={pageRef}
                                renderItem={(album: any) => {
                                    const albumKey = `${album.title}::::${album.artist_name || ''}`;
                                    let explicitTracks = tracksByAlbum.get(albumKey) || [];
                                    if (explicitTracks.length === 0 && album.id) {
                                        explicitTracks = library.filter(t => t.albumId === album.id);
                                    }
                                    return (
                                        <AlbumCard
                                            title={album.title}
                                            artist={album.artist_name || ''}
                                            artUrl={album.image_url || (explicitTracks.find(t => t.artUrl)?.artUrl)}
                                            subtitle={album.artist_name || ''}
                                            onPlay={() => { if (explicitTracks.length) setPlaylist(explicitTracks, 0); }}
                                            linkTo={album.id ? `/library/album/${album.id}` : undefined}
                                            linkState={{ backLabel: 'Back to Library' }}
                                            albumId={album.id}
                                        />
                                    );
                                }}
                            />
                        )}
                    </section>
                )}

                {showArtists && (
                    <section className="library-section mb-8 md:mb-12">
                        <FilterBar
                            view="artists"
                            filterState={artistFilters}
                            onFilterChange={setArtistFilters}
                            onOpenQueryBuilder={() => {
                                if (isMobile) {
                                    setMobileOverlayView('artists');
                                    setMobileOverlayOpen(true);
                                } else {
                                    handleOpenQueryBuilder('artists');
                                }
                            }}
                            facetValues={artistFacetValues}
                            isMobile={isMobile}
                        />
                        {filteredArtists.length === 0 && hasActiveFilters(artistFilters) ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <p className="text-[var(--color-text-muted)] text-sm mb-3">
                                    No artists match these filters
                                </p>
                                <button
                                    onClick={() => usePlayerStore.getState().clearArtistFilters()}
                                    className="btn btn-ghost btn-sm"
                                >
                                    Clear filters
                                </button>
                            </div>
                        ) : (
                            <VirtualizedCardGrid
                                items={filteredArtists as any[]}
                                getKey={(entity: any) => entity.id || entity.name || ''}
                                estimatedRowHeight={(colWidth) => colWidth + 40}
                                scrollParentRef={pageRef}
                                renderItem={(entity: any) => {
                                    const artistName = entity.name || '';
                                    if (!entity.id) return <ArtistCard artist={artistName} />;
                                    const artistHref = `/library/artist/${entity.id}`;
                                    const artistHero: ArtistHeroState = {
                                        kind: 'artist',
                                        name: artistName,
                                        imageUrl: (entity as any).image_url || (entity as any).artwork_url || undefined,
                                        backLabel: 'Back to Library',
                                    };
                                    return (
                                        <ArtistLink
                                            to={artistHref}
                                            state={artistHero}
                                        >
                                            <ArtistCard artist={artistName} artistId={entity.id} />
                                        </ArtistLink>
                                    );
                                }}
                            />
                        )}
                    </section>
                )}

                {showGenres && (
                    <section className="library-section">
                        {genres.length === 0 ? (
                           <p style={{ color: 'var(--color-text-muted)' }}>No genres found in your library.</p>
                        ) : (
                            <div className="genre-grid">
                                {genres.map(genreName => {
                                    const entity = genreEntities.find((g: any) => g.name?.toLowerCase() === genreName.toLowerCase());
                                    if (!entity) return <GenreCard key={genreName} genre={genreName} />;
                                    return (
                                        <Link key={genreName} to={`/library/genre/${entity.id}`} state={{ backLabel: 'Back to Library' }} className="no-underline">
                                            <GenreCard genre={genreName} />
                                        </Link>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                )}
            </div>

            <QueryBuilderModal
                view={queryBuilderView}
                isOpen={queryBuilderOpen}
                onClose={() => setQueryBuilderOpen(false)}
                onApply={handleApplyQuery}
                initialGroups={queryBuilderView === 'artists' ? artistFilters.queryGroups : albumFilters.queryGroups}
            />

            <MobileFilterOverlay
                view={mobileOverlayView}
                isOpen={mobileOverlayOpen}
                onClose={() => setMobileOverlayOpen(false)}
                filterState={mobileOverlayView === 'artists' ? artistFilters : albumFilters}
                onFilterChange={mobileOverlayView === 'artists' ? setArtistFilters : setAlbumFilters}
                onOpenQueryBuilder={() => {
                    setMobileOverlayOpen(false);
                    setQueryBuilderView(mobileOverlayView);
                    setQueryBuilderOpen(true);
                }}
                facetValues={mobileOverlayView === 'artists' ? artistFacetValues : albumFacetValues}
            />
        </div>
    );
};
