import Hls from 'hls.js';
import { castManager } from './CastManager';
import { usePlayerStore } from '../store';
import { applyStreamingQualityToHlsUrl } from './streaming';

export type PlaybackState = 'playing' | 'paused' | 'stopped';

class PlaybackManager {
    private static instance: PlaybackManager;
    private audio: HTMLAudioElement;
    private audioContext: AudioContext | null = null;
    private hls: Hls | null = null;
    private nextAudio: HTMLAudioElement | null = null;
    private nextHls: Hls | null = null;
    private nextUrlKey: string | null = null;
    private transitionStartedAt: number | null = null;
    
    // Internal state to track what's playing in case we switch to Cast mid-stream
    private currentUrl: string | null = null;
    private currentTitle: string | null = null;
    private currentArtist: string | null = null;
    private currentArtUrl: string | null = null;
    private currentAlbum: string | null = null;
    private currentFormat: string | null = null;

    // Store callbacks for Zustand to update its state
    private onTimeUpdateCallback?: (time: number) => void;
    private onDurationCallback?: (duration: number) => void;
    private onEndedCallback?: () => void;
    private onPlayStateChangeCallback?: (state: PlaybackState) => void;
    private onVolumeChangeCallback?: (volume: number) => void;
    private onMuteChangeCallback?: (muted: boolean) => void;
    private onTrackChangeCallback?: (index: number) => void;
    private onBufferingChangeCallback?: (isBuffering: boolean) => void;

    private constructor() {
        this.audio = this.createAudioElement();
        this.attachAudioEvents(this.audio);

        // Set up CastManager listeners
        castManager.onTimeUpdate = (time) => {
            if (castManager.isConnected()) this.onTimeUpdateCallback?.(time);
        };
        castManager.onDuration = (duration) => {
            if (castManager.isConnected()) this.onDurationCallback?.(duration);
        };
        castManager.onPlayStateChange = (isPlaying) => {
            if (castManager.isConnected()) {
                this.onPlayStateChangeCallback?.(isPlaying ? 'playing' : 'paused');
            }
        };
        castManager.onEnded = () => {
            if (castManager.isConnected()) {
                this.onPlayStateChangeCallback?.('stopped');
                this.onEndedCallback?.();
            }
        };
        castManager.onVolumeChange = (volume) => {
            if (castManager.isConnected()) this.onVolumeChangeCallback?.(volume);
        };
        castManager.onMuteChange = (muted) => {
            if (castManager.isConnected()) this.onMuteChangeCallback?.(muted);
        };
        castManager.onTrackChange = (index) => {
            if (castManager.isConnected()) this.onTrackChangeCallback?.(index);
        };
    }

    private createAudioElement(): HTMLAudioElement {
        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        return audio;
    }

