import React, { useEffect, useState, useMemo } from 'react';
import { usePlayerStore } from '../../store/index';
import { useNetworkInfo } from '../../hooks/useNetworkInfo';
import { Check, RefreshCw, RotateCcw, Speaker } from 'lucide-react';

const formatTelemetryTime = (timestamp: number | null): string => {
    if (!timestamp) return 'No data yet';
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatLoadPath = (path: string): string => {
    switch (path) {
        case 'prepared-hls': return 'Prepared HLS';
        case 'fallback-hls': return 'Fallback HLS';
        case 'cast': return 'Cast';
        case 'direct': return 'Direct file';
        default: return 'None';
    }
};

const formatRecoveryPath = (path: string): string => {
    switch (path) {
        case 'normal-hls-after-prepare-failure': return 'Normal HLS after prepare failure';
        case 'normal-hls-after-promotion-failure': return 'Normal HLS after promotion failure';
        default: return 'None';
    }
};

export const PlaybackTab: React.FC = () => {
    const discoveryLevel = usePlayerStore(state => state.discoveryLevel);
    const genreStrictness = usePlayerStore(state => state.genreStrictness);
    const artistAmnesiaLimit = usePlayerStore(state => state.artistAmnesiaLimit);
    const llmPlaylistDiversity = usePlayerStore(state => state.llmPlaylistDiversity);
    const llmVetoMode = usePlayerStore(state => state.llmVetoMode);
    const llmGenreCohesion = usePlayerStore(state => state.llmGenreCohesion);
    const llmDiscoveryBias = usePlayerStore(state => state.llmDiscoveryBias);
    const llmArtistSpread = usePlayerStore(state => state.llmArtistSpread);
    const genrePenaltyCurve = usePlayerStore(state => state.genrePenaltyCurve);
    const llmRecoveryStrength = usePlayerStore(state => state.llmRecoveryStrength);
    const llmAdjacentReach = usePlayerStore(state => state.llmAdjacentReach);
    const llmTracksPerPlaylist = usePlayerStore(state => state.llmTracksPerPlaylist);
    const llmPlaylistCount = usePlayerStore(state => state.llmPlaylistCount);
    
    const setSettings = usePlayerStore(state => state.setSettings);
    const streamingQuality = usePlayerStore(state => state.streamingQuality);
    const prebufferPolicy = usePlayerStore(state => state.prebufferPolicy);
    const playbackDebugLogging = usePlayerStore(state => state.playbackDebugLogging);
    const playbackTelemetry = usePlayerStore(state => state.playbackTelemetry);
    const sleepTimerEndsAt = usePlayerStore(state => state.sleepTimerEndsAt);
    const startSleepTimer = usePlayerStore(state => state.startSleepTimer);
    const cancelSleepTimer = usePlayerStore(state => state.cancelSleepTimer);
    const castConnected = usePlayerStore(state => state.castConnected);
    const audioOutputSupported = usePlayerStore(state => state.audioOutputSupported);
    const audioOutputPickerSupported = usePlayerStore(state => state.audioOutputPickerSupported);
    const audioOutputDevices = usePlayerStore(state => state.audioOutputDevices);
    const audioOutputDeviceId = usePlayerStore(state => state.audioOutputDeviceId);
    const audioOutputActive = usePlayerStore(state => state.audioOutputActive);
    const audioOutputDeviceLabel = usePlayerStore(state => state.audioOutputDeviceLabel);
    const audioOutputSelecting = usePlayerStore(state => state.audioOutputSelecting);
    const audioOutputError = usePlayerStore(state => state.audioOutputError);
    const selectAudioOutput = usePlayerStore(state => state.selectAudioOutput);
    const setAudioOutputDevice = usePlayerStore(state => state.setAudioOutputDevice);
    const refreshAudioOutputs = usePlayerStore(state => state.refreshAudioOutputs);
    const clearAudioOutput = usePlayerStore(state => state.clearAudioOutput);
    const networkInfo = useNetworkInfo();
    
    const [playbackTab, setPlaybackTab] = useState<'streaming' | 'output' | 'infinity' | 'llm'>('streaming');
    const [showLlmAdvanced, setShowLlmAdvanced] = useState(false);

    useEffect(() => {
        if (playbackTab === 'output') {
            void refreshAudioOutputs();
        }
    }, [playbackTab, refreshAudioOutputs]);

    // Tick once a second while a sleep timer is active to show the countdown.
    const [sleepNow, setSleepNow] = useState(() => Date.now());
    useEffect(() => {
        if (!sleepTimerEndsAt) return;
        setSleepNow(Date.now());
        const id = setInterval(() => setSleepNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [sleepTimerEndsAt]);
    const sleepRemainingMs = sleepTimerEndsAt ? Math.max(0, sleepTimerEndsAt - sleepNow) : 0;
    const sleepRemainingLabel = `${Math.floor(sleepRemainingMs / 60000)}:${String(Math.floor((sleepRemainingMs % 60000) / 1000)).padStart(2, '0')}`;
    const SLEEP_PRESETS = [15, 30, 45, 60];

    // Live penalty preview computed from current slider values
    const penaltyPreview = useMemo(() => {
        const curve = 0.5 + (genrePenaltyCurve / 100) * 1.5;
        const weight = llmGenreCohesion / 100;
        const format = (hop: number) => Math.pow(1 + hop, weight * curve).toFixed(2);
        return {
            deep: format(0.05),
            cousin: format(0.20),
            shareRoot: format(0.50),
            alien: format(2.0),
        };
    }, [genrePenaltyCurve, llmGenreCohesion]);

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Playback & Discovery</h3>
            </div>

            {/* Sub-tabs */}
            <div className="flex flex-wrap gap-2 mb-6">
                <button
                    onClick={() => setPlaybackTab('streaming')}
                    className={`btn-tab ${playbackTab === 'streaming' ? 'active' : ''}`}
                >
                    Streaming
                </button>
                <button
                    onClick={() => setPlaybackTab('output')}
                    className={`btn-tab ${playbackTab === 'output' ? 'active' : ''}`}
                >
                    Output
                </button>
                <button
                    onClick={() => setPlaybackTab('infinity')}
                    className={`btn-tab ${playbackTab === 'infinity' ? 'active' : ''}`}
                >
                    Infinity Mode
                </button>
                <button
                    onClick={() => setPlaybackTab('llm')}
                    className={`btn-tab ${playbackTab === 'llm' ? 'active' : ''}`}
                >
                    LLM Playlists
                </button>
            </div>

            {playbackTab === 'streaming' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        Audio is streamed using HLS (HTTP Live Streaming) for reliable seeking and offline caching. Choose a quality preset that suits your network and storage.
                    </p>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Streaming Quality</label>
                        <select
                            value={streamingQuality}
                            onChange={e => setSettings({ streamingQuality: e.target.value as any })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="auto">Auto (Normal — 128 kbps)</option>
                            <option value="64k">Low (64 kbps) — Saves data</option>
                            <option value="128k">Normal (128 kbps) — Good balance</option>
                            <option value="160k">High (160 kbps)</option>
                            <option value="320k">Very High (320 kbps) — Near-lossless</option>
                            <option value="source">Source — Original file, no conversion</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                            {streamingQuality === 'source'
                                ? 'Bit-perfect passthrough when the browser can play the file natively (FLAC, ALAC, WAV, MP3, AAC, Ogg, Opus) — bypasses HLS entirely and streams the raw bytes with Range seek. Falls back to high-bitrate AAC HLS for codecs the browser cannot decode (e.g. WMA). Chromecast still streams 128 kbps AAC HLS regardless of this setting.'
                                : streamingQuality === 'auto'
                                ? 'Automatically uses Normal quality (128 kbps AAC). This provides a good balance between quality and bandwidth.'
                                : `Audio will be transcoded to AAC at ${streamingQuality}bps. Both browser playback and Chromecast now honor this bitrate when a track starts. Higher bitrates sound better but use more bandwidth and storage.`
                            }
                        </p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Prebuffer Policy</label>
                        <select
                            value={prebufferPolicy}
                            onChange={e => setSettings({ prebufferPolicy: e.target.value as any })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="off">Off — No background preparation</option>
                            <option value="conservative">Conservative — Prepare next track</option>
                            <option value="aggressive">Aggressive — Prepare next track early</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                            {prebufferPolicy === 'off'
                                ? 'Disables HLS prewarm and local prepared audio. Use this if a browser or device behaves badly with background preparation.'
                                : prebufferPolicy === 'aggressive'
                                ? 'Currently prepares the immediate next track like Conservative, reserved for deeper prebuffering once proven safe.'
                                : 'Keeps the current stable behavior: server prewarm plus local prepared audio for the immediate next queued track.'
                            }
                        </p>
                    </div>

                    <div className="mb-6 p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                        <div className="flex items-center justify-between mb-3">
                            <div>
                                <p className="text-sm font-medium text-[var(--color-text-primary)]">Sleep Timer</p>
                                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                                    {sleepTimerEndsAt
                                        ? `Fading out and stopping in ${sleepRemainingLabel}.`
                                        : 'Gently fade out and pause after a set time.'}
                                </p>
                            </div>
                            {sleepTimerEndsAt && (
                                <button onClick={() => cancelSleepTimer()} className="btn btn-ghost btn-sm flex-shrink-0 ml-4">
                                    Cancel
                                </button>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {SLEEP_PRESETS.map((min) => {
                                const active = !!sleepTimerEndsAt && Math.round(sleepRemainingMs / 60000) <= min && Math.round(sleepRemainingMs / 60000) > min - 15;
                                return (
                                    <button
                                        key={min}
                                        onClick={() => startSleepTimer(min)}
                                        className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                                        aria-pressed={active}
                                    >
                                        {min} min
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="mb-6 flex items-center justify-between p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                        <div>
                            <p className="text-sm font-medium text-[var(--color-text-primary)]">Playback & Cast Debug Logging</p>
                            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                                Show HLS prewarm telemetry in the browser console and enable verbose Cast receiver diagnostics in the Cast log.
                            </p>
                        </div>
                        <button
                            onClick={() => setSettings({ playbackDebugLogging: !playbackDebugLogging })}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4 ${playbackDebugLogging ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                            aria-pressed={playbackDebugLogging}
                            aria-label="Toggle playback and Cast debug logging"
                        >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${playbackDebugLogging ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    {playbackDebugLogging && (
                        <div className="mb-6 p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Playback Telemetry</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Last path</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{formatLoadPath(playbackTelemetry.loadPath)}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Transition</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.lastTransitionLatencyMs !== null ? `${playbackTelemetry.lastTransitionLatencyMs}ms` : 'N/A'}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Prepared</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.prepareStatus}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Updated</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{formatTelemetryTime(playbackTelemetry.lastUpdatedAt)}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Prebuffer</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.prebufferPolicy}</span>
                                </div>
                            </div>
                            {playbackTelemetry.prebufferSkippedReason && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Prebuffer skipped: <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.prebufferSkippedReason}</span>
                                </p>
                            )}
                            {playbackTelemetry.lastFallbackReason && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Fallback reason: <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.lastFallbackReason}</span>
                                </p>
                            )}
                            {playbackTelemetry.recoveredFromPrepareFailure && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Recovery path: <span className="font-mono text-[var(--color-text-primary)]">{formatRecoveryPath(playbackTelemetry.recoveryPath)}</span>
                                </p>
                            )}
                            {playbackTelemetry.recoveryError && (
                                <p className="text-xs text-amber-500 mt-2">
                                    Recovery note: <span className="font-mono">{playbackTelemetry.recoveryError}</span>
                                </p>
                            )}
                            {playbackTelemetry.prepareError && (
                                <p className="text-xs text-amber-500 mt-2">
                                    Prepare warning: <span className="font-mono">{playbackTelemetry.prepareError}</span>
                                </p>
                            )}
                            <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                Cast diagnostics: <span className="font-mono text-[var(--color-text-primary)]">logs/cast-receiver.log</span>
                            </p>
                        </div>
                    )}

                    {/* Network info indicator */}
                    <div className="p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                        <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Network Status</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                            <div className="flex justify-between">
                                <span className="text-[var(--color-text-muted)]">Connection</span>
                                <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.type === 'unknown' ? 'Unknown' : networkInfo.type}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[var(--color-text-muted)]">Effective</span>
                                <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.effectiveType === 'unknown' ? 'N/A' : networkInfo.effectiveType}</span>
                            </div>
                            {networkInfo.downlink !== null && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-text-muted)]">Downlink</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.downlink} Mbps</span>
                                </div>
                            )}
                            <div className="flex justify-between">
                                <span className="text-[var(--color-text-muted)]">Data Saver</span>
                                <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.saveData ? 'On' : 'Off'}</span>
                            </div>
                        </div>
                        {networkInfo.type === 'unknown' && (
                            <p className="text-xs text-[var(--color-text-muted)] mt-2 italic">
                                Network info unavailable (common on iOS). Quality is fixed to your selected preset.
                            </p>
                        )}
                    </div>
                </div>
            )}

            {playbackTab === 'output' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        Choose the local audio output used by browser playback. Chromecast has its own route and takes priority while connected.
                    </p>

                    <div className="mb-6 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-[var(--color-text-primary)]">Audio Output</p>
                                <div className="mt-2 flex items-center gap-2 min-w-0">
                                    <Speaker
                                        size={18}
                                        className="flex-shrink-0"
                                        style={{
                                            color: audioOutputActive ? 'var(--color-primary)' : 'var(--color-text-muted)',
                                            filter: audioOutputActive ? 'drop-shadow(0 0 4px var(--color-primary))' : 'none',
                                        }}
                                    />
                                    <span className="text-sm text-[var(--color-text-primary)] truncate">
                                        {audioOutputActive
                                            ? audioOutputDeviceLabel || 'Selected output'
                                            : audioOutputDeviceLabel
                                            ? `${audioOutputDeviceLabel} saved`
                                            : 'System default'}
                                    </span>
                                </div>
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    {audioOutputSupported
                                        ? castConnected
                                            ? 'Disconnect Chromecast to choose a local output.'
                                            : audioOutputActive
                                            ? 'Browser playback is routed to the selected local output.'
                                            : 'System default is active. Select another exposed output below when available.'
                                        : 'System default is active. This browser has not exposed app-level routing for other outputs.'}
                                </p>
                                {audioOutputError && (
                                    <p className="text-xs text-amber-500 mt-2">{audioOutputError}</p>
                                )}
                            </div>

                            <div className="flex flex-col sm:flex-row gap-2 flex-shrink-0">
                                {audioOutputPickerSupported && (
                                    <button
                                        type="button"
                                        onClick={() => { void selectAudioOutput(); }}
                                        disabled={!audioOutputSupported || castConnected || audioOutputSelecting}
                                        className="btn btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-50"
                                    >
                                        <Speaker size={14} />
                                        {audioOutputSelecting ? 'Choosing...' : 'Picker'}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => { void refreshAudioOutputs(); }}
                                    disabled={audioOutputSelecting}
                                    className="btn btn-ghost btn-sm flex items-center gap-1.5 disabled:opacity-50"
                                >
                                    <RefreshCw size={14} />
                                    Refresh
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { void clearAudioOutput(); }}
                                    disabled={!audioOutputSupported || !audioOutputActive || audioOutputSelecting}
                                    className="btn btn-ghost btn-sm flex items-center gap-1.5 disabled:opacity-50"
                                >
                                    <RotateCcw size={14} />
                                    Default
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="mb-6 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                        <div className="flex items-center justify-between gap-3 mb-3">
                            <p className="text-sm font-medium text-[var(--color-text-primary)]">Available Outputs</p>
                            <span className="text-xs text-[var(--color-text-muted)]">{audioOutputDevices.length} shown</span>
                        </div>
                        <div className="space-y-2">
                            {audioOutputDevices.map((device) => {
                                const selected = device.isDefault
                                    ? !audioOutputActive
                                    : audioOutputActive && audioOutputDeviceId === device.deviceId;
                                const disabled = castConnected || audioOutputSelecting || (!device.isDefault && !audioOutputSupported);
                                return (
                                    <button
                                        key={device.isDefault ? 'default' : device.deviceId}
                                        type="button"
                                        onClick={() => { void setAudioOutputDevice(device.deviceId); }}
                                        disabled={disabled}
                                        className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-[var(--glass-border)] bg-[var(--color-bg-secondary)] text-left transition-ui hover:border-[var(--color-primary)]/40 disabled:opacity-60 disabled:hover:border-[var(--glass-border)]"
                                    >
                                        <span className="min-w-0 flex items-center gap-2">
                                            <Speaker
                                                size={17}
                                                className="flex-shrink-0"
                                                style={{ color: selected ? 'var(--color-primary)' : 'var(--color-text-muted)' }}
                                            />
                                            <span className="min-w-0">
                                                <span className="block text-sm text-[var(--color-text-primary)] truncate">{device.label}</span>
                                                <span className="block text-xs text-[var(--color-text-muted)]">
                                                    {device.isDefault ? 'Operating system default' : audioOutputSupported ? 'Browser-exposed output' : 'Visible, routing unavailable'}
                                                </span>
                                            </span>
                                        </span>
                                        {selected && <Check size={17} className="flex-shrink-0 text-[var(--color-primary)]" />}
                                    </button>
                                );
                            })}
                        </div>
                        {!audioOutputSupported && (
                            <p className="text-xs text-[var(--color-text-muted)] mt-3">
                                Aurora will keep using the system default output. Pair or switch headphones/speakers through the operating system audio controls.
                            </p>
                        )}
                    </div>

                    <div className="p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                        <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Routing Priority</p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                            <div className="rounded-lg border border-[var(--glass-border)] bg-[var(--color-bg-secondary)] p-3">
                                <span className="block text-[var(--color-text-muted)]">Chromecast</span>
                                <span className="block mt-1 font-medium text-[var(--color-text-primary)]">{castConnected ? 'Active' : 'Inactive'}</span>
                            </div>
                            <div className="rounded-lg border border-[var(--glass-border)] bg-[var(--color-bg-secondary)] p-3">
                                <span className="block text-[var(--color-text-muted)]">Local output</span>
                                <span className="block mt-1 font-medium text-[var(--color-text-primary)]">{audioOutputActive ? 'Selected' : 'Default'}</span>
                            </div>
                            <div className="rounded-lg border border-[var(--glass-border)] bg-[var(--color-bg-secondary)] p-3">
                                <span className="block text-[var(--color-text-muted)]">Hardware keys</span>
                                <span className="block mt-1 font-medium text-[var(--color-text-primary)]">Media Session</span>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {playbackTab === 'infinity' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        These settings control how Infinity Mode picks the next track. They're applied in order: first recent tracks are blocked, then candidates are found by sound similarity, and finally genre distance is penalized.
                    </p>
                    
                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Artist Amnesia (Anti-Repeat)</span>
                            <span>{artistAmnesiaLimit === 0 ? 'Off' : `${artistAmnesiaLimit} tracks`}</span>
                        </label>
                        <select 
                            value={artistAmnesiaLimit} 
                            onChange={e => setSettings({ artistAmnesiaLimit: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={0}>Off (no restriction)</option>
                            <option value={10}>Standard (last 10)</option>
                            <option value={50}>Strict (last 50)</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 1:</strong> Blocks recently played tracks from being picked again. "Off" means anything can repeat; "Strict" remembers the last 50 tracks you heard.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Discovery Level</span>
                            <span>{discoveryLevel}%</span>
                        </label>
                        <input type="range" min="1" max="100" value={discoveryLevel} onChange={e => setSettings({ discoveryLevel: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 2:</strong> How many similar-sounding tracks to consider. Low values pick from a small pool of near-identical matches; high values cast a wider net for more variety.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Genre Strictness</span>
                            <span>{genreStrictness}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={genreStrictness} onChange={e => setSettings({ genreStrictness: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 3:</strong> Penalizes tracks from different genres. 0% ignores genre entirely; 100% strongly prefers staying in the same genre family.</p>
                    </div>
                </div>
            )}

            {playbackTab === 'llm' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        These settings control how the library-relative playlist engine compiles each AI concept, recovers when the local library is thin, and balances cohesion against discovery.
                    </p>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Number of Playlists</label>
                        <select 
                            value={llmPlaylistCount} 
                            onChange={e => setSettings({ llmPlaylistCount: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={2}>2 playlists</option>
                            <option value={3}>3 playlists</option>
                            <option value={5}>5 playlists</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 1:</strong> How many separate playlists the AI creates. Each has its own theme (e.g., "Evening Chill", "Morning Energy").</p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Tracks per Playlist</label>
                        <select 
                            value={llmTracksPerPlaylist} 
                            onChange={e => setSettings({ llmTracksPerPlaylist: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={5}>5 tracks</option>
                            <option value={10}>10 tracks</option>
                            <option value={15}>15 tracks</option>
                            <option value={20}>20 tracks</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 2:</strong> The length of each generated playlist. More tracks = longer listening session per playlist.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Genre Cohesion</span>
                            <span>{llmGenreCohesion}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmGenreCohesion} onChange={e => setSettings({ llmGenreCohesion: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 3:</strong> How tightly playlists stay near the compiled genre path. Low values lean on sound similarity; high values stay closer to the concept's genre family.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Playlist Diversity</span>
                            <span>{llmPlaylistDiversity}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmPlaylistDiversity} onChange={e => setSettings({ llmPlaylistDiversity: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 4:</strong> How much controlled randomness the final selector allows. Low values stay close to best fit; high values let the optimizer take more interesting side roads.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Discovery Bias</span>
                            <span>{llmDiscoveryBias}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmDiscoveryBias} onChange={e => setSettings({ llmDiscoveryBias: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 5:</strong> How much the engine favors discovery and bridge pools over safest-fit picks. Higher values surface more underplayed or less obvious tracks without fully abandoning cohesion.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Artist Spread</span>
                            <span>{llmArtistSpread}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmArtistSpread} onChange={e => setSettings({ llmArtistSpread: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 6:</strong> How strongly the selector avoids repeating the same artist. Higher values push harder for broad artist coverage within each playlist.</p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Banned Genre Handling</label>
                        <select
                            value={llmVetoMode}
                            onChange={e => setSettings({ llmVetoMode: e.target.value as 'hard' | 'adaptive' })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="hard">Hard Veto — never include banned genres</option>
                            <option value="adaptive">Adaptive Penalty — relax only if the local pool fails</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 7:</strong> Controls how LLM banned genres are enforced. Hard veto keeps excluded styles out entirely; adaptive penalty can recover sparse libraries by treating banned genres as heavily penalized fallback candidates.</p>
                    </div>

                    <div className="mb-6 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <p className="text-sm font-medium text-[var(--color-text-primary)]">Advanced Tuning</p>
                                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                                    Recovery aggressiveness, adjacent-genre expansion, and raw genre penalty behavior.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowLlmAdvanced((value) => !value)}
                                className="btn btn-ghost btn-sm"
                            >
                                {showLlmAdvanced ? 'Hide' : 'Show'}
                            </button>
                        </div>

                        {showLlmAdvanced && (
                            <div className="mt-4">
                                <div className="mb-6">
                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                        <span>Recovery Strength</span>
                                        <span>{llmRecoveryStrength}%</span>
                                    </label>
                                    <input type="range" min="0" max="100" value={llmRecoveryStrength} onChange={e => setSettings({ llmRecoveryStrength: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How aggressively the engine widens non-genre pools when the concept is weak in your local library.</p>
                                </div>

                                <div className="mb-6">
                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                        <span>Adjacent Reach</span>
                                        <span>{llmAdjacentReach}%</span>
                                    </label>
                                    <input type="range" min="0" max="100" value={llmAdjacentReach} onChange={e => setSettings({ llmAdjacentReach: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How far the concept compiler may expand into adjacent genres when the exact path is thin.</p>
                                </div>

                                <div className="mb-0">
                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                        <span>Genre Penalty Curve</span>
                                        <span>{genrePenaltyCurve}%</span>
                                    </label>
                                    <input type="range" min="0" max="100" value={genrePenaltyCurve} onChange={e => setSettings({ genrePenaltyCurve: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How harshly distant genres are penalized once genre anchoring is active.</p>

                                    <div className="mt-3 p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--glass-border)]">
                                        <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Penalty Preview</p>
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                            <div className="flex justify-between">
                                                <span className="text-[var(--color-text-muted)]">Same subgenre</span>
                                                <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.deep}&times;</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-[var(--color-text-muted)]">Cousin genre</span>
                                                <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.cousin}&times;</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-[var(--color-text-muted)]">Same root genre</span>
                                                <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.shareRoot}&times;</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-[var(--color-text-muted)]">Completely different</span>
                                                <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.alien}&times;</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
