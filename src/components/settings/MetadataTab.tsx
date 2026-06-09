import React, { useCallback, useEffect, useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { useProviderConnectionTest } from '../../hooks/useProviderConnectionTest';
import { useToast } from '../../hooks/useToast';
import { Trash2, Sparkles, Image as ImageIcon, BookOpen, Disc3, FileText, User, Heart, Tags, Headphones, Star, Ticket, MapPin, Calendar, AlertTriangle, Users } from 'lucide-react';
import { DependencyBadge, DependencyGroup, DependencyInfoBox } from '../DependencyBadge';

type MetadataSubTab = 'overview' | 'lastfm' | 'genius' | 'musicbrainz' | 'jambase';

type JambaseStatusResp = {
  enabled: boolean;
  hasKey: boolean;
  usage: { yearMonth: string; count: number; lastCallAt: string | null; cap: number; hardStopActive: boolean; stopped: boolean };
  maxSubscriptionsPerUser: number;
  cacheTtlDays: number;
  hardStop: boolean;
  monthlyCap: number;
};

export const MetadataTab: React.FC = () => {
    const lastFmApiKey = usePlayerStore(state => state.lastFmApiKey);
    const setLastFmApiKey = usePlayerStore(state => state.setLastFmApiKey);
    const lastFmSharedSecret = usePlayerStore(state => state.lastFmSharedSecret);
    const setLastFmSharedSecret = usePlayerStore(state => state.setLastFmSharedSecret);

    const geniusApiKey = usePlayerStore(state => state.geniusApiKey);
    const setGeniusApiKey = usePlayerStore(state => state.setGeniusApiKey);

    const musicBrainzEnabled = usePlayerStore(state => state.musicBrainzEnabled);
    const setMusicBrainzEnabled = usePlayerStore(state => state.setMusicBrainzEnabled);
    const musicBrainzClientId = usePlayerStore(state => state.musicBrainzClientId);
    const setMusicBrainzClientId = usePlayerStore(state => state.setMusicBrainzClientId);
    const musicBrainzClientSecret = usePlayerStore(state => state.musicBrainzClientSecret);
    const setMusicBrainzClientSecret = usePlayerStore(state => state.setMusicBrainzClientSecret);
    const musicBrainzConnected = usePlayerStore(state => state.musicBrainzConnected);
    const setMusicBrainzConnected = usePlayerStore(state => state.setMusicBrainzConnected);
    const musicBrainzRedirectUri = usePlayerStore(state => state.musicBrainzRedirectUri);
    const setMusicBrainzRedirectUri = usePlayerStore(state => state.setMusicBrainzRedirectUri);
    const providerArtistImage = usePlayerStore(state => state.providerArtistImage);
    const providerArtistArtwork = usePlayerStore(state => state.providerArtistArtwork);
    const providerArtistBio = usePlayerStore(state => state.providerArtistBio);
    const providerAlbumArt = usePlayerStore(state => state.providerAlbumArt);
    const jambaseEnabled = usePlayerStore(state => state.jambaseEnabled);
    const jambaseMaxSubscriptionsPerUser = usePlayerStore(state => state.jambaseMaxSubscriptionsPerUser);
    const jambaseCacheTtlDays = usePlayerStore(state => state.jambaseCacheTtlDays);
    const jambaseMonthlyCap = usePlayerStore(state => state.jambaseMonthlyCap);
    const jambaseHardStop = usePlayerStore(state => state.jambaseHardStop);
    const setSettings = usePlayerStore(state => state.setSettings);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const { addToast } = useToast();

    // ─── Track-credit enrichment (MusicBrainz / Genius) ───────────────
    // Aurora populates track_artist_credits from on-disk tags during
    // every scan. These two buttons layer additional rows from connected
    // providers without touching the tag-derived rows.
    interface CreditsStatus {
        bySource: Record<string, number>;
        eligibleMusicbrainz: number;
        eligibleGenius: number;
        alreadyMusicbrainz: number;
        alreadyGenius: number;
    }
    const [creditsStatus, setCreditsStatus] = useState<CreditsStatus | null>(null);
    const [mbEnrichRunning, setMbEnrichRunning] = useState(false);
    const [geniusEnrichRunning, setGeniusEnrichRunning] = useState(false);

    const refreshCreditsStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/library/credits/status', { headers: getAuthHeader() });
            if (!res.ok) return;
            const data = await res.json();
            setCreditsStatus(data);
        } catch { /* ignore — the panel just won't show counts */ }
    }, [getAuthHeader]);

    useEffect(() => {
        void refreshCreditsStatus();
    }, [refreshCreditsStatus]);

    const runCreditEnrich = useCallback(async (provider: 'musicbrainz' | 'genius') => {
        const setRunning = provider === 'musicbrainz' ? setMbEnrichRunning : setGeniusEnrichRunning;
        setRunning(true);
        try {
            const res = await fetch(`/api/library/credits/enrich/${provider}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ limit: 200 }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                addToast(err.error || `${provider} enrichment failed`, 'error');
                return;
            }
            const data = await res.json();
            const provLabel = provider === 'musicbrainz' ? 'MusicBrainz' : 'Genius';
            if (data.attempted === 0) {
                addToast(`${provLabel}: nothing left to enrich`, 'info');
            } else {
                const more = data.ranOutOfQuota ? ' (rate-limited — try again later)' : '';
                addToast(`${provLabel}: ${data.succeeded} tracks credited (${data.creditsWritten} rows)${more}`, 'success');
            }
            void refreshCreditsStatus();
        } catch (e: any) {
            addToast(e?.message || 'Enrichment failed', 'error');
        } finally {
            setRunning(false);
        }
    }, [addToast, getAuthHeader, refreshCreditsStatus]);
    const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type), [addToast]);

    const [metadataTab, setMetadataTab] = useState<MetadataSubTab>('overview');
    const [mbShowOverride, setMbShowOverride] = useState(false);

    // Jambase live status (server-fetched — includes monthly usage and whether the
    // env JAMBASE_API_KEY is set).
    const [jambaseStatus, setJambaseStatus] = useState<JambaseStatusResp | null>(null);
    const [jambaseTestStatus, setJambaseTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [jambaseTestMessage, setJambaseTestMessage] = useState('');

    const refreshJambaseStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/providers/jambase/status', { headers: getAuthHeader() });
            if (res.ok) {
                const data = await res.json() as JambaseStatusResp;
                setJambaseStatus(data);
            }
        } catch {}
    }, [getAuthHeader]);

    useEffect(() => {
        if (metadataTab === 'jambase') {
            refreshJambaseStatus();
        }
    }, [metadataTab, refreshJambaseStatus]);

    // Effective redirect URI the server will use (override if set, else SERVER_URL default)
    const [mbEffectiveRedirectUri, setMbEffectiveRedirectUri] = useState<string>('');
    const [lfmCallbackUri, setLfmCallbackUri] = useState<string>('');
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const headers = getAuthHeader();
                const [mbRes, lfmRes] = await Promise.all([
                    fetch('/api/providers/musicbrainz/status', { headers }),
                    fetch('/api/providers/lastfm/status', { headers }),
                ]);
                const [mbData, lfmData] = await Promise.all([
                    mbRes.json().catch(() => ({})),
                    lfmRes.json().catch(() => ({})),
                ]);
                if (!cancelled && mbRes.ok && mbData.redirectUri) setMbEffectiveRedirectUri(mbData.redirectUri);
                if (!cancelled && lfmRes.ok && lfmData.callbackUri) setLfmCallbackUri(lfmData.callbackUri);
            } catch {}
        })();
        return () => { cancelled = true; };
    }, [getAuthHeader, musicBrainzRedirectUri]);

    const {
        lastFmStatus,
        lastFmMessage,
        geniusStatus,
        geniusMessage,
        musicBrainzStatus,
        musicBrainzMessage,
        testLastFm,
        testGenius,
        testMusicBrainz,
    } = useProviderConnectionTest();

    const lastFmBadge = (
        <DependencyBadge
            label="Last.fm Integration"
            status={lastFmApiKey && lastFmSharedSecret ? 'available' : 'unavailable'}
            message={lastFmApiKey && lastFmSharedSecret ? 'Ready for artwork, tags, popularity, and favorites sync' : 'Requires API Key and Shared Secret'}
        />
    );
    const geniusBadge = (
        <DependencyBadge
            label="Genius Integration"
            status={geniusApiKey ? 'available' : 'unavailable'}
            message={geniusApiKey ? 'Connected & ready for lyrics/artwork' : 'Requires Access Token'}
        />
    );
    const musicBrainzBadge = (
        <DependencyBadge
            label="MusicBrainz Application"
            status={musicBrainzConnected ? 'available' : (musicBrainzEnabled ? 'partial' : 'unavailable')}
            message={musicBrainzConnected ? 'Ready for metadata, tags, and rating sync' : (musicBrainzEnabled ? 'Requires OAuth Authorization' : 'Integration currently disabled')}
        />
    );
    const jambaseBadge = (
        <DependencyBadge
            label="Jambase Integration"
            status={jambaseEnabled && jambaseStatus?.hasKey ? 'available' : (jambaseEnabled ? 'partial' : 'unavailable')}
            message={jambaseEnabled && jambaseStatus?.hasKey
                ? 'Ready for tour dates and live event discovery'
                : jambaseEnabled
                    ? 'Set JAMBASE_API_KEY in server environment'
                    : 'Integration currently disabled'}
        />
    );

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Metadata Providers</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] mb-6">
                Configure external APIs to enrich your local library with imagery, biographies, tags, popularity signals, likes sync, and high-quality album art.
            </p>

            {/* Sub-tabs */}
            <div className="flex gap-2 mb-6 flex-wrap">
                <button
                    onClick={() => setMetadataTab('overview')}
                    className={`btn-tab ${metadataTab === 'overview' ? 'active' : ''}`}
                >
                    Overview
                </button>
                <button
                    onClick={() => setMetadataTab('lastfm')}
                    className={`btn-tab ${metadataTab === 'lastfm' ? 'active' : ''}`}
                >
                    Last.fm
                </button>
                <button
                    onClick={() => setMetadataTab('genius')}
                    className={`btn-tab ${metadataTab === 'genius' ? 'active' : ''}`}
                >
                    Genius
                </button>
                <button
                    onClick={() => setMetadataTab('musicbrainz')}
                    className={`btn-tab ${metadataTab === 'musicbrainz' ? 'active' : ''}`}
                >
                    MusicBrainz
                </button>
                <button
                    onClick={() => setMetadataTab('jambase')}
                    className={`btn-tab ${metadataTab === 'jambase' ? 'active' : ''}`}
                >
                    Jambase
                </button>
            </div>

            {metadataTab === 'overview' && (
                <div>
                    <div className="mb-6 space-y-4">
                        <DependencyGroup title="Provider Status">
                            {lastFmBadge}
                            {geniusBadge}
                            {musicBrainzBadge}
                            {jambaseBadge}
                        </DependencyGroup>
                    </div>

                    {/* Default Provider Configuration */}
                    <div className="mt-8 pt-6 border-t border-[var(--glass-border)]">
                        <h4 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">API Hierarchy Preferences</h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                            <div>
                                <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Artist Images</label>
                                <select disabled={!lastFmApiKey && !geniusApiKey} value={providerArtistImage} onChange={e => setSettings({ providerArtistImage: e.target.value as 'lastfm' | 'genius' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm shadow-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50">
                                    <option value="lastfm" disabled={!lastFmApiKey}>Last.fm {!lastFmApiKey && '(Not Configured)'}</option>
                                    <option value="genius" disabled={!geniusApiKey}>Genius {!geniusApiKey && '(Not Configured)'}</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Artist Artwork</label>
                                <select value={providerArtistArtwork} onChange={e => setSettings({ providerArtistArtwork: e.target.value as 'genius' | 'none' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm shadow-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors">
                                    <option value="genius" disabled={!geniusApiKey}>Genius {!geniusApiKey && '(Not Configured)'}</option>
                                    <option value="none">None</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Artist Bios</label>
                                <select disabled={!lastFmApiKey && !geniusApiKey} value={providerArtistBio} onChange={e => setSettings({ providerArtistBio: e.target.value as 'lastfm' | 'genius' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm shadow-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50">
                                    <option value="lastfm" disabled={!lastFmApiKey}>Last.fm {!lastFmApiKey && '(Not Configured)'}</option>
                                    <option value="genius" disabled={!geniusApiKey}>Genius {!geniusApiKey && '(Not Configured)'}</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Album Art</label>
                                <select disabled={!lastFmApiKey && !geniusApiKey && !musicBrainzEnabled} value={providerAlbumArt} onChange={e => setSettings({ providerAlbumArt: e.target.value as 'lastfm' | 'genius' | 'musicbrainz' })} className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm shadow-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50">
                                    <option value="lastfm" disabled={!lastFmApiKey}>Last.fm {!lastFmApiKey && '(Not Configured)'}</option>
                                    <option value="genius" disabled={!geniusApiKey}>Genius {!geniusApiKey && '(Not Configured)'}</option>
                                    <option value="musicbrainz" disabled={!musicBrainzEnabled}>MusicBrainz {!musicBrainzEnabled && '(Disabled)'}</option>
                                </select>
                            </div>
                        </div>
                        <button
                            onClick={async () => {
                                try {
                                    const authHeaders = getAuthHeader();
                                    const res = await fetch('/api/providers/external/refresh', { method: 'POST', headers: authHeaders });
                                    const data = await res.json();
                                    if (!res.ok || data.error) {
                                        showToast(data.error || 'Failed to clear cache', 'error');
                                    } else {
                                        showToast('Provider image & bio cache cleared', 'success');
                                    }
                                } catch (e: any) {
                                    showToast(e?.message || 'Network error', 'error');
                                }
                            }}
                            className="btn btn-ghost btn-sm flex items-center gap-2 text-amber-600 dark:text-amber-500 hover:text-amber-700 dark:hover:text-amber-400 hover:bg-amber-500/10 border-amber-500/20"
                        >
                            <Trash2 size={14} /> Clear cached images &amp; bios
                        </button>
                    </div>
                </div>
            )}

            {metadataTab === 'lastfm' && (
                <div>
                    <div className="mb-6 space-y-4">
                        <DependencyGroup title="Provider Status">
                            {lastFmBadge}
                        </DependencyGroup>
                    </div>

                    <div className="mb-6">
                        <div className="flex items-center gap-2 mb-3">
                            <Sparkles className="w-4 h-4 text-[var(--color-primary)]" />
                            <span className="text-sm font-medium text-[var(--color-text-primary)]">Features requiring Last.fm</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <DependencyInfoBox
                                title="Artist Imagery"
                                description="High-quality artist portraits shown on artist pages and in the now-playing view"
                                icon={<ImageIcon size={16} />}
                            />
                            <DependencyInfoBox
                                title="Artist Biographies"
                                description="Rich narrative bios displayed on artist detail pages"
                                icon={<BookOpen size={16} />}
                            />
                            <DependencyInfoBox
                                title="Popular Artist Tracks"
                                description="Ranks the artist's top Last.fm songs, then features the ones already in your Aurora library"
                                icon={<Headphones size={16} />}
                            />
                            <DependencyInfoBox
                                title="Like Sync"
                                description="Aurora's heart action sends Last.fm love/unlove in parallel with the local like"
                                icon={<Heart size={16} />}
                            />
                            <DependencyInfoBox
                                title="Community Tags"
                                description="Artist tag counts are merged with MusicBrainz to power community tag chips"
                                icon={<Tags size={16} />}
                            />
                            <DependencyInfoBox
                                title="Album Artwork Fallback"
                                description="Cover art fetched when local files have no embedded artwork"
                                icon={<Disc3 size={16} />}
                            />
                            <DependencyInfoBox
                                title="Genre Imagery"
                                description="Representative images powering the genre browser tiles"
                                icon={<ImageIcon size={16} />}
                            />
                        </div>
                    </div>

                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3 shadow-sm">
                        <input type="text" value={lastFmApiKey} onChange={e => setLastFmApiKey(e.target.value)} placeholder="API Key" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                        <input type="password" value={lastFmSharedSecret} onChange={e => setLastFmSharedSecret(e.target.value)} placeholder="Shared Secret" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                        <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-[var(--glass-border)]">
                            <label className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Callback URL</label>
                            <p className="text-xs text-[var(--color-text-muted)]">
                                Register this exact URL as the callback URL in your Last.fm API account. Aurora appends one-time auth parameters automatically during connect.
                            </p>
                            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--glass-border)]">
                                <code className="flex-1 text-xs text-[var(--color-text-primary)] break-all font-mono">
                                    {lfmCallbackUri || 'Loading…'}
                                </code>
                                <button
                                    type="button"
                                    onClick={async () => {
                                        if (!lfmCallbackUri) return;
                                        try {
                                            await navigator.clipboard.writeText(lfmCallbackUri);
                                            showToast('Copied Last.fm callback URL', 'success');
                                        } catch {
                                            showToast('Failed to copy', 'error');
                                        }
                                    }}
                                    className="text-xs text-[var(--color-primary)] hover:underline disabled:opacity-50 flex-shrink-0"
                                    disabled={!lfmCallbackUri}
                                >Copy</button>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <button onClick={() => testLastFm(lastFmApiKey)} disabled={lastFmStatus === 'testing' || !lastFmApiKey} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{lastFmStatus === 'testing' ? 'Testing...' : 'Test Connection'}</button>
                            {lastFmStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {lastFmMessage}</span>}
                            {lastFmStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {lastFmMessage}</span>}
                        </div>
                    </div>
                </div>
            )}

            {metadataTab === 'genius' && (
                <div>
                    <div className="mb-6 space-y-4">
                        <DependencyGroup title="Provider Status">
                            {geniusBadge}
                        </DependencyGroup>
                    </div>

                    <div className="mb-6">
                        <div className="flex items-center gap-2 mb-3">
                            <Sparkles className="w-4 h-4 text-[var(--color-primary)]" />
                            <span className="text-sm font-medium text-[var(--color-text-primary)]">Features requiring Genius</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <DependencyInfoBox
                                title="Song Lyrics"
                                description="Full lyrics panel for the currently playing track"
                                icon={<FileText size={16} />}
                            />
                            <DependencyInfoBox
                                title="Artist Imagery"
                                description="Alternative source for artist portraits when Last.fm is unavailable"
                                icon={<ImageIcon size={16} />}
                            />
                            <DependencyInfoBox
                                title="Artist Hero Artwork"
                                description="Secondary Genius header artwork used for faded artist page hero backgrounds"
                                icon={<ImageIcon size={16} />}
                            />
                            <DependencyInfoBox
                                title="Artist Biographies"
                                description="Fallback artist bios for artist detail pages"
                                icon={<BookOpen size={16} />}
                            />
                            <DependencyInfoBox
                                title="Album Artwork Fallback"
                                description="Alternative cover art source when local files are missing artwork"
                                icon={<Disc3 size={16} />}
                            />
                            <DependencyInfoBox
                                title="Track Credits"
                                description="Producer and writer credits per track, layered on top of tag-derived credits. Useful for hip-hop, pop, and electronic libraries where tags often miss producers."
                                icon={<Users size={16} />}
                            />
                        </div>
                    </div>

                    {/* Genius credit-import action */}
                    {!!geniusApiKey && (
                        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-4 flex items-center justify-between gap-4 shadow-sm">
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-[var(--color-text-primary)]">Import producer / writer credits</div>
                                <div className="text-xs text-[var(--color-text-muted)] mt-1">
                                    {creditsStatus
                                        ? `${creditsStatus.alreadyGenius} tracks already enriched · ${(creditsStatus.bySource['genius'] || 0)} credit rows on file`
                                        : 'Loads on demand · runs in batches of 200 tracks'}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => void runCreditEnrich('genius')}
                                disabled={geniusEnrichRunning}
                                className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50"
                            >
                                {geniusEnrichRunning ? 'Importing…' : 'Import credits'}
                            </button>
                        </div>
                    )}

                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-3 shadow-sm">
                        <div className="flex gap-2">
                            <input type="text" value={geniusApiKey} onChange={e => setGeniusApiKey(e.target.value)} placeholder="Access Token" className="flex-1 p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                            <button onClick={() => testGenius(geniusApiKey)} disabled={geniusStatus === 'testing' || !geniusApiKey} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{geniusStatus === 'testing' ? 'Testing...' : 'Test Connection'}</button>
                        </div>
                        {geniusStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {geniusMessage}</span>}
                        {geniusStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {geniusMessage}</span>}
                    </div>
                </div>
            )}

            {metadataTab === 'musicbrainz' && (
                <div>
                    <div className="mb-6 space-y-4">
                        <DependencyGroup title="Provider Status">
                            {musicBrainzBadge}
                        </DependencyGroup>
                    </div>

                    <div className="mb-6">
                        <div className="flex items-center gap-2 mb-3">
                            <Sparkles className="w-4 h-4 text-[var(--color-primary)]" />
                            <span className="text-sm font-medium text-[var(--color-text-primary)]">Features requiring MusicBrainz</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <DependencyInfoBox
                                title="High-Resolution Album Art"
                                description="Cover Art Archive images used as the highest-quality album artwork source"
                                icon={<Disc3 size={16} />}
                            />
                            <DependencyInfoBox
                                title="Authoritative Artist Data"
                                description="Canonical artist metadata (type, country, formation and dissolution dates)"
                                icon={<User size={16} />}
                            />
                            <DependencyInfoBox
                                title="Release Metadata"
                                description="Original release dates, catalog numbers, and track positions for your albums"
                                icon={<FileText size={16} />}
                            />
                            <DependencyInfoBox
                                title="Favorite Rating Sync"
                                description="Aurora's heart action writes a 5-star recording rating, and removes it when unhearted"
                                icon={<Star size={16} />}
                            />
                            <DependencyInfoBox
                                title="Community Tags & Genres"
                                description="Artist tags and genre votes are merged with Last.fm for deduped community chips"
                                icon={<Tags size={16} />}
                            />
                            <DependencyInfoBox
                                title="ISRC &amp; Recording Lookup"
                                description="Identify tracks by ISRC or MBID to match them against the global database"
                                icon={<BookOpen size={16} />}
                            />
                            <DependencyInfoBox
                                title="Track Credits"
                                description="Composer, conductor, performer (with instrument), producer, mixer, remixer, engineer, arranger, and lyricist credits per track. Layered on top of tag-derived credits — never replaces them."
                                icon={<Users size={16} />}
                            />
                        </div>
                    </div>

                    {/* MusicBrainz credit-import action */}
                    {musicBrainzConnected && (
                        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-4 flex items-center justify-between gap-4 shadow-sm">
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-[var(--color-text-primary)]">Import role credits</div>
                                <div className="text-xs text-[var(--color-text-muted)] mt-1">
                                    {creditsStatus
                                        ? `${creditsStatus.alreadyMusicbrainz} of ${creditsStatus.eligibleMusicbrainz} eligible tracks enriched · ${(creditsStatus.bySource['musicbrainz'] || 0)} credit rows on file`
                                        : 'Requires tracks with MusicBrainz recording IDs · runs in batches of 200'}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => void runCreditEnrich('musicbrainz')}
                                disabled={mbEnrichRunning}
                                className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50"
                            >
                                {mbEnrichRunning ? 'Importing…' : 'Import credits'}
                            </button>
                        </div>
                    )}

                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col shadow-sm">

                        {/* Clarification Alert */}
                        <div className="bg-blue-500/5 dark:bg-blue-500/10 border border-blue-500/10 dark:border-blue-500/20 rounded-lg p-3 mb-4 text-xs text-blue-700 dark:text-blue-200">
                            <strong>Note:</strong> This OAuth integration powers user-level MusicBrainz features such as ratings, private tag/genre access, and collection-capable authorization. It is separate from the imported <em>MusicBrainz Database</em> used by the Genre Matrix tool in the Database tab.
                        </div>

                        <div className="flex items-center justify-between mb-4">
                            <label className="text-sm font-medium text-[var(--color-text-primary)]">{musicBrainzEnabled ? 'Integration Enabled' : 'Integration Disabled'}</label>
                            <button onClick={() => setMusicBrainzEnabled(!musicBrainzEnabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${musicBrainzEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${musicBrainzEnabled ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                        </div>

                        {musicBrainzEnabled && (
                            <div className="flex flex-col gap-3 mt-1 border-t border-[var(--glass-border)] pt-4">
                                <input type="text" value={musicBrainzClientId} onChange={e => setMusicBrainzClientId(e.target.value)} placeholder="Client ID" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                <input type="password" value={musicBrainzClientSecret} onChange={e => setMusicBrainzClientSecret(e.target.value)} placeholder="Client Secret" className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors" />
                                <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-[var(--glass-border)]">
                                    <label className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Callback / Redirect URI</label>
                                    <p className="text-xs text-[var(--color-text-muted)]">
                                        Register this exact URL as the Callback URL in your{' '}
                                        <a href="https://musicbrainz.org/account/applications" target="_blank" rel="noreferrer" className="text-[var(--color-primary)] underline">MusicBrainz OAuth application</a>.
                                        Mismatches cause <code>invalid_request: Mismatched redirect URI</code>.
                                    </p>
                                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--glass-border)]">
                                        <code className="flex-1 text-xs text-[var(--color-text-primary)] break-all font-mono">
                                            {musicBrainzRedirectUri.trim() || mbEffectiveRedirectUri || 'Loading…'}
                                        </code>
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                const uri = musicBrainzRedirectUri.trim() || mbEffectiveRedirectUri;
                                                if (!uri) return;
                                                try {
                                                    await navigator.clipboard.writeText(uri);
                                                    showToast('Copied redirect URI', 'success');
                                                } catch {
                                                    showToast('Failed to copy', 'error');
                                                }
                                            }}
                                            className="text-xs text-[var(--color-primary)] hover:underline disabled:opacity-50 flex-shrink-0"
                                            disabled={!musicBrainzRedirectUri.trim() && !mbEffectiveRedirectUri}
                                        >Copy</button>
                                    </div>
                                    {(mbShowOverride || musicBrainzRedirectUri.trim()) ? (
                                        <input
                                            type="text"
                                            value={musicBrainzRedirectUri}
                                            onChange={e => setMusicBrainzRedirectUri(e.target.value)}
                                            placeholder="Override URL (leave blank to use server default)"
                                            autoFocus={mbShowOverride && !musicBrainzRedirectUri}
                                            className="w-full p-2 text-xs rounded-lg border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                        />
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setMbShowOverride(true)}
                                            className="text-xs text-[var(--color-primary)] hover:underline self-start"
                                        >Use override URL</button>
                                    )}
                                </div>
                                <div className="flex gap-2 items-center mt-2">
                                    <button onClick={() => testMusicBrainz()} disabled={musicBrainzStatus === 'testing'} className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50">{musicBrainzStatus === 'testing' ? 'Testing...' : 'Test Connection'}</button>
                                    {musicBrainzStatus === 'success' && <span className="text-green-500 font-semibold text-xs drop-shadow-sm">✓ {musicBrainzMessage}</span>}
                                    {musicBrainzStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {musicBrainzMessage}</span>}
                                    {musicBrainzConnected ? (
                                        <div className="ml-auto flex items-center gap-3">
                                            <span className="text-green-500 font-semibold text-xs drop-shadow-sm">✓ Connected</span>
                                            <button onClick={async () => {
                                                try {
                                                    const authHeaders = getAuthHeader();
                                                    await fetch('/api/providers/musicbrainz/disconnect', { method: 'POST', headers: authHeaders });
                                                    setMusicBrainzConnected(false);
                                                    showToast('MusicBrainz disconnected', 'info');
                                                } catch (e: any) {
                                                    showToast(e?.message || 'Failed to disconnect', 'error');
                                                }
                                            }} className="btn btn-danger btn-sm">Remove access</button>
                                        </div>
                                    ) : (
                                        <button onClick={async () => {
                                            try {
                                                const authHeaders = (usePlayerStore.getState() as any).getAuthHeader?.() || {};
                                                // Persist credentials server-side before the OAuth hop — the
                                                // authorize route reads Client ID/Secret from system settings.
                                                const saveRes = await fetch('/api/settings', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                                                    body: JSON.stringify({
                                                        musicBrainzEnabled: true,
                                                        musicBrainzClientId,
                                                        musicBrainzClientSecret,
                                                        musicBrainzRedirectUri: musicBrainzRedirectUri.trim(),
                                                    }),
                                                });
                                                if (!saveRes.ok) {
                                                    const err = await saveRes.json().catch(() => ({}));
                                                    showToast(err.error || 'Failed to save credentials', 'error');
                                                    return;
                                                }
                                                // Fetch the authorize URL and redirect — the endpoint returns
                                                // JSON `{url}`, so a plain window.location.href to it would
                                                // just show JSON instead of navigating to MusicBrainz.
                                                const res = await fetch(`/api/providers/musicbrainz/authorize?origin=${encodeURIComponent(window.location.origin)}`, { headers: authHeaders });
                                                const data = await res.json().catch(() => ({}));
                                                if (!res.ok || !data.url) {
                                                    showToast(data.error || 'Failed to start authorization', 'error');
                                                    return;
                                                }
                                                window.location.href = data.url;
                                            } catch (e: any) {
                                                showToast(e?.message || 'Network error', 'error');
                                            }
                                        }} disabled={!musicBrainzClientId || !musicBrainzClientSecret} className="btn btn-primary btn-sm disabled:opacity-50 ml-auto">Authorize Application</button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {metadataTab === 'jambase' && (
                <div>
                    <div className="mb-6 space-y-4">
                        <DependencyGroup title="Provider Status">
                            {jambaseBadge}
                        </DependencyGroup>
                    </div>

                    <div className="mb-6">
                        <div className="flex items-center gap-2 mb-3">
                            <Sparkles className="w-4 h-4 text-[var(--color-primary)]" />
                            <span className="text-sm font-medium text-[var(--color-text-primary)]">Features requiring Jambase</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <DependencyInfoBox
                                title="Live Concerts on Hub"
                                description='Ticket cards on the Hub showing upcoming shows by artists each user has subscribed to'
                                icon={<Ticket size={16} />}
                            />
                            <DependencyInfoBox
                                title='"On tour" Sticker'
                                description="Surfaces a tour-status pill and upcoming show list on artist detail pages"
                                icon={<Calendar size={16} />}
                            />
                            <DependencyInfoBox
                                title="Location-aware Filtering"
                                description="Events sorted by date and proximity to each user's saved location"
                                icon={<MapPin size={16} />}
                            />
                            <DependencyInfoBox
                                title="Tickets & Pricing"
                                description="Direct ticket links and price indicators when supplied by the venue or promoter"
                                icon={<Ticket size={16} />}
                            />
                        </div>
                    </div>

                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 flex flex-col gap-4 shadow-sm">
                        {/* Note about API key location */}
                        <div className="bg-blue-500/5 dark:bg-blue-500/10 border border-blue-500/10 dark:border-blue-500/20 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-200">
                            <strong>Note:</strong> Jambase is metered (1000 free calls / month, then $0.05 per call). Set <code className="font-mono">JAMBASE_API_KEY</code> in the server&apos;s <code className="font-mono">.env</code> — never paste it here. The key is read at request time and is not persisted in settings.
                        </div>

                        {/* Enable toggle */}
                        <div className="flex items-center justify-between">
                            <div>
                                <label className="text-sm font-medium text-[var(--color-text-primary)] block">{jambaseEnabled ? 'Integration Enabled' : 'Integration Disabled'}</label>
                                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">When disabled, no calls are made and the Hub card / tour stickers are hidden.</p>
                            </div>
                            <button
                                onClick={() => setSettings({ jambaseEnabled: !jambaseEnabled })}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${jambaseEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                aria-label="Toggle Jambase integration"
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${jambaseEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>

                        {jambaseEnabled && (
                            <>
                                {/* API key environment status + test */}
                                <div className="flex flex-col gap-2 pt-3 border-t border-[var(--glass-border)]">
                                    <label className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">API Key</label>
                                    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${jambaseStatus?.hasKey ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-300' : 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-300'}`}>
                                        <span className="text-xs font-mono flex-1">
                                            {jambaseStatus?.hasKey ? '✓ JAMBASE_API_KEY detected in environment' : '✗ JAMBASE_API_KEY not set — restart server after editing .env'}
                                        </span>
                                    </div>
                                    <div className="flex gap-2 items-center mt-1">
                                        <button
                                            type="button"
                                            disabled={jambaseTestStatus === 'testing' || !jambaseStatus?.hasKey}
                                            onClick={async () => {
                                                setJambaseTestStatus('testing');
                                                setJambaseTestMessage('');
                                                try {
                                                    // Persist the toggle/limits before testing — admin may have just flipped them.
                                                    await fetch('/api/settings', {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                                                        body: JSON.stringify({ jambaseEnabled, jambaseMaxSubscriptionsPerUser, jambaseCacheTtlDays, jambaseMonthlyCap, jambaseHardStop }),
                                                    });
                                                    const res = await fetch('/api/providers/jambase/test', { method: 'POST', headers: getAuthHeader() });
                                                    const data = await res.json();
                                                    if (res.ok && data.status === 'ok') {
                                                        setJambaseTestStatus('success');
                                                        setJambaseTestMessage(data.sample ? `Found "${data.sample}"` : 'Connected');
                                                    } else {
                                                        setJambaseTestStatus('error');
                                                        setJambaseTestMessage(data.error || `HTTP ${res.status}`);
                                                    }
                                                    refreshJambaseStatus();
                                                } catch (e: any) {
                                                    setJambaseTestStatus('error');
                                                    setJambaseTestMessage(e?.message || 'Network error');
                                                }
                                            }}
                                            className="btn btn-ghost btn-sm whitespace-nowrap disabled:opacity-50"
                                        >
                                            {jambaseTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                                        </button>
                                        {jambaseTestStatus === 'success' && <span className="text-green-500 font-semibold text-xs">✓ {jambaseTestMessage}</span>}
                                        {jambaseTestStatus === 'error' && <span className="text-red-500 font-semibold text-xs">✗ {jambaseTestMessage}</span>}
                                    </div>
                                </div>

                                {/* Monthly usage */}
                                <div className="flex flex-col gap-2 pt-3 border-t border-[var(--glass-border)]">
                                    <div className="flex items-baseline justify-between">
                                        <label className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Monthly Usage</label>
                                        <span className="text-xs text-[var(--color-text-muted)]">{jambaseStatus?.usage.yearMonth || '—'}</span>
                                    </div>
                                    {(() => {
                                        const usage = jambaseStatus?.usage;
                                        const count = usage?.count ?? 0;
                                        const cap = usage?.cap ?? jambaseMonthlyCap;
                                        const pct = cap > 0 ? Math.min(100, (count / cap) * 100) : 0;
                                        const stopped = usage?.stopped ?? false;
                                        const tone = stopped ? 'bg-red-500' : pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-[var(--color-primary)]';
                                        return (
                                            <>
                                                <div className="flex items-baseline justify-between">
                                                    <span className="text-2xl font-bold text-[var(--color-text-primary)] tabular-nums">{count.toLocaleString()}</span>
                                                    <span className="text-sm text-[var(--color-text-muted)] tabular-nums">/ {cap.toLocaleString()}</span>
                                                </div>
                                                <div className="h-2 w-full rounded-full bg-[var(--color-bg)] overflow-hidden">
                                                    <div className={`h-full ${tone} transition-all duration-300`} style={{ width: `${pct}%` }} />
                                                </div>
                                                {pct >= 80 && !stopped && (
                                                    <div className="flex items-start gap-2 mt-1 text-xs text-amber-700 dark:text-amber-300">
                                                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                                                        <span>{Math.round(pct)}% of monthly budget used. Calls will be {jambaseHardStop ? 'paused' : 'billed'} when limit is reached.</span>
                                                    </div>
                                                )}
                                                {stopped && (
                                                    <div className="flex items-start gap-2 mt-1 text-xs text-red-700 dark:text-red-300">
                                                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                                                        <span>Monthly cap reached. New API calls are paused; users are served from cache. Resets on the 1st of next month.</span>
                                                    </div>
                                                )}
                                            </>
                                        );
                                    })()}
                                </div>

                                {/* Hard stop & cap */}
                                <div className="flex flex-col gap-3 pt-3 border-t border-[var(--glass-border)]">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex-1">
                                            <label className="text-sm font-medium text-[var(--color-text-primary)] block">Hard stop at limit</label>
                                            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Pause API calls when the monthly cap is hit (recommended). Disable only if you want to pay for overage.</p>
                                        </div>
                                        <button
                                            onClick={() => setSettings({ jambaseHardStop: !jambaseHardStop })}
                                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${jambaseHardStop ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                            aria-label="Toggle hard stop"
                                        >
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${jambaseHardStop ? 'translate-x-6' : 'translate-x-1'}`} />
                                        </button>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                                        <div>
                                            <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Monthly cap</label>
                                            <input
                                                type="number"
                                                min={1}
                                                value={jambaseMonthlyCap}
                                                onChange={e => setSettings({ jambaseMonthlyCap: Math.max(1, parseInt(e.target.value, 10) || 0) })}
                                                className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Max subs / user</label>
                                            <input
                                                type="number"
                                                min={1}
                                                max={100}
                                                value={jambaseMaxSubscriptionsPerUser}
                                                onChange={e => setSettings({ jambaseMaxSubscriptionsPerUser: Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 0)) })}
                                                className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Cache TTL (days)</label>
                                            <input
                                                type="number"
                                                min={1}
                                                max={90}
                                                value={jambaseCacheTtlDays}
                                                onChange={e => setSettings({ jambaseCacheTtlDays: Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 0)) })}
                                                className="w-full p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

        </div>
    );
};
