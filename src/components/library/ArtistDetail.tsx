import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { normalizeArtistIdentityKey, parseArtistsForDisplay, trackMatchesArtist } from '../../utils/artistUtils';
import { useKnownArtistKeys } from '../../hooks/useKnownArtistKeys';
import { useArtistData } from '../../hooks/useArtistData';
import { useArtistTopTracks } from '../../hooks/useArtistTopTracks';
import { AlbumArt } from '../AlbumArt';
import { AlbumCard, AlbumCardSkeleton } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { ArtistInitial } from './ArtistInitial';
import { formatTime } from '../../utils/formatTime';
import { ExternalLink, Globe, Users, Mic2, Calendar, Sparkles, Music2, Clock, BookOpen, Play, Headphones, Link2, Disc3, Radio } from 'lucide-react';
import { ContextMenuFrame, ContextMenuHeader, ContextMenuLink, ContextMenuList, ContextMenuPortal } from '../ContextMenu';
import { useArtistConcerts, OnTourSticker, UpcomingShows } from './ArtistConcerts';
import { useIsCurrentCollection, useNowPlayingState } from '../../hooks/useNowPlaying';
import { NowPlayingBadge } from '../now-playing/NowPlayingBadge';
import { NowPlayingBars } from '../now-playing/NowPlayingBars';

// ─── Link label helpers ───────────────────────────────────────────────────────

/**
 * Returns false for URLs that clearly point to a specific release/album/track
 * rather than an artist page (e.g. discogs.com/master/…, allmusic.com/album/…).
 */
function isArtistLevelUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, '');
    const path = pathname.toLowerCase();

    if (host === 'discogs.com') return path.startsWith('/artist/');
    if (host === 'allmusic.com') return !path.startsWith('/album/') && !path.startsWith('/song/') && !path.startsWith('/composition/');
    if (host === 'open.spotify.com' || host === 'spotify.com') return path.startsWith('/artist/');
    if (host === 'last.fm' || host.endsWith('.last.fm')) {
      // /music/Artist → ok; /music/Artist/Album → release
      const segs = path.split('/').filter(Boolean);
      return !(segs[0] === 'music' && segs.length >= 3);
    }
    if (host === 'musicbrainz.org') return path.startsWith('/artist/');

    return true;
  } catch {
    return true;
  }
}

function getLinkLabel(url: string, type: string): string {
  const u = url.toLowerCase();
  if (u.includes('spotify.com')) return 'Spotify';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('facebook.com') || u.includes('fb.com')) return 'Facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'X / Twitter';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('bandcamp.com')) return 'Bandcamp';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('discogs.com')) return 'Discogs';
  if (u.includes('allmusic.com')) return 'AllMusic';
  if (u.includes('wikipedia.org')) return 'Wikipedia';
  if (u.includes('wikidata.org')) return 'Wikidata';
  if (u.includes('last.fm') || u.includes('lastfm.')) return 'Last.fm';
  if (u.includes('apple.com') || u.includes('music.apple')) return 'Apple Music';
  if (u.includes('tidal.com')) return 'Tidal';
  if (u.includes('deezer.com')) return 'Deezer';
  if (u.includes('genius.com')) return 'Genius';
  if (u.includes('rateyourmusic.com')) return 'RateYourMusic';
  if (u.includes('musicbrainz.org')) return 'MusicBrainz';

  if (type === 'official homepage') return 'Official Site';
  if (type === 'social network') return 'Social';
  if (type === 'streaming') return 'Streaming';
  if (type === 'official audio source') return 'Audio Source';
  if (type === 'discogs') return 'Discogs';
  if (type === 'youtube') return 'YouTube';
  if (type === 'spotify') return 'Spotify';
  if (type === 'soundcloud') return 'SoundCloud';
  if (type === 'bandcamp') return 'Bandcamp';
  if (type === 'wikipedia') return 'Wikipedia';
  return type || 'Link';
}

