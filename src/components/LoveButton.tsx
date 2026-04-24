import React from 'react';
import { Heart } from 'lucide-react';
import { usePlayerStore } from '../store';
import type { TrackInfo } from '../utils/fileSystem';

interface LoveButtonProps {
  track: TrackInfo;
  className?: string;
  size?: number;
  showLabel?: boolean;
}

export const LoveButton: React.FC<LoveButtonProps> = ({ track, className = '', size = 18, showLabel = false }) => {
  const toggleTrackLove = usePlayerStore((state) => state.toggleTrackLove);
  const [isPending, setIsPending] = React.useState(false);
  const isLoved = !!track.isLoved;

  const handleClick = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isPending) return;
    setIsPending(true);
    try {
      await toggleTrackLove(track);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      aria-pressed={isLoved}
      aria-label={isLoved ? 'Remove from favorites' : 'Add to favorites'}
      title={isLoved ? 'Remove from favorites' : 'Add to favorites'}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full transition-all active:scale-95 disabled:opacity-60 ${
        isLoved
          ? 'text-rose-500 drop-shadow-[0_0_8px_rgba(244,63,94,0.35)]'
          : 'text-[var(--color-text-muted)] hover:text-rose-400'
      } ${className}`}
    >
      <Heart size={size} fill={isLoved ? 'currentColor' : 'none'} />
      {showLabel && <span>{isLoved ? 'Loved' : 'Love'}</span>}
    </button>
  );
};

export default LoveButton;
