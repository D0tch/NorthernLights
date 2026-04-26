import { playbackManager } from './PlaybackManager';
import { usePlayerStore } from '../store';
import { applyStreamingQualityToHlsUrl } from './streaming';
import { createQueueEntryId, ensureQueueEntryIds } from './queue';
declare const chrome: any;
declare const cast: any;

const toast = {
    success: (msg: string) => usePlayerStore.getState().addToast(msg, 'success'),
    error: (msg: string) => usePlayerStore.getState().addToast(msg, 'error'),
    info: (msg: string) => usePlayerStore.getState().addToast(msg, 'info'),
};

export type CastState = 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED';

const SESSION_STORAGE_KEY = 'cast_session_id';
const CUSTOM_RECEIVER_HLS_CODEC = 'aac';

// Maps audio format strings (from music-metadata and file extensions) to MIME types.
// Keys must be lowercase. Covers: MPEG, FLAC, OGG, MP4/M4A, WAV/WAVE, WMA, AAC.
const FORMAT_MIME_MAP = new Map<string, string>([
    ['mp3', 'audio/mpeg'],
    ['mpeg', 'audio/mpeg'],
    ['flac', 'audio/flac'],
    ['ogg', 'audio/ogg'],
    ['m4a', 'audio/mp4'],
    ['mp4', 'audio/mp4'],
    ['mp4/m4a', 'audio/mp4'],  // music-metadata compound format
    ['aac', 'audio/aac'],
    ['wav', 'audio/wav'],
    ['wave', 'audio/wav'],  // music-metadata sometimes returns 'WAVE'
    ['wma', 'audio/x-ms-wma'],
    ['adts', 'audio/aac'],
    ['m3u8', 'application/vnd.apple.mpegurl'],
]);

function inferContentType(url: string, format?: string): string {
    // 1. Try the format string from music-metadata (e.g. 'MPEG', 'FLAC', 'MP4/M4A')
    if (format) {
        const mime = FORMAT_MIME_MAP.get(format.toLowerCase());
        if (mime) return mime;
    }
    // 2. Try extracting extension from the URL path (before query params)
    try {
        const pathname = new URL(url).pathname;
        const ext = pathname.split('.').pop()?.toLowerCase();
        if (ext) {
            const mime = FORMAT_MIME_MAP.get(ext);
            if (mime) return mime;
        }
    } catch { /* ignore */ }
    return 'audio/mpeg';
}

function stripQueryParam(url: string, key: string): string {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        parsed.searchParams.delete(key);
        return parsed.toString();
    } catch {
        return url;
    }
}

export class CastManager {
    private static instance: CastManager;
    private castContext: any = null;
    private player: any = null;
    private playerController: any = null;
    private state: CastState = 'NO_DEVICES_AVAILABLE';

    // Custom receiver app ID. Prefer runtime server config because HTML injection
    // is bypassed by service worker navigation caching and Vite dev HTML.
    private customAppId: string = (window as any).__CAST_APP_ID || '';
    private runtimeConfigPromise: Promise<void> | null = null;
    private initializePromise: Promise<void> | null = null;

    // Tracks whether this manager initiated the cast session (vs joining an existing one)
    private autoCastInProgress = false;

    // Serializes concurrent loadMedia calls to prevent session_error on rapid clicks
    private currentLoadPromise: Promise<void> = Promise.resolve();

    // Listener pattern for state changes (multiple subscribers)
    private stateChangeListeners: Set<(state: CastState) => void> = new Set();

    // Proxies for the player events so PlaybackManager can route them
    public onTimeUpdate?: (time: number) => void;
    public onDuration?: (duration: number) => void;
    public onPlayStateChange?: (isPlaying: boolean) => void;
    public onEnded?: () => void;
    public onVolumeChange?: (volume: number) => void;
    public onMuteChange?: (muted: boolean) => void;
    public onTrackChange?: (index: number) => void;
    private readonly queueItemIdByEntryId = new Map<string, number>();

    private constructor() {
        // The Cast API is loaded asynchronously via the script tag in index.html
        // It dispatches 'castApiAvailable' when ready.
        window.addEventListener('castApiAvailable', this.initializeCastApi.bind(this));

        // If it's already available
        if (typeof cast !== 'undefined' && cast.framework) {
            this.initializeCastApi();
        }
    }

    public static getInstance(): CastManager {
        if (!CastManager.instance) {
            CastManager.instance = new CastManager();
        }
        return CastManager.instance;
    }