function formatListeners(raw: string): string {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return raw;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M listeners`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K listeners`;
  return `${n} listeners`;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function normalizePopularTitle(value: string | undefined | null): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/\s*\[[^\]]*(remaster|remastered|version|edit|mono|stereo|explicit|clean)[^\]]*\]/gi, '')
    .replace(/\s*\([^)]*(remaster|remastered|version|edit|mono|stereo|explicit|clean)[^)]*\)/gi, '')
    .replace(/\s+(feat\.?|featuring|ft\.?)\s+.+$/i, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function formatCompactCount(raw?: string): string | null {
  if (!raw) return null;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return value.toLocaleString();
}

type SimilarArtist = {
    id: string;
    name: string;
    imageUrl?: string;
    trackCount: number;
    albumCount: number;
    analyzedTracks: number;
    matchScore: number;
};

const SimilarArtistsSection: React.FC<{ artists: SimilarArtist[]; loading: boolean }> = ({ artists, loading }) => {
    if (loading) {
        return (
            <section className="mb-12">
                <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
                    <Users className="w-4 h-4 text-[var(--color-primary)] opacity-60" />
                    Similar artists
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {[0, 1, 2, 3].map(i => (
                        <div key={i} className="h-[154px] rounded-xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                    ))}
                </div>
            </section>
        );
    }

    if (artists.length === 0) return null;

    return (
        <section className="mb-12">
            <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
                <Users className="w-4 h-4 text-[var(--color-primary)] opacity-60" />
                Similar artists
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {artists.map(artist => (
                    <Link
                        key={artist.id}
                        to={`/library/artist/${artist.id}`}
                        state={{ backLabel: 'Back to Artist' }}
                        className="group rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-3 transition-ui hover:border-[var(--color-primary)]/40 hover:bg-[var(--glass-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                    >
                        <div className="flex items-start gap-3">
                            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full border border-black/10 bg-black/10 dark:border-white/10 dark:bg-white/10">
                                {artist.imageUrl ? (
                                    <img src={artist.imageUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                        <ArtistInitial name={artist.name} className="text-xl text-[var(--color-primary)] opacity-55" />
                                    </div>
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold text-[var(--color-text-primary)] transition-colors group-hover:text-[var(--color-primary)]">
                                    {artist.name}
                                </div>
                                <div className="mt-1 text-xs text-[var(--color-text-muted)] tabular-nums">
                                    {artist.matchScore}% match
                                </div>
                            </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                            <span>{artist.trackCount} track{artist.trackCount !== 1 ? 's' : ''}</span>
                            {artist.albumCount > 0 && <span>{artist.albumCount} album{artist.albumCount !== 1 ? 's' : ''}</span>}
                        </div>
                    </Link>
                ))}
            </div>
        </section>
    );
};

const ArtistDetailSkeleton: React.FC<{ onBack: () => void }> = ({ onBack }) => (
    <div className="artist-detail page-container relative">
        <div className="relative z-10">
            <BackButton onClick={onBack} />
            <section className="flex flex-col md:flex-row items-center md:items-end gap-8 mb-10 md:mb-14">
                <div className="w-48 h-48 md:w-64 md:h-64 rounded-full shrink-0 bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                <div className="flex-1 w-full space-y-4 text-center md:text-left">
                    <div className="h-12 md:h-16 w-3/4 max-w-xl rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                    <div className="h-4 w-56 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                    <div className="h-10 w-36 rounded-full bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                </div>
            </section>
            <div className="mb-12 max-w-3xl space-y-2">
                <div className="h-4 w-full rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                <div className="h-4 w-5/6 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                <div className="h-4 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
            </div>
            <div className="album-grid">
                {Array.from({ length: 6 }).map((_, i) => <AlbumCardSkeleton key={i} />)}
            </div>
        </div>
    </div>
);

// ─── Component ───────────────────────────────────────────────────────────────

export const ArtistDetail: React.FC = () => {
    const { artistId } = useParams<{ artistId: string }>();
    const navigate = useNavigate();
    const { library, artists, setPlaylist, getAuthHeader, isLibraryLoading } = usePlayerStore();

    // Find artist info from entity list
    const artistInfo = useMemo(() => artists.find(a => a.id === artistId), [artists, artistId]);
    const artistName = artistInfo?.name || '';

    // Get MusicBrainz artist ID from the first track that has one
    const mbArtistId = useMemo(() => {
        if (!artistId) return null;
        const track = library.find(t => t.artistId === artistId && t.mbArtistId);
        return track?.mbArtistId || null;
    }, [library, artistId]);

    const { imageUrl, artworkUrl, bio, disambiguation, area, type, lifeSpan, links, genres, communityTags, listeners, members, isLoading: artistLoading } = useArtistData(artistName, mbArtistId);
    const { onTour, events: upcomingEvents, loading: concertsLoading, stale: concertsStale } = useArtistConcerts(artistId);
    const { tracks: externalTopTracks } = useArtistTopTracks(artistName, {
        enabled: !!artistName,
        limit: 30,
    });
    const [bioExpanded, setBioExpanded] = useState(false);
    const [linksMenuOpen, setLinksMenuOpen] = useState(false);
    const [popularExpanded, setPopularExpanded] = useState(false);
    const [similarArtists, setSimilarArtists] = useState<SimilarArtist[]>([]);
    const [similarArtistsLoading, setSimilarArtistsLoading] = useState(false);
    const [radioLoading, setRadioLoading] = useState(false);
    const linksButtonRef = useRef<HTMLButtonElement>(null);
    const isArtistPlaying = useIsCurrentCollection({ artistId: artistId ?? undefined });
    const playbackState = useNowPlayingState();
    const currentTrackId = usePlayerStore((s) => s.currentIndex !== null ? s.playlist[s.currentIndex]?.id ?? null : null);

    const handlePlayArtistRadio = async () => {
        if (!artistId || radioLoading) return;
        setRadioLoading(true);
        try {
            const res = await fetch('/api/hub/artist-radio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ artistId }),
            });
            if (!res.ok) throw new Error('Failed to load radio');
            const { playlist } = await res.json();
            const tracks = (playlist?.tracks || [])
                .map((t: any) => library.find(lt => lt.id === t.id) || t)
                .filter(Boolean);
            if (tracks.length > 0) setPlaylist(tracks, 0);
        } catch (e) {
            console.error('[Artist Radio] Failed to start radio', e);
        } finally {
            setRadioLoading(false);
        }
    };

    useEffect(() => {
        if (!artistId) {
            setSimilarArtists([]);
            setSimilarArtistsLoading(false);
            return;
        }

        let cancelled = false;
        setSimilarArtistsLoading(true);
        fetch(`/api/artists/${artistId}/similar?limit=8`, { headers: getAuthHeader() })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (!cancelled) setSimilarArtists(Array.isArray(data?.artists) ? data.artists : []);
            })
            .catch(() => {
                if (!cancelled) setSimilarArtists([]);
            })
            .finally(() => {
                if (!cancelled) setSimilarArtistsLoading(false);
            });

        return () => { cancelled = true; };
    }, [artistId, getAuthHeader]);

    // Tracks where this artist is the PRIMARY / album artist
    const primaryTracks = useMemo(() => {
        if (!artistName) return [];
        return library.filter(t => t.artistId === artistId);
    }, [library, artistId, artistName]);

    const knownArtistKeys = useKnownArtistKeys();

    // Tracks where this artist APPEARS but is NOT the album owner.
    // Compares using canonical identity keys (so post-merge variants like
    // "N'to" / "NTO" match) AND artist-aware credit splitting (so a joined
    // entry like "Tony Bennett & Lady Gaga" in tracks.artists matches both
    // halves when both are known artists in the library).
    const otherCreditedTracks = useMemo(() => {
        if (!artistName) return [];
        const artistKey = normalizeArtistIdentityKey(artistName);
        if (!artistKey) return [];
        const splitMatches = (raw: string | undefined) =>
            !!raw && parseArtistsForDisplay(raw, knownArtistKeys).some(a => normalizeArtistIdentityKey(a) === artistKey);
        return library.filter(t => {
            if (t.artistId === artistId) return false;
            const ownerSrc = t.albumArtist || t.artist || '';
            if (normalizeArtistIdentityKey(ownerSrc) === artistKey) return false;
            if (Array.isArray(t.artists) && t.artists.length > 0) {
                return t.artists.some(a => {
                    if (normalizeArtistIdentityKey(a) === artistKey) return true;
                    return splitMatches(a);
                });
            }
            return trackMatchesArtist(t.artist, artistName) || splitMatches(t.artist);
        });
    }, [library, artistId, artistName, knownArtistKeys]);

    // Among the credited-but-not-owner tracks, identify whole albums where
    // this artist is a co-primary collaborator rather than a guest feature.
    // Heuristic: if the artist is credited on at least half of the album's
    // tracks in the library, the album is a collaboration (Tony Bennett &
    // Lady Gaga's "Cheek to Cheek") and should appear under primary releases
    // on both pages. Single-track guest features stay under "Also appears on".
    const COLLABORATION_TRACK_RATIO = 0.5;
    const { collaborationTracks, featuredTracks } = useMemo(() => {
        if (otherCreditedTracks.length === 0) {
            return { collaborationTracks: [] as TrackInfo[], featuredTracks: [] as TrackInfo[] };
        }
        const artistKey = normalizeArtistIdentityKey(artistName);
        if (!artistKey) {
            return { collaborationTracks: [] as TrackInfo[], featuredTracks: otherCreditedTracks };
        }

        const albumKeyOf = (t: TrackInfo) =>
            t.albumId || (t.album ? `${t.album}::::${t.albumArtist || t.artist || ''}` : '');

        const tracksByAlbum = new Map<string, TrackInfo[]>();
        for (const t of library) {
            const k = albumKeyOf(t);
            if (!k) continue;
            tracksByAlbum.set(k, [...(tracksByAlbum.get(k) || []), t]);
        }

        const collaborationKeys = new Set<string>();
        const checked = new Set<string>();
        for (const t of otherCreditedTracks) {
            const k = albumKeyOf(t);
            if (!k || checked.has(k)) continue;
            checked.add(k);
            const allOnAlbum = tracksByAlbum.get(k) || [];
            if (allOnAlbum.length === 0) continue;
            const credited = allOnAlbum.filter(at => {
                const splitHit = (raw: string | undefined) =>
                    !!raw && parseArtistsForDisplay(raw, knownArtistKeys).some(a => normalizeArtistIdentityKey(a) === artistKey);
                if (Array.isArray(at.artists) && at.artists.length > 0) {
                    return at.artists.some(a => normalizeArtistIdentityKey(a) === artistKey || splitHit(a));
                }
                return trackMatchesArtist(at.artist, artistName) || splitHit(at.artist);
            }).length;
            if (credited / allOnAlbum.length >= COLLABORATION_TRACK_RATIO) {
                collaborationKeys.add(k);
            }
        }

        const collab: TrackInfo[] = [];
        const feat: TrackInfo[] = [];
        for (const t of otherCreditedTracks) {
            (collaborationKeys.has(albumKeyOf(t)) ? collab : feat).push(t);
        }
        return { collaborationTracks: collab, featuredTracks: feat };
    }, [library, otherCreditedTracks, artistName, knownArtistKeys]);

    // Aggregate file-embedded URLs from all primary tracks, deduplicated
    const fileLinks = useMemo(() => {
        const seen = new Set<string>();
        const result: { url: string; type: string }[] = [];
        for (const track of primaryTracks) {
            for (const link of (track.rawUrls || [])) {
                if (!seen.has(link.url)) {
                    seen.add(link.url);
                    result.push(link);
                }
            }
        }
        return result;
    }, [primaryTracks]);

    // Merge file links + MusicBrainz links, preferring file links (deduplicate by URL)
    const allLinks = useMemo(() => {
        const seen = new Set<string>();
        const result: { url: string; type: string }[] = [];
        const add = (link: { url: string; type: string }) => {
            if (!seen.has(link.url) && isArtistLevelUrl(link.url)) {
                seen.add(link.url);
                result.push(link);
            }
        };
        fileLinks.forEach(add);
        (links || []).forEach(add);
        return result;
    }, [fileLinks, links]);

    // Local library stats
    const libraryStats = useMemo(() => {
        const totalTracks = primaryTracks.length;
        const albumSet = new Set<string>();
        let totalDuration = 0;
        for (const t of primaryTracks) {
            if (t.albumId) albumSet.add(t.albumId);
            else if (t.album) albumSet.add(t.album);
            totalDuration += t.duration || 0;
        }
        return { totalTracks, totalAlbums: albumSet.size, totalDuration };
    }, [primaryTracks]);

    const buildReleaseGroups = (tracks: TrackInfo[]) => {
        const albumMap = new Map<string, { title: string, artist: string, artUrl?: string, albumId?: string, type: 'Album' | 'EP' | 'Single' | 'Compilation', tracks: TrackInfo[] }>();

        tracks.forEach(track => {
            const albumTitle = track.album || 'Unknown Album';
            const albumOwner = track.albumArtist || track.artist || 'Unknown Artist';
            const key = track.albumId || `${albumTitle}::::${albumOwner}`;
            if (!albumMap.has(key)) {
                let rType: 'Album' | 'EP' | 'Single' | 'Compilation' = 'Album';
                const rawType = (track.releaseType || '').toLowerCase();
                if (track.isCompilation || rawType.includes('compilation')) rType = 'Compilation';
                else if (rawType.includes('ep')) rType = 'EP';
                else if (rawType.includes('single')) rType = 'Single';

                albumMap.set(key, {
                    title: albumTitle,
                    artist: albumOwner,
                    artUrl: track.artUrl,
                    albumId: track.albumId,
                    type: rType,
                    tracks: []
                });
            }
            albumMap.get(key)!.tracks.push(track);
        });

        const all = Array.from(albumMap.values()).sort((a, b) => a.title.localeCompare(b.title));
        return {
            albums: all.filter(r => r.type === 'Album'),
            eps: all.filter(r => r.type === 'EP'),
            singles: all.filter(r => r.type === 'Single'),
            compilations: all.filter(r => r.type === 'Compilation'),
        };
    };

    const primaryReleaseTracks = useMemo(
        () => [...primaryTracks, ...collaborationTracks],
        [primaryTracks, collaborationTracks]
    );
    const releaseGroups = useMemo(() => buildReleaseGroups(primaryReleaseTracks), [primaryReleaseTracks]);
    const featuredGroups = useMemo(() => buildReleaseGroups(featuredTracks), [featuredTracks]);

    const popularLibraryTracks = useMemo(() => {
        if (externalTopTracks.length === 0) return [];
        const localTracks = [...primaryTracks, ...collaborationTracks, ...featuredTracks];
        const byExactTitle = new Map<string, TrackInfo[]>();
        const byLooseTitle = new Map<string, TrackInfo[]>();

        for (const track of localTracks) {
            const displayTitle = track.title || track.path.split(/[\\/]/).pop() || '';
            const exactKey = normalizePopularTitle(displayTitle);
            const looseKey = normalizePopularTitle(displayTitle.replace(/\s*[-–—]\s*(remaster|remastered|version|edit|mono|stereo).*/i, ''));
            if (!exactKey) continue;
            byExactTitle.set(exactKey, [...(byExactTitle.get(exactKey) || []), track]);
            byLooseTitle.set(looseKey, [...(byLooseTitle.get(looseKey) || []), track]);
        }

        const seen = new Set<string>();
        return externalTopTracks.flatMap((topTrack, rank) => {
            const key = normalizePopularTitle(topTrack.name);
            const candidates = byExactTitle.get(key) || byLooseTitle.get(key) || [];
            const track = candidates
                .filter(candidate => !seen.has(candidate.id))
                .sort((a, b) => (b.playCount || 0) - (a.playCount || 0) || (a.album || '').localeCompare(b.album || ''))[0];

            if (!track) return [];
            seen.add(track.id);
            return [{
                track,
                rank: rank + 1,
                playcount: topTrack.playcount,
                listeners: topTrack.listeners,
            }];
        }).slice(0, 10);
    }, [externalTopTracks, primaryTracks, collaborationTracks, featuredTracks]);

    const hasPopularInLibrary = popularLibraryTracks.length > 0;
    const popularTrackQueue = useMemo(
        () => popularLibraryTracks.map(entry => entry.track),
        [popularLibraryTracks]
    );
    const handlePlayPopularTracks = useCallback((startIndex = 0) => {
        if (popularTrackQueue.length === 0) return;
        setPlaylist(popularTrackQueue, startIndex);
    }, [popularTrackQueue, setPlaylist]);

    // Merged, deduplicated tags: communityTags take priority; plain genres fill in unique gaps
    const mergedTags = useMemo(() => {
        const result: Array<{ name: string; isCommunity: boolean; providers?: string[]; count?: number }> = [];
        const seen = new Set<string>();
        for (const tag of (communityTags || [])) {
            const key = tag.name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ name: tag.name, isCommunity: true, providers: tag.providers, count: tag.count });
            }
        }
        for (const g of (genres || [])) {
            const key = g.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ name: g, isCommunity: false });
            }
        }
        return result.slice(0, 12);
    }, [genres, communityTags]);

    const hasAnyContent = primaryTracks.length > 0 || collaborationTracks.length > 0 || featuredTracks.length > 0;

    if (isLibraryLoading && (!artistName || !hasAnyContent)) {
        return <ArtistDetailSkeleton onBack={() => navigate(-1)} />;
    }

    if (!artistName || !hasAnyContent) return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <Users className="w-12 h-12 text-[var(--color-text-muted)] opacity-30 mb-4" />
            <p className="text-lg font-medium text-[var(--color-text-secondary)]">Artist not found</p>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">This artist may not have any tracks in your library.</p>
        </div>
    );

    return (
        <div className="artist-detail page-container relative">
            {artworkUrl && <FadedHeroImage src={artworkUrl} variant="wide" />}
            <div className="relative z-10">
                <BackButton onClick={() => navigate(-1)} />

                <div className="flex flex-col md:flex-row gap-8 items-start mb-8 md:mb-12">
                    {imageUrl ? (
                        <div className="w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)]">
                            <img src={imageUrl} alt={artistName} className="w-full h-full object-cover" />
                        </div>
                    ) : (
                        <div className={`w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] flex items-center justify-center ${artistLoading ? 'animate-pulse motion-reduce:animate-none' : ''}`}>
                            <ArtistInitial name={artistName} />
                        </div>
                    )}

                    <div className="flex-1">
                        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                            <h1 className="font-bold text-4xl md:text-6xl lg:text-7xl tracking-tight text-[var(--color-text-primary)]">
                                {artistName}
                            </h1>
                            <OnTourSticker visible={onTour} />
                            {isArtistPlaying && playbackState !== 'stopped' && (
                                <NowPlayingBadge state={playbackState === 'playing' ? 'playing' : 'paused'} className="self-end mb-1.5 shrink-0" />
                            )}
                        </div>

                        {/* Band members */}
                        {members && members.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1 mb-3">
                                <span className="text-xs text-[var(--color-text-muted)] mr-1">Members:</span>
                                {members.map((m, i) => (
                                    <span key={m} className="text-xs text-[var(--color-text-secondary)]">
                                        {m}{i < members.length - 1 ? ',' : ''}
                                    </span>
                                ))}
                            </div>
                        )}

                        {/* MusicBrainz metadata */}
                        {(disambiguation || type || area || lifeSpan?.begin) && (
                            <div className="flex flex-wrap items-center gap-3 mb-3 text-xs text-[var(--color-text-muted)]">
                                {type && (
                                    <span className="inline-flex items-center gap-1">
                                        {type === 'Group' ? <Users className="w-3 h-3" /> : type === 'Person' ? <Mic2 className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                                        {type}
                                        {disambiguation && (
                                            <span className="italic text-[var(--color-text-muted)]">
                                                {' – '}{disambiguation}
                                            </span>
                                        )}
                                    </span>
                                )}
                                {!type && disambiguation && (
                                    <span className="italic text-[var(--color-text-muted)]">{disambiguation}</span>
                                )}
                                {area && (
                                    <span className="inline-flex items-center gap-1">
                                        <Globe className="w-3 h-3" />
                                        {area}
                                    </span>
                                )}
                                {lifeSpan?.begin && (
                                    <span className="inline-flex items-center gap-1">
                                        <Calendar className="w-3 h-3" />
                                        {lifeSpan.begin}{lifeSpan.end ? ` – ${lifeSpan.end}` : ' – present'}
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Local library stats */}
                        {(libraryStats.totalTracks > 0 || listeners) && (
                            <div className="flex items-center gap-3 mb-3 text-xs text-[var(--color-text-muted)]">
                                {libraryStats.totalTracks > 0 && (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="w-3 h-3" />
                                        {libraryStats.totalTracks} track{libraryStats.totalTracks !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {libraryStats.totalAlbums > 0 && (
                                    <span className="inline-flex items-center gap-1">
                                        <BookOpen className="w-3 h-3" />
                                        {libraryStats.totalAlbums} album{libraryStats.totalAlbums !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {libraryStats.totalDuration > 60 && (
                                    <span className="inline-flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        {formatDuration(libraryStats.totalDuration)}
                                    </span>
                                )}
                                {listeners && (
                                    <span className="inline-flex items-center gap-1">
                                        <Headphones className="w-3 h-3" />
                                        {formatListeners(listeners)}
                                    </span>
                                )}
                            </div>
                        )}

                        <div className="mt-4 mb-4 flex flex-wrap items-center gap-3">
                            <button
                                type="button"
                                onClick={handlePlayArtistRadio}
                                disabled={!artistId || radioLoading}
                                title={radioLoading ? 'Building radio…' : 'Play a mix inspired by this artist'}
                                aria-label={hasPopularInLibrary ? 'Play artist radio' : undefined}
                                className={`${hasPopularInLibrary ? 'h-12 w-12 px-0 shrink-0' : 'w-full px-8 sm:w-auto'} flex items-center justify-center gap-2 py-3.5 bg-[var(--color-primary)] text-white font-bold text-sm tracking-widest uppercase rounded-full shadow-[0_4px_24px_rgba(16,185,129,0.22)] hover:bg-[var(--color-primary-dark)] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-55 disabled:cursor-not-allowed transition-ui`}
                            >
                                {radioLoading ? (
                                    <span className="w-[18px] h-[18px] rounded-full border-2 border-white/40 border-t-white animate-spin" />
                                ) : (
                                    <Radio size={18} />
                                )}
                                {!hasPopularInLibrary && (radioLoading ? 'Building…' : 'Play artist radio')}
                            </button>

                            {hasPopularInLibrary && (
                                <button
                                    type="button"
                                    onClick={() => handlePlayPopularTracks(0)}
                                    className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--color-primary)] px-6 py-3.5 text-sm font-bold uppercase tracking-widest text-white shadow-[0_4px_24px_rgba(16,185,129,0.22)] transition-ui hover:bg-[var(--color-primary-dark)] hover:scale-[1.02] active:scale-[0.98] sm:flex-none"
                                >
                                    <Play className="h-4 w-4 shrink-0" fill="currentColor" />
                                    <span className="truncate">Play {artistName}</span>
                                </button>
                            )}

                            <button
                                ref={linksButtonRef}
                                type="button"
                                onClick={() => setLinksMenuOpen(open => !open)}
                                disabled={allLinks.length === 0}
                                aria-label="Artist links"
                                aria-haspopup="menu"
                                aria-expanded={linksMenuOpen}
                                title={allLinks.length > 0 ? 'Artist links' : 'No artist links available'}
                                className="absolute right-0 top-0 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-secondary)] shadow-[var(--shadow-sm)] transition-ui hover:border-[var(--glass-border-hover)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none md:static md:z-auto md:h-12 md:w-12"
                            >
                                <Link2 className="w-5 h-5" />
                            </button>

                            <ContextMenuPortal
                                open={linksMenuOpen && allLinks.length > 0}
                                onClose={() => setLinksMenuOpen(false)}
                                anchorRef={linksButtonRef}
                                desktopWidth={248}
                                desktopHeight={320}
                            >
                                {({ isMobile }) => (
                                    <ContextMenuFrame isMobile={isMobile}>
                                        <ContextMenuHeader
                                            title="Artist links"
                                            subtitle={`${allLinks.length} ${allLinks.length === 1 ? 'link' : 'links'}`}
                                        />
                                        <ContextMenuList className="max-h-64 overflow-y-auto">
                                            {allLinks.map((link, i) => (
                                                <ContextMenuLink
                                                    key={`${link.url}-${i}`}
                                                    href={link.url}
                                                    icon={<ExternalLink className="h-[15px] w-[15px]" />}
                                                    label={getLinkLabel(link.url, link.type)}
                                                    secondary={link.type || undefined}
                                                    onClick={() => setLinksMenuOpen(false)}
                                                />
                                            ))}
                                        </ContextMenuList>
                                    </ContextMenuFrame>
                                )}
                            </ContextMenuPortal>
                        </div>

                        {bio && (
                            <div className="mt-1">
                                <p className={`text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed max-w-3xl ${bioExpanded ? '' : 'line-clamp-4'}`}>
                                    {bio}
                                </p>
                                <button
                                    onClick={() => setBioExpanded(!bioExpanded)}
                                    className="text-xs font-medium text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] mt-1 transition-colors motion-reduce:transition-none"
                                >
                                    {bioExpanded ? 'Show less' : 'Read more'}
                                </button>
                            </div>
                        )}
                        {artistLoading && !bio && (
                            <div className="mt-1 space-y-2 max-w-3xl">
                                <div className="h-4 w-full rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                                <div className="h-4 w-5/6 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                                <div className="h-4 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                            </div>
                        )}

                        {mergedTags.length > 0 && (
                            <div className="mt-4 flex flex-wrap gap-1.5">
                                {mergedTags.map(tag => (
                                    tag.isCommunity ? (
                                        <span
                                            key={tag.name}
                                            title={`From ${(tag.providers || []).map(p => p === 'lastfm' ? 'Last.fm' : 'MusicBrainz').join(' + ')}${tag.count ? ` · ${tag.count}` : ''}`}
                                            className="px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-[0.16em] bg-emerald-500/10 text-[var(--color-primary)] border border-emerald-500/20"
                                        >
                                            {tag.name}
                                        </span>
                                    ) : (
                                        <span
                                            key={tag.name}
                                            className="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-surface-variant)] text-[var(--color-text-muted)] border border-[var(--glass-border)]"
                                        >
                                            {tag.name}
                                        </span>
                                    )
                                ))}
                            </div>
                        )}

                    </div>
                </div>

                {hasPopularInLibrary && (
                    <section className="mb-12">
                        <div className="flex items-center justify-between gap-4 mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                            <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] flex items-center gap-2">
                                <Sparkles className="w-4 h-4 text-[var(--color-primary)] opacity-70" />
                                Popular in your library
                            </h3>
                        </div>

                        {/* Column headers */}
                        <div className="grid grid-cols-[24px_40px_minmax(0,1fr)] md:grid-cols-[34px_52px_minmax(0,1.7fr)_minmax(160px,1fr)_120px_56px] gap-2 md:gap-3 px-1.5 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                            <div className="text-center md:text-left">#</div>
                            <div aria-hidden="true" />
                            <div>Title</div>
                            <div className="hidden md:block">Album</div>
                            <div className="hidden md:block">Last.fm plays</div>
                            <div className="hidden md:block text-right">Time</div>
                        </div>

                        <div className="space-y-0.5">
                            {popularLibraryTracks.slice(0, popularExpanded ? 10 : 5).map(({ track, rank, playcount, listeners }, index) => {
                                const isCurrentPopular = track.id === currentTrackId;
                                return (
                                <div
                                    key={track.id}
                                    onClick={() => handlePlayPopularTracks(index)}
                                    className={`grid grid-cols-[24px_40px_minmax(0,1fr)] md:grid-cols-[34px_52px_minmax(0,1.7fr)_minmax(160px,1fr)_120px_56px] gap-2 md:gap-3 px-1.5 md:px-4 py-2 border-b border-black/5 dark:border-white/5 cursor-pointer items-center transition-ui duration-200 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg my-0.5 group ${isCurrentPopular ? 'bg-[var(--color-primary)]/5' : ''}`}
                                >
                                    {/* Rank */}
                                    <div className="flex items-center justify-center md:justify-start text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm tabular-nums">
                                        {isCurrentPopular && playbackState !== 'stopped' ? (
                                            <NowPlayingBars state={playbackState === 'playing' ? 'playing' : 'paused'} />
                                        ) : (
                                            rank
                                        )}
                                    </div>

                                    {/* Art */}
                                    <div className="h-10 w-10 md:h-11 md:w-11 shrink-0 overflow-hidden rounded-lg border border-black/10 dark:border-white/10 bg-black/10 dark:bg-white/10">
                                        {track.artUrl ? (
                                            <img src={track.artUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                                        ) : (
                                            <div className="flex h-full w-full items-center justify-center">
                                                <Disc3 className="h-5 w-5 text-[var(--color-text-muted)] opacity-40" />
                                            </div>
                                        )}
                                    </div>

                                    {/* Title + artist */}
                                    <div className="min-w-0">
                                        <span className="block truncate text-sm md:text-base font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
                                            {track.title || track.path.split(/[\\/]/).pop()}
                                        </span>
                                        <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                                            {track.artist || track.albumArtist || 'Unknown Artist'}
                                        </span>
                                    </div>

                                    {/* Album */}
                                    <div className="hidden md:block min-w-0">
                                        <span className="block truncate text-sm text-[var(--color-text-secondary)]">
                                            {track.album || '--'}
                                        </span>
                                    </div>

                                    {/* Last.fm plays */}
                                    <div className="hidden md:flex items-center gap-1 text-sm text-[var(--color-text-muted)] tabular-nums">
                                        {(playcount || listeners) ? (
                                            <>
                                                <Headphones className="w-3.5 h-3.5 shrink-0" />
                                                <span>{formatCompactCount(playcount) || formatCompactCount(listeners)}</span>
                                                <span className="text-xs">{playcount ? 'plays' : 'listeners'}</span>
                                            </>
                                        ) : '--'}
                                    </div>

                                    {/* Duration */}
                                    <div className="hidden md:block text-[var(--color-text-muted)] text-sm tabular-nums text-right">
                                        {formatTime(track.duration, '--:--')}
                                    </div>
                                </div>
                                );
                            })}
                        </div>

                        {popularLibraryTracks.length > 5 && (
                            <button
                                onClick={() => setPopularExpanded(e => !e)}
                                className="mt-3 w-full py-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-colors"
                            >
                                {popularExpanded
                                    ? 'See less'
                                    : `See ${popularLibraryTracks.length - 5} more`}
                            </button>
                        )}
                    </section>
                )}

                <UpcomingShows
                    events={upcomingEvents}
                    loading={concertsLoading}
                    stale={concertsStale}
                />

                {/* Primary Releases */}
            {[
                { title: 'Albums', data: releaseGroups.albums },
                { title: 'EPs', data: releaseGroups.eps },
                { title: 'Singles', data: releaseGroups.singles },
                { title: 'Compilations', data: releaseGroups.compilations }
            ].map((section) => section.data.length > 0 && (
                <div key={section.title} className="mb-12">
                    <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">{section.title}</h3>
                    <div className="album-grid">
                        {section.data.map(album => (
                            <AlbumCard
                                key={album.albumId || `${album.title}-${album.artist}`}
                                title={album.title}
                                artist={album.artist}
                                artUrl={album.artUrl}
                                subtitle={`${album.tracks.length} track${album.tracks.length !== 1 ? 's' : ''}`}
                                linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
                                linkState={{ backLabel: 'Back to Artist' }}
                                onPlay={() => setPlaylist(album.tracks, 0)}
                            />
                        ))}
                    </div>
                </div>
            ))}

            {/* Also Appears On */}
            {[
                ...featuredGroups.albums,
                ...featuredGroups.eps,
                ...featuredGroups.singles,
                ...featuredGroups.compilations,
            ].length > 0 && (
                <div className="mb-12">
                    <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-[var(--color-primary)] opacity-60" /> Also appears on
                    </h3>
                    <div className="album-grid">
                        {[
                            ...featuredGroups.albums,
                            ...featuredGroups.eps,
                            ...featuredGroups.singles,
                            ...featuredGroups.compilations,
                        ].map(album => (
                            <AlbumCard
                                key={`feat-${album.albumId || `${album.title}-${album.artist}`}`}
                                title={album.title}
                                artist={album.artist}
                                artUrl={album.artUrl}
                                subtitle={album.artist}
                                linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
                                linkState={{ backLabel: 'Back to Artist' }}
                                onPlay={() => setPlaylist(album.tracks, 0)}
                            />
                        ))}
                    </div>
                </div>
            )}

            <SimilarArtistsSection artists={similarArtists} loading={similarArtistsLoading} />
            </div>
        </div>
    );
};