    private attachAudioEvents(audio: HTMLAudioElement): void {
        // Set up standard event listeners
        audio.addEventListener('timeupdate', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onTimeUpdateCallback?.(audio.currentTime);
            }
        });

        audio.addEventListener('loadedmetadata', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onDurationCallback?.(audio.duration || 0);
            }
        });

        // hls.js updates the media element's duration asynchronously after manifest parsing.
        // 'durationchange' fires when that happens, giving us the real VOD duration.
        audio.addEventListener('durationchange', () => {
            if (!castManager.isConnected() && audio === this.audio && isFinite(audio.duration) && audio.duration > 0) {
                this.onDurationCallback?.(audio.duration);
            }
        });

        audio.addEventListener('ended', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.transitionStartedAt = performance.now();
                this.onPlayStateChangeCallback?.('stopped');
                this.onEndedCallback?.();
            }
        });

        audio.addEventListener('waiting', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onBufferingChangeCallback?.(true);
            }
        });

        audio.addEventListener('playing', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                if (this.transitionStartedAt !== null) {
                    const elapsed = performance.now() - this.transitionStartedAt;
                    console.info(`[Playback] Track transition audible after ${Math.round(elapsed)}ms`);
                    this.transitionStartedAt = null;
                }
                this.onBufferingChangeCallback?.(false);
            }
        });

        audio.addEventListener('canplay', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onBufferingChangeCallback?.(false);
            }
        });

        audio.addEventListener('play', () => {
             if (!castManager.isConnected() && audio === this.audio) this.onPlayStateChangeCallback?.('playing');
        });
        audio.addEventListener('pause', () => {
             if (!castManager.isConnected() && audio === this.audio) this.onPlayStateChangeCallback?.('paused');
        });
    }

    public static getInstance(): PlaybackManager {
        if (!PlaybackManager.instance) {
            PlaybackManager.instance = new PlaybackManager();
        }
        return PlaybackManager.instance;
    }

    // --- Callbacks Setup ---
    public setCallbacks(callbacks: {
        onTimeUpdate?: (time: number) => void;
        onDuration?: (duration: number) => void;
        onEnded?: () => void;
        onPlayStateChange?: (state: PlaybackState) => void;
        onVolumeChange?: (volume: number) => void;
        onMuteChange?: (muted: boolean) => void;
        onTrackChange?: (index: number) => void;
        onBufferingChange?: (isBuffering: boolean) => void;
    }) {
        this.onTimeUpdateCallback = callbacks.onTimeUpdate;
        this.onDurationCallback = callbacks.onDuration;
        this.onEndedCallback = callbacks.onEnded;
        this.onPlayStateChangeCallback = callbacks.onPlayStateChange;
        this.onVolumeChangeCallback = callbacks.onVolumeChange;
        this.onMuteChangeCallback = callbacks.onMuteChange;
        this.onTrackChangeCallback = callbacks.onTrackChange;
        this.onBufferingChangeCallback = callbacks.onBufferingChange;
    }

    // --- Core Playback Controls ---

    public async playUrl(hlsUrl: string, rawUrl: string, title?: string, artist?: string, artUrl?: string, album?: string, format?: string): Promise<void> {
        const effectiveHlsUrl = applyStreamingQualityToHlsUrl(
            hlsUrl,
            usePlayerStore.getState().streamingQuality
        );

        this.currentUrl = effectiveHlsUrl || rawUrl;
        this.currentTitle = title || 'Unknown Title';
        this.currentArtist = artist || 'Unknown Artist';
        this.currentArtUrl = artUrl || null;
        this.currentAlbum = album || null;
        this.currentFormat = format || null;

        try {
            if (castManager.isConnected()) {
                this.audio.pause();
                // Pass both URLs — CastManager picks based on receiver mode
                await castManager.castMedia(effectiveHlsUrl, rawUrl, this.currentTitle, this.currentArtist, this.currentArtUrl || undefined, album, format);
                return;
            }

            // Route HLS URLs through hls.js
            if (effectiveHlsUrl.includes('.m3u8')) {
                if (this.isPreparedUrl(effectiveHlsUrl)) {
                    await this.promotePreparedAudio();
                    return;
                }
                await this.playHls(effectiveHlsUrl);
                return;
            }

            // Clean up previous HLS instance if switching away
            this.destroyHls();

            // Clean up previous URL if it exists AND is a blob
            if (this.audio.src && this.audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audio.src);
            }

            this.audio.src = effectiveHlsUrl || rawUrl;
            this.audio.load();
            await this.audio.play();

            this.ensureAudioContext();
        } catch (error) {
            // AbortError: play() was interrupted by a new source loading — not a real error
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('PlaybackManager playUrl error:', error);
            throw error;
        }
    }

    // --- HLS Playback ---

    public prepareNextUrl(hlsUrl: string, rawUrl: string, title?: string, artist?: string, artUrl?: string, album?: string, format?: string): void {
        if (castManager.isConnected()) return;
        const effectiveHlsUrl = applyStreamingQualityToHlsUrl(
            hlsUrl,
            usePlayerStore.getState().streamingQuality
        );
        const key = effectiveHlsUrl || rawUrl;
        if (!key || !effectiveHlsUrl.includes('.m3u8')) return;
        if (this.nextUrlKey === key) return;

        this.destroyPreparedAudio();

        try {
            console.info(`[Playback] Preparing next HLS track: ${title || 'Unknown Title'}${artist ? ` by ${artist}` : ''}`);

            const nextAudio = this.createAudioElement();
            nextAudio.volume = this.audio.volume;
            nextAudio.muted = this.audio.muted;
            this.attachAudioEvents(nextAudio);
            this.nextAudio = nextAudio;
            this.nextUrlKey = key;

            const authToken = new URL(effectiveHlsUrl, window.location.origin).searchParams.get('token') || '';

            if (Hls.isSupported()) {
                const nextHls = this.createHlsInstance(authToken, 30, 60);
                this.nextHls = nextHls;
                nextHls.on(Hls.Events.MANIFEST_PARSED, () => {
                    console.info(`[Playback] Prepared next HLS track: ${title || 'Unknown Title'}${artist ? ` by ${artist}` : ''}`);
                });
                nextHls.on(Hls.Events.ERROR, (_event: string, data: any) => {
                    if (data.fatal) {
                        console.warn('[Playback] Prepared next HLS track failed:', data);
                        this.destroyPreparedAudio();
                    }
                });
                nextHls.loadSource(effectiveHlsUrl);
                nextHls.attachMedia(nextAudio);
            } else if (nextAudio.canPlayType('application/vnd.apple.mpegurl')) {
                nextAudio.src = effectiveHlsUrl;
                nextAudio.load();
            }
        } catch (error) {
            console.warn('[Playback] Failed to prepare next track:', error);
            this.destroyPreparedAudio();
        }
    }

    private async playHls(playlistUrl: string): Promise<void> {
        // Clean up previous HLS instance
        this.destroyHls();

        // Extract auth token from the playlist URL so we can pass it to segment requests.
        // hls.js constructs segment URLs relative to the playlist but drops query params.
        const urlObj = new URL(playlistUrl, window.location.origin);
        const authToken = urlObj.searchParams.get('token') || '';

        if (Hls.isSupported()) {
            this.hls = this.createHlsInstance(authToken, 60, 120);

            this.hls.loadSource(playlistUrl);
            this.hls.attachMedia(this.audio);

            // Wait for the manifest to be parsed, then play
            await new Promise<void>((resolve, reject) => {
                const onParsed = () => {
                    this.hls?.off(Hls.Events.MANIFEST_PARSED, onParsed);
                    this.hls?.off(Hls.Events.ERROR, onError);
                    resolve();
                };

                const onError = (_event: string, data: any) => {
                    if (data.fatal) {
                        this.hls?.off(Hls.Events.MANIFEST_PARSED, onParsed);
                        this.hls?.off(Hls.Events.ERROR, onError);

                        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                            console.error('[HLS] Fatal network error:', data);
                            // Try to recover once
                            this.hls?.startLoad();
                        } else {
                            console.error('[HLS] Fatal error:', data);
                            this.destroyHls();
                            reject(new Error(`HLS fatal error: ${data.details}`));
                        }
                    }
                };

                this.hls!.on(Hls.Events.MANIFEST_PARSED, onParsed);
                this.hls!.on(Hls.Events.ERROR, onError);
            });

            await this.safePlay();
        }
        // Fallback for iOS Safari (native HLS support)
        else if (this.audio.canPlayType('application/vnd.apple.mpegurl')) {
            this.audio.src = playlistUrl;
            await new Promise<void>((resolve) => {
                this.audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
            });
            await this.safePlay();
        }
        else {
            throw new Error('HLS is not supported on this browser');
        }
    }

    private createHlsInstance(authToken: string, maxBufferLength: number, maxMaxBufferLength: number): Hls {
        return new Hls({
            maxBufferLength,
            maxMaxBufferLength,
            startFragPrefetch: true,
            xhrSetup: (xhr: XMLHttpRequest, _url: string) => {
                // DO NOT call xhr.open() here — hls.js has already opened the request.
                // Use setRequestHeader to inject the auth token as a Bearer header.
                if (authToken) {
                    xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
                }
            },
        });
    }

    private isPreparedUrl(url: string): boolean {
        return !!this.nextAudio && this.nextUrlKey === url;
    }

    private async promotePreparedAudio(): Promise<void> {
        if (!this.nextAudio || !this.nextUrlKey) return;

        const oldAudio = this.audio;
        oldAudio.pause();
        this.destroyHls();

        this.audio = this.nextAudio;
        this.hls = this.nextHls;
        this.nextAudio = null;
        this.nextHls = null;
        this.nextUrlKey = null;

        if (oldAudio.src && oldAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(oldAudio.src);
        }
        oldAudio.removeAttribute('src');
        oldAudio.load();

        console.info('[Playback] Promoting prepared next track');
        await this.safePlay();
    }

    /**
     * Safely handle AudioContext and play() promises.
     * Catches NotAllowedError which occurs when autoplay is blocked.
     */
    private async safePlay(): Promise<void> {
        try {
            await this.audio.play();
            this.ensureAudioContext();
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                console.warn('Autoplay blocked. User interaction required.');
            } else if (error instanceof DOMException && error.name === 'AbortError') {
                // Play was interrupted by a new load — not an error
                return;
            } else {
                throw error;
            }
        }
    }

    private destroyHls(): void {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    private destroyPreparedAudio(): void {
        if (this.nextHls) {
            this.nextHls.destroy();
            this.nextHls = null;
        }
        if (this.nextAudio) {
            this.nextAudio.pause();
            if (this.nextAudio.src && this.nextAudio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.nextAudio.src);
            }
            this.nextAudio.removeAttribute('src');
            this.nextAudio.load();
            this.nextAudio = null;
        }
        this.nextUrlKey = null;
    }

    public async playFile(fileHandle: FileSystemFileHandle): Promise<void> {
        // Cast cannot play files loaded locally directly by default without spinning up a local server inline.
        // We just fallback to local playback.
        try {
            // Clean up HLS if active
            this.destroyHls();
            this.destroyPreparedAudio();

            const file = await fileHandle.getFile();
            const url = URL.createObjectURL(file);

            // Clean up previous URL if it exists
            if (this.audio.src && this.audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audio.src);
            }

            this.audio.src = url;
            this.audio.load();
            await this.audio.play();

            this.ensureAudioContext();

        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('PlaybackManager playFile error:', error);
            throw error;
        }
    }

    public pause(): void {
        if (castManager.isConnected()) {
            castManager.pause();
        } else {
            this.audio.pause();
        }
    }

    public async resume(): Promise<void> {
        if (castManager.isConnected()) {
            castManager.resume();
        } else {
            if (this.audio.src) {
                await this.audio.play();
                if (this.audioContext?.state === 'suspended') {
                    await this.audioContext.resume();
                }
            }
        }
    }

    public stop(): void {
        if (castManager.isConnected()) {
            castManager.stop();
        } else {
            this.audio.pause();
            this.audio.currentTime = 0;
            this.destroyPreparedAudio();
            this.onPlayStateChangeCallback?.('stopped');
        }
    }

    public seek(time: number): void {
        if (castManager.isConnected()) {
            castManager.seek(time);
        } else {
            if (isFinite(time) && time >= 0) {
                this.audio.currentTime = time;
            }
        }
    }

    public setVolume(volume: number): void {
        // Clamp between 0 and 1
        const v = Math.max(0, Math.min(1, volume));
        if (castManager.isConnected()) {
            castManager.setVolume(v);
        } else {
            this.audio.volume = v;
        }
    }

    public getDuration(): number {
        // Since getDuration is often synchronous, we rely on the state maintained locally if needed,
        // but it's largely obsolete if Zustand stores it.
        return this.audio.duration || 0;
    }

    public getCurrentTime(): number {
        return this.audio.currentTime || 0;
    }

    public getCurrentTrackInfo() {
        if (!this.currentUrl) return null;
        return {
            url: this.currentUrl,
            title: this.currentTitle || 'Unknown Title',
            artist: this.currentArtist || 'Unknown Artist',
            artUrl: this.currentArtUrl || undefined,
            album: this.currentAlbum || undefined,
            format: this.currentFormat || undefined,
        };
    }

    public getLocalAudioElement(): HTMLAudioElement {
        return this.audio;
    }

    public destroy(): void {
        this.destroyHls();
        this.destroyPreparedAudio();
        this.audio.pause();
        this.audio.src = '';
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    // --- Web Audio API Integration (Foundation for EQ/Visualizers) ---

    /**
     * Ensures an AudioContext exists. Call this on first user interaction
     * (e.g., from App.tsx) so Safari doesn't block it.
     * If already created, resumes from suspended state if needed.
     */
    public ensureAudioContext(): void {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                const source = this.audioContext.createMediaElementSource(this.audio);

                // Basic routing: Source -> Destination
                // Future: Source -> Gain (crossfade) -> Analyser (visualizer) -> Biquads (EQ) -> Destination
                source.connect(this.audioContext.destination);
            }

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
        } catch (e) {
            console.warn("Could not initialize AudioContext:", e);
        }
    }
}

export const playbackManager = PlaybackManager.getInstance();
