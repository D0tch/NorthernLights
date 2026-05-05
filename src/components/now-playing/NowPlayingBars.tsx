import React from 'react';

type NowPlayingBarsState = 'playing' | 'paused';

interface NowPlayingBarsProps {
  state: NowPlayingBarsState;
  className?: string;
  ariaLabel?: string;
}

export const NowPlayingBars: React.FC<NowPlayingBarsProps> = ({
  state,
  className,
  ariaLabel,
}) => {
  const label = ariaLabel ?? (state === 'playing' ? 'now playing' : 'paused');
  return (
    <span
      className={className ? `np-bars ${className}` : 'np-bars'}
      data-state={state}
      role="img"
      aria-label={label}
    >
      <span />
      <span />
      <span />
    </span>
  );
};
