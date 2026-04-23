import React, { useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumArt } from '../AlbumArt';
import { parseArtists } from '../../utils/artistUtils';
import { formatTime } from '../../utils/formatTime';
import { BackButton } from './BackButton';
import { useAlbumData } from '../../hooks/useAlbumData';

import { MoreHorizontal, Play, Clock, ExternalLink, Headphones, BarChart2 } from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m} min`;
}

function formatQuality(format: string | undefined, bitrate: number | undefined): string | null {
    if (!format) return null;
    const fmt = format.toUpperCase();
    const lossless = ['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WV'];
    if (lossless.includes(fmt)) return `${fmt} · Lossless`;
    if (bitrate && bitrate > 0) return `${fmt} · ${Math.round(bitrate / 1000)}kbps`;
    return fmt;
}

function formatCount(raw: string | undefined): string | null {
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (isNaN(n)) return null;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return n.toLocaleString();
}

function getLinkLabel(url: string, type: string): string {
    const u = url.toLowerCase();
    if (u.includes('spotify.com')) return 'Spotify';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
    if (u.includes('bandcamp.com')) return 'Bandcamp';
    if (u.includes('soundcloud.com')) return 'SoundCloud';
    if (u.includes('discogs.com')) return 'Discogs';
    if (u.includes('allmusic.com')) return 'AllMusic';
    if (u.includes('wikipedia.org')) return 'Wikipedia';
    if (u.includes('last.fm') || u.includes('lastfm.')) return 'Last.fm';
    if (u.includes('apple.com') || u.includes('music.apple')) return 'Apple Music';
    if (u.includes('tidal.com')) return 'Tidal';
    if (u.includes('deezer.com')) return 'Deezer';
    if (u.includes('musicbrainz.org')) return 'MusicBrainz';
    if (type === 'official homepage' || type === 'official audio source') return 'Official Site';
    return type || 'Link';
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

const TrackRowSkeleton: React.FC = () => (
    <div className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] gap-2 px-2 md:px-4 py-2.5 animate-pulse">
        <div className="flex justify-center md:justify-start">
            <div className="h-4 w-4 rounded bg-[var(--color-surface-variant)]" />
        </div>
        <div className="space-y-1.5">
            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)] md:hidden" />
        </div>
        <div className="hidden md:flex justify-end">
            <div className="h-4 w-10 rounded bg-[var(--color-surface-variant)]" />
        </div>
    </div>
);

// ─── Component ───────────────────────────────────────────────────────────────

export const AlbumDetail: React.FC = () => {
    const { albumId } = useParams<{ albumId: string }>();
    const navigate = useNavigate();

    const library = usePlayerStore(state => state.library);
    const albums = usePlayerStore(state => state.albums);
    const artists = usePlayerStore(state => state.artists);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
    const openContextMenu = usePlayerStore(state => state.openContextMenu);

    const albumInfo = useMemo(() => albums.find(a => a.id === albumId), [albums, albumId]);

    const albumTracks = useMemo(() => {
        if (!albumId) return [];
        return library.filter(t => t.albumId === albumId);
    }, [library, albumId]);

    const sortedTracks = useMemo(() => {
        return [...albumTracks].sort((a, b) => {
            const discA = a.discNumber ?? 1;
            const discB = b.discNumber ?? 1;
            if (discA !== discB) return discA - discB;
            if (a.trackNumber != null && b.trackNumber != null) return a.trackNumber - b.trackNumber;
            if (a.trackNumber != null) return -1;
            if (b.trackNumber != null) return 1;
            const aName = a.title || a.path.split(/[\\/]/).pop() || '';
            const bName = b.title || b.path.split(/[\\/]/).pop() || '';
            return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
        });
    }, [albumTracks]);

    const isMultiDisc = useMemo(() =>
        new Set(sortedTracks.map(t => t.discNumber ?? 1)).size > 1,
    [sortedTracks]);

    // ── Derived metadata ───────────────────────────────────────────────────

    const totalDuration = useMemo(() =>
        sortedTracks.reduce((sum, t) => sum + (t.duration || 0), 0),
    [sortedTracks]);

    const releaseType = useMemo(() => {
        const raw = (sortedTracks[0]?.releaseType || '').toLowerCase();
        if (sortedTracks[0]?.isCompilation || raw.includes('compilation')) return 'Compilation';
        if (raw.includes('ep')) return 'EP';
        if (raw.includes('single')) return 'Single';
        if (raw.includes('album')) return 'Album';
        return 'Album';
    }, [sortedTracks]);

    const qualityLabel = useMemo(() => {
        // Pick the most common format; prefer lossless if mixed
        const counts = new Map<string, number>();
        let maxBitrate = 0;
        let dominantFormat = '';
        for (const t of sortedTracks) {
            const fmt = (t.format || '').toUpperCase();
            if (!fmt) continue;
            counts.set(fmt, (counts.get(fmt) || 0) + 1);
            if ((t.bitrate || 0) > maxBitrate) maxBitrate = t.bitrate || 0;
        }
        const lossless = ['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WV'];
        for (const fmt of lossless) {
            if (counts.has(fmt)) { dominantFormat = fmt; break; }
        }
        if (!dominantFormat && counts.size > 0) {
            dominantFormat = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        return dominantFormat ? formatQuality(dominantFormat, maxBitrate) : null;
    }, [sortedTracks]);

    const allGenres = useMemo(() => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const t of sortedTracks) {
            const genres = Array.isArray(t.genres) && t.genres.length > 0
                ? t.genres as string[]
                : t.genre ? [t.genre] : [];
            for (const g of genres) {
                const clean = g.trim();
                if (clean && !seen.has(clean.toLowerCase())) {
                    seen.add(clean.toLowerCase());
                    result.push(clean);
                }
            }
        }
        return result.slice(0, 6);
    }, [sortedTracks]);

    // External album data (Last.fm description, tags, stats)
    const primaryAlbumTitle = albumInfo?.title || sortedTracks[0]?.album || '';
    const primaryArtist = albumInfo?.artist_name || sortedTracks[0]?.albumArtist || sortedTracks[0]?.artist || '';
    const albumMbid = (albumInfo as any)?.mbid || null;
    const {
        description: lfmDescription,
        tags: lfmTags,
        listeners: lfmListeners,
        playcount: lfmPlaycount,
    } = useAlbumData(primaryAlbumTitle, primaryArtist, albumMbid, {
        enabled: !!(primaryAlbumTitle && primaryArtist),
    });

    // Aggregate file-embedded URLs from all tracks, deduplicated
    const fileLinks = useMemo(() => {
        const seen = new Set<string>();
        const result: { url: string; type: string }[] = [];
        for (const t of sortedTracks) {
            for (const link of (t.rawUrls || [])) {
                if (!seen.has(link.url)) {
                    seen.add(link.url);
                    result.push(link);
                }
            }
        }
        return result;
    }, [sortedTracks]);

    // ── Navigation helpers ─────────────────────────────────────────────────

    if (!albumId) {
        return (
            <div className="flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1">
                <div className="shrink-0 mb-6"><BackButton onClick={() => navigate(-1)} /></div>
                <div className="flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12">
                    <div className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl bg-[var(--color-surface-variant)] animate-pulse" />
                    <div className="flex-1 space-y-3">
                        <div className="h-4 w-16 rounded bg-[var(--color-surface-variant)] animate-pulse" />
                        <div className="h-10 w-3/4 rounded bg-[var(--color-surface-variant)] animate-pulse" />
                        <div className="h-5 w-1/2 rounded bg-[var(--color-surface-variant)] animate-pulse" />
                        <div className="h-10 w-32 rounded-full bg-[var(--color-surface-variant)] animate-pulse mt-4" />
                    </div>
                </div>
                <div className="space-y-0.5">
                    {Array.from({ length: 8 }).map((_, i) => <TrackRowSkeleton key={i} />)}
                </div>
            </div>
        );
    }

    if (albumTracks.length === 0) {
        return <div className="flex-1 flex justify-center items-center text-[var(--color-text-muted)]">Album not found.</div>;
    }

    const albumTitle = albumInfo?.title || albumTracks[0]?.album || 'Unknown Album';
    const albumArtist = albumInfo?.artist_name || albumTracks[0]?.albumArtist || albumTracks[0]?.artist || 'Unknown Artist';
    const artUrl = albumTracks.find(t => t.artUrl)?.artUrl;
    const albumYear = albumTracks.find(t => t.year)?.year;
    const headerArtists = parseArtists(albumArtist);

    const getArtistLink = (artistName: string): string | null => {
        const entity = artists.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase());
        if (entity) return `/library/artist/${entity.id}`;
        const track = albumTracks.find(t =>
            (t.albumArtist || t.artist || '').toLowerCase() === artistName.toLowerCase()
        );
        if (track?.artistId) return `/library/artist/${track.artistId}`;
        return null;
    };

    const handlePlayAll = () => setPlaylist(sortedTracks, 0);
    const handlePlayTrack = (index: number) => setPlaylist(sortedTracks, index);

    return (
        <div className="flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1">

            <div className="shrink-0 mb-6"><BackButton onClick={() => navigate(-1)} /></div>

            <div className="shrink-0 flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
                <div className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl relative overflow-hidden backdrop-blur-xl bg-black/10 dark:bg-white/5">
                    <AlbumArt artUrl={artUrl} artist={albumArtist} size={240} className="w-full h-full object-cover rounded-2xl" />
                </div>
                <div className="flex flex-col justify-end items-center md:items-start max-w-full">
                    {/* Release type label — dynamic */}
                    <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">{releaseType}</div>

                    <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight my-2 leading-tight text-[var(--color-text-primary)] line-clamp-2" title={albumTitle}>{albumTitle}</h1>

                    <h2 className="text-xl text-[var(--color-text-secondary)] flex flex-wrap justify-center md:justify-start items-center gap-2 mb-2 w-full truncate">
                        <span className="truncate">
                        {headerArtists.map((a, i) => {
                            const link = getArtistLink(a);
                            return (
                                <React.Fragment key={a}>
                                    {i > 0 && ' · '}
                                    {link ? (
                                        <Link
                                            to={link}
                                            className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                                        >{a}</Link>
                                    ) : (
                                        <span>{a}</span>
                                    )}
                                </React.Fragment>
                            );
                        })}
                        </span>
                        <span className="hidden md:inline shrink-0"> • </span>
                        <span className="shrink-0 text-sm md:text-xl text-[var(--color-text-muted)]">
                            {albumTracks.length} track{albumTracks.length !== 1 ? 's' : ''}
                            {albumYear && ` • ${albumYear}`}
                            {totalDuration > 0 && (
                                <span className="inline-flex items-center gap-1 ml-1">
                                    • <Clock className="w-3.5 h-3.5 inline" /> {formatDuration(totalDuration)}
                                </span>
                            )}
                        </span>
                    </h2>

                    {/* Genre tags */}
                    {allGenres.length > 0 && (
                        <div className="flex flex-wrap justify-center md:justify-start gap-1.5 mt-1 mb-3">
                            {allGenres.map(g => (
                                <span key={g} className="inline-block text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-[var(--glass-border)] bg-[var(--color-surface-variant)] text-[var(--color-primary)] backdrop-blur-sm">
                                    {g}
                                </span>
                            ))}
                        </div>
                    )}

                    {/* Quality badge */}
                    {qualityLabel && (
                        <div className="mb-3">
                            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-surface-variant)] text-[var(--color-text-muted)] border border-[var(--glass-border)]">
                                {qualityLabel}
                            </span>
                        </div>
                    )}

                    {/* Last.fm listener / playcount stats */}
                    {(lfmListeners || lfmPlaycount) && (
                        <div className="flex flex-wrap justify-center md:justify-start gap-3 mb-3 text-sm text-[var(--color-text-muted)]">
                            {lfmListeners && (
                                <span className="inline-flex items-center gap-1">
                                    <Headphones className="w-3.5 h-3.5" />
                                    {formatCount(lfmListeners)} listeners
                                </span>
                            )}
                            {lfmPlaycount && (
                                <span className="inline-flex items-center gap-1">
                                    <BarChart2 className="w-3.5 h-3.5" />
                                    {formatCount(lfmPlaycount)} plays
                                </span>
                            )}
                        </div>
                    )}

                    {/* Last.fm tags (supplemental genres) */}
                    {lfmTags && lfmTags.length > 0 && (
                        <div className="flex flex-wrap justify-center md:justify-start gap-1.5 mb-3">
                            {lfmTags.slice(0, 5).map(tag => (
                                <span key={tag} className="inline-block text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-[var(--glass-border)] bg-[var(--color-surface-variant)] text-[var(--color-text-secondary)] backdrop-blur-sm">
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}

                    {/* File-embedded links */}
                    {fileLinks.length > 0 && (
                        <div className="flex flex-wrap justify-center md:justify-start gap-2 mb-3">
                            {fileLinks.slice(0, 8).map((link, i) => (
                                <a
                                    key={i}
                                    href={link.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)] bg-[var(--color-surface-variant)] hover:bg-[var(--color-primary)]/10 border border-[var(--glass-border)] hover:border-[var(--glass-border-hover)] transition-colors motion-reduce:transition-none"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                    {getLinkLabel(link.url, link.type)}
                                </a>
                            ))}
                        </div>
                    )}

                    <div className="mt-2 flex justify-center md:justify-start w-full md:w-auto">
                        <button
                            onClick={handlePlayAll}
                            className="flex items-center justify-center gap-2 px-8 py-3.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold text-sm tracking-widest uppercase rounded-full shadow-[0_4px_24px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_32px_rgba(16,185,129,0.4)] hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 transition-all duration-300 w-full md:w-auto"
                        >
                            <Play size={18} fill="currentColor" className="ml-1" />
                            PLAY {releaseType.toUpperCase()}
                        </button>
                    </div>
                </div>
            </div>

            {lfmDescription && (
                <p className="shrink-0 text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4 mt-2 line-clamp-3 max-w-3xl">
                    {lfmDescription}
                </p>
            )}

            <div className="mt-4 overflow-y-auto flex-1 min-h-0 hide-scrollbar pb-6">
                <div className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] px-2 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                    <div className="text-center md:text-left">#</div>
                    <div>Title</div>
                    <div className="text-right hidden md:block">Time</div>
                </div>
                {(() => {
                    const rows: React.ReactNode[] = [];
                    let lastDisc: number | null = null;
                    sortedTracks.forEach((track, i) => {
                        const disc = track.discNumber ?? 1;
                        if (isMultiDisc && disc !== lastDisc) {
                            lastDisc = disc;
                            rows.push(
                                <div key={`disc-${disc}`} className="px-2 md:px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-widest text-[var(--color-primary)] border-b border-black/5 dark:border-white/10 mb-1">
                                    Disc {disc}
                                </div>
                            );
                        }
                        rows.push(
                            <div
                                key={track.id}
                                onClick={() => handlePlayTrack(i)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        handlePlayTrack(i);
                                    }
                                }}
                                className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] gap-2 px-2 md:px-4 py-2 border-b border-black/5 dark:border-white/5 cursor-pointer items-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:bg-black/5 dark:focus-visible:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] rounded-lg my-0.5 group"
                            >
                                <div className="text-center md:text-left text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm tabular-nums">
                                    {track.trackNumber ?? i + 1}
                                </div>
                                <div className="font-medium truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors min-w-0">
                                    <span className="block truncate text-sm md:text-base">{track.title || track.path.split(/[\/\\]/).pop()}</span>
                                    {((track.artists && Array.isArray(track.artists) && track.artists.length > 0) || (track.artist && parseArtists(track.artist).length > 0)) && (
                                        <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                                            {(Array.isArray(track.artists) && track.artists.length > 0 ? track.artists : parseArtists(track.artist || '')).map((a, j) => {
                                                const link = getArtistLink(a);
                                                return (
                                                    <React.Fragment key={a}>
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
                                    )}
                                </div>
                                <div className="text-[var(--color-text-muted)] text-right group-hover:text-[var(--color-text-primary)] transition-colors flex flex-row items-center justify-end md:gap-3">
                                    <span className="w-12 text-right hidden md:inline text-sm tabular-nums">
                                        {formatTime(track.duration, '--:--')}
                                    </span>
                                    <button
                                        aria-label="More options"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            openContextMenu(track, e.clientX, e.clientY);
                                        }}
                                        className="opacity-50 md:opacity-0 md:group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/10 rounded-md transition-all p-1.5 focus:opacity-100"
                                    >
                                        <MoreHorizontal size={18} />
                                    </button>
                                </div>
                            </div>
                        );
                    });
                    return rows;
                })()}
            </div>
        </div>
    );
};
