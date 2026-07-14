import {
  getConfiguredAllowedOrigins,
  isCorsOriginAllowed,
  normalizeAllowedOrigins,
  parseBareOrigin,
} from './corsOrigin';
import fs from 'fs';
import path from 'path';

describe('CORS origin policy', () => {
  it('keeps both documented local entrypoints usable by default', () => {
    expect(getConfiguredAllowedOrigins(undefined, 3001)).toEqual([
      'http://localhost:3000',
      'http://localhost:3001',
    ]);
    expect(getConfiguredAllowedOrigins(undefined, 4100)).toEqual([
      'http://localhost:3000',
      'http://localhost:4100',
    ]);

    const exampleEnv = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    expect(exampleEnv).toContain('ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001');
  });

  it('does not append local exceptions to an explicit allow-list', () => {
    expect(getConfiguredAllowedOrigins(' https://music.example.com , https://house.example.com ', 3001)).toEqual([
      'https://music.example.com',
      'https://house.example.com',
    ]);
  });

  it('normalizes configured origins while rejecting non-origin URL shapes', () => {
    const origins = normalizeAllowedOrigins([
      'https://Music.Example.com:443',
      'http://localhost:3000',
      'https://music.example.com/path',
      'https://user:password@music.example.com',
    ]);

    expect([...origins]).toEqual([
      'https://music.example.com',
      'http://localhost:3000',
    ]);
    expect(parseBareOrigin('https://music.example.com/?debug=1')).toBeNull();
  });

  it('allows exact configured and trusted Cast origins only', () => {
    const origins = normalizeAllowedOrigins(['https://music.example.com']);

    expect(isCorsOriginAllowed('https://music.example.com', origins)).toBe(true);
    expect(isCorsOriginAllowed('https://www.gstatic.com', origins)).toBe(true);
    expect(isCorsOriginAllowed('https://cast.google.com', origins)).toBe(true);
    expect(isCorsOriginAllowed('https://music.example.com.attacker.test', origins)).toBe(false);
    expect(isCorsOriginAllowed('https://www.gstatic.com.attacker.test', origins)).toBe(false);
    expect(isCorsOriginAllowed('https://other.example.com', origins)).toBe(false);
  });

  it('keeps the readable origin-status probe ahead of the rejecting CORS middleware', () => {
    const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server/index.ts'), 'utf8');
    const probeIndex = serverSource.indexOf("app.get('/api/origin-status'");
    const corsIndex = serverSource.indexOf('app.use(cors({');

    expect(probeIndex).toBeGreaterThan(-1);
    expect(corsIndex).toBeGreaterThan(probeIndex);
  });
});
