import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { Ticket, MapPin, Search as SearchIcon, X, Loader2, Headphones, AlertTriangle, Sparkles, RotateCw, Undo2 } from 'lucide-react';

type SubscribedArtist = {
    id: string;
    name: string;
    image_url: string | null;
    mbid: string | null;
    jambase_id?: string | null;
    created_at?: string;
    source?: 'explicit' | 'auto';
};

type DismissedArtist = {
    id: string;
    name: string;
    image_url: string | null;
    dismissed_at: string;
};

type LibraryArtist = {
    id: string;
    name: string;
    image_url: string | null;
    mbid: string | null;
    user_plays?: number;
};

export const LiveMusicTab: React.FC = () => {
    const concertsEnabled = usePlayerStore(s => s.concertsEnabled);
    const concertsLat = usePlayerStore(s => s.concertsLat);
    const concertsLng = usePlayerStore(s => s.concertsLng);
    const concertsLocationLabel = usePlayerStore(s => s.concertsLocationLabel);
    const concertsRadiusKm = usePlayerStore(s => s.concertsRadiusKm);
    const concertsAutoAddEnabled = usePlayerStore(s => s.concertsAutoAddEnabled);
    const setSettings = usePlayerStore(s => s.setSettings);
    const getAuthHeader = usePlayerStore(s => s.getAuthHeader);
    const { addToast } = useToast();

    // Persist immediately on field changes — settings tabs typically rely on
    // saveSettings on close, but this tab's location/radius drive the Hub feed
    // which a user may want to see right after toggling, so we save eagerly.
    const persist = useCallback(async (patch: Record<string, any>) => {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify(patch),
            });
        } catch {}
    }, [getAuthHeader]);

    // ── Subscriptions ───────────────────────────────────────────────
    const [subs, setSubs] = useState<SubscribedArtist[]>([]);
    const [maxSubs, setMaxSubs] = useState(10);
    const [subsLoading, setSubsLoading] = useState(true);
    const [dismissed, setDismissed] = useState<DismissedArtist[]>([]);
    const [autoRefreshing, setAutoRefreshing] = useState(false);

    const loadSubs = useCallback(async () => {
        try {
            const [subsRes, dismissedRes] = await Promise.all([
                fetch('/api/concerts/subscriptions', { headers: getAuthHeader() }),
                fetch('/api/concerts/auto-add/dismissed', { headers: getAuthHeader() }),
            ]);
            if (subsRes.ok) {
                const data = await subsRes.json();
                setSubs(data.subscriptions || []);
                setMaxSubs(data.max ?? 10);
            }
            if (dismissedRes.ok) {
                const data = await dismissedRes.json();
                setDismissed(data.dismissed || []);
            }
        } catch {}
        finally {
            setSubsLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => { loadSubs(); }, [loadSubs]);

    const refreshAutoAdd = useCallback(async (silent = false) => {
        setAutoRefreshing(true);
        try {
            const res = await fetch('/api/concerts/auto-add/refresh', { method: 'POST', headers: getAuthHeader() });
            if (res.ok) {
                const data = await res.json();
                if (!silent) {
                    if (data.added > 0) addToast(`Added ${data.added} top-played artist${data.added === 1 ? '' : 's'}`, 'success');
                    else if (data.skipped === 'no-slots') addToast('All subscription slots are full', 'info');
                    else if (data.skipped === 'disabled') addToast('Auto-add is disabled', 'info');
                    else addToast('No new candidates to add', 'info');
                }
                loadSubs();
            }
        } catch (e: any) {
            if (!silent) addToast(e?.message || 'Failed to refresh', 'error');
        } finally {
            setAutoRefreshing(false);
        }
    }, [getAuthHeader, addToast, loadSubs]);

    const undismiss = async (artistId: string) => {
        try {
            const res = await fetch(`/api/concerts/auto-add/undismiss/${artistId}`, { method: 'POST', headers: getAuthHeader() });
            if (res.ok) loadSubs();
        } catch {}
    };

    const toggleAutoAdd = async () => {
        const next = !concertsAutoAddEnabled;
        setSettings({ concertsAutoAddEnabled: next });
        await persist({ concertsAutoAddEnabled: next });
        if (next) {
            // Fire-and-fill — pick up top played artists into the empty slots.
            refreshAutoAdd(false);
        }
    };

    const subscribed = useMemo(() => new Set(subs.map(s => s.id)), [subs]);

    const subscribe = async (artistId: string) => {
        if (subs.length >= maxSubs) {
            addToast(`Limit reached (${maxSubs}). Remove an artist first.`, 'error');
            return;
        }
        try {
            const res = await fetch(`/api/concerts/subscriptions/${artistId}`, {
                method: 'POST',
                headers: getAuthHeader(),
            });
            if (res.ok) {
                loadSubs();
            } else {
                const data = await res.json().catch(() => ({}));
                addToast(data.error || 'Failed to subscribe', 'error');
            }
        } catch (e: any) {
            addToast(e?.message || 'Network error', 'error');
        }
    };

    const unsubscribe = async (artistId: string) => {
        try {
            const res = await fetch(`/api/concerts/subscriptions/${artistId}`, {
                method: 'DELETE',
                headers: getAuthHeader(),
            });
            if (res.ok) {
                // Reload from server — the server may have just dismissed this
                // artist (if it was auto-added) and re-filled the slot with a
                // different top-played artist, so optimistic local state would
                // diverge.
                loadSubs();
            } else {
                const data = await res.json().catch(() => ({}));
                addToast(data.error || 'Failed to unsubscribe', 'error');
            }
        } catch (e: any) {
            addToast(e?.message || 'Network error', 'error');
        }
    };

    // ── Library artist lookup ───────────────────────────────────────
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<LibraryArtist[]>([]);
    const [topArtists, setTopArtists] = useState<LibraryArtist[]>([]);
    const [searching, setSearching] = useState(false);
    const debounceRef = useRef<number | null>(null);

    useEffect(() => {
        // Suggestions when the field is empty.
        (async () => {
            try {
                const res = await fetch('/api/concerts/library/top-artists?limit=10', { headers: getAuthHeader() });
                if (res.ok) {
                    const data = await res.json();
                    setTopArtists(data.artists || []);
                }
            } catch {}
        })();
    }, [getAuthHeader]);

    useEffect(() => {
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        const q = query.trim();
        if (!q) {
            setResults([]);
            return;
        }
        setSearching(true);
        debounceRef.current = window.setTimeout(async () => {
            try {
                const res = await fetch(`/api/concerts/library/artist-search?q=${encodeURIComponent(q)}&limit=15`, { headers: getAuthHeader() });
                if (res.ok) {
                    const data = await res.json();
                    setResults(data.artists || []);
                }
            } catch {} finally {
                setSearching(false);
            }
        }, 250);
        return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
    }, [query, getAuthHeader]);

    // ── Location ─────────────────────────────────────────────────────
    const [locating, setLocating] = useState(false);
    const [manualCity, setManualCity] = useState('');

    const reverseGeocode = async (lat: number, lng: number): Promise<string | null> => {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10`, {
                headers: { 'Accept-Language': navigator.language || 'en' },
            });
            if (!res.ok) return null;
            const data = await res.json();
            const addr = data?.address || {};
            const city = addr.city || addr.town || addr.village || addr.municipality || addr.county;
            const country = addr.country;
            return city ? (country ? `${city}, ${country}` : city) : data?.display_name || null;
        } catch {
            return null;
        }
    };

    const useCurrentLocation = () => {
        if (!navigator.geolocation) {
            addToast('Geolocation not available in this browser', 'error');
            return;
        }
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                const label = (await reverseGeocode(lat, lng)) || `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
                setSettings({ concertsLat: lat, concertsLng: lng, concertsLocationLabel: label });
                persist({ concertsLat: lat, concertsLng: lng, concertsLocationLabel: label });
                setLocating(false);
            },
            (err) => {
                setLocating(false);
                addToast(err.code === err.PERMISSION_DENIED ? 'Location permission denied' : 'Could not get location', 'error');
            },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 60_000 }
        );
    };

    const submitManualCity = async () => {
        const q = manualCity.trim();
        if (!q) return;
        setLocating(true);
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`, {
                headers: { 'Accept-Language': navigator.language || 'en' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const hit = Array.isArray(data) ? data[0] : null;
            if (!hit) {
                addToast('No matching place found', 'error');
                return;
            }
            const lat = parseFloat(hit.lat);
            const lng = parseFloat(hit.lon);
            const label = hit.display_name?.split(',').slice(0, 2).join(',').trim() || q;
            setSettings({ concertsLat: lat, concertsLng: lng, concertsLocationLabel: label });
            persist({ concertsLat: lat, concertsLng: lng, concertsLocationLabel: label });
            setManualCity('');
        } catch (e: any) {
            addToast(e?.message || 'Could not look up location', 'error');
        } finally {
            setLocating(false);
        }
    };

    const clearLocation = () => {
        setSettings({ concertsLat: null, concertsLng: null, concertsLocationLabel: '' });
        persist({ concertsLat: null, concertsLng: null, concertsLocationLabel: '' });
    };

    // ── Render helpers ──────────────────────────────────────────────
    const renderArtistRow = (a: LibraryArtist) => {
        const isSubbed = subscribed.has(a.id);
        const atLimit = !isSubbed && subs.length >= maxSubs;
        return (
            <li key={a.id} className="flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-[var(--glass-bg-hover)] transition-colors">
                <div className="w-10 h-10 rounded-full bg-[var(--color-bg)] overflow-hidden flex-shrink-0 border border-[var(--glass-border)]">
                    {a.image_url ? (
                        <img src={a.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]"><Headphones size={16} /></div>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">{a.name}</div>
                    {typeof a.user_plays === 'number' && a.user_plays > 0 && (
                        <div className="text-xs text-[var(--color-text-muted)]">{a.user_plays.toLocaleString()} plays</div>
                    )}
                </div>
                <button
                    onClick={() => isSubbed ? unsubscribe(a.id) : subscribe(a.id)}
                    disabled={atLimit}
                    className={`min-h-[44px] px-4 py-2 text-xs font-semibold rounded-full transition-colors flex-shrink-0 ${
                        isSubbed
                            ? 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary)]/90'
                            : atLimit
                                ? 'bg-[var(--color-surface-variant)] text-[var(--color-text-muted)] cursor-not-allowed'
                                : 'bg-[var(--color-bg)] text-[var(--color-text-primary)] border border-[var(--glass-border)] hover:bg-[var(--glass-bg-hover)]'
                    }`}
                    aria-label={isSubbed ? `Unsubscribe from ${a.name}` : `Subscribe to ${a.name}`}
                >
                    {isSubbed ? 'Subscribed' : atLimit ? 'Limit reached' : 'Subscribe'}
                </button>
            </li>
        );
    };

    const lookupList = query.trim() ? results : topArtists;
    const showSuggestionsLabel = !query.trim() && topArtists.length > 0;

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)] flex items-center gap-2">
                    <Ticket size={22} className="text-[var(--color-primary)]" />
                    Live Music
                </h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] mb-6">
                Get a heads-up when artists you care about announce shows near you. Pick the artists, share your location, and they&apos;ll surface as ticket cards on your Hub.
            </p>

            {/* Master enable */}
            <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-6 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex-1">
                        <label className="text-sm font-semibold text-[var(--color-text-primary)] block">{concertsEnabled ? 'Enabled' : 'Disabled'}</label>
                        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Show the &quot;Favourites live near you&quot; section on the Hub.</p>
                    </div>
                    <button
                        onClick={() => {
                            const next = !concertsEnabled;
                            setSettings({ concertsEnabled: next });
                            persist({ concertsEnabled: next });
                        }}
                        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors flex-shrink-0 ${concertsEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                        aria-label="Toggle live music"
                        aria-pressed={concertsEnabled}
                    >
                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${concertsEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                </div>
            </div>

            {concertsEnabled && (
                <>
                    {/* Location */}
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-6 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                            <MapPin size={16} className="text-[var(--color-primary)]" />
                            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Location</h4>
                        </div>

                        {concertsLat !== null && concertsLng !== null ? (
                            <div className="flex items-center gap-3 mb-4 p-3 rounded-xl bg-[var(--color-bg)] border border-[var(--glass-border)]">
                                <MapPin size={16} className="text-[var(--color-primary)] flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">{concertsLocationLabel || `${concertsLat.toFixed(2)}, ${concertsLng.toFixed(2)}`}</div>
                                    <div className="text-xs text-[var(--color-text-muted)]">{concertsLat.toFixed(4)}, {concertsLng.toFixed(4)}</div>
                                </div>
                                <button onClick={clearLocation} className="min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]" aria-label="Clear location">
                                    <X size={18} />
                                </button>
                            </div>
                        ) : (
                            <p className="text-xs text-[var(--color-text-muted)] mb-4">No location set. Events will be sorted by date only.</p>
                        )}

                        <div className="flex flex-col sm:flex-row gap-2">
                            <button
                                onClick={useCurrentLocation}
                                disabled={locating}
                                className="btn btn-primary btn-sm flex-1 min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {locating ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
                                Use my current location
                            </button>
                        </div>

                        <div className="mt-3 pt-3 border-t border-[var(--glass-border)]">
                            <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Or enter a city manually</label>
                            <div className="flex flex-col sm:flex-row gap-2">
                                <input
                                    type="text"
                                    value={manualCity}
                                    onChange={e => setManualCity(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') submitManualCity(); }}
                                    placeholder="e.g. Oslo, Norway"
                                    className="flex-1 p-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors min-h-[44px]"
                                    autoComplete="off"
                                />
                                <button
                                    onClick={submitManualCity}
                                    disabled={locating || !manualCity.trim()}
                                    className="btn btn-ghost btn-sm min-h-[44px] disabled:opacity-50"
                                >
                                    {locating ? <Loader2 size={14} className="animate-spin" /> : 'Search'}
                                </button>
                            </div>
                        </div>

                        {/* Radius */}
                        <div className="mt-5 pt-3 border-t border-[var(--glass-border)]">
                            <div className="flex items-baseline justify-between mb-2">
                                <label className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Search radius</label>
                                <span className="text-sm font-semibold text-[var(--color-text-primary)] tabular-nums">{concertsRadiusKm} km</span>
                            </div>
                            <input
                                type="range"
                                min={10}
                                max={300}
                                step={5}
                                value={concertsRadiusKm}
                                onChange={e => setSettings({ concertsRadiusKm: parseInt(e.target.value, 10) })}
                                onMouseUp={() => persist({ concertsRadiusKm })}
                                onTouchEnd={() => persist({ concertsRadiusKm })}
                                className="w-full accent-[var(--color-primary)]"
                                aria-label="Search radius in kilometers"
                            />
                            <div className="flex justify-between text-[10px] text-[var(--color-text-muted)] mt-1">
                                <span>10 km</span><span>300 km</span>
                            </div>
                        </div>
                    </div>

                    {/* Auto-subscribe to favourites */}
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-6 shadow-sm">
                        <div className="flex items-start justify-between gap-3 mb-1">
                            <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                                    <Sparkles size={14} className="text-[var(--color-primary)]" />
                                    Auto-subscribe to my favourites
                                </h4>
                                <p className="text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
                                    Fills empty slots with your most-played artists. We&apos;ll never replace artists you added manually, and removing an auto-pick keeps it from coming back.
                                </p>
                            </div>
                            <button
                                onClick={toggleAutoAdd}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 mt-1 ${concertsAutoAddEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                aria-label="Toggle auto-add"
                                aria-pressed={concertsAutoAddEnabled}
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${concertsAutoAddEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>
                        {concertsAutoAddEnabled && (
                            <button
                                onClick={() => refreshAutoAdd(false)}
                                disabled={autoRefreshing}
                                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] hover:underline disabled:opacity-50"
                            >
                                {autoRefreshing ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
                                Refresh suggestions now
                            </button>
                        )}
                    </div>

                    {/* Subscribed artists */}
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-6 shadow-sm">
                        <div className="flex items-baseline justify-between mb-3">
                            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Subscribed artists</h4>
                            <span className="text-xs text-[var(--color-text-muted)] tabular-nums">{subs.length} / {maxSubs}</span>
                        </div>

                        {subsLoading ? (
                            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] py-4">
                                <Loader2 size={14} className="animate-spin" /> Loading…
                            </div>
                        ) : subs.length === 0 ? (
                            <p className="text-sm text-[var(--color-text-muted)] py-2">
                                No subscriptions yet. Pick artists below to start tracking their tours.
                            </p>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {subs.map(s => {
                                    const isAuto = s.source === 'auto';
                                    return (
                                        <div
                                            key={s.id}
                                            className={`inline-flex items-center gap-2 pl-1 pr-1 py-1 rounded-full border ${isAuto ? 'bg-[var(--color-primary)]/5 border-[var(--color-primary)]/25' : 'bg-[var(--color-bg)] border-[var(--glass-border)]'}`}
                                        >
                                            <div className="w-7 h-7 rounded-full bg-[var(--color-surface)] overflow-hidden flex-shrink-0">
                                                {s.image_url ? (
                                                    <img src={s.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]"><Headphones size={12} /></div>
                                                )}
                                            </div>
                                            <span className="text-sm font-medium text-[var(--color-text-primary)] max-w-[160px] truncate">{s.name}</span>
                                            {isAuto && (
                                                <span
                                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[var(--color-primary)]/15 text-[var(--color-primary)] text-[9px] font-bold uppercase tracking-wider"
                                                    title="Added automatically based on your top played artists"
                                                >
                                                    <Sparkles size={9} />
                                                    Auto
                                                </span>
                                            )}
                                            <button
                                                onClick={() => unsubscribe(s.id)}
                                                className="w-8 h-8 flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors flex-shrink-0"
                                                aria-label={`Remove ${s.name}`}
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {subs.length >= maxSubs && (
                            <div className="flex items-start gap-2 mt-3 text-xs text-amber-700 dark:text-amber-300">
                                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                                <span>You&apos;ve reached the maximum of {maxSubs} subscriptions. Remove an artist to add another.</span>
                            </div>
                        )}
                    </div>

                    {/* Dismissed auto-picks — only render when there are some, since
                        most users won't ever need this and an empty section is clutter */}
                    {dismissed.length > 0 && (
                        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 mb-6 shadow-sm">
                            <div className="flex items-baseline justify-between mb-1">
                                <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Won&apos;t auto-add</h4>
                                <span className="text-xs text-[var(--color-text-muted)] tabular-nums">{dismissed.length}</span>
                            </div>
                            <p className="text-xs text-[var(--color-text-muted)] mb-3">
                                These artists were removed from auto-add. They&apos;ll stay out of suggestions unless you allow them again.
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {dismissed.map(d => (
                                    <button
                                        key={d.id}
                                        onClick={() => undismiss(d.id)}
                                        className="inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-[var(--color-bg)] border border-dashed border-[var(--glass-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/5 transition-colors group"
                                        title="Allow this artist to be auto-added again"
                                        aria-label={`Allow ${d.name} to be auto-added again`}
                                    >
                                        <div className="w-7 h-7 rounded-full bg-[var(--color-surface)] overflow-hidden flex-shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
                                            {d.image_url ? (
                                                <img src={d.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]"><Headphones size={12} /></div>
                                            )}
                                        </div>
                                        <span className="text-sm font-medium text-[var(--color-text-secondary)] max-w-[140px] truncate">{d.name}</span>
                                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-primary)] opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Undo2 size={10} />
                                            Allow
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Library lookup */}
                    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--glass-border)] p-5 shadow-sm">
                        <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-1">Add an artist</h4>
                        <p className="text-xs text-[var(--color-text-muted)] mb-3">Search artists in your library. Subscribe to get their upcoming shows on the Hub.</p>

                        <div className="relative mb-3">
                            <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
                            <input
                                type="search"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Search your library…"
                                className="w-full pl-10 pr-3 py-3 rounded-xl border border-[var(--glass-border)] bg-[var(--color-bg)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-colors min-h-[44px]"
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </div>

                        {showSuggestionsLabel && (
                            <div className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-semibold px-3 mb-1">Top played</div>
                        )}

                        {searching ? (
                            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] py-4 px-3">
                                <Loader2 size={14} className="animate-spin" /> Searching…
                            </div>
                        ) : lookupList.length === 0 ? (
                            <p className="text-sm text-[var(--color-text-muted)] py-4 px-3">
                                {query.trim() ? `No artists matching "${query}" in your library.` : 'Your library has no plays yet — start listening to populate suggestions.'}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-0.5">
                                {lookupList.map(renderArtistRow)}
                            </ul>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
