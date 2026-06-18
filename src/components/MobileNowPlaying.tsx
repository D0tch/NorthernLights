import { usePlayerStore } from '../store/index';
import { useState, useEffect, useMemo, type CSSProperties } from 'react';
import { X, Infinity as InfinityIcon, ListMusic, FileText, Speaker } from 'lucide-react';
import ProgressBar from './ProgressBar';
import { useSwipe } from '../hooks/useSwipe';
import { castManager } from '../utils/CastManager';
import { LyricsPanel } from './LyricsPanel';
import { LoveButton } from './LoveButton';
import { CastButton } from './cast/CastButton';
import { IconNext, IconPause, IconPlay, IconPrev, IconRepeatAll, IconRepeatOne, IconShuffle } from './icons/PlayerIcons';
import { useDominantColor } from '../hooks/useDominantColor';
import { buildCoverMeshGradient } from '../utils/coverGradient';
import { useTrackMusicVideo } from '../hooks/useTrackMusicVideo';
import MobileNowPlayingVideo, { type VideoPhase } from './MobileNowPlayingVideo';

interface MobileNowPlayingProps {
  onClose: () => void;
  isOpen?: boolean;
}

const MobileNowPlaying: React.FC<MobileNowPlayingProps> = ({ onClose, isOpen = true }) => {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playbackState = usePlayerStore((s) => s.playbackState);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const pause = usePlayerStore((s) => s.pause);
  const resume = usePlayerStore((s) => s.resume);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const isInfinityMode = usePlayerStore((s) => s.isInfinityMode);
  const toggleInfinityMode = usePlayerStore((s) => s.toggleInfinityMode);
  const setIsSidebarOpen = usePlayerStore((s) => s.setIsSidebarOpen);
  const audioOutputSupported = usePlayerStore((s) => s.audioOutputSupported);
  const audioOutputActive = usePlayerStore((s) => s.audioOutputActive);
  const audioOutputDeviceLabel = usePlayerStore((s) => s.audioOutputDeviceLabel);
  const audioOutputSelecting = usePlayerStore((s) => s.audioOutputSelecting);
  const selectAudioOutput = usePlayerStore((s) => s.selectAudioOutput);
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);

  const [castConnected, setCastConnected] = useState(castManager.isConnected());
  const [castDeviceName, setCastDeviceName] = useState(() => castManager.isConnected() ? castManager.getCastDeviceName() : '');
  const [showLyrics, setShowLyrics] = useState(false);
  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const trackIdentity = currentTrack?.queueEntryId || currentTrack?.id || currentTrack?.path || 'current-track';
  const colorSeedTracks = useMemo(() => currentTrack ? [currentTrack] : [], [currentTrack]);
  const { bgColor, colors } = useDominantColor(colorSeedTracks, { quality: 12 });
  const meshGradient = useMemo(
    () => buildCoverMeshGradient(trackIdentity, colors, bgColor),
    [trackIdentity, colors, bgColor],
  );

  // Matched YouTube music video for the current track (mobile-only, gated).
  const { videoId } = useTrackMusicVideo(currentTrack);
  const [videoPhase, setVideoPhase] = useState<VideoPhase>('none');
  // New track → drop back to the cover until its video (if any) buffers in.
  useEffect(() => { setVideoPhase('none'); }, [trackIdentity]);

  useEffect(() => {
    const unsubscribe = castManager.addStateChangeListener((state) => {
      const connected = state === 'CONNECTED';
      setCastConnected(connected);
      if (connected) {
        setCastDeviceName(castManager.getCastDeviceName());
      } else {
        setCastDeviceName('');
      }
    });
    return unsubscribe;
  }, []);

  const isPlaying = playbackState === 'playing';
  const mobileNowStyle = {
    '--mobile-now-art-color': bgColor,
  } as CSSProperties;

  const handlePlayPause = () => {
    if (playlist.length === 0) return;
    if (isPlaying) pause();
    else if (currentIndex === null) usePlayerStore.getState().playAtIndex(0);
    else resume();
  };

  const swipeRef = useSwipe<HTMLDivElement>({
    onSwipeDown: onClose,
    threshold: 80,
  });

  if (!currentTrack) return null;

  return (
    <div
      className="mobile-now-playing-shell md:hidden"
      data-playing={isPlaying}
      data-buffering={isBuffering}
      data-state={isOpen ? 'open' : 'closing'}
      data-video={videoPhase}
      style={mobileNowStyle}
    >
      {/* Vibrant cover-color mesh — the no-video background */}
      <div className="mobile-now-playing-mesh" aria-hidden="true" style={{ background: meshGradient }} />

      {currentTrack.artUrl && (
        <img
          src={currentTrack.artUrl}
          alt=""
          aria-hidden="true"
          className="mobile-now-playing-ambient"
        />
      )}

      {/* Full-screen, muted background music video (fades in when buffered) */}
      {videoId && (
        <div className="mobile-now-video" aria-hidden="true">
          <MobileNowPlayingVideo key={trackIdentity} videoId={videoId} onPhaseChange={setVideoPhase} />
        </div>
      )}

      {/* Safe area top spacer */}
      <div style={{ height: 'var(--safe-area-top)' }} />

      {/* Header */}
      <div className="mobile-now-playing-header">
        <button
          type="button"
          onClick={onClose}
          className="mobile-player-control-btn mobile-player-control-btn-sm"
          aria-label="Close now playing"
        >
          <X size={18} />
        </button>
        <div className="mobile-now-playing-heading">
          <span>Now Playing</span>
        </div>
        {currentTrack ? (
          <LoveButton track={currentTrack} size={18} className="mobile-player-control-btn mobile-player-control-btn-sm mobile-player-love-btn" />
        ) : (
          <div className="w-9" />
        )}
      </div>

      {/* Scrollable content */}
      <div ref={swipeRef} className="mobile-now-playing-content">
        {/* Album Art or Lyrics */}
        {showLyrics ? (
          <div className="mobile-now-lyrics-card" key={`lyrics-${trackIdentity}`}>
            <LyricsPanel
              trackName={currentTrack.title || currentTrack.path.split(/[\\/]/).pop() || ''}
              artistName={currentTrack.artist || ''}
              isVisible={showLyrics}
              onClose={() => setShowLyrics(false)}
            />
          </div>
        ) : (
          <div className="mobile-now-art" key={`art-${trackIdentity}`}>
            {currentTrack.artUrl ? (
              <img
                src={currentTrack.artUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]">
                <IconPlay />
              </div>
            )}
          </div>
        )}

        {/* Track Info */}
        <div className="mobile-now-track-info" key={`info-${trackIdentity}`}>
          <h2 className="mobile-now-title">
            {currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}
          </h2>
          <p className="mobile-now-artist">
            {currentTrack.artist || 'Unknown Artist'}
          </p>
          {currentTrack.album && (
            <p className="mobile-now-album">
              {currentTrack.album}
            </p>
          )}
          {castConnected && (
            <div className="mobile-now-state-chip mobile-now-state-chip-active">
              <span className="mobile-now-state-dot" aria-hidden="true" />
              <span>
                Casting{castDeviceName ? ` to ${castDeviceName}` : ''}
              </span>
            </div>
          )}
          {!castConnected && audioOutputActive && (
            <div className="mobile-now-state-chip mobile-now-state-chip-active">
              <Speaker size={14} aria-hidden="true" />
              <span className="truncate">
                Playing on {audioOutputDeviceLabel || 'selected output'}
              </span>
            </div>
          )}
        </div>

        {/* Progress Bar */}
        <div className="mobile-now-progress">
          <ProgressBar />
        </div>

        {castConnected && (
          <div className="mobile-now-volume">
            <div className="mobile-now-volume-label">
              <span>Cast volume</span>
              <span className="text-[var(--color-primary)]">{Math.round(volume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => setVolume(parseFloat(event.target.value))}
              className="mobile-now-volume-slider"
              aria-label="Cast volume"
            />
          </div>
        )}

        {/* Transport Controls */}
        <div className="mobile-now-transport">
          <button
            type="button"
            onClick={toggleShuffle}
            aria-label={shuffle ? 'Turn shuffle off' : 'Turn shuffle on'}
            aria-pressed={shuffle}
            className={`mobile-player-control-btn mobile-player-control-btn-md ${shuffle ? 'is-active' : ''}`}
          >
            <IconShuffle />
          </button>

          <button
            type="button"
            onClick={prevTrack}
            aria-label="Previous track"
            className="mobile-player-control-btn mobile-player-control-btn-lg"
          >
            <IconPrev />
          </button>

          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={isBuffering ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
            className="mobile-player-play-btn mobile-player-play-btn-lg"
            disabled={isBuffering}
          >
            {isBuffering ? (
              <svg className="mobile-player-spinner" width="28" height="28" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : isPlaying ? <IconPause /> : <IconPlay />}
          </button>

          <button
            type="button"
            onClick={() => void nextTrack()}
            aria-label="Next track"
            className="mobile-player-control-btn mobile-player-control-btn-lg"
          >
            <IconNext />
          </button>

          <button
            type="button"
            onClick={cycleRepeat}
            aria-label={repeat === 'one' ? 'Repeat one is on. Cycle repeat' : repeat === 'all' ? 'Repeat all is on. Cycle repeat' : 'Repeat is off. Cycle repeat'}
            aria-pressed={repeat !== 'none'}
            className={`mobile-player-control-btn mobile-player-control-btn-md ${repeat !== 'none' ? 'is-active' : ''}`}
          >
            {repeat === 'one' ? <IconRepeatOne /> : <IconRepeatAll />}
          </button>
        </div>

        {/* Secondary controls row */}
        <div className="mobile-now-secondary-controls">
          <button
            type="button"
            onClick={() => { setIsSidebarOpen(true); }}
            aria-label="Open play queue"
            className="mobile-player-control-btn mobile-player-control-btn-sm"
          >
            <ListMusic size={20} />
          </button>

          <button
            type="button"
            onClick={() => setShowLyrics(!showLyrics)}
            aria-label={showLyrics ? 'Hide lyrics' : 'Show lyrics'}
            aria-pressed={showLyrics}
            className={`mobile-player-pill-btn ${showLyrics ? 'is-active' : ''}`}
          >
            <FileText size={16} />
            Lyrics
          </button>

          <button
            type="button"
            onClick={toggleInfinityMode}
            aria-label={isInfinityMode ? 'Turn Infinity Mode off' : 'Turn Infinity Mode on'}
            aria-pressed={isInfinityMode}
            className={`mobile-player-pill-btn ${isInfinityMode ? 'is-active' : ''}`}
          >
            <InfinityIcon size={16} />
            Infinity
          </button>

          {audioOutputSupported && (
            <button
              type="button"
              onClick={() => { void selectAudioOutput(); }}
              disabled={castConnected || audioOutputSelecting}
              aria-label={audioOutputActive ? `Playing on ${audioOutputDeviceLabel || 'selected output'}` : 'Choose audio output'}
              className={`mobile-player-control-btn mobile-player-control-btn-sm ${audioOutputActive ? 'is-active' : ''}`}
              title={audioOutputActive ? `Playing on ${audioOutputDeviceLabel || 'selected output'}` : 'Choose audio output'}
            >
              <Speaker size={22} />
            </button>
          )}

          <CastButton size="sm" showIntro={false} className="mobile-now-cast-control" />
        </div>
      </div>

      {/* Safe area bottom spacer */}
      <div style={{ height: 'var(--safe-area-bottom)' }} />
    </div>
  );
};

export default MobileNowPlaying;
