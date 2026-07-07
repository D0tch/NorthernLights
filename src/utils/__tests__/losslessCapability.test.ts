import { castLosslessMime } from '../losslessCapability';

describe('castLosslessMime', () => {
  test('FLAC → audio/flac', () => {
    expect(castLosslessMime('FLAC')).toBe('audio/flac');
    expect(castLosslessMime('flac')).toBe('audio/flac');
  });

  test('WAV / WAVE → audio/wav', () => {
    expect(castLosslessMime('WAVE')).toBe('audio/wav');
    expect(castLosslessMime('WAV')).toBe('audio/wav');
  });

  test('ALAC / M4A container → null (Cast cannot decode ALAC)', () => {
    expect(castLosslessMime('M4A/mp42/isom')).toBeNull();
    expect(castLosslessMime('ALAC')).toBeNull();
  });

  test('lossy formats → null', () => {
    expect(castLosslessMime('MPEG')).toBeNull();       // MP3
    expect(castLosslessMime('MPEG-4/AAC')).toBeNull();  // must NOT match flac/wav
    expect(castLosslessMime('Ogg')).toBeNull();
    expect(castLosslessMime('ASF/audio')).toBeNull();   // WMA
  });

  test('empty / null → null', () => {
    expect(castLosslessMime(null)).toBeNull();
    expect(castLosslessMime(undefined)).toBeNull();
    expect(castLosslessMime('')).toBeNull();
  });
});
