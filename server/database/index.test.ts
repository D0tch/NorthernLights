jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

import { RECORD_PLAYBACK_STATS_SQL } from './index';

describe('record playback stats SQL', () => {
  it('keeps last_played_at monotonic when importing older timed scrobbles', () => {
    expect(RECORD_PLAYBACK_STATS_SQL).toContain(
      'last_played_at = GREATEST(COALESCE(user_playback_stats.last_played_at, $3), $3)',
    );
    expect(RECORD_PLAYBACK_STATS_SQL).toContain('play_count = user_playback_stats.play_count + 1');
  });
});
