import React from 'react';
import { NowPlayingBars } from './NowPlayingBars';

interface NowPlayingBadgeProps {
  state: 'playing' | 'paused';
  label?: string;
  className?: string;
}

export const NowPlayingBadge: React.FC<NowPlayingBadgeProps> = ({
  state,
  label,
  className,
}) => {
  const text = label ?? (state === 'playing' ? 'now playing' : 'paused');
  return (
    <span className={className ? `np-badge ${className}` : 'np-badge'}>
      <NowPlayingBars state={state} ariaLabel={text} />
      <span>{text}</span>
    </span>
  );
};
