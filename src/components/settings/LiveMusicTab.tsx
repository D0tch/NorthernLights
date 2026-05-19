import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { Ticket, MapPin, Search as SearchIcon, X, Loader2, Headphones, AlertTriangle, Sparkles, RotateCw, Undo2, Users2 } from 'lucide-react';

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

    // Persist immediately on field changes. Settings tabs typically rely on
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

    // Subscriptions
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
            // Fire and fill empty slots from top played artists.
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
                // Reload from server. The server may have just dismissed this
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

    // Library artist lookup
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

    // Location
    const [locating, setLocating] = useState(false);
    const [manualCity, setManualCity] = useState('');
    const [locationEditorOpen, setLocationEditorOpen] = useState(false);

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
                setLocationEditorOpen(false);
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
            setLocationEditorOpen(false);
        } catch (e: any) {
            addToast(e?.message || 'Could not look up location', 'error');
        } finally {
            setLocating(false);
        }
    };

    // Render helpers
    const renderArtistRow = (a: LibraryArtist) => {
        const isSubbed = subscribed.has(a.id);
        const atLimit = !isSubbed && subs.length >= maxSubs;
        return (
            <li key={a.id}>
                <button
                    type="button"
                    onClick={() => isSubbed ? unsubscribe(a.id) : subscribe(a.id)}
                    disabled={atLimit}
                    className="live-music-artist-row"
                    data-state={isSubbed ? 'subscribed' : atLimit ? 'disabled' : 'idle'}
                    aria-pressed={isSubbed}
                    aria-label={isSubbed ? `Remove ${a.name} from subscribed artists` : atLimit ? `Subscription limit reached for ${a.name}` : `Add ${a.name} to subscribed artists`}
                >
                    <div className="live-music-avatar" aria-hidden="true">
                        {a.image_url ? (
                            <img src={a.image_url} alt="" loading="lazy" />
                        ) : (
                            <Headphones size={16} />
                        )}
                    </div>
                    <div className="live-music-artist-row__copy">
                        <div className="live-music-artist-row__name">{a.name}</div>
                        {typeof a.user_plays === 'number' && a.user_plays > 0 && (
                            <div className="live-music-artist-row__meta">{a.user_plays.toLocaleString()} plays</div>
                        )}
                    </div>
                    {isSubbed ? (
                        <span className="live-music-artist-row__state">Subscribed</span>
                    ) : atLimit ? (
                        <span className="live-music-artist-row__state">Limit reached</span>
                    ) : (
                        <span className="live-music-artist-row__state">Add</span>
                    )}
                </button>
            </li>
        );
    };

    const lookupList = query.trim() ? results : topArtists;
    const showSuggestionsLabel = !query.trim() && topArtists.length > 0;
    const hasLocation = concertsLat !== null && concertsLng !== null;
    const showLocationEditor = !hasLocation || locationEditorOpen;

    return (
        <div className="settings-section live-music-settings">
            <header className="live-music-settings__header">
                <div>
                    <p className="live-music-settings__eyebrow">Discovery</p>
                    <h3>Live Music</h3>
                    <p>Track shows near you from artists in your Aurora library.</p>
                </div>
                <span className="live-music-status" data-state={concertsEnabled ? 'on' : 'off'}>
                    {concertsEnabled ? 'Enabled' : 'Disabled'}
                </span>
            </header>

            <section className="live-music-hero" aria-label="Live Music status">
                <div className="live-music-hero__icon" aria-hidden="true">
                    <Ticket size={24} />
                </div>
                <div className="live-music-hero__copy">
                    <h4>Hub ticket cards</h4>
                    <p>Shows from subscribed artists appear in the Hub when Live Music is enabled.</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={concertsEnabled}
                    onClick={() => {
                        const next = !concertsEnabled;
                        setSettings({ concertsEnabled: next });
                        persist({ concertsEnabled: next });
                    }}
                    className="account-switch"
                    data-state={concertsEnabled ? 'on' : 'off'}
                    aria-label="Toggle live music"
                >
                    <span className="account-switch__thumb" />
                </button>
            </section>

            {concertsEnabled && (
                <>
                    <section className="live-music-overview" aria-label="Live Music setup summary">
                        <div className="live-music-overview__item">
                            <span>Location</span>
                            <strong>{hasLocation ? concertsLocationLabel || `${concertsLat.toFixed(2)}, ${concertsLng.toFixed(2)}` : 'Not set'}</strong>
                        </div>
                        <div className="live-music-overview__item">
                            <span>Radius</span>
                            <strong>{concertsRadiusKm} km</strong>
                        </div>
                        <div className="live-music-overview__item">
                            <span>Artists</span>
                            <strong>{subs.length} / {maxSubs}</strong>
                        </div>
                    </section>

                    <section className="live-music-panel live-music-panel--location">
                        <div className="live-music-panel__header">
                            <div className="live-music-panel__title">
                                <MapPin size={17} aria-hidden="true" />
                                <h4>Location</h4>
                            </div>
                            <p>Used to rank nearby shows before date-only results.</p>
                        </div>

                        {hasLocation ? (
                            <div className="live-music-location-card">
                                <MapPin size={16} aria-hidden="true" />
                                <div>
                                    <h5>{concertsLocationLabel || `${concertsLat.toFixed(2)}, ${concertsLng.toFixed(2)}`}</h5>
                                    <p>{concertsLat.toFixed(4)}, {concertsLng.toFixed(4)}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setLocationEditorOpen(open => !open)}
                                    className="btn btn-ghost btn-sm"
                                >
                                    {locationEditorOpen ? 'Cancel' : 'Change location'}
                                </button>
                            </div>
                        ) : (
                            <div className="live-music-empty">
                                <MapPin size={17} aria-hidden="true" />
                                <span>No location set. Events will be sorted by date only.</span>
                            </div>
                        )}

                        {showLocationEditor && (
                            <>
                                <div className="live-music-location-actions">
                                    <button
                                        type="button"
                                        onClick={useCurrentLocation}
                                        disabled={locating}
                                        className="btn btn-primary btn-sm"
                                    >
                                        {locating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />}
                                        Use current location
                                    </button>
                                </div>

                                <div className="live-music-field-row">
                                    <label className="live-music-field" htmlFor="live-music-city">
                                        <span>Enter a city manually</span>
                                        <input
                                            id="live-music-city"
                                            type="text"
                                            value={manualCity}
                                            onChange={e => setManualCity(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') submitManualCity(); }}
                                            placeholder="Oslo, Norway"
                                            autoComplete="off"
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        onClick={submitManualCity}
                                        disabled={locating || !manualCity.trim()}
                                        className="btn btn-ghost btn-sm live-music-field-row__action disabled:opacity-50"
                                    >
                                        {locating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : 'Search'}
                                    </button>
                                </div>
                            </>
                        )}

                        <div className="live-music-radius">
                            <div className="live-music-radius__label">
                                <span>Search radius</span>
                                <strong>{concertsRadiusKm} km</strong>
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
                                aria-label="Search radius in kilometers"
                            />
                            <div className="live-music-radius__bounds">
                                <span>10 km</span>
                                <span>300 km</span>
                            </div>
                        </div>
                    </section>

                    <section className="live-music-panel live-music-panel--subscriptions">
                        <div className="live-music-panel__header">
                            <div className="live-music-panel__title">
                                <Users2 size={17} aria-hidden="true" />
                                <h4>Subscribed Artists</h4>
                            </div>
                            <span className="live-music-count">{subs.length} / {maxSubs}</span>
                        </div>

                        <div className="live-music-auto-strip">
                            <div className="live-music-auto-strip__copy">
                                <Sparkles size={15} aria-hidden="true" />
                                <div>
                                    <strong>Auto-subscribe</strong>
                                    <span>Fill open slots from your most-played artists.</span>
                                </div>
                            </div>
                            <div className="live-music-auto-strip__actions">
                                {concertsAutoAddEnabled && (
                                    <button
                                        type="button"
                                        onClick={() => refreshAutoAdd(false)}
                                        disabled={autoRefreshing}
                                        className="live-music-link-button"
                                    >
                                        {autoRefreshing ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RotateCw size={12} aria-hidden="true" />}
                                        Refresh
                                    </button>
                                )}
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={concertsAutoAddEnabled}
                                    onClick={toggleAutoAdd}
                                    className="account-switch"
                                    data-state={concertsAutoAddEnabled ? 'on' : 'off'}
                                    aria-label="Toggle auto-add"
                                >
                                    <span className="account-switch__thumb" />
                                </button>
                            </div>
                        </div>

                        {subsLoading ? (
                            <div className="live-music-empty" role="status">
                                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                                <span>Loading subscriptions...</span>
                            </div>
                        ) : subs.length === 0 ? (
                            <div className="live-music-empty">
                                <Headphones size={16} aria-hidden="true" />
                                <span>No subscriptions yet. Pick artists below to track their tours.</span>
                            </div>
                        ) : (
                            <div className="live-music-chip-list">
                                {subs.map(s => {
                                    const isAuto = s.source === 'auto';
                                    return (
                                        <div key={s.id} className="live-music-artist-chip" data-source={isAuto ? 'auto' : 'manual'}>
                                            <div className="live-music-chip-avatar" aria-hidden="true">
                                                {s.image_url ? (
                                                    <img src={s.image_url} alt="" loading="lazy" />
                                                ) : (
                                                    <Headphones size={12} />
                                                )}
                                            </div>
                                            <span>{s.name}</span>
                                            {isAuto && (
                                                <span className="live-music-auto-badge" title="Added automatically based on your top played artists">
                                                    <Sparkles size={9} aria-hidden="true" />
                                                    Auto
                                                </span>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => unsubscribe(s.id)}
                                                className="live-music-chip-remove"
                                                aria-label={`Remove ${s.name}`}
                                            >
                                                <X size={14} aria-hidden="true" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {subs.length >= maxSubs && (
                            <div className="live-music-warning">
                                <AlertTriangle size={14} aria-hidden="true" />
                                <span>You have reached the maximum of {maxSubs} subscriptions. Remove an artist to add another.</span>
                            </div>
                        )}
                    </section>

                    {dismissed.length > 0 && (
                        <section className="live-music-panel live-music-panel--dismissed">
                            <div className="live-music-panel__header">
                                <div className="live-music-panel__title">
                                    <Undo2 size={17} aria-hidden="true" />
                                    <h4>Won&apos;t Auto-add</h4>
                                </div>
                                <span className="live-music-count">{dismissed.length}</span>
                            </div>
                            <p className="live-music-panel__description">
                                These artists were removed from auto-add. Allow them again to return them to suggestions.
                            </p>
                            <div className="live-music-chip-list">
                                {dismissed.map(d => (
                                    <button
                                        type="button"
                                        key={d.id}
                                        onClick={() => undismiss(d.id)}
                                        className="live-music-dismissed-chip"
                                        title="Allow this artist to be auto-added again"
                                        aria-label={`Allow ${d.name} to be auto-added again`}
                                    >
                                        <div className="live-music-chip-avatar" aria-hidden="true">
                                            {d.image_url ? (
                                                <img src={d.image_url} alt="" loading="lazy" />
                                            ) : (
                                                <Headphones size={12} />
                                            )}
                                        </div>
                                        <span>{d.name}</span>
                                        <strong>
                                            <Undo2 size={10} aria-hidden="true" />
                                            Allow
                                        </strong>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    <section className="live-music-panel live-music-panel--lookup">
                        <div className="live-music-panel__header">
                            <div className="live-music-panel__title">
                                <SearchIcon size={17} aria-hidden="true" />
                                <h4>Add an Artist</h4>
                            </div>
                            <p>Search artists in your library.</p>
                        </div>

                        <div className="live-music-search">
                            <SearchIcon size={16} aria-hidden="true" />
                            <input
                                type="search"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Search your library..."
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </div>

                        {showSuggestionsLabel && (
                            <div className="live-music-list-label">Top played</div>
                        )}

                        {searching ? (
                            <div className="live-music-empty" role="status">
                                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                                <span>Searching...</span>
                            </div>
                        ) : lookupList.length === 0 ? (
                            <div className="live-music-empty">
                                <Headphones size={16} aria-hidden="true" />
                                <span>
                                    {query.trim() ? `No artists matching "${query}" in your library.` : 'Your library has no plays yet. Start listening to populate suggestions.'}
                                </span>
                            </div>
                        ) : (
                            <ul className="live-music-artist-list">
                                {lookupList.map(renderArtistRow)}
                            </ul>
                        )}
                    </section>
                </>
            )}
        </div>
    );
};