    // --- State change listener management ---
    public addStateChangeListener(listener: (state: CastState) => void): () => void {
        this.stateChangeListeners.add(listener);
        // Immediately fire with current state
        listener(this.state);
        // Return unsubscribe function
        return () => this.stateChangeListeners.delete(listener);
    }

    public removeStateChangeListener(listener: (state: CastState) => void) {
        this.stateChangeListeners.delete(listener);
    }

    // Keep the old single-callback property as a setter that adds to the set
    set onStateChange(listener: ((state: CastState) => void) | undefined) {
        // Remove the old one if it was set via this setter
        if (this._onStateChangeCallback) {
            this.stateChangeListeners.delete(this._onStateChangeCallback);
        }
        this._onStateChangeCallback = listener;
        if (listener) {
            this.stateChangeListeners.add(listener);
        }
    }
    private _onStateChangeCallback?: (state: CastState) => void;

    private notifyStateChange() {
        for (const listener of this.stateChangeListeners) {
            try {
                listener(this.state);
            } catch (e) {
                console.error('[Cast] State change listener error:', e);
            }
        }
    }

    private initializeCastApi() {
        if (this.castContext) return;
        if (!this.initializePromise) {
            this.initializePromise = this.initializeCastApiInternal().finally(() => {
                if (!this.castContext) {
                    this.initializePromise = null;
                }
            });
        }
    }

    private async ensureRuntimeConfigLoaded() {
        if (this.customAppId) return;
        if (!this.runtimeConfigPromise) {
            this.runtimeConfigPromise = fetch('/api/client-config')
                .then(async (response) => {
                    if (!response.ok) {
                        throw new Error(`client-config ${response.status}`);
                    }
                    return response.json() as Promise<{ castReceiverAppId?: string }>;
                })
                .then((data) => {
                    this.customAppId = (data.castReceiverAppId || '').trim();
                    if (this.customAppId) {
                        console.log('[Cast] Loaded runtime custom receiver app ID');
                    } else {
                        console.warn('[Cast] Runtime client config has no custom receiver app ID; falling back to Default Media Receiver');
                    }
                })
                .catch((error) => {
                    console.warn('[Cast] Failed to load runtime client config:', error);
                });
        }
        await this.runtimeConfigPromise;
    }

