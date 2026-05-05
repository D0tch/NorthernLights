import React from 'react';
import {
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from 'lucide-react';
import { usePlayerStore } from '../../store';
import { usePlaybackTimeStore } from '../../store/playbackTime';
import { playbackManager } from '../../utils/PlaybackManager';
import { formatTime } from '../../utils/formatTime';
import { castManager } from '../../utils/CastManager';
import type { TrackInfo } from '../../utils/fileSystem';

interface CastExpandedControllerProps {
  onClose: () => void;
}

export const CastExpandedController: React.FC<CastExpandedControllerProps> = ({ onClose }) => {
  const expandedOpenedLoggedRef = React.useRef(false);
  const playlist = usePlayerStore((state) => state.playlist);
  const library = usePlayerStore((state) => state.library);
  const sessionHistoryTrackIds = usePlayerStore((state) => state.sessionHistoryTrackIds);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const playbackState = usePlayerStore((state) => state.playbackState);
  const isBuffering = usePlayerStore((state) => state.isBuffering);
  const pause = usePlayerStore((state) => state.pause);
  const resume = usePlayerStore((state) => state.resume);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const prevTrack = usePlayerStore((state) => state.prevTrack);
  const repeat = usePlayerStore((state) => state.repeat);
  const cycleRepeat = usePlayerStore((state) => state.cycleRepeat);
  const volume = usePlayerStore((state) => state.volume);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const setIsSidebarOpen = usePlayerStore((state) => state.setIsSidebarOpen);
  const currentTime = usePlaybackTimeStore((state) => state.currentTime);
  const duration = usePlaybackTimeStore((state) => state.duration);

  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const upNext = currentIndex !== null ? playlist.slice(currentIndex + 1, currentIndex + 4) : playlist.slice(0, 3);
  const recentTracks = React.useMemo(() => {
    const byId = new Map([...library, ...playlist].map((track) => [track.id, track]));
    const seen = new Set<string>();
    return [...sessionHistoryTrackIds]
      .reverse()
      .filter((trackId) => {
        if (!trackId || trackId === currentTrack?.id || seen.has(trackId)) return false;
        seen.add(trackId);
        return byId.has(trackId);
      })
      .slice(0, 3)
      .map((trackId) => byId.get(trackId))
      .filter((track): track is TrackInfo => Boolean(track));
  }, [currentTrack?.id, library, playlist, sessionHistoryTrackIds]);
  const displayDuration = duration || currentTrack?.duration || 0;
  const progressPercent = displayDuration > 0 ? Math.min(100, Math.max(0, (currentTime / displayDuration) * 100)) : 0;
  const isPlaying = playbackState === 'playing';
  const deviceName = castManager.getCastDeviceName() || 'Cast device';

  React.useEffect(() => {
    if (!currentTrack || expandedOpenedLoggedRef.current) return;
    expandedOpenedLoggedRef.current = true;
    castManager.logSenderExpandedOpened(
      `device=${deviceName} index=${currentIndex ?? 'none'} title=${currentTrack.title || 'Unknown Title'} state=${playbackState}`
    );
  }, [currentIndex, currentTrack, deviceName, playbackState]);

  if (!currentTrack) return null;

  const handlePlayPause = () => {
    if (isPlaying) pause();
    else void resume();
  };

  const handleSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!displayDuration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    playbackManager.seek(ratio * displayDuration);
  };

  const openQueue = () => {
    setIsSidebarOpen(true);
    onClose();
  };

  return (
    <div className="cast-expanded-backdrop" role="dialog" aria-modal="true" aria-label="Cast controller">
      <section className="cast-expanded-panel">
        <header className="cast-expanded-header">
          <div>
            <div className="cast-expanded-kicker">Casting to</div>
            <h2>{deviceName}</h2>
          </div>
          <button type="button" className="cast-expanded-close" onClick={onClose} aria-label="Close Cast controller">
            <X size={18} />
          </button>
        </header>

        <div className="cast-expanded-body">
          <div className="cast-expanded-art">
            {currentTrack.artUrl ? (
              <img src={currentTrack.artUrl} alt="" />
            ) : (
              <div>{(currentTrack.title || currentTrack.artist || 'A').charAt(0).toUpperCase()}</div>
            )}
          </div>

          <div className="cast-expanded-main">
            <div className="cast-expanded-track">
              <h3>{currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}</h3>
              <p>{currentTrack.artist || 'Unknown Artist'}</p>
              {currentTrack.album && <span>{currentTrack.album}</span>}
            </div>

            <div className="cast-expanded-progress">
              <div className="cast-expanded-times">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(displayDuration)}</span>
              </div>
              <div className="cast-expanded-trackbar" onClick={handleSeek}>
                <div style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            <div className="cast-expanded-controls">
              <button type="button" onClick={() => void prevTrack()} aria-label="Previous track">
                <SkipBack size={22} fill="currentColor" />
              </button>
              <button
                type="button"
                className="cast-expanded-play"
                onClick={handlePlayPause}
                disabled={isBuffering}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
              </button>
              <button type="button" onClick={() => void nextTrack()} aria-label="Next track">
                <SkipForward size={22} fill="currentColor" />
              </button>
              <button type="button" onClick={cycleRepeat} aria-label={`Repeat mode: ${repeat}`} data-active={repeat !== 'none'}>
                {repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
              </button>
            </div>

            <div className="cast-expanded-volume">
              <Volume2 size={17} />
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => setVolume(parseFloat(event.target.value))}
                aria-label="Cast volume"
              />
              <span>{Math.round(volume * 100)}%</span>
            </div>
          </div>
        </div>

        <footer className="cast-expanded-footer">
          <div>
            <div className="cast-expanded-kicker">Queue position</div>
            <strong>{currentIndex !== null ? `${currentIndex + 1} of ${playlist.length}` : `${playlist.length} tracks`}</strong>
          </div>
          <div className="cast-expanded-next">
            <div className="cast-expanded-kicker">Up next</div>
            {upNext.length > 0 ? (
              upNext.map((track) => (
                <div key={track.queueEntryId || `${track.id}-${track.title}`} className="cast-expanded-next-row">
                  <span>{track.title || track.path.split(/[\\/]/).pop()}</span>
                  <small>{track.artist || 'Unknown Artist'}</small>
                </div>
              ))
            ) : (
              <div className="cast-expanded-empty">No upcoming tracks.</div>
            )}
          </div>
          <div className="cast-expanded-recent">
            <div className="cast-expanded-kicker">Recently played</div>
            {recentTracks.length > 0 ? (
              recentTracks.map((track) => (
                <div key={`recent-${track.id}`} className="cast-expanded-next-row">
                  <span>{track.title || track.path.split(/[\\/]/).pop()}</span>
                  <small>{track.artist || 'Unknown Artist'}</small>
                </div>
              ))
            ) : (
              <div className="cast-expanded-empty">No session history yet.</div>
            )}
          </div>
          <button type="button" className="cast-expanded-queue" onClick={openQueue}>
            <ListMusic size={16} />
            Queue
          </button>
        </footer>
      </section>
    </div>
  );
};

export default CastExpandedController;
