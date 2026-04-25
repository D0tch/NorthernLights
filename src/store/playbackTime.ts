import { create } from 'zustand';

export interface PlaybackTimeState {
  currentTime: number;
  duration: number;
}

export const usePlaybackTimeStore = create<PlaybackTimeState>(() => ({
  currentTime: 0,
  duration: 0,
}));

export const getPlaybackTimeSnapshot = (): PlaybackTimeState => {
  const { currentTime, duration } = usePlaybackTimeStore.getState();
  return { currentTime, duration };
};

export const setPlaybackCurrentTime = (currentTime: number): void => {
  usePlaybackTimeStore.setState({ currentTime });
};

export const setPlaybackDuration = (duration: number): void => {
  usePlaybackTimeStore.setState({ duration });
};

export const setPlaybackTimeState = (state: Partial<PlaybackTimeState>): void => {
  usePlaybackTimeStore.setState(state);
};
