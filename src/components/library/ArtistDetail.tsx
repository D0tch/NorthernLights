import React, { useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { trackMatchesArtist } from '../../utils/artistUtils';
import { useArtistData } from '../../hooks/useArtistData';
import { AlbumArt } from '../AlbumArt';
import { AlbumCard, AlbumCardSkeleton } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { ArtistInitial } from './ArtistInitial';
import { ExternalLink, Globe, Users, Mic2, Calendar, Sparkles, Music2, Clock, BookOpen } from 'lucide-react';

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

// ─── Component ───────────────────────────────────────────────────────────────

export const ArtistDetail: React.FC = () => {
    const { artistId } = useParams<{ artistId: string }>();
    const navigate = useNavigate();
    const { library, artists, setPlaylist } = usePlayerStore();

    // Find artist info from entity list
    const artistInfo = useMemo(() => artists.find(a => a.id === artistId), [artists, artistId]);
    const artistName = artistInfo?.name || '';

    // Get MusicBrainz artist ID from the first track that has one
    const mbArtistId = useMemo(() => {
        if (!artistId) return null;
        const track = library.find(t => t.artistId === artistId && t.mbArtistId);
        return track?.mbArtistId || null;
    }, [library, artistId]);

    const { imageUrl, bio, disambiguation, area, type, lifeSpan, links, genres, listeners, members, isLoading: artistLoading } = useArtistData(artistName, mbArtistId);
    const [bioExpanded, setBioExpanded] = useState(false);

    // Tracks where this artist is the PRIMARY / album artist
    const primaryTracks = useMemo(() => {
        if (!artistName) return [];
        return library.filter(t => t.artistId === artistId);
    }, [library, artistId, artistName]);

    // Tracks where this artist APPEARS but is NOT the album owner
    const featuredTracks = useMemo(() => {
        if (!artistName) return [];
        const artistLower = artistName.toLowerCase();
        return library.filter(t => {
            const albumOwner = (t.albumArtist || t.artist || '').toLowerCase();
            if (albumOwner === artistLower) return false;
            if (Array.isArray(t.artists)) {
                return t.artists.some(a => a.toLowerCase() === artistLower);
            }
            return trackMatchesArtist(t.artist, artistName);
        });
    }, [library, artistName]);

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

    const releaseGroups = useMemo(() => buildReleaseGroups(primaryTracks), [primaryTracks]);
    const featuredGroups = useMemo(() => buildReleaseGroups(featuredTracks), [featuredTracks]);

    const hasAnyContent = primaryTracks.length > 0 || featuredTracks.length > 0;

    if (!artistName || !hasAnyContent) return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <Users className="w-12 h-12 text-[var(--color-text-muted)] opacity-30 mb-4" />
            <p className="text-lg font-medium text-[var(--color-text-secondary)]">Artist not found</p>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">This artist may not have any tracks in your library.</p>
        </div>
    );

    return (
        <div className="artist-detail page-container relative">
            {imageUrl && <FadedHeroImage src={imageUrl} />}
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
                        <h1 className="font-bold text-4xl md:text-6xl lg:text-7xl tracking-tight mb-2 text-[var(--color-text-primary)]">
                            {artistName}
                        </h1>

                        {/* MusicBrainz metadata badges */}
                        {(disambiguation || type || area || lifeSpan?.begin || listeners) && (
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                {disambiguation && (
                                    <span className="text-sm text-[var(--color-text-muted)] italic">{disambiguation}</span>
                                )}
                                {type && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/20">
                                        {type === 'Group' ? <Users className="w-3 h-3" /> : type === 'Person' ? <Mic2 className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                                        {type}
                                    </span>
                                )}
                                {area && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                                        <Globe className="w-3 h-3" />
                                        {area}
                                    </span>
                                )}
                                {lifeSpan?.begin && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                                        <Calendar className="w-3 h-3" />
                                        {lifeSpan.begin}{lifeSpan.end ? ` – ${lifeSpan.end}` : ' – present'}
                                    </span>
                                )}
                                {listeners && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                                        <Users className="w-3 h-3" />
                                        {formatListeners(listeners)}
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Local library stats */}
                        {libraryStats.totalTracks > 0 && (
                            <div className="flex items-center gap-3 mb-3 text-xs text-[var(--color-text-muted)]">
                                <span className="inline-flex items-center gap-1">
                                    <Music2 className="w-3 h-3" />
                                    {libraryStats.totalTracks} track{libraryStats.totalTracks !== 1 ? 's' : ''}
                                </span>
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
                            </div>
                        )}

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

                        {/* Genre tags */}
                        {genres && genres.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-3">
                                {genres.slice(0, 8).map(g => (
                                    <span key={g} className="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-surface-variant)] text-[var(--color-text-muted)] border border-[var(--glass-border)]">
                                        {g}
                                    </span>
                                ))}
                            </div>
                        )}

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

                        {/* External links (file tags + MusicBrainz, deduplicated) */}
                        {allLinks.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-3">
                                {allLinks.slice(0, 10).map((link, i) => (
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
                    </div>
                </div>

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
                                onPlay={() => setPlaylist(album.tracks, 0)}
                            />
                        ))}
                    </div>
                </div>
            )}
            </div>
        </div>
    );
};
