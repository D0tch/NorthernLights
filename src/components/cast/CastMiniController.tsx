import React from 'react';
import { Cast, Pause, Play } from 'lucide-react';
import { usePlayerStore } from '../../store';
import { usePlaybackTimeStore } from '../../store/playbackTime';
import { castManager } from '../../utils/CastManager';

interface CastMiniControllerProps {
  onOpen: () => void;
}

export const CastMiniController: React.FC<CastMiniControllerProps> = ({ onOpen }) => {
  const castConnected = usePlayerStore((state) => state.castConnected);
  const playlist = usePlayerStore((state) => state.playlist);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const playbackState = usePlayerStore((state) => state.playbackState);
  const pause = usePlayerStore((state) => state.pause);
  const resume = usePlayerStore((state) => state.resume);
  const currentTime = usePlaybackTimeStore((state) => state.currentTime);
  const duration = usePlaybackTimeStore((state) => state.duration);

  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const deviceName = castManager.getCastDeviceName() || 'Cast device';

  React.useEffect(() => {
    if (!castConnected || !currentTrack) return;
    castManager.logSenderMiniVisible(
      `device=${deviceName} index=${currentIndex ?? 'none'} title=${currentTrack.title || 'Unknown Title'} state=${playbackState}`
    );
  }, [castConnected, currentIndex, currentTrack, deviceName, playbackState]);

  if (!castConnected || !currentTrack) return null;

  const isPlaying = playbackState === 'playing';
  const displayDuration = duration || currentTrack.duration || 0;
  const progressPercent = displayDuration > 0 ? Math.min(100, Math.max(0, (currentTime / displayDuration) * 100)) : 0;

  const handlePlayPause = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isPlaying) pause();
    else void resume();
  };

  const handleOpenKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen();
  };

  return (
    <div
      className="cast-mini-controller"
      onClick={onOpen}
      onKeyDown={handleOpenKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Open Cast controller for ${currentTrack.title || 'current track'} on ${deviceName}`}
    >
      <span className="cast-mini-progress" style={{ width: `${progressPercent}%` }} aria-hidden="true" />
      <span className="cast-mini-art" aria-hidden="true">
        {currentTrack.artUrl ? <img src={currentTrack.artUrl} alt="" /> : <Cast size={16} />}
      </span>
      <span className="cast-mini-copy">
        <span>{currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}</span>
        <small>{deviceName}</small>
      </span>
      <button
        type="button"
        className="cast-mini-action"
        onClick={handlePlayPause}
        aria-label={isPlaying ? 'Pause Cast playback' : 'Play Cast playback'}
      >
        {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>
    </div>
  );
};

export default CastMiniController;
