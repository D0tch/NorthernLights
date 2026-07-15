export function parseBareOrigin(origin: string): URL | null {
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getConfiguredAllowedOrigins(
  configuredOrigins: string | undefined,
  serverPort: string | number
): string[] {
  if (configuredOrigins) {
    return configuredOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  }

  return Array.from(new Set([
    'http://localhost:3000',
    `http://localhost:${serverPort}`,
  ]));
}

export function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  return new Set(
    origins
      .map((origin) => parseBareOrigin(origin)?.origin || null)
      .filter((origin): origin is string => Boolean(origin))
  );
}

export function isCorsOriginAllowed(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  const parsed = parseBareOrigin(origin);
  if (!parsed) return false;

  if (allowedOrigins.has(parsed.origin)) return true;

  return parsed.origin === 'https://www.gstatic.com' || parsed.origin === 'https://cast.google.com';
}
