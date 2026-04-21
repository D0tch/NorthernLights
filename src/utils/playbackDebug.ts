const readPersistedPlaybackDebugLogging = (): boolean => {
    if (typeof window === 'undefined') return false;

    try {
        const persisted = window.localStorage.getItem('player-store');
        if (!persisted) return false;
        const parsed = JSON.parse(persisted) as { state?: { playbackDebugLogging?: boolean } };
        return parsed.state?.playbackDebugLogging === true;
    } catch {
        return false;
    }
};

let playbackDebugLogging = readPersistedPlaybackDebugLogging();

export const setPlaybackDebugLogging = (enabled: boolean): void => {
    playbackDebugLogging = enabled;
};

export const logPlaybackInfo = (...args: Parameters<typeof console.info>): void => {
    if (playbackDebugLogging) {
        console.info(...args);
    }
};
