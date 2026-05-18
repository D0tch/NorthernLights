import { useCallback, useEffect, useState } from 'react';

export type PlayerPlacement = 'float' | 'dock';

const STORAGE_KEY = 'aurora.player.placement';
const PLACEMENT_EVENT = 'aurora:player-placement';

const readInitial = (): PlayerPlacement => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'dock' ? 'dock' : 'float';
  } catch {
    return 'float';
  }
};

export const usePlayerPlacement = (): readonly [PlayerPlacement, (next: PlayerPlacement) => void, () => void] => {
  const [placement, setPlacementState] = useState<PlayerPlacement>(readInitial);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<PlayerPlacement>).detail;
      if (detail === 'dock' || detail === 'float') setPlacementState(detail);
    };
    window.addEventListener(PLACEMENT_EVENT, onChange);
    return () => window.removeEventListener(PLACEMENT_EVENT, onChange);
  }, []);

  const setPlacement = useCallback((next: PlayerPlacement) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable (e.g. private mode); placement still works in-memory.
    }
    window.dispatchEvent(new CustomEvent(PLACEMENT_EVENT, { detail: next }));
  }, []);

  const toggle = useCallback(() => {
    setPlacement(placement === 'float' ? 'dock' : 'float');
  }, [placement, setPlacement]);

  return [placement, setPlacement, toggle] as const;
};
