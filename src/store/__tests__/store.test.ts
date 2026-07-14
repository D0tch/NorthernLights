import { usePlayerStore } from '../index';
import { TrackInfo } from '../../utils/fileSystem';

describe('Music Store Logic', () => {
  beforeEach(() => {
    usePlayerStore.setState({ library: [], playlist: [] });
  });
  it('adds tracks to library', () => {
    usePlayerStore.setState({ library: [] });
    usePlayerStore.getState().addTracksToLibrary([{ id: 'baz', path: '/baz.mp3', title: 'c' }]);
    expect(usePlayerStore.getState().library).toHaveLength(1);
    expect(usePlayerStore.getState().library[0].title).toBe('c');
  });

  it('moves a track in the playlist', () => {
    usePlayerStore.setState({
      playlist: [
        { id: 'a', path: '/a.mp3', title: 'x' },
        { id: 'b', path: '/b.mp3', title: 'y' }
      ]
    });
    usePlayerStore.getState().moveInPlaylist(0, 1);
    expect(usePlayerStore.getState().playlist.map((t: TrackInfo) => t.id)).toEqual(['b', 'a']);
  });

  it('preserves Auto quality while hydrating browser track URLs', () => {
    usePlayerStore.setState({ mediaAccessToken: 'media-token', streamingQuality: 'auto' });
    const [track] = usePlayerStore.getState().hydrateTracks([
      { id: 'adaptive-track', path: 'L211c2ljL2FkYXB0aXZlLmZsYWM=', title: 'Adaptive' },
    ]);
    const url = new URL(track.url!);
    expect(url.searchParams.get('quality')).toBe('auto');
    expect(url.searchParams.get('token')).toBe('media-token');
  });
});
