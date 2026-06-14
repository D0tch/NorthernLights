import { cleanYouTubeVideoTitle, videoTitleCandidates } from './youtubeTitle';

describe('cleanYouTubeVideoTitle', () => {
  it('returns empty for falsy input', () => {
    expect(cleanYouTubeVideoTitle('')).toBe('');
  });

  it('strips bracketed video-type noise groups', () => {
    expect(cleanYouTubeVideoTitle('Telemiscommunications (Official Video)')).toBe('Telemiscommunications');
    expect(cleanYouTubeVideoTitle('Strobe (Official Music Video) [HD]')).toBe('Strobe');
    expect(cleanYouTubeVideoTitle('The Veldt (Lyric Video)')).toBe('The Veldt');
    expect(cleanYouTubeVideoTitle('Some Song (Official Audio)')).toBe('Some Song');
  });

  it('strips trailing dash qualifiers without brackets', () => {
    expect(cleanYouTubeVideoTitle('Artist - Song - Official Video')).toBe('Artist - Song');
    expect(cleanYouTubeVideoTitle('Song - Lyrics')).toBe('Song');
  });

  it('preserves "feat." since library titles often carry it', () => {
    expect(cleanYouTubeVideoTitle('Beneath with Me (feat. Skylar Grey)')).toBe('Beneath with Me (feat. Skylar Grey)');
    expect(cleanYouTubeVideoTitle('Professional Griefers (feat. Gerard Way) [Official Music Video]'))
      .toBe('Professional Griefers (feat. Gerard Way)');
  });

  it('keeps a clean title untouched', () => {
    expect(cleanYouTubeVideoTitle('Strobe')).toBe('Strobe');
  });
});

describe('videoTitleCandidates', () => {
  it('returns just the cleaned title when there is no artist prefix', () => {
    expect(videoTitleCandidates('Strobe (Official Video)')).toEqual(['Strobe']);
  });

  it('adds a prefix-stripped candidate for "Artist - Title" uploads', () => {
    expect(videoTitleCandidates('deadmau5 - Strobe (Official Video)')).toEqual(['deadmau5 - Strobe', 'Strobe']);
  });

  it('handles en/em dash and colon/pipe separators', () => {
    expect(videoTitleCandidates('deadmau5 – Strobe')).toEqual(['deadmau5 – Strobe', 'Strobe']);
    expect(videoTitleCandidates('deadmau5 — Strobe')).toEqual(['deadmau5 — Strobe', 'Strobe']);
    expect(videoTitleCandidates('deadmau5 | Strobe')).toEqual(['deadmau5 | Strobe', 'Strobe']);
  });

  it('keeps everything after the first separator for multi-dash titles', () => {
    expect(videoTitleCandidates('deadmau5 - Strobe - Radio Edit'))
      .toEqual(['deadmau5 - Strobe - Radio Edit', 'Strobe - Radio Edit']);
  });
});