    private async initializeCastApiInternal() {
        if (this.castContext) return;

        await this.ensureRuntimeConfigLoaded();

        try {
            const receiverApplicationId = this.customAppId || chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID;
            console.log(`[Cast] Initializing sender with ${this.customAppId ? 'custom' : 'default'} receiver app ID: ${receiverApplicationId}`);
            cast.framework.CastContext.getInstance().setOptions({
                receiverApplicationId,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            });

            this.castContext = cast.framework.CastContext.getInstance();
            this.player = new cast.framework.RemotePlayer();
            this.playerController = new cast.framework.RemotePlayerController(this.player);

            // --- Cast state changes (device discovery) ---
            this.castContext.addEventListener(
                cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                (event: any) => {
                    const prevState = this.state;
                    this.state = event.castState;
                    this.notifyStateChange();

                    // Auto-cast: when we transition to CONNECTED and have a track playing locally
                    if (prevState !== 'CONNECTED' && this.state === 'CONNECTED' && !this.autoCastInProgress) {
                        this.handleCastConnected();
                    }
                }
            );

            // --- Session state changes (session lifecycle — per Google Cast docs) ---
            this.castContext.addEventListener(
                cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
                (event: any) => {
                    switch (event.sessionState) {
                        case cast.framework.SessionState.SESSION_STARTED:
                            // Store session ID for rejoin
                            const session = this.castContext.getCurrentSession();
                            if (session) {
                                const sid = session.getSessionId();
                                if (sid) {
                                    localStorage.setItem(SESSION_STORAGE_KEY, sid);
                                    console.log('[Cast] Session started, stored ID:', sid);
                                }
                            }
                            break;

                        case cast.framework.SessionState.SESSION_RESUMED:
                            this.state = this.castContext.getCastState();
                            this.notifyStateChange();
                            // Re-store the session ID
                            const resumedSession = this.castContext.getCurrentSession();
                            if (resumedSession) {
                                const sid = resumedSession.getSessionId();
                                if (sid) localStorage.setItem(SESSION_STORAGE_KEY, sid);
                            }
                            break;

                        case cast.framework.SessionState.SESSION_ENDING:
                        case cast.framework.SessionState.SESSION_ENDED:
                            console.log('[Cast] Session ended');
                            localStorage.removeItem(SESSION_STORAGE_KEY);
                            this.state = 'NOT_CONNECTED';
                            this.notifyStateChange();
                            break;
                    }
                }
            );

            // --- Remote player connection changes (e.g., stopped from Google Home) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
                () => {
                    if (!this.player.isConnected) {
                        console.log('[Cast] Remote player disconnected');
                        localStorage.removeItem(SESSION_STORAGE_KEY);
                        this.state = 'NOT_CONNECTED';
                        this.notifyStateChange();
                    }
                }
            );

            // Set initial state
            this.state = this.castContext.getCastState();
            this.notifyStateChange();

            // --- Player state events ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
                () => {
                    this.onPlayStateChange?.(!this.player.isPaused);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
                () => {
                    this.onTimeUpdate?.(this.player.currentTime);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.DURATION_CHANGED,
                () => {
                    this.onDuration?.(this.player.duration);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
                () => {
                    if (this.player.playerState === chrome.cast.media.PlayerState.IDLE) {
                        // idleReason is only available on the media session, not RemotePlayer
                        try {
                            const session = this.castContext?.getCurrentSession();
                            const mediaSession = session?.getMediaSession();
                            if (mediaSession?.idleReason === chrome.cast.media.IdleReason.FINISHED) {
                                this.onEnded?.();
                            }
                        } catch { /* ignore */ }
                    }
                }
            );

            // --- Volume sync from receiver → sender (per Google Cast docs) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.VOLUME_LEVEL_CHANGED,
                () => {
                    this.onVolumeChange?.(this.player.volumeLevel);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_MUTED_CHANGED,
                () => {
                    this.onMuteChange?.(this.player.isMuted);
                }
            );

            // --- Queue change events (receiver auto-advances tracks) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.MEDIA_INFO_CHANGED,
                () => {
                    if (!this.isConnected()) return;
                    try {
                        this.syncCurrentTrackFromSession(this.castContext.getCurrentSession()?.getMediaSession());
                    } catch { /* ignore */ }
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.MEDIA_STATUS_CHANGED,
                () => {
                    try {
                        this.syncCurrentTrackFromSession(this.castContext.getCurrentSession()?.getMediaSession());
                    } catch { /* ignore */ }
                }
            );

            // --- Try to rejoin an existing session on init ---
            this.tryRejoinSession();

        } catch (e) {
            console.error("Failed to initialize Google Cast API", e);
            toast.error('Failed to initialize Google Cast. Please refresh and try again.');
        }
    }

    private getRepeatMode(repeat: 'none' | 'one' | 'all'): any {
        if (repeat === 'one') return chrome.cast.media.RepeatMode.SINGLE;
        if (repeat === 'all') return chrome.cast.media.RepeatMode.ALL;
        return chrome.cast.media.RepeatMode.OFF;
    }

    private getMediaSession(): any | null {
        return this.castContext?.getCurrentSession?.()?.getMediaSession?.() || null;
    }

    private ensureStoreQueueEntryIds() {
        const state = usePlayerStore.getState();
        const normalized = ensureQueueEntryIds(state.playlist);
        if (normalized.changed) {
            usePlayerStore.setState({ playlist: normalized.tracks });
        }
        return normalized.tracks;
    }

    private buildMediaInfo(track: {
        queueEntryId?: string;
        url?: string;
        rawUrl?: string;
        title?: string;
        artist?: string;
        artUrl?: string;
        album?: string;
        format?: string;
        duration?: number;
    }, options?: {
        includeAuthTokenInCustomData?: boolean;
        includeArtwork?: boolean;
        includeDuration?: boolean;
        compactHlsUrl?: boolean;
    }) {
        const includeAuthTokenInCustomData = options?.includeAuthTokenInCustomData ?? true;
        const includeArtwork = options?.includeArtwork ?? true;
        const includeDuration = options?.includeDuration ?? true;
        const compactHlsUrl = options?.compactHlsUrl ?? false;
        const useHls = !!this.customAppId;
        const effectiveHlsUrl = applyStreamingQualityToHlsUrl(
            track.url || '',
            usePlayerStore.getState().streamingQuality
        );
        let mediaUrl = useHls ? (effectiveHlsUrl || track.rawUrl || '') : (track.rawUrl || effectiveHlsUrl || '');
        if (useHls) {
            if (compactHlsUrl) {
                mediaUrl = stripQueryParam(mediaUrl, 'token');
            }
            try {
                const url = new URL(mediaUrl);
                url.searchParams.set('codec', CUSTOM_RECEIVER_HLS_CODEC);
                mediaUrl = url.toString();
            } catch { /* ignore */ }
        }
        const contentType = useHls ? 'application/vnd.apple.mpegurl' : inferContentType(mediaUrl, track.format);
        const mediaInfo = new chrome.cast.media.MediaInfo(mediaUrl, contentType);
        mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        mediaInfo.metadata.title = track.title || 'Unknown Title';
        mediaInfo.metadata.artist = track.artist || 'Unknown Artist';
        if (track.album) mediaInfo.metadata.albumName = track.album;
        if (includeArtwork && track.artUrl) mediaInfo.metadata.images = [new chrome.cast.Image(track.artUrl)];
        if (includeDuration && track.duration) mediaInfo.metadata.duration = track.duration;

        const customData: Record<string, any> = {};
        if (track.queueEntryId) {
            customData.queueEntryId = track.queueEntryId;
        }
        if (useHls) {
            const authToken = this.extractTokenFromUrl(mediaUrl);
            if (includeAuthTokenInCustomData && authToken) customData.token = authToken;
            customData.codec = CUSTOM_RECEIVER_HLS_CODEC;
        }
        if (Object.keys(customData).length > 0) {
            mediaInfo.customData = customData;
        }
        return mediaInfo;
    }

    private buildQueueItem(track: {
        queueEntryId?: string;
        url?: string;
        rawUrl?: string;
        title?: string;
        artist?: string;
        artUrl?: string;
        album?: string;
        format?: string;
        duration?: number;
    }, options?: {
        includeAuthTokenInCustomData?: boolean;
        includeArtwork?: boolean;
        includeDuration?: boolean;
        compactHlsUrl?: boolean;
    }) {
        const item = new chrome.cast.media.QueueItem(this.buildMediaInfo(track, options));
        item.autoplay = true;
        item.preloadTime = 30;
        return item;
    }

    private syncQueueItemMapFromSession(mediaSession: any | null = this.getMediaSession()) {
        this.queueItemIdByEntryId.clear();
        const items = mediaSession?.items;
        if (!Array.isArray(items)) return;
        for (const item of items) {
            const queueEntryId = item?.media?.customData?.queueEntryId;
            if (queueEntryId && typeof item.itemId === 'number') {
                this.queueItemIdByEntryId.set(queueEntryId, item.itemId);
            }
        }
    }

    private getSessionQueueEntryIds(mediaSession: any | null = this.getMediaSession()): string[] {
        const items = mediaSession?.items;
        if (!Array.isArray(items)) return [];
        return items
            .map((item: any) => item?.media?.customData?.queueEntryId)
            .filter((entryId: string | undefined): entryId is string => !!entryId);
    }

    private getCurrentQueueEntryId(mediaSession: any | null = this.getMediaSession()): string | null {
        if (!mediaSession) return null;
        const currentItemId = mediaSession.currentItemId;
        if (typeof currentItemId === 'number' && Array.isArray(mediaSession.items)) {
            const currentItem = mediaSession.items.find((item: any) => item?.itemId === currentItemId);
            const currentEntryId = currentItem?.media?.customData?.queueEntryId;
            if (currentEntryId) return currentEntryId;
        }
        return mediaSession.media?.customData?.queueEntryId || null;
    }

    private syncCurrentTrackFromSession(mediaSession: any | null = this.getMediaSession()): boolean {
        if (!mediaSession) return false;

        this.syncQueueItemMapFromSession(mediaSession);

        const state = usePlayerStore.getState();
        const currentQueueEntryId = this.getCurrentQueueEntryId(mediaSession);
        if (currentQueueEntryId) {
            const index = state.playlist.findIndex((track) => track.queueEntryId === currentQueueEntryId);
            if (index >= 0) {
                if (index !== state.currentIndex) {
                    this.onTrackChange?.(index);
                }
                return true;
            }
        }

        const currentItemIndex = mediaSession.currentItemIndex;
        if (typeof currentItemIndex === 'number' && currentItemIndex >= 0 && currentItemIndex < state.playlist.length) {
            if (currentItemIndex !== state.currentIndex) {
                this.onTrackChange?.(currentItemIndex);
            }
            return true;
        }

        const fallbackIndex = mediaSession.media?.metadata?.index;
        if (typeof fallbackIndex === 'number' && fallbackIndex >= 0 && fallbackIndex < state.playlist.length) {
            if (fallbackIndex !== state.currentIndex) {
                this.onTrackChange?.(fallbackIndex);
            }
            return true;
        }

        return false;
    }

    private getQueueItemId(queueEntryId: string, mediaSession: any | null = this.getMediaSession()): number | null {
        this.syncQueueItemMapFromSession(mediaSession);
        const itemId = this.queueItemIdByEntryId.get(queueEntryId);
        return typeof itemId === 'number' ? itemId : null;
    }

    private isSessionQueueMatchingTracks(tracks: { queueEntryId?: string }[], mediaSession: any | null = this.getMediaSession()): boolean {
        if (!mediaSession) return false;
        const sessionEntryIds = this.getSessionQueueEntryIds(mediaSession);
        if (sessionEntryIds.length !== tracks.length) return false;
        return tracks.every((track, index) => track.queueEntryId && track.queueEntryId === sessionEntryIds[index]);
    }

    public async ensureQueuePlayback(
        tracks: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }[],
        startIndex: number = 0,
        repeat: 'none' | 'one' | 'all' = 'none'
    ) {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession || !this.isSessionQueueMatchingTracks(tracks, mediaSession)) {
            await this.castQueue(tracks, startIndex, repeat);
            return;
        }

