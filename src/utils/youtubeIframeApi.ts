// Singleton loader for the YouTube IFrame Player API.
//
// Unlike a plain <iframe> embed, the IFrame API (YT.Player) lets us detect
// buffering/playing, seek to a position, and react to the video ending — all
// of which the mobile now-playing background video needs. The API script must
// be loaded once globally; it then invokes the global `onYouTubeIframeAPIReady`
// callback. We wrap that in a memoised promise so any number of players can
// await readiness.

// Minimal typings — we intentionally avoid pulling in @types/youtube.
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  mute(): void;
  unMute(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoLoadedFraction(): number;
  getPlayerState(): number;
  destroy(): void;
}

export interface YTPlayerEvent {
  target: YTPlayer;
  data: number;
}

export interface YTPlayerOptions {
  videoId?: string;
  host?: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: YTPlayerEvent) => void;
    onStateChange?: (event: YTPlayerEvent) => void;
    onError?: (event: YTPlayerEvent) => void;
  };
}

export interface YTNamespace {
  Player: new (element: HTMLElement | string, options: YTPlayerOptions) => YTPlayer;
  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

let apiPromise: Promise<YTNamespace> | null = null;

export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(new Error('YouTube IFrame API unavailable outside the browser'));
      return;
    }

    // Already loaded and ready.
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }

    // Preserve any callback that might already be registered, then chain ours.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT && window.YT.Player) {
        resolve(window.YT);
      } else {
        reject(new Error('YouTube IFrame API loaded without YT.Player'));
      }
    };

    // Inject the script only once.
    if (!document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = IFRAME_API_SRC;
      script.async = true;
      script.onerror = () => {
        apiPromise = null;
        reject(new Error('Failed to load YouTube IFrame API script'));
      };
      document.head.appendChild(script);
    }
  });

  return apiPromise;
}