        const desiredRepeatMode = this.getRepeatMode(repeat);
        if (mediaSession.repeatMode !== desiredRepeatMode) {
            try {
                await mediaSession.queueSetRepeatMode(desiredRepeatMode);
            } catch (e) {
                console.warn('[Cast] Failed to sync repeat mode:', e);
            }
        }

        const items = mediaSession.items;
        if (!items || !items[startIndex]) return;
        const targetItemId = items[startIndex].itemId;
        if (targetItemId === mediaSession.currentItemId) return;
        try {
            await mediaSession.queueJumpToItem(targetItemId);
        } catch (e) {
            console.error('[Cast] Failed to jump to queue item:', e);
        }
    }

    /**
     * Attempt to rejoin a previously stored cast session.
     * Per Google Cast docs: use requestSessionById() to resume without page reload.
     */
    private tryRejoinSession() {
        const storedId = localStorage.getItem(SESSION_STORAGE_KEY);
        if (!storedId) return;

        console.log('[Cast] Attempting to rejoin session:', storedId);
        try {
            chrome.cast.requestSessionById(storedId);
        } catch (e) {
            console.warn('[Cast] Failed to rejoin session:', e);
            localStorage.removeItem(SESSION_STORAGE_KEY);
            toast.info('Cast session could not be restored. Starting fresh.');
        }
    }

    /**
     * Called when cast state transitions to CONNECTED.
     * Automatically takes the currently playing track and starts casting it.
     */
    private async handleCastConnected() {
        // Read current playback state from the store
        const state = usePlayerStore.getState();
        const { currentIndex, repeat } = state;
        const playlist = this.ensureStoreQueueEntryIds();

        if (!playlist.length || currentIndex === null) {
            console.log('[Cast] Connected but no playlist is active — nothing to auto-cast.');
            return;
        }

        const track = playlist[currentIndex];
        // Get current playback position before we pause local audio
        const currentTime = playbackManager.getCurrentTime();

        console.log(`[Cast] Auto-casting: "${track.title}" by ${track.artist} (position: ${currentTime.toFixed(1)}s)`);

        this.autoCastInProgress = true;
        try {
            // Pause local audio DIRECTLY on the HTMLAudioElement.
            // We cannot use playbackManager.pause() because it checks
            // castManager.isConnected() — which is now true — and routes to
            // castManager.pause(), which is a no-op since no media is loaded
            // on the Cast device yet. This would leave local audio playing.
            playbackManager.getLocalAudioElement().pause();

            await this.castQueue(
                playlist.map((item) => ({
                    queueEntryId: item.queueEntryId,
                    url: item.url || '',
                    rawUrl: item.rawUrl || '',
                    title: item.title || 'Unknown Title',
                    artist: item.artist || ((item.artists as string[])?.join(', ')) || 'Unknown Artist',
                    artUrl: item.artUrl,
                    album: item.album,
                    format: item.format,
                    duration: item.duration,
                })),
                currentIndex,
                repeat
            );

            // Seek to where we left off locally (with a small delay to let the media load)
            if (currentTime > 1) {
                setTimeout(() => {
                    this.seek(currentTime);
                }, 500);
            }
        } catch (e) {
            console.error('[Cast] Failed to auto-cast current track:', e);
            toast.error('Connected to Cast device but failed to play media.');
        } finally {
            this.autoCastInProgress = false;
        }
    }

    public isConnected(): boolean {
        return this.state === 'CONNECTED';
    }

    /**
     * Returns the friendly name of the connected Cast device (e.g. "Living Room TV").
     */
    public getCastDeviceName(): string {
        try {
            const session = this.castContext?.getCurrentSession();
            if (session) {
                const device = session.getCastDevice();
                return device?.friendlyName || '';
            }
        } catch { /* ignore */ }
        return '';
    }

    /**
     * Extract the auth token from a track URL's query parameters.
     */
    private extractTokenFromUrl(url: string): string {
        try {
            return new URL(url).searchParams.get('token') || '';
        } catch {
            return '';
        }
    }

    public async castMedia(hlsUrl: string, rawUrl: string, title: string, artist: string, artUrl?: string, album?: string, format?: string, token?: string) {
        if (!this.isConnected()) return;

        const castSession = this.castContext.getCurrentSession();
        if (!castSession) return;

        const effectiveHlsUrl = applyStreamingQualityToHlsUrl(
            hlsUrl,
            usePlayerStore.getState().streamingQuality
        );

        // Select URL based on mode: custom receiver → HLS, default → raw file
        const useHls = !!(this.customAppId && effectiveHlsUrl);
        let mediaUrl = useHls ? effectiveHlsUrl : (rawUrl || effectiveHlsUrl);
        const authToken = token || this.extractTokenFromUrl(mediaUrl);

        if (useHls) {
            try {
                const url = new URL(mediaUrl);
                url.searchParams.set('codec', CUSTOM_RECEIVER_HLS_CODEC);
                mediaUrl = url.toString();
            } catch { /* ignore */ }
        }

        // Warn if the Chromecast can't reach the server (localhost / 127.0.0.1)
        try {
            const host = new URL(mediaUrl).hostname;
            if (host === 'localhost' || host === '127.0.0.1') {
                console.warn('[Cast] Server URL is localhost — the Chromecast device cannot reach it. Access the app via your LAN IP or domain to cast.');
                toast.error('Cannot cast: server is at localhost. Access the app via your LAN IP address to cast.');
                return;
            }
        } catch { /* ignore */ }

        const contentType = useHls ? 'application/vnd.apple.mpegurl' : inferContentType(mediaUrl, format);
        const mediaInfo = new chrome.cast.media.MediaInfo(mediaUrl, contentType);
        mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        mediaInfo.metadata.title = title;
        mediaInfo.metadata.artist = artist;
        if (album) {
            mediaInfo.metadata.albumName = album;
        }

        if (artUrl) {
            mediaInfo.metadata.images = [new chrome.cast.Image(artUrl)];
        }

        // Pass auth token to custom receiver via customData for Bearer header injection
        if (useHls && authToken) {
            mediaInfo.customData = { token: authToken, codec: CUSTOM_RECEIVER_HLS_CODEC };
        }

        // Serialize loadMedia calls to prevent concurrent loads from clashing
        const previous = this.currentLoadPromise;
        let resolveLoad: () => void;
        this.currentLoadPromise = new Promise<void>((resolve) => { resolveLoad = resolve; });

        // Wait for any in-flight load to complete
        await previous;

        const request = new chrome.cast.media.LoadRequest(mediaInfo);
        request.autoplay = true;

        try {
            await castSession.loadMedia(request);
            this.queueItemIdByEntryId.clear();
        } catch (e: any) {
            const errorDetail = e?.code || e?.message || String(e);
            const errorDesc = e?.description || '';
            console.error(`[Cast] Failed to load media: ${errorDetail}${errorDesc ? ' — ' + errorDesc : ''}`, e);
            if (!String(errorDetail).includes('cancel') && !String(errorDetail).includes('abort')) {
                toast.error(`Failed to play "${title}" on Cast device.`);
            }
            return;
        } finally {
            resolveLoad!();
        }

        // Store session ID for rejoin after successful load
        const sessionId = castSession.getSessionId();
        if (sessionId) {
            localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        }
    }

    /**
     * Load a queue of tracks onto the Cast device for gapless playback.
     * The receiver handles auto-advancement, eliminating gaps between tracks.
     * @param tracks Array of track objects with url, title, artist, artUrl, album, format, duration
     * @param startIndex Which track to start playing (0-based)
     * @param repeat 'none' | 'one' | 'all' — repeat mode
     */
    public async castQueue(tracks: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }[], startIndex: number = 0, repeat: 'none' | 'one' | 'all' = 'none') {
        if (!this.isConnected()) return;

        const castSession = this.castContext.getCurrentSession();
        if (!castSession) return;
        const normalizedStartIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
        const queueItems: any[] = tracks.map((track, index) => this.buildQueueItem(track, {
            includeAuthTokenInCustomData: false,
            includeArtwork: index === normalizedStartIndex,
            includeDuration: index === normalizedStartIndex,
            compactHlsUrl: true,
        }));

        const startItem = queueItems[normalizedStartIndex] || queueItems[0];
        if (!startItem?.media) {
            console.error('[Cast] Cannot load queue: missing start item media');
            return;
        }

        const startTrack = tracks[normalizedStartIndex] || tracks[0];
        const startTrackUrl = applyStreamingQualityToHlsUrl(
            startTrack?.url || '',
            usePlayerStore.getState().streamingQuality
        );
        const sharedAuthToken = this.extractTokenFromUrl(startTrackUrl || startTrack?.rawUrl || '');
        startItem.media.customData = {
            ...(startItem.media.customData || {}),
            ...(sharedAuthToken ? { token: sharedAuthToken } : {}),
        };

        const request = new chrome.cast.media.LoadRequest(startItem.media);
        request.autoplay = true;
        request.queueData = new chrome.cast.media.QueueData();
        request.queueData.items = queueItems;
        request.queueData.startIndex = normalizedStartIndex;
        request.queueData.repeatMode = this.getRepeatMode(repeat);

        try {
            const approxPayloadChars = JSON.stringify({
                media: request.media,
                queueData: {
                    startIndex: request.queueData.startIndex,
                    repeatMode: request.queueData.repeatMode,
                    items: request.queueData.items,
                }
            }).length;
            console.log(`[Cast] Queue load summary: items=${queueItems.length} startIndex=${normalizedStartIndex} approxPayloadChars=${approxPayloadChars}`);
        } catch { /* ignore */ }

        // Serialize loadMedia calls to prevent concurrent loads from clashing
        const previous = this.currentLoadPromise;
        let resolveLoad: () => void;
        this.currentLoadPromise = new Promise<void>((resolve) => { resolveLoad = resolve; });
        await previous;

        try {
            await castSession.loadMedia(request);
        } catch (e: any) {
            const errorDetail = e?.code || e?.message || String(e);
            const errorDesc = e?.description || '';
            console.error(`[Cast] Failed to load queue: ${errorDetail}${errorDesc ? ' — ' + errorDesc : ''}`, e);
            if (!String(errorDetail).includes('cancel') && !String(errorDetail).includes('abort')) {
                toast.error('Failed to load queue on Cast device.');
            }
            return;
        } finally {
            resolveLoad!();
        }

        // Store session ID for rejoin
        const sessionId = castSession.getSessionId();
        if (sessionId) {
            localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        }
        this.syncQueueItemMapFromSession(castSession.getMediaSession());
    }

    /**
     * Jump to a specific index in the cast queue.
     * Much faster than reloading the entire queue for next/prev navigation.
     */
    public async jumpToQueueIndex(index: number) {
        if (!this.isConnected()) return;
        const session = this.castContext.getCurrentSession();
        if (!session) return;
        const mediaSession = session.getMediaSession();
        if (!mediaSession) return;

        const items = mediaSession.items;
        if (!items || !items[index]) return;

        // Jump to the specified item in the cast queue
        try {
            await mediaSession.queueJumpToItem(items[index].itemId);
        } catch (e) {
            console.error('[Cast] Failed to jump to queue index:', e);
        }
    }

    /**
     * Appends a new track to the end of the active Cast queue without interrupting playback.
     */
    public async appendToQueue(track: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }) {
        if (!this.isConnected()) return;
        const session = this.castContext.getCurrentSession();
        if (!session) return;
        const mediaSession = session.getMediaSession();
        if (!mediaSession) return;
        const item = this.buildQueueItem({
            ...track,
            queueEntryId: track.queueEntryId || createQueueEntryId(),
        });

        try {
            await mediaSession.queueAppendItem(item);
            this.syncQueueItemMapFromSession(mediaSession);
        } catch (e) {
            console.error('[Cast] Failed to append track to queue:', e);
        }
    }

    public async insertNextInQueue(track: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }) {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;

        const item = this.buildQueueItem({
            ...track,
            queueEntryId: track.queueEntryId || createQueueEntryId(),
        });
        const request = new chrome.cast.media.QueueInsertItemsRequest([item]);
        const items = mediaSession.items;
        const currentIndex = mediaSession.currentItemIndex;
        if (Array.isArray(items) && typeof currentIndex === 'number' && currentIndex >= 0 && currentIndex < items.length - 1) {
            request.insertBefore = items[currentIndex + 1].itemId;
        }

        try {
            await mediaSession.queueInsertItems(request);
            this.syncQueueItemMapFromSession(mediaSession);
        } catch (e) {
            console.error('[Cast] Failed to insert track after current item:', e);
        }
    }

    public async removeFromQueue(queueEntryId: string) {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;

        const itemId = this.getQueueItemId(queueEntryId, mediaSession);
        if (itemId === null) return;
        try {
            await mediaSession.queueRemoveItem(itemId);
            this.syncQueueItemMapFromSession(mediaSession);
        } catch (e) {
            console.error('[Cast] Failed to remove track from queue:', e);
        }
    }

    public async moveQueueItem(queueEntryId: string, newIndex: number) {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;

        const itemId = this.getQueueItemId(queueEntryId, mediaSession);
        if (itemId === null) return;
        try {
            await mediaSession.queueMoveItemToNewIndex(itemId, newIndex);
            this.syncQueueItemMapFromSession(mediaSession);
        } catch (e) {
            console.error('[Cast] Failed to reorder Cast queue:', e);
        }
    }

    public async setRepeatMode(repeat: 'none' | 'one' | 'all') {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;
        try {
            await mediaSession.queueSetRepeatMode(this.getRepeatMode(repeat));
        } catch (e) {
            console.error('[Cast] Failed to update repeat mode:', e);
        }
    }

    public playOrPause() {
        if (this.playerController) {
            this.playerController.playOrPause();
        }
    }

    public pause() {
        if (this.playerController && !this.player.isPaused) {
            this.playerController.playOrPause();
        }
    }

    public resume() {
        if (this.playerController && this.player.isPaused) {
            this.playerController.playOrPause();
        }
    }

    public stop() {
        if (this.playerController) {
            this.playerController.stop();
        }
    }

    public seek(time: number) {
        if (this.playerController) {
            this.player.currentTime = time;
            this.playerController.seek();
        }
    }

    public getCurrentCastTime(): number {
        return this.player?.currentTime ?? 0;
    }

    public setVolume(volumeLevel: number) {
        if (this.playerController) {
            this.player.volumeLevel = volumeLevel;
            this.playerController.setVolumeLevel();
        }
    }

    public async requestSession() {
        if (!this.castContext) return;
        try {
            await this.castContext.requestSession();
        } catch (e: any) {
            console.error("Failed to request cast session", e);
            // User cancelled or an error occurred
            const msg = e?.message || String(e);
            if (!msg.includes('cancel') && !msg.includes('abort') && !msg.includes('cancelled')) {
                toast.error('Failed to connect to Cast device. Please try again.');
            }
        }
    }

    /**
     * Disconnect from the cast device.
     * Stops cast playback and resumes local playback from the current position.
     */
    public async disconnect() {
        if (!this.castContext) return;

        // Capture current cast playback position
        const castTime = this.getCurrentCastTime();
        const isPlaying = this.player && !this.player.isPaused;

        console.log(`[Cast] Disconnecting — position: ${castTime.toFixed(1)}s, wasPlaying: ${isPlaying}`);

        // Clear stored session ID before ending
        localStorage.removeItem(SESSION_STORAGE_KEY);

        try {
            // Stop the cast media first
            this.stop();

            // End the cast session — pass true to stop the receiver app
            this.castContext.endCurrentSession(true);
        } catch (e) {
            console.error('[Cast] Error during disconnect:', e);
            toast.error('Error disconnecting from Cast device.');
        }

        // Resume local playback at the position we left off
        try {
            const trackInfo = playbackManager.getCurrentTrackInfo();
            if (trackInfo && castTime > 0) {
                // Seek the local audio to the cast position
                playbackManager.seek(castTime);
                if (isPlaying) {
                    await playbackManager.resume();
                }
            }
        } catch (e) {
            console.error('[Cast] Error resuming local playback after disconnect:', e);
        }
    }

    public getState(): CastState {
        return this.state;
    }
}

export const castManager = CastManager.getInstance();
